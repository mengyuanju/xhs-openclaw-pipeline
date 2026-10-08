import { analyzeAndSaveExcellentCopy } from './deepseek-copy-analysis.mjs';
import { analyzeVisualImage } from '../../src/admin/visual-knowledge-service.mjs';
import { createPreviewServiceClient, createDeliveryPreviewUrlResolver } from './delivery-preview.mjs';
import { resolve } from 'node:path';
import Koa from 'koa';
import Router from '@koa/router';
import { cleanCommittedDeletionQuarantines } from './http-task-storage.mjs';
import { randomUUID } from 'node:crypto';
import { HttpError, mappedError, accessLogRecord, JSON_BODY_LIMIT, readAuthenticationUser, initialPasswordRequestAllowed, assertCurrentActorIdentity, validXhsSearchMachineToken, machineTokenMatches } from './http-route-common.mjs';
import { invalidatePersonalWorkspaceCounts } from './personal-workspace-query.mjs';
import { bodyParser } from '@koa/bodyparser';
import { installControlPlaneRoutes } from './http-routes.mjs';
import { captureWorkspaceMutation, workspaceMutationCommitted, workspaceCountsNeedInvalidation } from './http-workspace-invalidation.mjs';
export function createControlPlaneApp({
  repository,
  storageRoot,
  enforceUserAuth = true,
  xhsSearchMachineToken = process.env.XHS_SEARCH_MACHINE_TOKEN,
  analyzeCopy = analyzeAndSaveExcellentCopy,
  analyzeVisual = analyzeVisualImage,
  previewClient = createPreviewServiceClient({
    baseUrl: process.env.PREVIEW_BASE_URL,
    apiKey: process.env.PREVIEW_API_KEY
  }),
  previewUrlResolver = createDeliveryPreviewUrlResolver(process.env.PREVIEW_BASE_URL),
  logger = console,
  onProgrammaticReady,
  reportProjectionEnabled = process.env.XHS_SERVER_ENV === 'development' || process.env.REPORT_PROJECTION_WORKER_ENABLED === 'true',
  disposableCleanupEnabled = process.env.XHS_SERVER_ENV === 'development' || process.env.DISPOSABLE_DATA_CLEANUP_ENABLED === 'true',
  storageOptimizationEnabled = process.env.XHS_SERVER_ENV === 'development' || process.env.STORAGE_OPTIMIZATION_WORKER_ENABLED === 'true'
}) {
  if (!repository) throw new TypeError('repository is required');
  const resolvedStorageRoot = resolve(storageRoot);
  const app = new Koa();
  const router = new Router();
  const staleDeletionCleanup = cleanCommittedDeletionQuarantines(resolvedStorageRoot).catch(error => console.error('failed to clean committed task deletion quarantine', error));
  app.use(async (ctx, next) => {
    const startedAt = process.hrtime.bigint();
    let errorCode = null;
    await staleDeletionCleanup;
    ctx.state.requestId = randomUUID();
    ctx.set('X-Request-Id', ctx.state.requestId);
    ctx.set('Cache-Control', 'no-store');
    ctx.set('X-Content-Type-Options', 'nosniff');
    const workspaceVersion = captureWorkspaceMutation(repository);
    try {
      await next();
      if (ctx.status === 404 && ctx.body == null) {
        throw new HttpError(404, 'NOT_FOUND', 'route not found');
      }
      if (workspaceMutationCommitted(repository, ctx, workspaceVersion)) {
        if (workspaceCountsNeedInvalidation(repository, ctx)) invalidatePersonalWorkspaceCounts(repository.pool);
        void app.context.onMutationCommitted?.();
      }
    } catch (error) {
      const mapped = mappedError(error);
      errorCode = mapped.code;
      ctx.body?.destroy?.();
      for (const header of ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
        ctx.remove(header);
      }
      ctx.set('Cache-Control', 'no-store');
      ctx.status = mapped.status;
      ctx.type = 'application/json';
      ctx.body = {
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(mapped.details === undefined ? {} : {
            details: mapped.details
          })
        }
      };
    } finally {
      const line = JSON.stringify(accessLogRecord(ctx, startedAt, errorCode));
      if (ctx.status >= 500) logger.error?.(line);else logger.info?.(line);
    }
  });
  const parseImageEditorUpload = bodyParser({
    enableTypes: ['json'],
    jsonLimit: 36 * 1024 * 1024,
    parsedMethods: ['POST']
  });
  const parseJsonBody = bodyParser({
    enableTypes: ['json'],
    jsonLimit: JSON_BODY_LIMIT,
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE']
  });
  app.use(async (ctx, next) => {
    const rawUpload = ctx.method === 'POST' && /^\/v1\/image-editor\/uploads\/[^/]+\/[1-5]$/u.test(ctx.path) || ctx.method === 'PUT' && (/^\/v1\/executions\/[^/]+\/assets$/u.test(ctx.path) || /^\/v1\/executions\/[^/]+\/image-edit\/result$/u.test(ctx.path) || /^\/v1\/knowledge-versions\/[^/]+\/asset$/u.test(ctx.path) || ctx.path === '/v1/query-packages/import-preview');
    if (rawUpload) return next();
    if (ctx.method === 'POST' && ctx.path === '/v1/image-editor/workspaces') return parseImageEditorUpload(ctx, next);
    return parseJsonBody(ctx, next);
  });
  app.use(async (ctx, next) => {
    const username = String(ctx.get('X-Actor-Username') || '').trim().toLowerCase();
    if (!enforceUserAuth) {
      ctx.state.actor = {
        username: username || String(ctx.get('X-Task-Creator-Id') || 'admin'),
        role: 'ADMIN',
        userId: 1,
        credentialVersion: 1
      };
      return next();
    }
    if (!username) return next();
    const rawUserId = String(ctx.get('X-Actor-User-Id') || '').trim();
    const actorUserId = /^[1-9]\d*$/u.test(rawUserId) ? Number(rawUserId) : NaN;
    const role = String(ctx.get('X-Actor-Role') || '').trim().toUpperCase();
    const credentialVersion = Number(ctx.get('X-Actor-Credential-Version'));
    const user = await readAuthenticationUser(repository, repository.getUserByUsername, username);
    if (!Number.isSafeInteger(actorUserId) || !user || user.id !== actorUserId || user.status !== 'ACTIVE' || user.role !== role || user.credentialVersion !== credentialVersion) {
      throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    }
    if (user.mustChangePassword && !initialPasswordRequestAllowed(ctx)) {
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', '必须先修改初始密码后才能使用其他功能');
    }
    ctx.state.actor = {
      username: user.username,
      role: user.role,
      userId: user.id,
      credentialVersion: user.credentialVersion
    };
    await next();
    if (['GET', 'HEAD'].includes(ctx.method)) {
      await assertCurrentActorIdentity(repository, ctx.state.actor);
    }
  });
  const disposeRouteResources = installControlPlaneRoutes({
    router,
    repository,
    storageRoot: resolvedStorageRoot,
    analyzeCopy,
    analyzeVisual,
    previewClient,
    previewUrlResolver,
    xhsSearchMachineTokenConfigured: validXhsSearchMachineToken(xhsSearchMachineToken) !== null,
    onProgrammaticReady,
    reportProjectionEnabled,
    disposableCleanupEnabled,
    storageOptimizationEnabled
  });
  app.context.disposeControlPlaneResources = disposeRouteResources;
  app.context.onMutationCommitted = disposeRouteResources.onMutationCommitted;
  app.use(async (ctx, next) => {
    const xhsSearchMachineRoute = ctx.path.startsWith('/v1/xhs-query-search/');
    if (xhsSearchMachineRoute && enforceUserAuth) {
      const configuredToken = validXhsSearchMachineToken(xhsSearchMachineToken);
      if (!configuredToken) {
        throw new HttpError(503, 'XHS_SEARCH_NOT_CONFIGURED', '小红书搜索执行机密钥尚未配置');
      }
      if (!machineTokenMatches(configuredToken, ctx.get('X-XHS-Search-Token'))) {
        throw new HttpError(401, 'INVALID_XHS_SEARCH_TOKEN', '小红书搜索执行机认证失败');
      }
    }
    const machineRoute = ctx.path.startsWith('/v1/executions/') || xhsSearchMachineRoute || ctx.path === '/v1/nodes' && ctx.method !== 'GET';
    if (machineRoute && ctx.state.actor && ctx.state.actor.role !== 'ADMIN') {
      throw new HttpError(403, 'FORBIDDEN', 'user sessions cannot use executor machine routes');
    }
    return next();
  });
  app.use(async (ctx, next) => {
    if (ctx.state.actor && typeof repository.assertContentTaskIds === 'function' && ctx.path.startsWith('/v1/tasks/')) {
      const match = /^\/v1\/tasks\/([1-9]\d*)(?:\/|$)/u.exec(ctx.path);
      const ids = match ? [Number(match[1])] : Array.isArray(ctx.request.body?.taskIds) ? ctx.request.body.taskIds : [];
      if (ids.length) await repository.assertContentTaskIds(ids);
    }
    return next();
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
