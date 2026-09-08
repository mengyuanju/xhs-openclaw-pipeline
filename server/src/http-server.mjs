import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import Koa from 'koa';
import { importCopyKnowledgeLabels, listCopyAnalysisPrompts, retireKnowledge, saveCopyAnalysisPrompt } from './knowledge-admin.mjs';
import { analyzeAndSaveExcellentCopy, CopyAnalysisServiceError } from './deepseek-copy-analysis.mjs';
import { archiveFileName, buildBatchTaskArchive, buildTaskArchive } from './task-archive.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';
import { AssetDeliveryError, createAssetDelivery } from './asset-delivery.mjs';
import { normalizePromptContent } from '../../src/admin/prompt-service.mjs';
import { assertPromptPublishable } from '../../src/admin/prompt-preview.mjs';
import { readPromptConfiguration, savePromptPolicy } from '../../src/admin/prompt-runtime-service.mjs';
import { analyzeVisualImage } from '../../src/admin/visual-knowledge-service.mjs';
import { withPromptExecution, listPromptExecutions, readPromptExecution } from '../../src/admin/prompt-execution.mjs';
import { generateAndImportLayouts } from '../../src/admin/layout-catalog-service.mjs';
import { LoginRateLimiter } from '../../src/admin/auth.mjs';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskCreatorRole,
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
  if (error?.code === 'CATALOG_CONFLICT') return new HttpError(409, error.code, error.message);
  if (error instanceof HttpError) return error;
  if (error instanceof AssetDeliveryError) return new HttpError(error.status, error.code, error.message);
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
  const imageFormat = Object.values(IMAGE_FORMATS).find(format => format.mediaType === mediaType);
  const extension = imageFormat ? `.${imageFormat.extension}` : mediaType === 'application/json' ? '.json' : null;
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

function normalizedBatchTaskIds(value, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new RangeError(`taskIds must contain between 1 and ${max} items`);
  }
  const taskIds = [...new Set(value.map((entry) => Number(entry)))];
  if (taskIds.some((taskId) => !Number.isSafeInteger(taskId) || taskId < 1)) {
    throw new TypeError('taskIds must contain positive integers');
  }
  return taskIds;
}

async function applyBatchTaskAction(repository, taskIds, action) {
  if (!['RETRY', 'CANCEL_QUEUE'].includes(action)) throw new TypeError('batch task action is invalid');
  const succeeded = [];
  const failed = [];
  for (const taskId of taskIds) {
    try {
      const readSummary = repository.getTaskActionSummary ?? repository.getTask;
      const task = await readSummary.call(repository, taskId);
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (action === 'CANCEL_QUEUE') {
        if (!['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state)) {
          throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only queued work can be cancelled in bulk');
        }
        await repository.cancelTask(taskId, { queuedOnly: true });
      } else if (['COPY_RUNNING', 'COPY_FAILED'].includes(task.state)) {
        await repository.retryTask(taskId, { useLatestConfig: true });
      } else if (['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)
        || (task.state === 'COPY_REVIEW_PENDING' && task.currentStage === 'IMAGE_RETRY_EXHAUSTED')) {
        await repository.requeueImageTask(taskId, { retryOnly: true });
      } else {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only running or failed work can be retried in bulk');
      }
      succeeded.push(taskId);
    } catch (error) {
      const safe = mappedError(error);
      failed.push({ id: taskId, code: safe.code, message: safe.message });
    }
  }
  return { action, succeeded, failed };
}

async function quarantineTaskStorage(storageRoot, taskId) {
  const quarantineRoot = safeStoragePath(storageRoot, '.task-deletion-quarantine', `${taskId}-${randomUUID()}`);
  const locations = [
    { source: safeStoragePath(storageRoot, 'tasks', String(taskId)), target: safeStoragePath(quarantineRoot, 'task') },
    { source: safeStoragePath(storageRoot, 'thumbnails', String(taskId)), target: safeStoragePath(quarantineRoot, 'thumbnails') },
  ];
  const moved = [];
  async function restoreMovedLocations() {
    const failures = [];
    for (const location of [...moved].reverse()) {
      try {
        await mkdir(dirname(location.source), { recursive: true });
        await rename(location.target, location.source);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to restore quarantined task files');
    }
    await rm(quarantineRoot, { recursive: true, force: true });
  }
  await mkdir(quarantineRoot, { recursive: true });
  try {
    for (const location of locations) {
      try {
        await rename(location.source, location.target);
        moved.push(location);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    try {
      await restoreMovedLocations();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'failed to quarantine task files safely');
    }
    throw error;
  }
  return {
    quarantineRoot,
    async markCommitted() {
      await writeFile(safeStoragePath(quarantineRoot, 'COMMITTED'), new Date().toISOString(), { flag: 'wx' });
    },
    async restore() {
      await restoreMovedLocations();
    },
  };
}

async function removeQuarantine(path, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === attempts) return false;
      await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 75));
    }
  }
  return false;
}

function scheduleQuarantineCleanup(path, attempt = 1) {
  const timer = setTimeout(async () => {
    if (await removeQuarantine(path)) return;
    scheduleQuarantineCleanup(path, attempt + 1);
  }, Math.min(60_000, attempt * 5_000));
  timer.unref?.();
}

async function cleanCommittedDeletionQuarantines(storageRoot) {
  const root = safeStoragePath(storageRoot, '.task-deletion-quarantine');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
    const directory = safeStoragePath(root, entry.name);
    try {
      await readFile(safeStoragePath(directory, 'COMMITTED'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!await removeQuarantine(directory)) scheduleQuarantineCleanup(directory);
  }));
}

async function applyBatchPermanentDeletion(repository, storageRoot, taskIds, actorUsername, deletionPassword) {
  const quarantines = new Map();
  let result;
  try {
    result = await repository.permanentlyDeleteTasks(taskIds, {
      actorUsername,
      deletionPassword,
      beforeDelete: async (taskId) => {
        quarantines.set(taskId, await quarantineTaskStorage(storageRoot, taskId));
      },
    });
  } catch (error) {
    for (const quarantine of [...quarantines.values()].reverse()) {
      try {
        await quarantine.restore();
      } catch (restoreError) {
        console.error('failed to restore quarantined task files', restoreError);
      }
    }
    throw error;
  }

  const cleanupPending = [];
  for (const taskId of result.succeeded) {
    const quarantine = quarantines.get(taskId);
    if (!quarantine) continue;
    await quarantine.markCommitted().catch(error => console.error('failed to mark task deletion quarantine', error));
    const cleaned = await removeQuarantine(quarantine.quarantineRoot);
    if (!cleaned) {
      cleanupPending.push(taskId);
      scheduleQuarantineCleanup(quarantine.quarantineRoot);
    }
  }
  return { action: 'PERMANENT_DELETE', succeeded: result.succeeded, failed: result.failed, cleanupPending };
}

async function assertTaskAccess(ctx, repository, { ownerOnly = false, summaryOnly = false } = {}) {
  const actor = requestActor(ctx);
  const readTask = summaryOnly && typeof repository.getTaskAccess === 'function' ? repository.getTaskAccess : repository.getTask;
  if (typeof readTask !== 'function') return { actor, task: null };
  const task = await readTask.call(repository, ctx.params.taskId);
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  if ((ownerOnly || actor.role === 'USER') && task.createdByUserId !== actor.username) {
    throw new HttpError(403, 'FORBIDDEN', 'current user cannot access this task');
  }
  return { actor, task };
}

function installRoutes(router, repository, storageRoot, analyzeCopy, analyzeVisual) {
  const deliverAsset = createAssetDelivery({ storageRoot });
  const passwordLimiters = new Map();
  function passwordLimiter(username) {
    const existing = passwordLimiters.get(username);
    if (existing) {
      passwordLimiters.delete(username);
      passwordLimiters.set(username, existing);
      return existing;
    }
    if (passwordLimiters.size >= 100) passwordLimiters.delete(passwordLimiters.keys().next().value);
    const limiter = new LoginRateLimiter();
    passwordLimiters.set(username, limiter);
    return limiter;
  }
  function assertPasswordAttemptAllowed(ctx, limiter) {
    const status = limiter.check();
    if (status.allowed) return;
    ctx.set('Retry-After', String(status.retryAfterSeconds));
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '密码尝试过多，请稍后再试');
  }
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
  router.post('/v1/profile/deletion-password', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const limiter = passwordLimiter(actor.username);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.setOwnDeletionPassword(actor.username, requireJson(ctx));
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'CURRENT_PASSWORD_INVALID') limiter.recordFailure();
      else limiter.reset();
      throw error;
    }
  });
  router.put('/v1/executions/:executionId/model-calls/:callId', async (ctx) => {
    json(ctx, 200, await repository.recordModelCall(ctx.params.executionId, ctx.params.callId, requireJson(ctx)));
  });
  router.get('/v1/tasks/:taskId/model-calls', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.listModelCalls(ctx.params.taskId, { limit: ctx.query.limit, offset: ctx.query.offset }));
  });
  router.get('/v1/tasks/:taskId/model-calls/:callId', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
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
  router.get('/v1/executor-statuses', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listNodes());
  });
  router.post('/v1/tasks', async (ctx) => {
    const actor = requestActor(ctx);
    const body = requireJson(ctx);
    const { skipCopyReview = false } = body;
    if (typeof skipCopyReview !== 'boolean') throw new TypeError('skipCopyReview must be a boolean');
    if (skipCopyReview) requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createTasks({
      nodeId: body.nodeId,
      createdByUserId: actor.username,
      skipCopyReview,
      tasks: body.tasks,
    }));
  });
  router.get('/v1/tasks', async (ctx) => {
    const actor = requestActor(ctx);
    if (ctx.query.createdByRole !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.attention !== undefined) requestActor(ctx, ['ADMIN']);
    const createdByRole = normalizeTaskCreatorRole(ctx.query.createdByRole);
    json(ctx, 200, await repository.listTasks({
      state: ctx.query.state,
      states: ctx.query.states,
      nodeId: ctx.query.nodeId,
      createdByUserId: actor.role === 'USER' ? actor.username : ctx.query.createdByUserId,
      ...(createdByRole !== null ? { createdByRole } : {}),
      ...(ctx.query.taskId !== undefined ? { taskId: ctx.query.taskId } : {}),
      query: ctx.query.query,
      deduplicateQuery: ctx.query.deduplicateQuery === 'true',
      ...(ctx.query.attention !== undefined ? { attention: ctx.query.attention } : {}),
      ...(ctx.query.sortBy !== undefined ? { sortBy: ctx.query.sortBy } : {}),
      ...(ctx.query.sortOrder !== undefined ? { sortOrder: ctx.query.sortOrder } : {}),
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      includeTotal: ctx.query.includeTotal === 'true',
    }));
  });
  router.get('/v1/task-views', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listSavedTaskViews(actor.username));
  });
  router.post('/v1/task-views', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.saveTaskView(actor.username, requireJson(ctx)));
  });
  router.delete('/v1/task-views/:viewId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.deleteSavedTaskView(actor.username, ctx.params.viewId));
  });
  router.post('/v1/tasks/batch-actions', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 100);
    json(ctx, 200, await applyBatchTaskAction(repository, taskIds, String(body.action ?? '')));
  });
  router.post('/v1/tasks/batch-permanent-delete', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 20);
    const limiter = passwordLimiter(actor.username);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await applyBatchPermanentDeletion(
        repository,
        storageRoot,
        taskIds,
        actor.username,
        body.deletionPassword,
      );
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();
      else limiter.reset();
      throw error;
    }
  });
  router.post('/v1/tasks/batch-archive', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const taskIds = normalizedBatchTaskIds(requireJson(ctx).taskIds, 20);
    const tasks = await Promise.all(taskIds.map(async (taskId) => {
      const task = await repository.getTask(taskId);
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (!['MANUAL_ARCHIVE', 'REVIEWED'].includes(task.state)) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only manually archived tasks can be downloaded');
      }
      return task;
    }));
    const content = await buildBatchTaskArchive(tasks, async (task, assetId) => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return { ...asset, content: await readFile(path) };
    });
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', `attachment; filename="task-resources-batch.zip"; filename*=UTF-8''${encodeURIComponent('批量作业资源.zip')}`);
    ctx.body = content;
  });
  router.get('/v1/task-counts', async (ctx) => {
    json(ctx, 200, await repository.taskCounts({ nodeId: ctx.query.nodeId }));
  });
  router.get('/v1/tasks/:taskId', async (ctx) => {
    const { task, actor } = await assertTaskAccess(ctx, repository);
    // Execution snapshots include internal prompts and model configuration.
    const { executions, ...reviewableTask } = task;
    json(ctx, 200, actor.role === 'ADMIN' ? task : reviewableTask);
  });
  router.get('/v1/tasks/:taskId/archive', async (ctx) => {
    const { task } = await assertTaskAccess(ctx, repository);
    if (!['MANUAL_ARCHIVE', 'REVIEWED'].includes(task.state)) {
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
  router.post('/v1/executions/heartbeat', async (ctx) => {
    json(ctx, 200, await repository.heartbeatExecutions(requireJson(ctx)));
  });
  router.post('/v1/executions/claim-image', async (ctx) => {
    const body = requireJson(ctx);
    json(ctx, 200, await repository.claimImage(body.nodeId, body.imageControlsVersion, body.layoutCatalogVersion));
  });
  router.post('/v1/executions/claim-copy-batch', async (ctx) => {
    json(ctx, 200, await repository.claimCopyBatch(requireJson(ctx)));
  });
  router.post('/v1/executions/claim-image-batch', async (ctx) => {
    json(ctx, 200, await repository.claimImageBatch(requireJson(ctx)));
  });
  router.patch('/v1/executions/:executionId/progress', async (ctx) => {
    json(ctx, 200, await repository.updateProgress(ctx.params.executionId, requireJson(ctx)));
  });
  router.put('/v1/executions/:executionId/visual-plan', async (ctx) => {
    json(ctx, 200, await repository.saveVisualPlan(ctx.params.executionId, requireJson(ctx)));
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
    await assertTaskAccess(ctx, repository, { summaryOnly: true });
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    await deliverAsset(ctx, asset, path);
  });
  router.get('/v1/executions/:executionId/source-assets/:assetId', async (ctx) => {
    const asset = await repository.imageReprocessAsset(ctx.params.executionId, ctx.params.assetId);
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.type = asset.mediaType;
    ctx.body = await readFile(path);
  });

  router.post('/v1/tasks/:taskId/approve-copy', async (ctx) => {
    const access = await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.approveCopy(ctx.params.taskId, requireJson(ctx), { actorRole: access.actor.role }));
  });
  router.post('/v1/tasks/:taskId/review-images', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    await assertTaskAccess(ctx, repository);
    const { imageRunId, decision } = requireJson(ctx);
    json(ctx, 200, await repository.reviewImages(ctx.params.taskId, {
      imageRunId, decision, reviewerUserId: actor.username,
    }));
  });
  router.post('/v1/tasks/:taskId/retry', async (ctx) => {
    await assertTaskAccess(ctx, repository, { ownerOnly: requestActor(ctx).role !== 'ADMIN' });
    json(ctx, 200, await repository.retryTask(ctx.params.taskId, requireJson(ctx)));
  });
  router.post('/v1/tasks/:taskId/retry-image', async (ctx) => {
    await assertTaskAccess(ctx, repository, { ownerOnly: requestActor(ctx).role !== 'ADMIN' });
    json(ctx, 200, await repository.requeueImageTask(ctx.params.taskId));
  });
  router.post('/v1/tasks/:taskId/image-revisions', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 201, await repository.reviseImages(ctx.params.taskId, requireJson(ctx), actor.username, actor.role));
  });
  router.get('/v1/tasks/:taskId/image-capabilities', async (ctx) => {
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, { version: 1, formats: Object.keys(IMAGE_FORMATS) });
  });
  router.post('/v1/tasks/:taskId/cancel', async (ctx) => {
    await assertTaskAccess(ctx, repository, { ownerOnly: requestActor(ctx).role !== 'ADMIN' });
    json(ctx, 200, await repository.cancelTask(ctx.params.taskId));
  });
  router.post('/v1/tasks/:taskId/requeue', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.requeueCancelledTask(ctx.params.taskId));
  });
  router.delete('/v1/tasks/:taskId/permanent', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    const limiter = passwordLimiter(actor.username);
    assertPasswordAttemptAllowed(ctx, limiter);
    let quarantine = null;
    let deleted;
    try {
      deleted = await repository.permanentlyDeleteTask(ctx.params.taskId, {
        actorUsername: actor.username,
        deletionPassword: requireJson(ctx).deletionPassword,
        beforeDelete: async (taskId) => {
          quarantine = await quarantineTaskStorage(storageRoot, taskId);
        },
      });
      limiter.reset();
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();
      else limiter.reset();
      if (quarantine) {
        try { await quarantine.restore(); } catch (restoreError) {
          console.error('failed to restore quarantined task files', restoreError);
        }
      }
      throw error;
    }
    let cleaned = true;
    if (quarantine) {
      await quarantine.markCommitted().catch(error => console.error('failed to mark task deletion quarantine', error));
      cleaned = await removeQuarantine(quarantine.quarantineRoot);
      if (!cleaned) scheduleQuarantineCleanup(quarantine.quarantineRoot);
    }
    json(ctx, 200, { id: deleted.id, deleted: true, cleanupPending: !cleaned });
  });

  router.get('/v1/layout-catalog', async (ctx) => {
    requestActor(ctx, ['ADMIN']); json(ctx, 200, await repository.getLayoutCatalog());
  });
  router.post('/v1/layout-catalog', async (ctx) => {
    requestActor(ctx, ['ADMIN']); json(ctx, 200, await repository.updateLayoutCatalog(requireJson(ctx)));
  });
  router.post('/v1/layout-catalog/generate', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const controlPlane = { listPrompts: () => repository.listPrompts(), listSettings: () => repository.listSettings(), listKnowledge: () => repository.listKnowledge() };
    json(ctx, 201, await generateAndImportLayouts({ input: requireJson(ctx), outputRoot: storageRoot,
      configuration: await readPromptConfiguration({ controlPlane }), readCatalog: () => repository.getLayoutCatalog(), updateCatalog: (change, options) => repository.updateLayoutCatalog(change, options) }));
  });

  router.get('/v1/settings', async (ctx) => {
    // Existing executors have no user session. Startup only needs the provider;
    // full configuration is delivered later in their existing claim snapshot.
    if (!ctx.state.actor) {
      const records = await repository.listSettings();
      const agentProvider = records.find((record) => record.key === 'production')?.value?.modelApi?.agentProvider;
      return json(ctx, 200, [{ key: 'production', value: { modelApi: agentProvider ? { agentProvider } : {} } }]);
    }
    requestActor(ctx, ['ADMIN']); json(ctx, 200, await repository.listSettings());
  });
  router.put('/v1/settings/:key', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    if (ctx.params.key === 'prompt_runtime') {
      const controlPlane = { listPrompts: () => repository.listPrompts(), updateSetting: (key, value) => repository.upsertSetting(key, value) };
      json(ctx, 200, await savePromptPolicy(requireJson(ctx).value, { controlPlane }));
    } else json(ctx, 200, await repository.upsertSetting(ctx.params.key, requireJson(ctx).value));
  });
  router.get('/v1/prompts', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await repository.listPrompts()); });
  router.post('/v1/prompts/versions', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 201, await repository.createPromptVersion({ ...body, content: normalizePromptContent(body.content) }));
  });
  router.post('/v1/prompt-versions/:versionId/publish', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const templates = await repository.listPrompts();
    const template = templates.find((item) => item.versions.some((version) => Number(version.id) === Number(ctx.params.versionId)));
    const version = template?.versions.find((item) => Number(item.id) === Number(ctx.params.versionId));
    if (version) assertPromptPublishable(template.kind, version.content);
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
    json(ctx, 201, await withPromptExecution({ outputRoot: storageRoot, configuration: { source: 'CENTER_ANALYSIS_TEMPLATE', promptRuntime: null },
      kind: 'COPY_ANALYSIS' }, () => analyzeCopy({ repository, input: requireJson(ctx) })));
  });
  router.post('/v1/visual-knowledge/analyze', async (ctx) => {
    requestActor(ctx, ['ADMIN', 'REVIEWER']);
    const body = requireJson(ctx);
    if (typeof body.imageBase64 !== 'string' || body.imageBase64.length > 14_000_000) throw new TypeError('图片输入无效');
    const controlPlane = { listPrompts: () => repository.listPrompts(), listSettings: () => repository.listSettings(), listKnowledge: () => repository.listKnowledge() };
    const configuration = await readPromptConfiguration({ controlPlane });
    const result = await withPromptExecution({ outputRoot: storageRoot, configuration, kind: 'VISUAL_ANALYSIS' }, () =>
      analyzeVisual({ buffer: Buffer.from(body.imageBase64, 'base64'), mimeType: body.mimeType, fileName: body.fileName,
        modelApi: configuration.productionSettings.modelApi }));
    json(ctx, 201, result);
  });
  router.get('/v1/prompt-runs', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, ctx.query.id ? await readPromptExecution(storageRoot, String(ctx.query.id)) : await listPromptExecutions(storageRoot));
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

export function createControlPlaneApp({ repository, storageRoot, enforceUserAuth = true, analyzeCopy = analyzeAndSaveExcellentCopy, analyzeVisual = analyzeVisualImage }) {
  if (!repository) throw new TypeError('repository is required');
  const resolvedStorageRoot = resolve(storageRoot);
  const app = new Koa();
  const router = new Router();
  const staleDeletionCleanup = cleanCommittedDeletionQuarantines(resolvedStorageRoot)
    .catch(error => console.error('failed to clean committed task deletion quarantine', error));

  app.use(async (ctx, next) => {
    await staleDeletionCleanup;
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
  installRoutes(router, repository, resolvedStorageRoot, analyzeCopy, analyzeVisual);
  app.use(async (ctx, next) => {
    const machineRoute = ctx.path.startsWith('/v1/executions/') || (ctx.path === '/v1/nodes' && ctx.method !== 'GET');
    if (machineRoute && ctx.state.actor && ctx.state.actor.role !== 'ADMIN') {
      throw new HttpError(403, 'FORBIDDEN', 'user sessions cannot use executor machine routes');
    }
    return next();
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
