import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import Koa from 'koa';
import { importCopyKnowledgeLabels, listCopyAnalysisPrompts, retireKnowledge, saveCopyAnalysisPrompt } from './knowledge-admin.mjs';
import { analyzeAndSaveExcellentCopy, CopyAnalysisServiceError } from './deepseek-copy-analysis.mjs';
import { archiveFileName, buildTaskArchive } from './task-archive.mjs';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
} from './domain.mjs';

const JSON_BODY_LIMIT = 12 * 1024 * 1024;
const ASSET_BODY_LIMIT = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function mappedError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof CopyAnalysisServiceError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof ControlPlaneNotFoundError) {
    return new HttpError(404, error.code, error.message);
  }
  if (error instanceof ControlPlaneConflictError) {
    return new HttpError(409, error.code, error.message);
  }
  if (error?.status === 422 && error?.type === 'entity.parse.failed') {
    return new HttpError(400, 'INVALID_JSON', 'request body must be valid JSON');
  }
  if (error?.status === 413) {
    return new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return new HttpError(400, 'VALIDATION_ERROR', error.message);
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'control plane request failed');
}

function requireJson(ctx) {
  if (!ctx.is('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }
  return ctx.request.body;
}

async function readBody(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeStoragePath(storageRoot, ...segments) {
  const path = resolve(storageRoot, ...segments);
  const relation = relative(storageRoot, path);
  if (relation.startsWith('..') || relation.includes(':')) {
    throw new Error('resolved storage path escaped storage root');
  }
  return path;
}

async function uploadAsset({ ctx, repository, storageRoot, executionId }) {
  const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
  const extension = mediaType === 'image/png'
    ? '.png'
    : mediaType === 'image/jpeg'
      ? '.jpg'
      : mediaType === 'application/json'
        ? '.json'
        : null;
  if (!extension) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'asset type is not supported');
  const body = await readBody(ctx.req, ASSET_BODY_LIMIT);
  const context = await repository.activeImageUploadContext(executionId);
  const directory = safeStoragePath(
    storageRoot,
    'tasks',
    String(context.taskId),
    'image-runs',
    context.imageRunId,
  );
  await mkdir(directory, { recursive: true });
  const storagePath = safeStoragePath(directory, `${randomUUID()}${extension}`);
  await writeFile(storagePath, body, { flag: 'wx' });
  try {
    return await repository.recordAsset({
      executionId,
      mediaType,
      byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      storagePath,
      originalName: ctx.request.headers['x-file-name'] ?? null,
    });
  } catch (error) {
    await rm(storagePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function uploadKnowledgeAsset({ ctx, repository, storageRoot, versionId }) {
  const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
  if (mediaType !== 'image/png') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'knowledge assets must be normalized PNG images');
  }
  const body = await readBody(ctx.req, ASSET_BODY_LIMIT);
  const context = await repository.knowledgeUploadContext(versionId);
  const directory = safeStoragePath(
    storageRoot,
    'knowledge',
    context.kind.toLowerCase(),
    String(context.itemId),
    String(context.versionId),
  );
  await mkdir(directory, { recursive: true });
  const storagePath = safeStoragePath(directory, `${randomUUID()}.png`);
  await writeFile(storagePath, body, { flag: 'wx' });
  try {
    return await repository.attachKnowledgeAsset({
      versionId,
      storagePath,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  } catch (error) {
    await rm(storagePath, { force: true }).catch(() => {});
    throw error;
  }
}

function json(ctx, status, data) {
  ctx.status = status;
  ctx.body = { data };
}

const APP_ROLES = Object.freeze(['ADMIN', 'REVIEWER', 'USER']);

function requestActor(ctx, allowedRoles = APP_ROLES) {
  const actor = ctx.state.actor;
  if (!actor) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'authenticated user context is required');
  }
  if (!allowedRoles.includes(actor.role)) throw new HttpError(403, 'FORBIDDEN', 'current role cannot perform this operation');
  return actor;
}

async function assertTaskAccess(ctx, repository, { ownerOnly = false } = {}) {
  const actor = requestActor(ctx);
  if (typeof repository.getTask !== 'function') return { actor, task: null };
  const task = await repository.getTask(ctx.params.taskId);
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  if ((ownerOnly || actor.role === 'USER') && task.createdByUserId !== actor.username) {
    throw new HttpError(403, 'FORBIDDEN', 'current user cannot access this task');
  }
  return { actor, task };
}

function installRoutes(router, repository, storageRoot, analyzeCopy) {
  router.post('/v1/auth/login', async (ctx) => {
    const body = requireJson(ctx);
    const user = await repository.authenticateUser(body.username, body.password);
    if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', '登录失败');
    json(ctx, 200, user);
  });
  router.get('/v1/users', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listUsers({ status: ctx.query.status || null }));
  });
  router.post('/v1/users', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createUser(requireJson(ctx)));
  });
  router.patch('/v1/users/:userId', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateUser(ctx.params.userId, requireJson(ctx)));
  });
  router.delete('/v1/users/:userId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.deleteUser(ctx.params.userId, {
      ...requireJson(ctx),
      actorUsername: actor.username,
    }));
  });
  router.post('/v1/users/:userId/reset-password', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.resetUserPassword(ctx.params.userId));
  });
  router.get('/v1/profile', async (ctx) => {
    const actor = requestActor(ctx);
    const user = await repository.getUserByUsername(actor.username);
    if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    json(ctx, 200, user);
  });
  router.patch('/v1/profile', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.updateOwnProfile(actor.username, requireJson(ctx)));
  });
  router.post('/v1/profile/password', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.changeOwnPassword(actor.username, requireJson(ctx)));
  });
  router.put('/v1/executions/:executionId/model-calls/:callId', async (ctx) => {
    json(ctx, 200, await repository.recordModelCall(ctx.params.executionId, ctx.params.callId, requireJson(ctx)));
  });
  router.get('/v1/tasks/:taskId/model-calls', async (ctx) => {
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.listModelCalls(ctx.params.taskId, { limit: ctx.query.limit, offset: ctx.query.offset }));
  });
  router.get('/v1/tasks/:taskId/model-calls/:callId', async (ctx) => {
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.getModelCall(ctx.params.taskId, ctx.params.callId));
  });
  router.get('/health', async (ctx) => json(ctx, 200, await repository.health()));

  router.post('/v1/nodes', async (ctx) => {
    json(ctx, 200, await repository.registerNode(requireJson(ctx)));
  });
  router.get('/v1/nodes', async (ctx) => {
    json(ctx, 200, await repository.listNodes());
  });
  router.post('/v1/tasks', async (ctx) => {
    const actor = requestActor(ctx);
    const body = requireJson(ctx);
    json(ctx, 201, await repository.createTasks({
      nodeId: body.nodeId,
      copyExecutorNodeId: body.copyExecutorNodeId,
      createdByUserId: actor.username,
      tasks: body.tasks,
    }));
  });
  router.get('/v1/tasks', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.listTasks({
      state: ctx.query.state,
      states: ctx.query.states,
      nodeId: ctx.query.nodeId,
      createdByUserId: actor.role === 'USER' ? actor.username : ctx.query.createdByUserId,
      query: ctx.query.query,
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      includeTotal: ctx.query.includeTotal === 'true',
    }));
  });
  router.get('/v1/task-counts', async (ctx) => {
    json(ctx, 200, await repository.taskCounts({ nodeId: ctx.query.nodeId }));
  });
  router.get('/v1/tasks/:taskId', async (ctx) => {
    const { task } = await assertTaskAccess(ctx, repository);
    json(ctx, 200, task);
  });
  router.get('/v1/tasks/:taskId/archive', async (ctx) => {
    const { task } = await assertTaskAccess(ctx, repository);
    if (task.state !== 'MANUAL_ARCHIVE') {
      throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only manually archived tasks can be downloaded');
    }
    const content = await buildTaskArchive(task, async (assetId) => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return { ...asset, content: await readFile(path) };
    });
    const fileName = archiveFileName(task);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', `attachment; filename="task-${task.id}-resources.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    ctx.body = content;
  });

  router.post('/v1/executions/claim-copy', async (ctx) => {
    json(ctx, 200, await repository.claimCopy(requireJson(ctx).nodeId));
  });
  router.post('/v1/executions/claim-image', async (ctx) => {
    json(ctx, 200, await repository.claimImage(requireJson(ctx).nodeId));
  });
  router.patch('/v1/executions/:executionId/progress', async (ctx) => {
    json(ctx, 200, await repository.updateProgress(ctx.params.executionId, requireJson(ctx)));
  });
  router.post('/v1/executions/:executionId/complete-copy', async (ctx) => {
    json(ctx, 200, await repository.completeCopy(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/complete-image', async (ctx) => {
    json(ctx, 200, await repository.completeImage(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/fail', async (ctx) => {
    const body = requireJson(ctx);
    json(ctx, 200, await repository.failExecution(ctx.params.executionId, body.error, { autoRetry: body.autoRetry }));
  });
  router.put('/v1/executions/:executionId/assets', async (ctx) => {
    const result = await uploadAsset({
      ctx,
      repository,
      storageRoot,
      executionId: ctx.params.executionId,
    });
    json(ctx, 201, { ...result, url: `/v1/assets/${result.id}` });
  });
  router.get('/v1/assets/:assetId', async (ctx) => {
    const asset = await repository.getAsset(ctx.params.assetId);
    if (!asset) throw new ControlPlaneNotFoundError('asset not found');
    ctx.params.taskId = String(asset.taskId);
    await assertTaskAccess(ctx, repository);
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.status = 200;
    ctx.type = asset.mediaType;
    ctx.body = await readFile(path);
  });

  router.post('/v1/tasks/:taskId/approve-copy', async (ctx) => {
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.approveCopy(ctx.params.taskId, requireJson(ctx)));
  });
  router.post('/v1/tasks/:taskId/retry', async (ctx) => {
    await assertTaskAccess(ctx, repository, { ownerOnly: requestActor(ctx).role !== 'ADMIN' });
    json(ctx, 200, await repository.retryTask(ctx.params.taskId, requireJson(ctx)));
  });
  router.post('/v1/tasks/:taskId/cancel', async (ctx) => {
    await assertTaskAccess(ctx, repository, { ownerOnly: requestActor(ctx).role !== 'ADMIN' });
    json(ctx, 200, await repository.cancelTask(ctx.params.taskId));
  });

  router.get('/v1/settings', async (ctx) => json(ctx, 200, await repository.listSettings()));
  router.put('/v1/settings/:key', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.upsertSetting(ctx.params.key, requireJson(ctx).value));
  });
  router.get('/v1/prompts', async (ctx) => json(ctx, 200, await repository.listPrompts()));
  router.post('/v1/prompts/versions', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createPromptVersion(requireJson(ctx)));
  });
  router.post('/v1/prompt-versions/:versionId/publish', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.publishPromptVersion(ctx.params.versionId));
  });

  router.get('/v1/knowledge', async (ctx) => json(ctx, 200, await repository.listKnowledge()));
  router.get('/v1/knowledge/capabilities', (ctx) => json(ctx, 200, { workbenchVersion: 1 }));
  router.get('/v1/copy-analysis-prompts', async (ctx) => { requestActor(ctx, ['ADMIN', 'REVIEWER']); json(ctx, 200, await listCopyAnalysisPrompts(repository.pool)); });
  router.post('/v1/copy-analysis-prompts', async (ctx) => { requestActor(ctx, ['ADMIN', 'REVIEWER']); json(ctx, 201, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx))); });
  router.patch('/v1/copy-analysis-prompts/:id', async (ctx) => { requestActor(ctx, ['ADMIN', 'REVIEWER']); json(ctx, 200, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx), ctx.params.id)); });
  router.post('/v1/knowledge/labels/import', async (ctx) => { requestActor(ctx, ['ADMIN', 'REVIEWER']); json(ctx, 200, await importCopyKnowledgeLabels(repository.pool, requireJson(ctx).labels)); });
  router.post('/v1/copy-knowledge/analyze', async (ctx) => {
    requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 201, await analyzeCopy({ repository, input: requireJson(ctx) }));
  });
  router.post('/v1/knowledge/:id/retire', async (ctx) => { requestActor(ctx, ['ADMIN', 'REVIEWER']); json(ctx, 200, await retireKnowledge(repository.pool, ctx.params.id)); });
  router.post('/v1/knowledge/versions', async (ctx) => {
    requestActor(ctx, ['ADMIN', 'REVIEWER']);
    const body = requireJson(ctx);
    json(ctx, 201, await repository.createKnowledgeVersion({
      itemId: body.itemId ?? null,
      kind: body.kind,
      name: body.name,
      content: body.content ?? {},
      publish: body.publish ?? false,
      expectedVersionId: body.expectedVersionId ?? null,
    }));
  });
  router.put('/v1/knowledge-versions/:versionId/asset', async (ctx) => {
    requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 201, await uploadKnowledgeAsset({
      ctx,
      repository,
      storageRoot,
      versionId: ctx.params.versionId,
    }));
  });
  router.get('/v1/knowledge-versions/:versionId/asset', async (ctx) => {
    const asset = await repository.getKnowledgeAsset(ctx.params.versionId);
    if (!asset) throw new ControlPlaneNotFoundError('knowledge asset not found');
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.status = 200;
    ctx.type = 'image/png';
    ctx.body = await readFile(path);
  });
  router.post('/v1/knowledge-versions/:versionId/publish', async (ctx) => {
    requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.publishKnowledgeVersion(ctx.params.versionId));
  });
}

export function createControlPlaneApp({ repository, storageRoot, enforceUserAuth = true, analyzeCopy = analyzeAndSaveExcellentCopy }) {
  if (!repository) throw new TypeError('repository is required');
  const resolvedStorageRoot = resolve(storageRoot);
  const app = new Koa();
  const router = new Router();

  app.use(async (ctx, next) => {
    ctx.state.requestId = randomUUID();
    ctx.set('X-Request-Id', ctx.state.requestId);
    ctx.set('Cache-Control', 'no-store');
    ctx.set('X-Content-Type-Options', 'nosniff');
    try {
      await next();
      if (ctx.status === 404 && ctx.body == null) {
        throw new HttpError(404, 'NOT_FOUND', 'route not found');
      }
    } catch (error) {
      const mapped = mappedError(error);
      if (mapped.status === 500) console.error(error);
      ctx.status = mapped.status;
      ctx.type = 'application/json';
      ctx.body = { error: { code: mapped.code, message: mapped.message } };
    }
  });

  const parseJsonBody = bodyParser({
    enableTypes: ['json'],
    jsonLimit: JSON_BODY_LIMIT,
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.use(async (ctx, next) => {
    const rawUpload = ctx.method === 'PUT'
      && (/^\/v1\/executions\/[^/]+\/assets$/u.test(ctx.path)
        || /^\/v1\/knowledge-versions\/[^/]+\/asset$/u.test(ctx.path));
    if (rawUpload) return next();
    return parseJsonBody(ctx, next);
  });
  app.use(async (ctx, next) => {
    const username = String(ctx.get('X-Actor-Username') || '').trim().toLowerCase();
    if (!enforceUserAuth) {
      ctx.state.actor = {
        username: username || String(ctx.get('X-Task-Creator-Id') || 'admin'),
        role: 'ADMIN',
        userId: 1,
      };
      return next();
    }
    if (!username) return next();
    const role = String(ctx.get('X-Actor-Role') || '').trim().toUpperCase();
    const credentialVersion = Number(ctx.get('X-Actor-Credential-Version'));
    const user = await repository.getUserByUsername(username).catch(() => null);
    if (!user || user.status !== 'ACTIVE' || user.role !== role
      || user.credentialVersion !== credentialVersion) {
      throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    }
    ctx.state.actor = { username: user.username, role: user.role, userId: user.id };
    return next();
  });
  installRoutes(router, repository, resolvedStorageRoot, analyzeCopy);
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
