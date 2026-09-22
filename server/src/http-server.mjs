import { getCopyQualityQueues } from './copy-quality-control.mjs';
import { loadWorkModePage } from './work-mode.mjs';
import { installSharedDeliveryRoutes } from './delivery-routes.mjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import Koa from 'koa';
import { importCopyKnowledgeLabels, listCopyAnalysisPrompts, retireKnowledge, saveCopyAnalysisPrompt } from './knowledge-admin.mjs';
import { analyzeAndSaveExcellentCopy, CopyAnalysisServiceError } from './deepseek-copy-analysis.mjs';
import {
  archiveFileName,
  buildBatchTaskArchive,
  buildTaskArchive,
  queryPackageFileNameSegment,
  writeBatchTaskArchive,
} from './task-archive.mjs';
import {
  assertDeliveryBindingsReady,
  assertReadyDeliveryTask,
  createDeliveryExportRegistry,
  DELIVERY_EXPORT_TTL_MS,
  loadReadyDeliveryTask,
  normalizeDeliveryExportRequest,
  resolveDeliveryExportTaskIds,
} from './delivery-export.mjs';
import { deliveryBatchCode } from './delivery-batches.mjs';
import {
  deliverySpreadsheetAssetIds,
  DELIVERY_SPREADSHEET_MEDIA_TYPE,
  MAX_DELIVERY_SPREADSHEET_TASKS,
  writeDeliverySpreadsheetExport,
} from './delivery-spreadsheet.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';
import { createImageEditingService } from './image-editing.mjs';
import { installStandaloneImageEditorRoutes } from './standalone-image-editor-routes.mjs';
import {
  addDeliveryPreviewUrls,
  createDeliveryPreviewUrlResolver,
  createPreviewServiceClient,
  DeliveryPreviewServiceError,
  drainDeliveryPreviewRevocations,
  publishDeliveryPreviews,
} from './delivery-preview.mjs';
import { AssetDeliveryError, createAssetDelivery } from './asset-delivery.mjs';
import { assertPromptEditable, normalizePromptContent } from '../../src/admin/prompt-service.mjs';
import { assertPromptPublishable } from '../../src/admin/prompt-preview.mjs';
import { readPromptConfiguration, savePromptPolicy } from '../../src/admin/prompt-runtime-service.mjs';
import { analyzeVisualImage } from '../../src/admin/visual-knowledge-service.mjs';
import { withPromptExecution, listPromptExecutions, readPromptExecution } from '../../src/admin/prompt-execution.mjs';
import { generateAndImportLayouts } from '../../src/admin/layout-catalog-service.mjs';
import { LoginRateLimiter } from '../../src/admin/auth.mjs';
import {
  parseQueryPackageSpreadsheet,
  QUERY_PACKAGE_SPREADSHEET_BYTES,
} from './query-package-spreadsheet.mjs';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskCreatorRole,
} from './domain.mjs';
import { UNASSIGNED_CREATOR_COPY_CONTROL_STATES } from './task-assignment-domain.mjs';

const JSON_BODY_LIMIT = 12 * 1024 * 1024;
const ASSET_BODY_LIMIT = 20 * 1024 * 1024;
const DELIVERY_IMAGE_MEDIA_TYPES = new Set(
  Object.values(IMAGE_FORMATS).map((format) => format.mediaType),
);

function validXhsSearchMachineToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return token.length >= 32 && token.length <= 512 ? token : null;
}

function machineTokenMatches(expected, received) {
  if (!expected || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length
    && timingSafeEqual(expectedBytes, receivedBytes);
}

class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function mappedError(error) {
  if (error?.code === 'CATALOG_CONFLICT') return new HttpError(409, error.code, error.message);
  if (error instanceof HttpError) return error;
  if (error instanceof AssetDeliveryError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof DeliveryPreviewServiceError) {
    return new HttpError(error.status, error.code, error.message, error.details);
  }
  if (error instanceof CopyAnalysisServiceError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof ControlPlaneAuthenticationError) {
    return new HttpError(401, error.code, error.message);
  }
  if (error instanceof ControlPlaneAuthorizationError) {
    return new HttpError(403, error.code, error.message);
  }
  if (error instanceof ControlPlaneNotFoundError) {
    return new HttpError(404, error.code, error.message);
  }
  if (error instanceof ControlPlaneConflictError) {
    return new HttpError(409, error.code, error.message, error.details);
  }
  if (error?.name === 'AbortError') {
    return new HttpError(499, 'REQUEST_CANCELLED', '请求已取消');
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

function accessRoute(ctx) {
  if (typeof ctx._matchedRoute === 'string' && ctx._matchedRoute) return ctx._matchedRoute;
  return ctx.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,35}(?=\/|$)/giu, '/:uuid')
    .replace(/\/\d+(?=\/|$)/gu, '/:id');
}

function accessIdentifier(value, pattern) {
  const text = String(value ?? '');
  return pattern.test(text) ? text : null;
}

function accessLogRecord(ctx, startedAt, errorCode = null) {
  const responseData = ctx.body?.data;
  const taskId = accessIdentifier(ctx.params?.taskId
    ?? ctx.path.match(/^\/v1\/tasks\/(\d+)(?:\/|$)/u)?.[1], /^[1-9]\d*$/u);
  const executionId = accessIdentifier(ctx.params?.executionId
    ?? ctx.path.match(/^\/v1\/executions\/([^/]+)(?:\/|$)/u)?.[1],
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  const rawStage = responseData?.currentStage ?? responseData?.stage ?? ctx.request.body?.stage;
  const stage = accessIdentifier(rawStage, /^[A-Z][A-Z0-9_]{0,63}$/u);
  return {
    timestamp: new Date().toISOString(),
    event: 'control_plane_access',
    requestId: ctx.state.requestId,
    method: ctx.method,
    route: accessRoute(ctx),
    status: ctx.status,
    durationMs: Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1_000_000),
    ...(errorCode ? { errorCode } : {}),
    ...(taskId ? { taskId: Number(taskId) } : {}),
    ...(executionId ? { executionId } : {}),
    ...(stage ? { stage } : {}),
    ...(ctx.state.actor ? {
      actorId: Number(ctx.state.actor.userId),
      actorRole: String(ctx.state.actor.role),
    } : {}),
  };
}

function requireJson(ctx) {
  if (!ctx.is('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }
  return ctx.request.body;
}

function imageEditExecutionIdentity(ctx) {
  return {
    executionId: ctx.params.executionId,
    editId: ctx.get('X-Image-Edit-Id'),
    leaseToken: ctx.get('X-Image-Edit-Lease'),
  };
}

function imageEditExecutorAsset(asset) {
  if(!asset||typeof asset!=='object')return asset;
  const {storage_path:_storagePath,...safe}=asset;
  return safe;
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
    const asset = await repository.recordAsset({
      executionId,
      mediaType,
      byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      storagePath,
      originalName: ctx.request.headers['x-file-name'] ?? null,
    });
    if (asset.reused) await rm(storagePath, { force: true });
    return asset;
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

function userVisibleTask(task, { includeXhsSearch = false } = {}) {
  const visible = { ...task };
  delete visible.sourceQueryPackageId;
  delete visible.sourceQueryPackageName;
  delete visible.sourceQueryPackageExternalId;
  delete visible.productionBatchId;
  delete visible.deliveryStatus;
  if (!includeXhsSearch) {
    delete visible.xiaohongshuSearchStatus;
    delete visible.xiaohongshuSearchBlockedReason;
    delete visible.xiaohongshuLinks;
  }
  return visible;
}

function userVisibleTaskList(result) {
  if (Array.isArray(result)) return result.map((task) => userVisibleTask(task));
  if (!result || typeof result !== 'object' || !Array.isArray(result.items)) return result;
  return { ...result, items: result.items.map((task) => userVisibleTask(task)) };
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

function initialPasswordRequestAllowed(ctx) {
  const matches = (path) => ctx.path === path || ctx.path === `${path}/`;
  if (matches('/v1/auth/login')) return ctx.method === 'POST';
  if (matches('/health')) return ['GET', 'HEAD'].includes(ctx.method);
  if (matches('/v1/profile')) return ['GET', 'HEAD'].includes(ctx.method);
  return matches('/v1/profile/password') && ctx.method === 'POST';
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

function assignmentTarget(body) {
  const assignedToUserId = body.assignedToUserId ?? null;
  const rawAccountId = body.assignedToAccountId ?? null;
  if (assignedToUserId === null) {
    if (rawAccountId !== null) throw new TypeError('assignedToAccountId requires assignedToUserId');
    return { assignedToUserId: null, assignedToAccountId: null };
  }
  const assignedToAccountId = Number(rawAccountId);
  if (!Number.isSafeInteger(assignedToAccountId) || assignedToAccountId < 1) {
    throw new TypeError('请选择有效的标注账号后重试');
  }
  return { assignedToUserId, assignedToAccountId };
}

function requiredAccountId(value, message = '请选择有效的标注账号后重试') {
  const accountId = Number(value);
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new TypeError(message);
  return accountId;
}

async function applyBatchTaskAction(repository, taskIds, action, actor) {
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
        await repository.cancelTask(taskId, { queuedOnly: true, actor });
      } else if (['COPY_RUNNING', 'COPY_FAILED'].includes(task.state)) {
        await repository.retryTask(taskId, { useLatestConfig: true, actor });
      } else if (['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)) {
        await repository.requeueImageTask(taskId, { retryOnly: true, actor });
      } else {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only running or failed work can be retried in bulk');
      }
      succeeded.push(taskId);
    } catch (error) {
      if (error instanceof ControlPlaneAuthenticationError) throw error;
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

async function applyBatchPermanentDeletion(repository, storageRoot, taskIds, actor, deletionPassword) {
  const quarantines = new Map();
  let result;
  try {
    result = await repository.permanentlyDeleteTasks(taskIds, {
      actor,
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

async function assertTaskAccess(ctx, repository, {
  ownerOnly = false,
  summaryOnly = false,
  allowCreatorRead = false,
  allowUnassignedCreatorStates = [],
} = {}) {
  const actor = requestActor(ctx);
  const readAccess = typeof repository.getTaskAccess === 'function'
    ? repository.getTaskAccess
    : repository.getTask;
  if (typeof readAccess !== 'function') return { actor, task: null };
  const accessTask = await readAccess.call(repository, ctx.params.taskId);
  if (!accessTask) throw new ControlPlaneNotFoundError('task not found');
  const authorize = (candidate) => {
    if(candidate.taskKind === 'STANDALONE_IMAGE_EDIT') throw new ControlPlaneNotFoundError('请从独立图片编辑入口访问');
    if (actor.role === 'REVIEWER' && candidate.activeBlindQa === true) {
      // A blind-QA task must be reachable only through its opaque QA assignment.
      // Return 404 so guessed task ids do not reveal membership.
      throw new HttpError(404, 'TASK_NOT_FOUND', 'task not found');
    }
    const assignedToUserId = Object.hasOwn(candidate, 'assignedToUserId')
      ? candidate.assignedToUserId
      : candidate.createdByUserId;
    // V3 authorization is account-bound. A username without its immutable
    // account id is insufficient because deleted names can be reused.
    const creatorAccountMatches = candidate.createdByAccountId === actor.userId;
    const creatorStateAllowed = allowUnassignedCreatorStates.includes(candidate.state)
      || (candidate.state === 'CANCELLED'
        && allowUnassignedCreatorStates.includes(candidate.cancelledFromState));
    const creatorRead = (allowCreatorRead || (assignedToUserId === null && creatorStateAllowed))
      && candidate.createdByUserId === actor.username
      && creatorAccountMatches;
    const assigneeRead = assignedToUserId === actor.username
      && candidate.assignedToAccountId === actor.userId;
    if (actor.role !== 'ADMIN' && assignedToUserId === null && !creatorRead) {
      throw new HttpError(403, 'FORBIDDEN', '未分配任务仅管理员可访问');
    }
    if ((ownerOnly || actor.role === 'USER') && !assigneeRead && !creatorRead) {
      throw new HttpError(403, 'FORBIDDEN', 'current user cannot access this task');
    }
  };
  authorize(accessTask);
  const task = !summaryOnly && readAccess !== repository.getTask && typeof repository.getTask === 'function'
    ? await repository.getTask(ctx.params.taskId)
    : accessTask;
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  if (!summaryOnly && readAccess !== repository.getTask) {
    const currentAccess = await readAccess.call(repository, ctx.params.taskId);
    if (!currentAccess) throw new ControlPlaneNotFoundError('task not found');
    authorize(currentAccess);
  }
  return { actor, task };
}

async function assertCurrentActorIdentity(repository, actor) {
  if (!actor) return;
  const current = typeof repository.getUserByIdentity === 'function'
    ? await repository.getUserByIdentity(actor)
    : typeof repository.getUserByUsername === 'function'
      ? await repository.getUserByUsername(actor.username)
      : null;
  if (typeof repository.getUserByIdentity !== 'function'
    && typeof repository.getUserByUsername !== 'function') return;
  if (!current || current.id !== actor.userId || current.username !== actor.username
    || current.role !== actor.role || current.status !== 'ACTIVE'
    || current.credentialVersion !== actor.credentialVersion) {
    throw new ControlPlaneAuthenticationError();
  }
}

async function assertOperatorDeliveryTaskAccess(repository, taskIds, actor) {
  if (actor.role === 'ADMIN') return;
  if (actor.role !== 'USER' || typeof repository.getTaskAccess !== 'function') {
    throw new ControlPlaneAuthorizationError('current role cannot create a delivery batch');
  }
  const tasks = await Promise.all(taskIds.map((taskId) => repository.getTaskAccess(taskId)));
  if (tasks.some((task) => !task
      || task.assignedToUserId !== actor.username
      || task.assignedToAccountId !== actor.userId)) {
    throw new ControlPlaneAuthorizationError('只能交付当前账号负责的作业');
  }
}

function lazyFileStream(path) {
  return Readable.from((async function* readWhenRequested() {
    const source = createReadStream(path);
    try {
      for await (const chunk of source) yield chunk;
    } finally {
      source.destroy();
    }
  })());
}

const DELIVERY_EXPORT_DIRECTORY = '.delivery-exports';
const DELIVERY_BATCH_DIRECTORY = '.delivery-batches';
const DELIVERY_EXPORT_STALE_MS = Math.max(60 * 60_000, DELIVERY_EXPORT_TTL_MS * 2);
const DELIVERY_EXPORT_SWEEP_MS = 15 * 60_000;
const DELIVERY_EXPORT_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function cleanStaleDeliveryExportDirectories(storageRoot, now = Date.now()) {
  const root = safeStoragePath(storageRoot, DELIVERY_EXPORT_DIRECTORY);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && DELIVERY_EXPORT_DIRECTORY_PATTERN.test(entry.name))
    .map(async (entry) => {
      const directory = safeStoragePath(root, entry.name);
      const artifacts = await Promise.all([
        safeStoragePath(directory, 'delivery-pool.zip'),
        safeStoragePath(directory, 'delivery-pool.xlsx'),
      ].map((path) => stat(path).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      })));
      const metadata = artifacts
        .filter(Boolean)
        .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
        ?? await stat(directory);
      if (now - metadata.mtimeMs < DELIVERY_EXPORT_STALE_MS) return;
      await rm(directory, { recursive: true, force: true });
    }));
}

async function stageDeliveryPoolArchive(repository, storageRoot, taskIds, { signal } = {}) {
  const exportDirectory = safeStoragePath(
    storageRoot,
    DELIVERY_EXPORT_DIRECTORY,
    randomUUID(),
  );
  const archivePath = safeStoragePath(exportDirectory, 'delivery-pool.zip');
  await mkdir(exportDirectory, { recursive: true });
  const bindings = [];
  try {
    async function* readyTasks() {
      for (const taskId of taskIds) {
        signal?.throwIfAborted();
        const snapshot = await loadReadyDeliveryTask(repository, taskId);
        bindings.push(snapshot.binding);
        yield snapshot.task;
      }
    }
    const output = createWriteStream(archivePath, { flags: 'wx', signal });
    const result = await writeBatchTaskArchive(readyTasks(), async (task, assetId) => {
      signal?.throwIfAborted();
      const asset = await repository.getAsset(assetId);
      signal?.throwIfAborted();
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      const metadata = await stat(path);
      signal?.throwIfAborted();
      if (!metadata.isFile()) return null;
      return { ...asset, content: lazyFileStream(path) };
    }, output, { maxTasks: Number.POSITIVE_INFINITY, signal });
    return {
      archivePath,
      byteSize: (await stat(archivePath)).size,
      taskCount: result.taskCount,
      bindings,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    };
  } catch (error) {
    await rm(exportDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function deliveryBatchArchivePath(storageRoot, publicId) {
  const id = String(publicId ?? '').toLowerCase();
  if (!DELIVERY_EXPORT_DIRECTORY_PATTERN.test(id)) {
    throw new ControlPlaneNotFoundError('delivery batch not found');
  }
  return safeStoragePath(storageRoot, DELIVERY_BATCH_DIRECTORY, `${id}.zip`);
}

async function persistDeliveryBatchArchive(storageRoot, staged, publicId) {
  const destination = deliveryBatchArchivePath(storageRoot, publicId);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(staged.archivePath, destination);
    const metadata = await stat(destination);
    if (!metadata.isFile() || metadata.size !== staged.byteSize) {
      throw new Error('persisted delivery batch archive is incomplete');
    }
    const sha256 = await fileSha256(destination);
    await staged.cleanup();
    return {
      ...staged,
      archivePath: destination,
      sha256,
      cleanup: async () => {},
      removePersistent: () => rm(destination, { force: true }),
    };
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    await staged.cleanup().catch(() => {});
    throw error;
  }
}

async function storedDeliveryBatchArtifact(repository, storageRoot, publicId, actor) {
  const batch = await repository.getDeliveryBatchArtifact(publicId, { actor });
  const archivePath = deliveryBatchArchivePath(storageRoot, batch.publicId);
  const metadata = await stat(archivePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata?.isFile() || metadata.size !== batch.byteSize) {
    throw new ControlPlaneConflictError(
      'DELIVERY_BATCH_ARCHIVE_MISSING',
      '该交付批次的历史文件缺失或不完整，请联系管理员检查文件存储',
    );
  }
  return { ...batch, archivePath };
}

function recordDeliveryBatchDownload(repository, publicId, actor) {
  void repository.recordDeliveryBatchDownload(publicId, { actor }).catch((error) => {
    console.error('failed to record delivery batch download', error);
  });
}

async function loadDeliverySpreadsheetAsset(
  repository,
  storageRoot,
  task,
  assetId,
  signal,
  cachedAsset,
) {
  signal?.throwIfAborted();
  const asset = cachedAsset ?? await repository.getAsset(assetId);
  signal?.throwIfAborted();
  const byteSize = Number(asset?.byteSize);
  const sha256 = String(asset?.sha256 ?? '').toLowerCase();
  if (!asset || Number(asset.id) !== Number(assetId)
      || Number(asset.taskId) !== Number(task.id)
      || !DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType))
      || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > ASSET_BODY_LIMIT
      || !/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
  const metadata = await stat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  signal?.throwIfAborted();
  if (!metadata?.isFile() || metadata.size !== byteSize) return null;
  const content = await readFile(path, { signal });
  signal?.throwIfAborted();
  if (createHash('sha256').update(content).digest('hex') !== sha256) return null;
  return { ...asset, content };
}

async function hydrateDeliverySpreadsheetAssetSizes(repository, tasks, signal) {
  const assets = new Map();
  for (const task of tasks) {
    for (const assetId of deliverySpreadsheetAssetIds(task)) {
      signal?.throwIfAborted();
      const asset = await repository.getAsset(assetId);
      signal?.throwIfAborted();
      const byteSize = Number(asset?.byteSize);
      if (!asset || Number(asset.id) !== Number(assetId)
          || Number(asset.taskId) !== Number(task.id)
          || !DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType))
          || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > ASSET_BODY_LIMIT) {
        throw new TypeError(`任务 ${task.id} 的交付图片缺失`);
      }
      const membership = task.assets?.find((candidate) =>
        Number(candidate.id) === Number(assetId)
          && String(candidate.imageRunId) === String(task.currentImageRunId));
      if (!membership) throw new TypeError(`任务 ${task.id} 的交付图片缺失`);
      membership.byteSize = byteSize;
      assets.set(Number(assetId), asset);
    }
  }
  return assets;
}

async function stageDeliveryPoolSpreadsheet(repository, storageRoot, taskIds, { signal } = {}) {
  if (taskIds.length > MAX_DELIVERY_SPREADSHEET_TASKS) {
    throw new ControlPlaneConflictError(
      'DELIVERY_SPREADSHEET_TOO_LARGE',
      `Excel 图片导出一次最多 ${MAX_DELIVERY_SPREADSHEET_TASKS} 篇文章，请勾选后分批导出`,
    );
  }
  const exportDirectory = safeStoragePath(
    storageRoot,
    DELIVERY_EXPORT_DIRECTORY,
    randomUUID(),
  );
  await mkdir(exportDirectory, { recursive: true });
  const bindings = [];
  try {
    const tasks = [];
    for (const taskId of taskIds) {
      signal?.throwIfAborted();
      const snapshot = await loadReadyDeliveryTask(repository, taskId);
      bindings.push(snapshot.binding);
      tasks.push(snapshot.task);
    }
    const assets = await hydrateDeliverySpreadsheetAssetSizes(repository, tasks, signal);
    const result = await writeDeliverySpreadsheetExport(
      tasks,
      (task, assetId) => loadDeliverySpreadsheetAsset(
        repository,
        storageRoot,
        task,
        assetId,
        signal,
        assets.get(Number(assetId)),
      ),
      exportDirectory,
      { signal, maxTasks: MAX_DELIVERY_SPREADSHEET_TASKS },
    );
    return {
      spreadsheetPath: result.artifactPath,
      mediaType: result.mediaType,
      fileExtension: result.fileExtension,
      partCount: result.partCount,
      byteSize: (await stat(result.artifactPath)).size,
      taskCount: result.taskCount,
      bindings,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    };
  } catch (error) {
    await rm(exportDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function stageDeliveryBatchSpreadsheet(
  repository,
  storageRoot,
  publicId,
  actor,
  { signal } = {},
) {
  if (typeof repository.getDeliveryBatchSpreadsheet !== 'function') {
    throw new ControlPlaneConflictError(
      'FINAL_DELIVERY_UNAVAILABLE',
      '中心服务尚未支持历史批次 Excel，请升级后重试',
    );
  }
  const snapshot = await repository.getDeliveryBatchSpreadsheet(publicId, { actor });
  if (!Array.isArray(snapshot?.tasks) || !Array.isArray(snapshot?.bindings)
      || snapshot.tasks.length !== snapshot.taskCount
      || snapshot.bindings.length !== snapshot.taskCount) {
    throw new ControlPlaneConflictError(
      'DELIVERY_BATCH_SOURCE_MISSING',
      '该历史批次的冻结数据不完整，无法生成 Excel',
    );
  }
  if (snapshot.taskCount > MAX_DELIVERY_SPREADSHEET_TASKS) {
    throw new ControlPlaneConflictError(
      'DELIVERY_SPREADSHEET_TOO_LARGE',
      `Excel 图片导出一次最多 ${MAX_DELIVERY_SPREADSHEET_TASKS} 篇文章`,
    );
  }
  const exportDirectory = safeStoragePath(
    storageRoot,
    DELIVERY_EXPORT_DIRECTORY,
    randomUUID(),
  );
  await mkdir(exportDirectory, { recursive: true });
  try {
    const assets = await hydrateDeliverySpreadsheetAssetSizes(
      repository,
      snapshot.tasks,
      signal,
    );
    const result = await writeDeliverySpreadsheetExport(
      snapshot.tasks,
      (task, assetId) => loadDeliverySpreadsheetAsset(
        repository,
        storageRoot,
        task,
        assetId,
        signal,
        assets.get(Number(assetId)),
      ),
      exportDirectory,
      { signal, maxTasks: MAX_DELIVERY_SPREADSHEET_TASKS },
    );
    return {
      spreadsheetPath: result.artifactPath,
      mediaType: result.mediaType,
      fileExtension: result.fileExtension,
      partCount: result.partCount,
      byteSize: (await stat(result.artifactPath)).size,
      taskCount: result.taskCount,
      bindings: snapshot.bindings,
      batch: snapshot,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    };
  } catch (error) {
    await rm(exportDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function assertDeliveryExportArtifact(record, pathKey) {
  if (typeof record?.staged?.[pathKey] !== 'string') {
    throw new ControlPlaneNotFoundError('delivery export not found');
  }
  return record;
}

function installRoutes(
  router,
  repository,
  storageRoot,
  analyzeCopy,
  analyzeVisual,
  previewClient,
  previewUrlResolver,
  xhsSearchMachineTokenConfigured,
) {
  const deliverAsset = createAssetDelivery({ storageRoot });
  installStandaloneImageEditorRoutes(router,repository,storageRoot,{requestActor,requireJson,json});
  const deliveryExportRegistry = createDeliveryExportRegistry();
  const disposeSharedDelivery = installSharedDeliveryRoutes(router, repository, storageRoot, {
    requestActor, requireJson, json, assertCurrentActorIdentity,
  });
  const initialDeliveryExportCleanup = cleanStaleDeliveryExportDirectories(storageRoot)
    .catch((error) => console.error('failed to clean stale delivery exports', error));
  const deliveryExportSweep = setInterval(() => {
    void cleanStaleDeliveryExportDirectories(storageRoot)
      .catch((error) => console.error('failed to clean stale delivery exports', error));
  }, DELIVERY_EXPORT_SWEEP_MS);
  deliveryExportSweep.unref?.();
  let revocationDrain = Promise.resolve();
  const drainRevocations = () => {
    revocationDrain = revocationDrain.then(() => drainDeliveryPreviewRevocations(
      repository,
      previewClient,
    )).catch((error) => console.error('failed to revoke withdrawn delivery previews', error));
    return revocationDrain;
  };
  const previewRevocationSweep = setInterval(() => { void drainRevocations(); }, 5_000);
  previewRevocationSweep.unref?.();
  void drainRevocations();
  const imageQualitySweep = setInterval(() => {
    void repository.flushExpiredImageQualityBatches?.()
      .catch((error) => console.error('failed to freeze expired image QA tails', error));
  }, 60_000);
  imageQualitySweep.unref?.();
  const passwordLimiters = new Map();
  const currentPasswordLimiters = new Map();
  function limiterFor(limiters, userId) {
    const existing = limiters.get(userId);
    if (existing) {
      limiters.delete(userId);
      limiters.set(userId, existing);
      return existing;
    }
    if (limiters.size >= 100) limiters.delete(limiters.keys().next().value);
    const limiter = new LoginRateLimiter();
    limiters.set(userId, limiter);
    return limiter;
  }
  const passwordLimiter = (userId) => limiterFor(passwordLimiters, userId);
  const currentPasswordLimiter = (userId) => limiterFor(currentPasswordLimiters, userId);
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
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createUser(requireJson(ctx), { actor }));
  });
  router.patch('/v1/users/:userId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateUser(ctx.params.userId, { ...requireJson(ctx), actorUsername: actor.username }, { actor }));
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
  router.get('/v1/auto-assignment', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getAutoAssignmentOverview());
  });
  router.patch('/v1/auto-assignment/settings', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.updateAutoAssignmentSettings({
      enabled: body.enabled,
      mode: body.mode,
      expectedVersion: body.expectedVersion,
      actor,
    }));
  });
  router.put('/v1/auto-assignment/workers/:username', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.putAutoAssignmentWorker(ctx.params.username, {
      status: body.status,
      assignmentLimit: body.assignmentLimit,
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor,
    }));
  });
  router.delete('/v1/auto-assignment/workers/:username', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.removeAutoAssignmentWorker(ctx.params.username, {
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor,
    }));
  });
  router.post('/v1/auto-assignment/workers/:username/allocate', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.allocateAutoAssignmentWorker(ctx.params.username, {
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor,
    }));
  });
  router.get('/v1/profile', async (ctx) => {
    const actor = requestActor(ctx);
    const readUser = repository.getUserByIdentity ?? repository.getUserByUsername;
    const user = repository.getUserByIdentity
      ? await readUser.call(repository, actor)
      : await readUser.call(repository, actor.username);
    if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    json(ctx, 200, user);
  });
  router.patch('/v1/profile', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.updateOwnProfile(actor, requireJson(ctx)));
  });
  router.post('/v1/profile/password', async (ctx) => {
    const actor = requestActor(ctx);
    const limiter = currentPasswordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.changeOwnPassword(actor, requireJson(ctx));
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'CURRENT_PASSWORD_INVALID') limiter.recordFailure();
      throw error;
    }
  });
  router.post('/v1/profile/deletion-password', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.setOwnDeletionPassword(actor, requireJson(ctx));
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
  router.get('/health', async (ctx) => json(ctx, 200, {
    ...await repository.health(),
    xhsSearchMachineTokenConfigured,
  }));

  router.get('/v1/workflow-quality-settings', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getWorkflowQualitySettings());
  });
  router.put('/v1/workflow-quality-settings', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateWorkflowQualitySettings(requireJson(ctx), { actor }));
  });
  router.get('/v1/query-packages', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listQueryPackages({ limit: ctx.query.limit, offset: ctx.query.offset }, { actor }));
  });
  router.post('/v1/query-packages', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createQueryPackage(requireJson(ctx), { actor }));
  });
  router.put('/v1/query-packages/import-preview', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
    if (mediaType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请上传 .xlsx 工作簿');
    }
    const body = await readBody(ctx.req, QUERY_PACKAGE_SPREADSHEET_BYTES);
    json(ctx, 200, await parseQueryPackageSpreadsheet(body, {
      sheet: ctx.query.sheet,
      column: ctx.query.column,
    }));
  });
  router.get('/v1/query-packages/:packageId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getQueryPackage(ctx.params.packageId, {
      actor,
      itemPage: {
        limit: ctx.query.itemLimit,
        cursor: ctx.query.itemCursor,
        filter: ctx.query.itemFilter,
        search: ctx.query.itemSearch,
      },
    }));
  });
  router.patch('/v1/query-packages/:packageId/assignee', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.assignQueryPackage(ctx.params.packageId, requireJson(ctx), { actor }));
  });
  router.get('/v1/query-packages/:packageId/item-assignment-summary', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getQueryPackageItemAssignmentSummary(ctx.params.packageId, { actor }));
  });
  router.put('/v1/query-packages/:packageId/item-assignments', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.assignQueryPackageItems(
      ctx.params.packageId, requireJson(ctx), { actor },
    ));
  });
  router.put('/v1/query-packages/:packageId/screening', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.updateQueryPackageScreening(ctx.params.packageId, requireJson(ctx), { actor }));
  });
  router.post('/v1/query-packages/:packageId/production-batches', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createQueryPackageProductionBatch(ctx.params.packageId, requireJson(ctx), { actor }));
  });
  router.post('/v1/query-packages/:packageId/abandon', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.abandonQueryPackage(ctx.params.packageId, requireJson(ctx), { actor }));
  });
  router.get('/v1/query-packages/:packageId/permanent-delete-preview', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.previewPermanentQueryPackageDeletion(ctx.params.packageId, { actor }));
  });
  router.delete('/v1/query-packages/:packageId/permanent', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.permanentlyDeleteQueryPackage(
        ctx.params.packageId, requireJson(ctx), { actor },
      );
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();
      else limiter.reset();
      throw error;
    }
  });
  router.get('/v1/production-batches/:batchId/copy-sampling-readiness', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.getProductionBatchSamplingReadiness(ctx.params.batchId, { actor }));
  });
  router.post('/v1/production-batches/:batchId/copy-sampling-freeze', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.freezeCopySamplingBatch(ctx.params.batchId, requireJson(ctx), { actor }));
  });
  router.get('/v1/copy-quality/queues', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await getCopyQualityQueues(repository.pool, actor));
  });
  router.get('/v1/copy-qa/statistics', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getCopyQaStatistics({ actor }));
  });
  router.get('/v1/copy-qa/reason-tags', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listCopyQaReasonTags({ actor }));
  });
  router.post('/v1/copy-qa/reason-tags', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 201, await repository.createCopyQaReasonTag(requireJson(ctx), { actor }));
  });
  router.patch('/v1/copy-qa/reason-tags/:tagId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.updateCopyQaReasonTag(
      ctx.params.tagId,
      requireJson(ctx),
      { actor },
    ));
  });
  router.get('/v1/copy-qa/items', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listCopyQaItems({
      status: ctx.query.status,
      taskId: ctx.query.taskId,
      queryPackageName: ctx.query.queryPackageName,
      personName: ctx.query.personName,
      limit: ctx.query.limit,
      offset: ctx.query.offset,
    }, { actor }));
  });
  for (const stage of ['COPY', 'IMAGE']) router.post(`/v1/${stage.toLowerCase()}-qa/items/:itemId/escalate`, async (ctx) => {
    const actor = requestActor(ctx, stage === 'COPY' ? ['ADMIN', 'REVIEWER', 'USER'] : ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.escalateQualityToAdmin(stage, ctx.params.itemId, requireJson(ctx), { actor, storageRoot }));
  });
  router.get('/v1/admin/reassignment-cases', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listReassignmentCases(ctx.query, { actor }));
  });
  router.get('/v1/admin/reassignment-cases/:caseId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getReassignmentCase(ctx.params.caseId, { actor }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/restore', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.restoreReassignmentCase(ctx.params.caseId, requireJson(ctx), { actor }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/regenerate', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.regenerateReassignmentBaseline(ctx.params.caseId, requireJson(ctx), { actor }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/reset', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retryReassignmentReset(ctx.params.caseId, requireJson(ctx), { actor, storageRoot }));
  });
  for (const operation of ['REASSIGN', 'DISCARD']) router.post(`/v1/admin/reassignment-cases/:caseId/${operation.toLowerCase()}`, async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.disposeReassignmentCase(ctx.params.caseId, requireJson(ctx), { actor, operation }));
  });
  router.get('/v1/copy-qa/items/:itemId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getCopyQaItem(ctx.params.itemId, { actor }));
  });
  router.post('/v1/copy-qa/items/:itemId/pass', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.passCopyQaItem(ctx.params.itemId, requireJson(ctx), { actor }));
  });
  router.post('/v1/copy-qa/items/:itemId/return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.returnCopyQaItem(ctx.params.itemId, requireJson(ctx), { actor }));
  });
  router.get('/v1/copy-qa/freezes/:freezePublicId/batch-return-preview', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getCopyQaBatchReturnPreview(ctx.params.freezePublicId, { actor }));
  });
  router.post('/v1/copy-qa/batch-return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.batchReturnCopyQa(requireJson(ctx), { actor }));
  });
  router.post('/v1/copy-qa/freezes/:freezePublicId/release-rest', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.releaseCopyQaFreeze(ctx.params.freezePublicId, requireJson(ctx), { actor }));
  });
  router.post('/v1/tasks/:taskId/copy-qa-return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.returnCopyQaItem(body.samplingItemId, body, {
      actor,
      expectedTaskId: ctx.params.taskId,
    }));
  });
  router.post('/v1/tasks/batch-copy-qa-return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.batchReturnCopyQa(requireJson(ctx), { actor }));
  });
  router.get('/v1/image-qa/items', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.listImageQaItems({
      status: ctx.query.status,
      personName: ctx.query.personName,
      limit: ctx.query.limit,
      offset: ctx.query.offset,
    }, { actor }));
  });
  router.get('/v1/image-qa/items/:itemId/assets/:assetId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    const asset = await repository.getImageQaAsset(ctx.params.itemId, ctx.params.assetId, { actor });
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    await deliverAsset(ctx, asset, path);
  });
  router.post('/v1/image-qa/items/:itemId/pass', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.passImageQaItem(ctx.params.itemId, requireJson(ctx), { actor }));
  });
  router.post('/v1/image-qa/items/:itemId/return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.returnImageQaItem(ctx.params.itemId, requireJson(ctx), { actor }));
  });
  router.get('/v1/image-qa/freezes/:freezePublicId/batch-return-preview', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.getImageQaBatchReturnPreview(ctx.params.freezePublicId, { actor }));
  });
  router.post('/v1/image-qa/batch-return', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.batchReturnImageQa(requireJson(ctx), { actor }));
  });
  router.post('/v1/image-qa/close-tail', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.closeImageSamplingTail(requireJson(ctx), { actor }));
  });

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
  router.get('/v1/xhs-search-statuses', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listXhsQuerySearchNodes());
  });
  router.delete('/v1/xhs-search-statuses', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retireXhsQuerySearchNode(requireJson(ctx).nodeId, actor));
  });
  router.delete('/v1/executor-statuses', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retireNode(requireJson(ctx).nodeId, actor));
  });
  router.post('/v1/tasks', async (ctx) => {
    // Ordinary workers must enter production through an assigned Query package
    // after screening. Keeping the legacy direct creator admin-only prevents a
    // disabled import switch from being bypassed with raw task payloads.
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const { skipCopyReview = false } = body;
    if (typeof skipCopyReview !== 'boolean') throw new TypeError('skipCopyReview must be a boolean');
    if (skipCopyReview) requestActor(ctx, ['ADMIN']);
    if (actor.role !== 'ADMIN' && (Object.hasOwn(body, 'assignedToUserId')
      || Object.hasOwn(body, 'assignedToAccountId'))) {
      throw new HttpError(403, 'FORBIDDEN', '仅管理员可以指定任务负责人');
    }
    let target = actor.role === 'ADMIN'
      ? assignmentTarget(body)
      : { assignedToUserId: null, assignedToAccountId: null };
    if (skipCopyReview && target.assignedToUserId === null) {
      throw new ControlPlaneConflictError(
        'SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED',
        '免人工文案审核的任务必须在创建时明确指定负责人',
      );
    }
    if (!skipCopyReview && target.assignedToUserId !== null) {
      throw new ControlPlaneConflictError(
        'TASK_NOT_READY_FOR_ASSIGNMENT',
        '普通任务将在文案生成完成后分配审核负责人',
      );
    }
    if (!skipCopyReview) target = { assignedToUserId: null, assignedToAccountId: null };
    json(ctx, 201, await repository.createTasks({
      nodeId: body.nodeId,
      createdByUserId: actor.username,
      actor,
      ...target,
      assignmentSource: target.assignedToUserId === null ? null : 'MANUAL',
      skipCopyReview,
      tasks: body.tasks,
    }));
  });
  router.get('/v1/personal-workspace/qa-activities',async(ctx)=>{
    ctx.set('Cache-Control','private, no-store');
    json(ctx,200,await repository.personalQualityActivity(requestActor(ctx),ctx.query));
  });
  for (const kind of ['statistics', 'tasks']) router.get(`/v1/personal-workspace/${kind}`, async (ctx) => {
    const actor = requestActor(ctx);
    if (actor.role === 'USER' && ctx.query.queryPackageName) throw new HttpError(403,'FORBIDDEN','标注不能按词包名称筛选任务');
    const result = await repository.personalWorkspace(actor, ctx.query, kind === 'statistics');
    ctx.set('Cache-Control','private, no-store');
    json(ctx,200,kind === 'tasks' && actor.role === 'USER' ? userVisibleTaskList(result) : result);
  });
  router.post('/v1/image-qa/items/:itemId/discard', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.discardImageQaItem(ctx.params.itemId, requireJson(ctx), { actor }));
  });
  router.get('/v1/admin/operator-performance', async (ctx) => {
    const actor=requestActor(ctx,['ADMIN']);
    ctx.set('Cache-Control','private, no-store');
    json(ctx,200,await repository.operatorPerformance(actor,ctx.query));
  });
  router.get('/v1/admin/operator-performance/tasks', async(ctx)=>{
    const actor=requestActor(ctx,['ADMIN']);
    ctx.set('Cache-Control','private, no-store');
    json(ctx,200,await repository.operatorPerformance(actor,ctx.query,{kind:'detail'}));
  });
  router.get('/v1/admin/operator-performance/export', async (ctx) => {
    const actor=requestActor(ctx,['ADMIN']);
    const result=await repository.operatorPerformance(actor,ctx.query,{kind:'export'});
    ctx.set('Cache-Control','private, no-store');
    ctx.set('Content-Disposition','attachment; filename="operator-performance.csv"');
    ctx.type='text/csv; charset=utf-8';ctx.body=result.csv;
  });
  for(const suffix of ['', '/tasks']) router.get(`/v1/admin/operator-performance/:accountId${suffix}`,async(ctx)=>{
    const actor=requestActor(ctx,['ADMIN']);
    ctx.set('Cache-Control','private, no-store');
    json(ctx,200,await repository.operatorPerformance(actor,ctx.query,{kind:'detail',accountId:ctx.params.accountId}));
  });
  router.get('/v1/task-completions', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.listPersonalTaskCompletions({
      accountId: actor.userId,
      username: actor.username,
      from: ctx.query.from,
      to: ctx.query.to,
    }));
  });
  router.get('/v1/work-mode/items', async (ctx) => {
    const actor = requestActor(ctx);
    json(ctx, 200, await loadWorkModePage(repository, {
      kind: ctx.query.kind, limit: ctx.query.limit, offset: ctx.query.offset,
      itemId: ctx.query.itemId,
    }, actor));
  });
  router.get('/v1/tasks', async (ctx) => {
    const actor = requestActor(ctx);
    if (actor.role === 'USER' && ctx.query.queryPackageName !== undefined) {
      throw new HttpError(403, 'FORBIDDEN', '标注不能按词包名称筛选任务');
    }
    const personal = ctx.query.personal === 'true';
    if (ctx.query.personal !== undefined && !['true', 'false'].includes(ctx.query.personal)) {
      throw new TypeError('personal must be true or false');
    }
    const personalScope = String(ctx.query.personalScope ?? 'ALL').toUpperCase();
    if (!['ALL', 'ASSIGNED', 'CREATED'].includes(personalScope)) {
      throw new TypeError('personalScope must be ALL, ASSIGNED or CREATED');
    }
    if (!personal && ctx.query.personalScope !== undefined) {
      throw new TypeError('personalScope requires personal=true');
    }
    if (ctx.query.lastPage !== undefined && !['true', 'false'].includes(ctx.query.lastPage)) {
      throw new TypeError('lastPage must be true or false');
    }
    if (ctx.query.copyQaReturned !== undefined && !['true', 'false'].includes(ctx.query.copyQaReturned)) {
      throw new TypeError('copyQaReturned must be true or false');
    }
    if (personal && ['assignedToUserId', 'assignedToAccountId', 'unassigned', 'createdByUserId', 'createdByAccountId', 'nodeId']
      .some((key) => ctx.query[key] !== undefined)) {
      throw new TypeError('personal task scope cannot be combined with ownership filters');
    }
    if (ctx.query.createdByRole !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.createdByAccountId !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.assignedToAccountId !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.attention !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.createdDateFrom !== undefined || ctx.query.createdDateTo !== undefined) {
      requestActor(ctx, ['ADMIN']);
    }
    if (ctx.query.unassigned !== undefined
      || (ctx.query.assignedToUserId !== undefined
        && actor.role !== 'ADMIN'
        && ctx.query.assignedToUserId !== actor.username)) {
      requestActor(ctx, ['ADMIN']);
    }
    const createdByRole = normalizeTaskCreatorRole(ctx.query.createdByRole);
    const result = await repository.listTasks({
      ...(actor.role === 'REVIEWER' ? { reviewAssignedToAccountId: actor.userId } : {}),
      state: ctx.query.state,
      states: ctx.query.states,
      nodeId: ctx.query.nodeId,
      createdByUserId: personalScope === 'CREATED' ? actor.username : ctx.query.createdByUserId,
      createdByAccountId: personalScope === 'CREATED' ? actor.userId : ctx.query.createdByAccountId,
      assignedToUserId: personalScope === 'ASSIGNED'
        ? actor.username : personal ? undefined : actor.role === 'USER' ? actor.username : ctx.query.assignedToUserId,
      assignedToAccountId: personalScope === 'ASSIGNED'
        ? actor.userId : personal ? undefined : actor.role === 'USER' ? actor.userId : ctx.query.assignedToAccountId,
      visibleToUserId: personal && personalScope === 'ALL' ? actor.username : undefined,
      visibleToAccountId: personal && personalScope === 'ALL' ? actor.userId : undefined,
      unassignedOnly: !personal && actor.role === 'ADMIN' && ctx.query.unassigned === 'true',
      excludeUnassigned: actor.role !== 'ADMIN' && !personal,
      ...(createdByRole !== null ? { createdByRole } : {}),
      ...(ctx.query.createdDateFrom !== undefined ? { createdDateFrom: ctx.query.createdDateFrom } : {}),
      ...(ctx.query.createdDateTo !== undefined ? { createdDateTo: ctx.query.createdDateTo } : {}),
      ...(ctx.query.taskId !== undefined ? { taskId: ctx.query.taskId } : {}),
      query: ctx.query.query,
      queryPackageName: ctx.query.queryPackageName,
      deduplicateQuery: ctx.query.deduplicateQuery === 'true',
      ...(ctx.query.attention !== undefined ? { attention: ctx.query.attention } : {}),
      ...(ctx.query.priorityMode !== undefined ? { priorityMode: ctx.query.priorityMode } : {}),
      ...(ctx.query.sortBy !== undefined ? { sortBy: ctx.query.sortBy } : {}),
      ...(ctx.query.sortOrder !== undefined ? { sortOrder: ctx.query.sortOrder } : {}),
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      cursor: ctx.query.cursor,
      lastPage: ctx.query.lastPage === 'true',
      includeTotal: ctx.query.includeTotal === 'true',
      excludeActiveBlindQa: actor.role === 'REVIEWER',
      ...(ctx.query.copyQaReturned === 'true' ? { copyQaReturnedOnly: true } : {}),
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTaskList(result) : result);
  });
  router.post('/v1/tasks/duplicate-query-discard-preview', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.previewDuplicateQueryDiscard(requireJson(ctx), { actor }));
  });
  router.post('/v1/tasks/duplicate-query-discard', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.discardDuplicateQueries(requireJson(ctx), { actor }));
  });
  router.get('/v1/task-views', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listSavedTaskViews(actor.username));
  });
  router.post('/v1/task-views', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.saveTaskView(actor.username, requireJson(ctx), { actor }));
  });
  router.delete('/v1/task-views/:viewId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.deleteSavedTaskView(actor.username, ctx.params.viewId, { actor }));
  });
  router.post('/v1/tasks/priority-scope', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getPriorityScope(requireJson(ctx), { actor }));
  });
  router.post('/v1/tasks/priority', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.setTaskPriority(requireJson(ctx), { actor }));
  });
  router.get('/v1/tasks/:taskId/priority-audit', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getTaskPriorityAudit(ctx.params.taskId, { actor }));
  });
  router.post('/v1/tasks/batch-actions', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 100);
    json(ctx, 200, await applyBatchTaskAction(repository, taskIds, String(body.action ?? ''), actor));
  });
  router.post('/v1/tasks/batch-assignee', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 100);
    const target = assignmentTarget(body);
    json(ctx, 200, await repository.assignTasks(taskIds, {
      ...target,
      actor,
      reason: body.reason,
    }));
  });
  router.post('/v1/tasks/batch-permanent-delete', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 20);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await applyBatchPermanentDeletion(
        repository,
        storageRoot,
        taskIds,
        actor,
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
    const actor = requestActor(ctx, ['ADMIN']);
    const taskIds = normalizedBatchTaskIds(requireJson(ctx).taskIds, 20);
    const snapshots = await Promise.all(taskIds.map(async (taskId) => {
      const task = await repository.getTask(taskId);
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      const binding = await assertReadyDeliveryTask(repository, task);
      return { task, binding };
    }));
    const tasks = snapshots.map((snapshot) => snapshot.task);
    const content = await buildBatchTaskArchive(tasks, async (task, assetId) => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return { ...asset, content: await readFile(path) };
    });
    await assertDeliveryBindingsReady(repository, snapshots.map((snapshot) => snapshot.binding));
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', `attachment; filename="task-resources-batch.zip"; filename*=UTF-8''${encodeURIComponent('批量作业资源.zip')}`);
    ctx.body = content;
  });
  router.post('/v1/delivery-pool/archive', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const request = normalizeDeliveryExportRequest(requireJson(ctx));
    if (actor.role === 'USER' && request.scope !== 'SELECTED') {
      throw new ControlPlaneAuthorizationError('标注只能打包明确选中的本人作业');
    }
    const controller = new AbortController();
    const cancellation = () => new DOMException(
      'delivery export client disconnected',
      'AbortError',
    );
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(
        actor,
        (reason) => controller.abort(reason),
      );
      await initialDeliveryExportCleanup;
      const batchHistoryEnabled = typeof repository.createDeliveryBatch === 'function'
        && typeof repository.getDeliveryBatchArtifact === 'function'
        && typeof repository.recordDeliveryBatchDownload === 'function';
      if (actor.role === 'USER' && !batchHistoryEnabled) {
        throw new ControlPlaneConflictError(
          'FINAL_DELIVERY_UNAVAILABLE',
          '中心服务尚未支持标注交付留痕，请升级后重试',
        );
      }
      const taskIds = await resolveDeliveryExportTaskIds(repository, request, actor, {
        unpackedOnly: batchHistoryEnabled,
      });
      await assertOperatorDeliveryTaskAccess(repository, taskIds, actor);
      staged = await stageDeliveryPoolArchive(repository, storageRoot, taskIds, {
        signal: controller.signal,
      });
      const expectedBindings = requireJson(ctx).expectedBindings;
      if (expectedBindings !== undefined) {
        if (!Array.isArray(expectedBindings) || expectedBindings.length !== staged.bindings.length
            || new Set(expectedBindings.map(binding => binding?.taskId)).size !== expectedBindings.length
            || expectedBindings.some(expected => !staged.bindings.some(binding => binding.taskId === expected?.taskId
              && binding.copyRevisionId === expected?.copyRevisionId && binding.imageRunId === expected?.imageRunId))) {
          throw new ControlPlaneConflictError('DELIVERY_VERSION_CHANGED', '所选内容版本已变化，请刷新后重新确认打包范围');
        }
      }
      await assertDeliveryBindingsReady(repository, staged.bindings);
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const batchPublicId = batchHistoryEnabled ? randomUUID() : null;
      const batchCode = batchPublicId ? deliveryBatchCode(batchPublicId) : null;
      const sourceFileName = request.scope === 'ALL_READY'
        ? '交付池-全部可交付项.zip'
        : request.scope === 'QUERY_PACKAGE'
          ? `${queryPackageFileNameSegment(request.queryPackageName)}-交付资源.zip`
          : request.scope === 'CLIENT_BATCH'
            ? `${queryPackageFileNameSegment(request.clientBatchCode)}-交付资源.zip`
          : '交付池-已选资源.zip';
      const fileName = batchCode ? `${batchCode}-${sourceFileName}` : sourceFileName;
      let deliveryBatch = null;
      if (batchPublicId) {
        const persisted = await persistDeliveryBatchArchive(storageRoot, staged, batchPublicId);
        staged = null;
        try {
          deliveryBatch = await repository.createDeliveryBatch({
            publicId: batchPublicId,
            scope: request.scope,
            ...(request.scope === 'QUERY_PACKAGE'
              ? { queryPackageName: request.queryPackageName }
              : {}),
            ...(request.scope === 'CLIENT_BATCH'
              ? { clientBatchCode: request.clientBatchCode }
              : {}),
            fileName,
            byteSize: persisted.byteSize,
            sha256: persisted.sha256,
            bindings: persisted.bindings,
          }, { actor });
        } catch (error) {
          await persisted.removePersistent().catch(() => {});
          throw error;
        }
        staged = persisted;
      }
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName,
        taskCount: staged.taskCount,
        bindings: staged.bindings,
        deliveryBatch,
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.head('/v1/delivery-pool/archive/:downloadId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const record = assertDeliveryExportArtifact(
      await deliveryExportRegistry.peek(ctx.params.downloadId, actor),
      'archivePath',
    );
    if (record.deliveryBatch) {
      await storedDeliveryBatchArtifact(repository, storageRoot, record.deliveryBatch.publicId, actor);
    } else {
      await assertDeliveryBindingsReady(repository, record.bindings);
    }
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-pool.zip"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
  });
  router.get('/v1/delivery-pool/archive/:downloadId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const { downloadId } = ctx.params;
    assertDeliveryExportArtifact(
      await deliveryExportRegistry.peek(downloadId, actor),
      'archivePath',
    );
    const record = await deliveryExportRegistry.take(downloadId, actor);
    try {
      if (record.deliveryBatch) {
        await storedDeliveryBatchArtifact(repository, storageRoot, record.deliveryBatch.publicId, actor);
      } else {
        await assertDeliveryBindingsReady(repository, record.bindings);
      }
      await assertCurrentActorIdentity(repository, actor);
      record.downloadSignal.throwIfAborted();
    } catch (error) {
      await deliveryExportRegistry.complete(downloadId, record);
      throw error;
    }
    const content = new Transform({
      transform(chunk, encoding, callback) {
        deliveryExportRegistry.touch(downloadId, record);
        callback(null, chunk);
      },
    });
    const source = createReadStream(record.staged.archivePath, { signal: record.downloadSignal });
    void pipeline(source, content, { signal: record.downloadSignal }).catch((error) => {
      if (!content.destroyed) content.destroy(error);
    });
    let cleanupStarted = false;
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) {
        record.downloadController.abort(
          new DOMException('delivery export client disconnected', 'AbortError'),
        );
      }
    };
    ctx.res.once('close', onResponseClosed);
    if (record.deliveryBatch) {
      ctx.res.once('finish', () => recordDeliveryBatchDownload(
        repository,
        record.deliveryBatch.publicId,
        actor,
      ));
    }
    content.once('close', () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      ctx.res.off('close', onResponseClosed);
      void deliveryExportRegistry.complete(downloadId, record).catch((error) => {
        console.error('failed to clean staged delivery export', error);
      });
    });
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-pool.zip"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
    ctx.body = content;
  });
  router.head('/v1/delivery-batches/:batchId/archive', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const batch = await storedDeliveryBatchArtifact(
      repository,
      storageRoot,
      ctx.params.batchId,
      actor,
    );
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = batch.byteSize;
    ctx.set('X-Delivery-Task-Count', String(batch.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-batch.zip"; filename*=UTF-8''${encodeURIComponent(batch.fileName)}`);
  });
  router.get('/v1/delivery-batches/:batchId/archive', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const batch = await storedDeliveryBatchArtifact(
      repository,
      storageRoot,
      ctx.params.batchId,
      actor,
    );
    await assertCurrentActorIdentity(repository, actor);
    ctx.res.once('finish', () => recordDeliveryBatchDownload(repository, batch.publicId, actor));
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = batch.byteSize;
    ctx.set('X-Delivery-Task-Count', String(batch.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-batch.zip"; filename*=UTF-8''${encodeURIComponent(batch.fileName)}`);
    ctx.body = createReadStream(batch.archivePath);
  });
  router.post('/v1/delivery-batches/:batchId/xlsx', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const controller = new AbortController();
    const cancellation = () => new DOMException(
      'delivery batch spreadsheet client disconnected',
      'AbortError',
    );
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(
        actor,
        (reason) => controller.abort(reason),
      );
      await initialDeliveryExportCleanup;
      staged = await stageDeliveryBatchSpreadsheet(
        repository,
        storageRoot,
        ctx.params.batchId,
        actor,
        { signal: controller.signal },
      );
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName: `${staged.batch.code}-交付内容${staged.fileExtension}`,
        taskCount: staged.taskCount,
        bindings: staged.bindings,
        validateBindings: false,
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.post('/v1/delivery-pool/xlsx', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const request = normalizeDeliveryExportRequest(requireJson(ctx));
    const controller = new AbortController();
    const cancellation = () => new DOMException(
      'delivery spreadsheet client disconnected',
      'AbortError',
    );
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(
        actor,
        (reason) => controller.abort(reason),
      );
      await initialDeliveryExportCleanup;
      const taskIds = await resolveDeliveryExportTaskIds(repository, request, actor);
      staged = await stageDeliveryPoolSpreadsheet(repository, storageRoot, taskIds, {
        signal: controller.signal,
      });
      await assertDeliveryBindingsReady(repository, staged.bindings);
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const fileStem = request.scope === 'ALL_READY'
        ? '交付池-全部文章与图片'
        : request.scope === 'QUERY_PACKAGE'
          ? `${queryPackageFileNameSegment(request.queryPackageName)}-交付内容`
          : request.scope === 'CLIENT_BATCH'
            ? `${queryPackageFileNameSegment(request.clientBatchCode)}-交付内容`
          : '交付池-已选文章与图片';
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName: `${fileStem}${staged.fileExtension}`,
        taskCount: staged.taskCount,
        bindings: staged.bindings,
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.head('/v1/delivery-pool/xlsx/:downloadId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const record = assertDeliveryExportArtifact(
      await deliveryExportRegistry.peek(ctx.params.downloadId, actor),
      'spreadsheetPath',
    );
    if (record.validateBindings) {
      await assertDeliveryBindingsReady(repository, record.bindings);
    }
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = record.staged.mediaType ?? DELIVERY_SPREADSHEET_MEDIA_TYPE;
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('X-Delivery-Part-Count', String(record.staged.partCount ?? 1));
    const fallbackFileName = record.staged.fileExtension === '.zip'
      ? 'delivery-pool.zip'
      : 'delivery-pool.xlsx';
    ctx.set('Content-Disposition', `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
  });
  router.get('/v1/delivery-pool/xlsx/:downloadId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const { downloadId } = ctx.params;
    assertDeliveryExportArtifact(
      await deliveryExportRegistry.peek(downloadId, actor),
      'spreadsheetPath',
    );
    const record = await deliveryExportRegistry.take(downloadId, actor);
    try {
      if (record.validateBindings) {
        await assertDeliveryBindingsReady(repository, record.bindings);
      }
      await assertCurrentActorIdentity(repository, actor);
      record.downloadSignal.throwIfAborted();
    } catch (error) {
      await deliveryExportRegistry.complete(downloadId, record);
      throw error;
    }
    const content = new Transform({
      transform(chunk, encoding, callback) {
        deliveryExportRegistry.touch(downloadId, record);
        callback(null, chunk);
      },
    });
    const source = createReadStream(record.staged.spreadsheetPath, {
      signal: record.downloadSignal,
    });
    void pipeline(source, content, { signal: record.downloadSignal }).catch((error) => {
      if (!content.destroyed) content.destroy(error);
    });
    let cleanupStarted = false;
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) {
        record.downloadController.abort(
          new DOMException('delivery spreadsheet client disconnected', 'AbortError'),
        );
      }
    };
    ctx.res.once('close', onResponseClosed);
    content.once('close', () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      ctx.res.off('close', onResponseClosed);
      void deliveryExportRegistry.complete(downloadId, record).catch((error) => {
        console.error('failed to clean staged delivery spreadsheet', error);
      });
    });
    ctx.status = 200;
    ctx.type = record.staged.mediaType ?? DELIVERY_SPREADSHEET_MEDIA_TYPE;
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('X-Delivery-Part-Count', String(record.staged.partCount ?? 1));
    const fallbackFileName = record.staged.fileExtension === '.zip'
      ? 'delivery-pool.zip'
      : 'delivery-pool.xlsx';
    ctx.set('Content-Disposition', `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
    ctx.body = content;
  });
  router.get('/v1/task-counts', async (ctx) => {
    json(ctx, 200, await repository.taskCounts({ nodeId: ctx.query.nodeId }));
  });
  router.get('/v1/tasks/:taskId/copy-review-drafts', async (ctx) => {
    const { actor } = await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.listCopyReviewDrafts(ctx.params.taskId, { actor }));
  });
  router.post('/v1/tasks/:taskId/copy-review-drafts', async (ctx) => {
    const { actor } = await assertTaskAccess(ctx, repository);
    const result = await repository.saveCopyReviewDraft(
      ctx.params.taskId,
      requireJson(ctx),
      { actor },
    );
    json(ctx, result.created ? 201 : 200, result);
  });
  router.post('/v1/tasks/:taskId/regenerate-image-plan', async (ctx) => {
    const { actor } = await assertTaskAccess(ctx, repository);
    const result = await repository.createImagePlanRegeneration(
      ctx.params.taskId,
      requireJson(ctx),
      { actor },
    );
    json(ctx, result.created ? 202 : 200, result);
  });
  router.get('/v1/tasks/:taskId/regenerate-image-plan/:jobId', async (ctx) => {
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.getImagePlanRegeneration(ctx.params.taskId, ctx.params.jobId));
  });
  router.get('/v1/tasks/:taskId', async (ctx) => {
    const { task, actor } = await assertTaskAccess(ctx, repository, { allowCreatorRead: true });
    // Execution snapshots include internal prompts and model configuration.
    const { executions, ...reviewableTask } = task;
    json(ctx, 200, actor.role === 'ADMIN'
      ? task
      : actor.role === 'USER'
        ? userVisibleTask(reviewableTask, { includeXhsSearch: true })
        : reviewableTask);
  });
  router.patch('/v1/tasks/:taskId/assignee', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const target = assignmentTarget(body);
    json(ctx, 200, await repository.assignTask(ctx.params.taskId, {
      ...target,
      actor,
      reason: body.reason,
    }));
  });
  router.head('/v1/tasks/:taskId/archive', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const { task } = await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN',
    });
    await assertReadyDeliveryTask(repository, task);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', `attachment; filename="task-${task.id}-resources.zip"; filename*=UTF-8''${encodeURIComponent(archiveFileName(task))}`);
  });
  router.get('/v1/tasks/:taskId/archive', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const { task } = await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN',
    });
    const binding = await assertReadyDeliveryTask(repository, task);
    const content = await buildTaskArchive(task, async (assetId) => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return { ...asset, content: await readFile(path) };
    });
    await assertDeliveryBindingsReady(repository, [binding]);
    if (actor.role === 'USER') {
      await assertTaskAccess(ctx, repository, { ownerOnly: true, summaryOnly: true });
    }
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
    await repository.flushExpiredCopyQualityBatches?.();
    const body = requireJson(ctx);
    json(ctx, 200, await repository.claimImage(body.nodeId, body.imageControlsVersion,
      body.layoutCatalogVersion, body.imageEditExecutorVersion));
  });
  router.post('/v1/executions/claim-copy-batch', async (ctx) => {
    json(ctx, 200, await repository.claimCopyBatch(requireJson(ctx)));
  });
  router.post('/v1/executions/claim-image-batch', async (ctx) => {
    await repository.flushExpiredCopyQualityBatches?.();
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
  router.post('/v1/executions/:executionId/complete-image-plan-regeneration', async (ctx) => {
    json(ctx, 200, await repository.completeImagePlanRegeneration(
      ctx.params.executionId,
      requireJson(ctx).result,
    ));
  });
  router.post('/v1/executions/:executionId/fail-image-plan-regeneration', async (ctx) => {
    json(ctx, 200, await repository.failImagePlanRegeneration(
      ctx.params.executionId,
      requireJson(ctx).error,
    ));
  });
  router.post('/v1/executions/:executionId/complete-image', async (ctx) => {
    json(ctx, 200, await repository.completeImage(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/fail', async (ctx) => {
    const body = requireJson(ctx);
    json(ctx, 200, await repository.failExecution(ctx.params.executionId, body.error, { autoRetry: body.autoRetry }));
  });
  router.post('/v1/xhs-query-search/claim', async (ctx) => {
    json(ctx, 200, await repository.claimXhsQuerySearch(requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/complete', async (ctx) => {
    json(ctx, 200, await repository.completeXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/block', async (ctx) => {
    json(ctx, 200, await repository.blockXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/fail', async (ctx) => {
    json(ctx, 200, await repository.failXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/resume', async (ctx) => {
    json(ctx, 200, await repository.resumeXhsQuerySearch(requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/retry-failed', async (ctx) => {
    json(ctx, 200, await repository.retryFailedXhsQuerySearch(requireJson(ctx)));
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
    await assertTaskAccess(ctx, repository, { summaryOnly: true, allowCreatorRead: true });
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
    const task = await repository.approveCopy(ctx.params.taskId, requireJson(ctx), {
      actor: access.actor,
    });
    json(ctx, 200, access.actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/discard-returned-copy', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    const task = await repository.discardReturnedCopy(
      ctx.params.taskId,
      requireJson(ctx),
      { actor },
    );
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/admin-direct-copy-qa', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.adminDirectApproveCopyQa(
      ctx.params.taskId,
      requireJson(ctx),
      { actor },
    ));
  });
  router.post('/v1/tasks/:taskId/submit-image-self-review', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: true });
    json(ctx, 200, await repository.submitImageSelfReview(
      ctx.params.taskId,
      requireJson(ctx),
      { actor },
    ));
  });
  router.post('/v1/tasks/:taskId/review-images', async () => {
    throw new HttpError(410, 'IMAGE_REVIEW_MOVED', '图片初审已改由任务负责人提交；图片质检请在图片质检池处理');
  });
  router.post('/v1/tasks/:taskId/discard-images', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: true });
    json(ctx, 200, await repository.discardTaskImages(ctx.params.taskId, requireJson(ctx), { actor }));
  });
  router.post('/v1/tasks/:taskId/retry', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN',
      allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
    });
    const task = await repository.retryTask(ctx.params.taskId, { ...requireJson(ctx), actor });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/retry-image', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    const task = await repository.requeueImageTask(ctx.params.taskId, { actor });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/image-revisions', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    const task = await repository.reviseImages(
      ctx.params.taskId,
      requireJson(ctx),
      actor.username,
      actor.role,
      actor,
    );
    json(ctx, 201, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  const imageEditing = createImageEditingService({ pool: repository.pool, storageRoot });
  router.get('/v1/executions/:executionId/image-edit/context', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    const context=await imageEditing.executorContext(identity.executionId,identity.editId,identity.leaseToken);
    json(ctx,200,{...context,source:imageEditExecutorAsset(context.source),
      repairSource:imageEditExecutorAsset(context.repairSource),refs:context.refs.map(imageEditExecutorAsset)});
  });
  router.get('/v1/executions/:executionId/image-edit/assets/:assetId', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    const result=await imageEditing.executorAsset(identity.executionId,identity.editId,identity.leaseToken,ctx.params.assetId);
    ctx.type=result.asset.media_type;
    ctx.body=result.bytes;
  });
  router.get('/v1/executions/:executionId/image-edit/asset-metadata/:assetId', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    const result=await imageEditing.executorAsset(identity.executionId,identity.editId,identity.leaseToken,ctx.params.assetId);
    json(ctx,200,imageEditExecutorAsset(result.asset));
  });
  router.post('/v1/executions/:executionId/image-edit/heartbeat', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    json(ctx,200,{active:await imageEditing.heartbeatExecutor(identity.executionId,identity.editId,identity.leaseToken)});
  });
  router.post('/v1/executions/:executionId/image-edit/validation', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    json(ctx,200,await imageEditing.stageExecutorValidation(identity.executionId,identity.editId,
      identity.leaseToken,requireJson(ctx).validation));
  });
  router.put('/v1/executions/:executionId/image-edit/result', async ctx => {
    if(String(ctx.request.headers['content-type']??'').split(';')[0].trim()!=='image/png') {
      throw new HttpError(415,'UNSUPPORTED_MEDIA_TYPE','image edit result must be image/png');
    }
    const identity=imageEditExecutionIdentity(ctx);
    json(ctx,200,await imageEditing.completeExecutor(identity.executionId,identity.editId,
      identity.leaseToken,await readBody(ctx.req,ASSET_BODY_LIMIT)));
  });
  router.put('/v1/executions/:executionId/image-edit/rejected-result', async ctx => {
    if(String(ctx.request.headers['content-type']??'').split(';')[0].trim()!=='image/png') {
      throw new HttpError(415,'UNSUPPORTED_MEDIA_TYPE','rejected image edit result must be image/png');
    }
    const identity=imageEditExecutionIdentity(ctx);
    json(ctx,200,await imageEditing.rejectExecutor(identity.executionId,identity.editId,
      identity.leaseToken,await readBody(ctx.req,ASSET_BODY_LIMIT)));
  });
  router.post('/v1/executions/:executionId/image-edit/fail', async ctx => {
    const identity=imageEditExecutionIdentity(ctx);
    json(ctx,200,await imageEditing.failExecutor(identity.executionId,identity.editId,
      identity.leaseToken,requireJson(ctx)));
  });
  router.post('/v1/tasks/:taskId/image-edit-references', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 201, await imageEditing.upload(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.post('/v1/tasks/:taskId/image-edits', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 201, await imageEditing.create(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.get('/v1/tasks/:taskId/image-edits', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 200, await imageEditing.list(ctx.params.taskId, { pendingOnly: ctx.query.pending === 'true' }));
  });
  router.post('/v1/tasks/:taskId/image-edits/resolve-pending', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 200, await imageEditing.resolvePending(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.get('/v1/image-edits/:editId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const edit = await imageEditing.get(ctx.params.editId);
    ctx.params.taskId = String(edit.task_id);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 200, edit);
  });
  for (const action of ['queue', 'retry', 'apply-suggestion', 'cancel', 'accept', 'reject']) {
    router.post(`/v1/image-edits/:editId/${action}`, async ctx => {
      const actor = requestActor(ctx, ['ADMIN', 'USER']);
      const edit = await imageEditing.get(ctx.params.editId);
      ctx.params.taskId = String(edit.task_id);
      await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
      json(ctx, 200, await imageEditing.action(ctx.params.editId, action, requireJson(ctx), actor));
    });
  }
  router.post('/v1/tasks/:taskId/image-versions/:runId/restore', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, { ownerOnly: actor.role !== 'ADMIN' });
    json(ctx, 201, await imageEditing.create(ctx.params.taskId, {
      ...requireJson(ctx), operation: 'RESTORE', restoreRunId: ctx.params.runId,
    }, actor));
  });
  router.get('/v1/tasks/:taskId/image-capabilities', async (ctx) => {
    await assertTaskAccess(ctx, repository, { summaryOnly: true, allowCreatorRead: true });
    json(ctx, 200, { version: 1, reviewImagePlanEdits: true, formats: Object.keys(IMAGE_FORMATS) });
  });
  router.post('/v1/tasks/:taskId/cancel', async (ctx) => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN',
      allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
    });
    const task = await repository.cancelTask(ctx.params.taskId, { actor });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/restore', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.restoreCancelledTask(ctx.params.taskId, requireJson(ctx), { actor }));
  });
  router.post('/v1/tasks/:taskId/requeue', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.requeueCancelledTask(ctx.params.taskId, { actor }));
  });
  router.delete('/v1/tasks/:taskId/permanent', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    let quarantine = null;
    let deleted;
    try {
      deleted = await repository.permanentlyDeleteTask(ctx.params.taskId, {
        actor,
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

  router.get('/v1/human-quality-settings', async (ctx) => {
    requestActor(ctx);
    json(ctx, 200, await repository.getHumanQualitySettings());
  });

  router.get('/v1/delivery-pool', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const deliveryPool = await repository.listDeliveryPool({
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      includeTotal: ctx.query.includeTotal === 'true',
      ...(ctx.query.queryPackageName === undefined
        ? {} : { queryPackageName: ctx.query.queryPackageName }),
      ...(ctx.query.clientBatchCode === undefined
        ? {} : { clientBatchCode: ctx.query.clientBatchCode }),
      ...(ctx.query.packingState === undefined
        ? {} : { packingState: ctx.query.packingState }),
    }, { actor });
    json(ctx, 200, addDeliveryPreviewUrls(deliveryPool, previewUrlResolver));
  });
  router.get('/v1/delivery-batches', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    json(ctx, 200, await repository.listDeliveryBatches({
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      ...(ctx.query.status === undefined ? {} : { status: ctx.query.status }),
      ...(ctx.query.queryPackageName === undefined
        ? {} : { queryPackageName: ctx.query.queryPackageName }),
      ...(ctx.query.clientBatchCode === undefined
        ? {} : { clientBatchCode: ctx.query.clientBatchCode }),
    }, { actor }));
  });
  router.get('/v1/delivery-batches/:batchId', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    json(ctx, 200, await repository.getDeliveryBatch(ctx.params.batchId, { actor }));
  });
  router.post('/v1/delivery-batches/:batchId/confirm', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    if (typeof repository.confirmDeliveryBatch !== 'function') {
      throw new ControlPlaneConflictError(
        'FINAL_DELIVERY_UNAVAILABLE',
        '中心服务尚未支持确认交付，请升级后重试',
      );
    }
    await assertCurrentActorIdentity(repository, actor);
    json(ctx, 200, await repository.confirmDeliveryBatch(ctx.params.batchId, { actor }));
  });
  router.post('/v1/delivery-pool/previews', async (ctx) => {
    const actor = requestActor(ctx, ['ADMIN']);
    const controller = new AbortController();
    const cancel = () => controller.abort(
      new DOMException('delivery preview client disconnected', 'AbortError'),
    );
    ctx.req.once('aborted', cancel);
    try {
      json(ctx, 200, await publishDeliveryPreviews({
        repository,
        storageRoot,
        previewClient,
        input: requireJson(ctx),
        actor,
        signal: controller.signal,
      }));
    } finally {
      ctx.req.off('aborted', cancel);
    }
  });
  router.put('/v1/human-quality-settings', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateHumanQualitySettings(requireJson(ctx)));
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
    assertPromptEditable(body.kind, body.content);
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

  router.get('/v1/knowledge', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await repository.listKnowledge()); });
  router.get('/v1/knowledge/capabilities', (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, { workbenchVersion: 1 }); });
  router.get('/v1/copy-analysis-prompts', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await listCopyAnalysisPrompts(repository.pool)); });
  router.post('/v1/copy-analysis-prompts', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 201, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx))); });
  router.patch('/v1/copy-analysis-prompts/:id', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx), ctx.params.id)); });
  router.post('/v1/knowledge/labels/import', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await importCopyKnowledgeLabels(repository.pool, requireJson(ctx).labels)); });
  router.post('/v1/copy-knowledge/analyze', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const controlPlane = { listPrompts: () => repository.listPrompts(), listSettings: () => repository.listSettings(), listKnowledge: () => repository.listKnowledge() };
    const configuration = await readPromptConfiguration({ controlPlane });
    json(ctx, 201, await withPromptExecution({ outputRoot: storageRoot, configuration,
      kind: 'COPY_ANALYSIS' }, () => analyzeCopy({ repository, input: requireJson(ctx) })));
  });
  router.post('/v1/visual-knowledge/analyze', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
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
  router.post('/v1/knowledge/:id/retire', async (ctx) => { requestActor(ctx, ['ADMIN']); json(ctx, 200, await retireKnowledge(repository.pool, ctx.params.id)); });
  router.post('/v1/knowledge/versions', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
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
    requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await uploadKnowledgeAsset({
      ctx,
      repository,
      storageRoot,
      versionId: ctx.params.versionId,
    }));
  });
  router.get('/v1/knowledge-versions/:versionId/asset', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    const asset = await repository.getKnowledgeAsset(ctx.params.versionId);
    if (!asset) throw new ControlPlaneNotFoundError('knowledge asset not found');
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.status = 200;
    ctx.type = 'image/png';
    ctx.body = await readFile(path);
  });
  router.post('/v1/knowledge-versions/:versionId/publish', async (ctx) => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.publishKnowledgeVersion(ctx.params.versionId));
  });
  return async () => {
    clearInterval(deliveryExportSweep);
    clearInterval(previewRevocationSweep);
    clearInterval(imageQualitySweep);
    await revocationDrain;
    await deliveryExportRegistry.dispose();
    await disposeSharedDelivery();
  };
}

export function createControlPlaneApp({
  repository,
  storageRoot,
  enforceUserAuth = true,
  xhsSearchMachineToken = process.env.XHS_SEARCH_MACHINE_TOKEN,
  analyzeCopy = analyzeAndSaveExcellentCopy,
  analyzeVisual = analyzeVisualImage,
  previewClient = createPreviewServiceClient({
    baseUrl: process.env.PREVIEW_BASE_URL,
    apiKey: process.env.PREVIEW_API_KEY,
  }),
  previewUrlResolver = createDeliveryPreviewUrlResolver(process.env.PREVIEW_BASE_URL),
  logger = console,
}) {
  if (!repository) throw new TypeError('repository is required');
  const resolvedStorageRoot = resolve(storageRoot);
  const app = new Koa();
  const router = new Router();
  const staleDeletionCleanup = cleanCommittedDeletionQuarantines(resolvedStorageRoot)
    .catch(error => console.error('failed to clean committed task deletion quarantine', error));

  app.use(async (ctx, next) => {
    const startedAt = process.hrtime.bigint();
    let errorCode = null;
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
      errorCode = mapped.code;
      for (const header of ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
        ctx.remove(header);
      }
      ctx.set('Cache-Control', 'no-store');
      ctx.status = mapped.status;
      ctx.type = 'application/json';
      ctx.body = { error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      } };
    } finally {
      const line = JSON.stringify(accessLogRecord(ctx, startedAt, errorCode));
      if (ctx.status >= 500) logger.error?.(line);
      else logger.info?.(line);
    }
  });

  const parseImageEditorUpload = bodyParser({enableTypes:['json'],jsonLimit:36*1024*1024,parsedMethods:['POST']});
  const parseJsonBody = bodyParser({
    enableTypes: ['json'],
    jsonLimit: JSON_BODY_LIMIT,
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.use(async (ctx, next) => {
    const rawUpload = ctx.method === 'PUT'
      && (/^\/v1\/executions\/[^/]+\/assets$/u.test(ctx.path)
        || /^\/v1\/executions\/[^/]+\/image-edit\/result$/u.test(ctx.path)
        || /^\/v1\/knowledge-versions\/[^/]+\/asset$/u.test(ctx.path)
        || ctx.path === '/v1/query-packages/import-preview');
    if (rawUpload) return next();
    if (ctx.method==='POST' && ctx.path==='/v1/image-editor/workspaces') return parseImageEditorUpload(ctx,next);
    return parseJsonBody(ctx, next);
  });
  app.use(async (ctx, next) => {
    const username = String(ctx.get('X-Actor-Username') || '').trim().toLowerCase();
    if (!enforceUserAuth) {
      ctx.state.actor = {
        username: username || String(ctx.get('X-Task-Creator-Id') || 'admin'),
        role: 'ADMIN',
        userId: 1,
        credentialVersion: 1,
      };
      return next();
    }
    if (!username) return next();
    const rawUserId = String(ctx.get('X-Actor-User-Id') || '').trim();
    const actorUserId = /^[1-9]\d*$/u.test(rawUserId) ? Number(rawUserId) : NaN;
    const role = String(ctx.get('X-Actor-Role') || '').trim().toUpperCase();
    const credentialVersion = Number(ctx.get('X-Actor-Credential-Version'));
    const user = await repository.getUserByUsername(username).catch(() => null);
    if (!Number.isSafeInteger(actorUserId) || !user || user.id !== actorUserId
      || user.status !== 'ACTIVE' || user.role !== role
      || user.credentialVersion !== credentialVersion) {
      throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    }
    if (user.mustChangePassword && !initialPasswordRequestAllowed(ctx)) {
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', '必须先修改初始密码后才能使用其他功能');
    }
    ctx.state.actor = {
      username: user.username,
      role: user.role,
      userId: user.id,
      credentialVersion: user.credentialVersion,
    };
    await next();
    if (['GET', 'HEAD'].includes(ctx.method)) {
      await assertCurrentActorIdentity(repository, ctx.state.actor);
    }
  });
  const disposeRouteResources = installRoutes(
    router,
    repository,
    resolvedStorageRoot,
    analyzeCopy,
    analyzeVisual,
    previewClient,
    previewUrlResolver,
    validXhsSearchMachineToken(xhsSearchMachineToken) !== null,
  );
  app.context.disposeControlPlaneResources = disposeRouteResources;
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
    const machineRoute = ctx.path.startsWith('/v1/executions/')
      || xhsSearchMachineRoute
      || (ctx.path === '/v1/nodes' && ctx.method !== 'GET');
    if (machineRoute && ctx.state.actor && ctx.state.actor.role !== 'ADMIN') {
      throw new HttpError(403, 'FORBIDDEN', 'user sessions cannot use executor machine routes');
    }
    return next();
  });
  app.use(async (ctx,next)=>{
    if(ctx.state.actor && typeof repository.assertContentTaskIds==='function' && ctx.path.startsWith('/v1/tasks/')) {
      const match=/^\/v1\/tasks\/([1-9]\d*)(?:\/|$)/u.exec(ctx.path);
      const ids=match?[Number(match[1])]:Array.isArray(ctx.request.body?.taskIds)?ctx.request.body.taskIds:[];
      if(ids.length)await repository.assertContentTaskIds(ids);
    }
    return next();
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
