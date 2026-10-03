import { IMAGE_FORMATS } from './image-options.mjs';
import { timingSafeEqual } from 'node:crypto';
import { AssetDeliveryError } from './asset-delivery.mjs';
import { DeliveryPreviewServiceError } from './delivery-preview.mjs';
import { CopyAnalysisServiceError } from './deepseek-copy-analysis.mjs';
import { ControlPlaneAuthenticationError, ControlPlaneAuthorizationError, ControlPlaneNotFoundError, ControlPlaneConflictError } from './domain.mjs';
import { resolve, relative } from 'node:path';
import { canAdminDiscardTask } from '../../src/control-plane/task-discard.mjs';
export const JSON_BODY_LIMIT = 12 * 1024 * 1024;
export const ASSET_BODY_LIMIT = 20 * 1024 * 1024;
export const DELIVERY_IMAGE_MEDIA_TYPES = new Set(Object.values(IMAGE_FORMATS).map(format => format.mediaType));
export function validXhsSearchMachineToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return token.length >= 32 && token.length <= 512 ? token : null;
}
export function machineTokenMatches(expected, received) {
  if (!expected || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}
export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export function mappedError(error) {
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
export function accessRoute(ctx) {
  if (typeof ctx._matchedRoute === 'string' && ctx._matchedRoute) return ctx._matchedRoute;
  return ctx.path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,35}(?=\/|$)/giu, '/:uuid').replace(/\/\d+(?=\/|$)/gu, '/:id');
}
export function accessIdentifier(value, pattern) {
  const text = String(value ?? '');
  return pattern.test(text) ? text : null;
}
export function accessLogRecord(ctx, startedAt, errorCode = null) {
  const responseData = ctx.body?.data;
  const taskId = accessIdentifier(ctx.params?.taskId ?? ctx.path.match(/^\/v1\/tasks\/(\d+)(?:\/|$)/u)?.[1], /^[1-9]\d*$/u);
  const executionId = accessIdentifier(ctx.params?.executionId ?? ctx.path.match(/^\/v1\/executions\/([^/]+)(?:\/|$)/u)?.[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
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
    ...(errorCode ? {
      errorCode
    } : {}),
    ...(taskId ? {
      taskId: Number(taskId)
    } : {}),
    ...(executionId ? {
      executionId
    } : {}),
    ...(stage ? {
      stage
    } : {}),
    ...(ctx.state.actor ? {
      actorId: Number(ctx.state.actor.userId),
      actorRole: String(ctx.state.actor.role)
    } : {})
  };
}
export function requireJson(ctx) {
  if (!ctx.is('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }
  return ctx.request.body;
}
export function imageEditExecutionIdentity(ctx) {
  return {
    executionId: ctx.params.executionId,
    editId: ctx.get('X-Image-Edit-Id'),
    leaseToken: ctx.get('X-Image-Edit-Lease')
  };
}
export function imageEditExecutorAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const {
    storage_path: _storagePath,
    ...safe
  } = asset;
  return safe;
}
export async function readBody(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function safeStoragePath(storageRoot, ...segments) {
  const path = resolve(storageRoot, ...segments);
  const relation = relative(storageRoot, path);
  if (relation.startsWith('..') || relation.includes(':')) {
    throw new Error('resolved storage path escaped storage root');
  }
  return path;
}
export function json(ctx, status, data) {
  ctx.status = status;
  ctx.body = {
    data
  };
}
export async function streamPreparedArchive(ctx, prepare, validate, disposition) {
  const controller = new AbortController();
  let prepared;
  let stream;
  const aborted = () => controller.abort(new DOMException('Archive client disconnected', 'AbortError'));
  const detach = () => {
    ctx.req.off('aborted', aborted);
    ctx.res.off('close', closed);
  };
  const cleanup = () => {
    detach();
    void prepared?.dispose().catch(error => console.error('failed to dispose prepared archive', error));
  };
  const closed = () => {
    if (!ctx.res.writableEnded) aborted();
    cleanup();
  };
  ctx.req.once('aborted', aborted);
  ctx.res.once('close', closed);
  if (ctx.req.aborted || ctx.res.destroyed) aborted();
  try {
    prepared = await prepare(controller.signal);
    await validate();
    controller.signal.throwIfAborted();
    stream = await prepared.openStream();
    stream.once('close', cleanup);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', disposition);
    ctx.set('Content-Length', String(prepared.size));
    ctx.body = stream;
  } catch (error) {
    detach();
    stream?.destroy();
    await prepared?.dispose();
    throw error;
  }
}
export function userVisibleTask(task, {
  includeXhsSearch = false
} = {}) {
  const visible = {
    ...task
  };
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
export function userVisibleTaskList(result) {
  if (Array.isArray(result)) return result.map(task => userVisibleTask(task));
  if (!result || typeof result !== 'object' || !Array.isArray(result.items)) return result;
  return {
    ...result,
    items: result.items.map(task => userVisibleTask(task))
  };
}
export const APP_ROLES = Object.freeze(['ADMIN', 'REVIEWER', 'USER']);
export function requestActor(ctx, allowedRoles = APP_ROLES) {
  const actor = ctx.state.actor;
  if (!actor) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'authenticated user context is required');
  }
  if (!allowedRoles.includes(actor.role)) throw new HttpError(403, 'FORBIDDEN', 'current role cannot perform this operation');
  return actor;
}
export function initialPasswordRequestAllowed(ctx) {
  const matches = path => ctx.path === path || ctx.path === `${path}/`;
  if (matches('/v1/auth/login')) return ctx.method === 'POST';
  if (matches('/health')) return ['GET', 'HEAD'].includes(ctx.method);
  if (matches('/v1/profile')) return ['GET', 'HEAD'].includes(ctx.method);
  return matches('/v1/profile/password') && ctx.method === 'POST';
}
export function normalizedBatchTaskIds(value, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new RangeError(`taskIds must contain between 1 and ${max} items`);
  }
  const taskIds = [...new Set(value.map(entry => Number(entry)))];
  if (taskIds.some(taskId => !Number.isSafeInteger(taskId) || taskId < 1)) {
    throw new TypeError('taskIds must contain positive integers');
  }
  return taskIds;
}
export function assignmentTarget(body) {
  const assignedToUserId = body.assignedToUserId ?? null;
  const rawAccountId = body.assignedToAccountId ?? null;
  if (assignedToUserId === null) {
    if (rawAccountId !== null) throw new TypeError('assignedToAccountId requires assignedToUserId');
    return {
      assignedToUserId: null,
      assignedToAccountId: null
    };
  }
  const assignedToAccountId = Number(rawAccountId);
  if (!Number.isSafeInteger(assignedToAccountId) || assignedToAccountId < 1) {
    throw new TypeError('请选择有效的标注账号后重试');
  }
  return {
    assignedToUserId,
    assignedToAccountId
  };
}
export function requiredAccountId(value, message = '请选择有效的标注账号后重试') {
  const accountId = Number(value);
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new TypeError(message);
  return accountId;
}
export async function applyBatchTaskAction(repository, taskIds, action, actor) {
  if (!['RETRY', 'CANCEL_QUEUE', 'DISCARD'].includes(action)) throw new TypeError('batch task action is invalid');
  const succeeded = [];
  const failed = [];
  for (const taskId of taskIds) {
    try {
      const readSummary = repository.getTaskActionSummary ?? repository.getTask;
      const task = await readSummary.call(repository, taskId);
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (action === 'DISCARD') {
        if (!canAdminDiscardTask(task)) {
          throw new ControlPlaneConflictError('INVALID_TASK_STATE', '仅排队或普通待文案审核任务可批量废弃');
        }
        await repository.cancelTask(taskId, {
          adminDiscardOnly: true,
          actor
        });
      } else if (action === 'CANCEL_QUEUE') {
        if (!['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state)) {
          throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only queued work can be cancelled in bulk');
        }
        await repository.cancelTask(taskId, {
          queuedOnly: true,
          actor
        });
      } else if (['COPY_RUNNING', 'COPY_FAILED'].includes(task.state)) {
        await repository.retryTask(taskId, {
          useLatestConfig: true,
          actor
        });
      } else if (['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)) {
        await repository.requeueImageTask(taskId, {
          retryOnly: true,
          actor
        });
      } else {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only running or failed work can be retried in bulk');
      }
      succeeded.push(taskId);
    } catch (error) {
      if (error instanceof ControlPlaneAuthenticationError) throw error;
      const safe = mappedError(error);
      failed.push({
        id: taskId,
        code: safe.code,
        message: safe.message
      });
    }
  }
  return {
    action,
    succeeded,
    failed
  };
}
export async function assertTaskAccess(ctx, repository, {
  ownerOnly = false,
  summaryOnly = false,
  allowCreatorRead = false,
  allowUnassignedCreatorStates = [],
  historyMode = 'all'
} = {}) {
  const actor = requestActor(ctx);
  const readAccess = typeof repository.getTaskAccess === 'function' ? repository.getTaskAccess : repository.getTask;
  if (typeof readAccess !== 'function') return {
    actor,
    task: null
  };
  const accessTask = await readAccess.call(repository, ctx.params.taskId);
  if (!accessTask) throw new ControlPlaneNotFoundError('task not found');
  const authorize = candidate => {
    if (candidate.taskKind === 'STANDALONE_IMAGE_EDIT') throw new ControlPlaneNotFoundError('请从独立图片编辑入口访问');
    if (actor.role === 'REVIEWER' && candidate.activeBlindQa === true) {
      // A blind-QA task must be reachable only through its opaque QA assignment.
      // Return 404 so guessed task ids do not reveal membership.
      throw new HttpError(404, 'TASK_NOT_FOUND', 'task not found');
    }
    const assignedToUserId = Object.hasOwn(candidate, 'assignedToUserId') ? candidate.assignedToUserId : candidate.createdByUserId;
    // V3 authorization is account-bound. A username without its immutable
    // account id is insufficient because deleted names can be reused.
    const creatorAccountMatches = candidate.createdByAccountId === actor.userId;
    const creatorStateAllowed = allowUnassignedCreatorStates.includes(candidate.state) || candidate.state === 'CANCELLED' && allowUnassignedCreatorStates.includes(candidate.cancelledFromState);
    const creatorRead = (allowCreatorRead || assignedToUserId === null && creatorStateAllowed) && candidate.createdByUserId === actor.username && creatorAccountMatches;
    const assigneeRead = assignedToUserId === actor.username && candidate.assignedToAccountId === actor.userId;
    if (actor.role !== 'ADMIN' && assignedToUserId === null && !creatorRead) {
      throw new HttpError(403, 'FORBIDDEN', '未分配任务仅管理员可访问');
    }
    if ((ownerOnly || actor.role === 'USER') && !assigneeRead && !creatorRead) {
      throw new HttpError(403, 'FORBIDDEN', 'current user cannot access this task');
    }
  };
  authorize(accessTask);
  const task = !summaryOnly && readAccess !== repository.getTask && typeof repository.getTask === 'function' ? await repository.getTask(ctx.params.taskId, {
    historyMode
  }) : accessTask;
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  if (!summaryOnly && readAccess !== repository.getTask) {
    const currentAccess = await readAccess.call(repository, ctx.params.taskId);
    if (!currentAccess) throw new ControlPlaneNotFoundError('task not found');
    authorize(currentAccess);
  }
  return {
    actor,
    task
  };
}
export async function readAuthenticationUser(repository, readUser, identity) {
  try {
    return await readUser.call(repository, identity);
  } catch (error) {
    // A failed account lookup cannot establish that an existing session is stale.
    if (mappedError(error).status < 500) throw error;
    throw new HttpError(503, 'CONTROL_PLANE_UNAVAILABLE', '中心服务暂时不可用，请稍后重试');
  }
}
export async function assertCurrentActorIdentity(repository, actor) {
  if (!actor) return;
  const current = typeof repository.getUserByIdentity === 'function' ? await readAuthenticationUser(repository, repository.getUserByIdentity, actor) : typeof repository.getUserByUsername === 'function' ? await readAuthenticationUser(repository, repository.getUserByUsername, actor.username) : null;
  if (typeof repository.getUserByIdentity !== 'function' && typeof repository.getUserByUsername !== 'function') return;
  if (!current || current.id !== actor.userId || current.username !== actor.username || current.role !== actor.role || current.status !== 'ACTIVE' || current.credentialVersion !== actor.credentialVersion) {
    throw new ControlPlaneAuthenticationError();
  }
}
export async function assertOperatorDeliveryTaskAccess(repository, taskIds, actor) {
  if (actor.role === 'ADMIN') return;
  if (actor.role !== 'USER' || typeof repository.getTaskAccess !== 'function') {
    throw new ControlPlaneAuthorizationError('current role cannot create a delivery batch');
  }
  const tasks = await Promise.all(taskIds.map(taskId => repository.getTaskAccess(taskId)));
  if (tasks.some(task => !task || task.assignedToUserId !== actor.username || task.assignedToAccountId !== actor.userId)) {
    throw new ControlPlaneAuthorizationError('只能交付当前账号负责的作业');
  }
}
