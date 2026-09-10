import { randomUUID } from 'node:crypto';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
} from './domain.mjs';

export const DELIVERY_EXPORT_SCOPES = Object.freeze({
  ALL_READY: 'ALL_READY',
  SELECTED: 'SELECTED',
});

export const MAX_SELECTED_DELIVERY_TASKS = 200;
export const DELIVERY_EXPORT_TTL_MS = 5 * 60_000;
export const DELIVERY_DOWNLOAD_IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAX_CONCURRENT_DELIVERY_EXPORTS = 2;

function selectedTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTED_DELIVERY_TASKS) {
    throw new RangeError(
      `taskIds must contain between 1 and ${MAX_SELECTED_DELIVERY_TASKS} items`,
    );
  }
  return [...new Set(value.map((entry) => normalizeTaskId(entry)))];
}

export function normalizeDeliveryExportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('delivery export request must be an object');
  }
  if (value.scope === DELIVERY_EXPORT_SCOPES.ALL_READY) {
    if (value.taskIds !== undefined) {
      throw new TypeError('ALL_READY export cannot include taskIds');
    }
    return { scope: DELIVERY_EXPORT_SCOPES.ALL_READY };
  }
  if (value.scope === DELIVERY_EXPORT_SCOPES.SELECTED) {
    return {
      scope: DELIVERY_EXPORT_SCOPES.SELECTED,
      taskIds: selectedTaskIds(value.taskIds),
    };
  }
  throw new TypeError('delivery export scope must be ALL_READY or SELECTED');
}

export async function resolveDeliveryExportTaskIds(repository, request, actor) {
  if (request.scope === DELIVERY_EXPORT_SCOPES.SELECTED) return request.taskIds;
  if (typeof repository.listAllDeliveryPoolTaskIds !== 'function') {
    throw new TypeError('delivery pool export is unavailable');
  }
  const ids = await repository.listAllDeliveryPoolTaskIds({ actor });
  if (!Array.isArray(ids)) throw new TypeError('delivery pool export snapshot is invalid');
  const taskIds = [...new Set(ids.map((entry) => normalizeTaskId(entry)))];
  if (taskIds.length === 0) {
    throw new ControlPlaneConflictError('DELIVERY_POOL_EMPTY', '交付池当前没有可导出的条目');
  }
  return taskIds;
}

function normalizedDeliveryBinding(value, taskId) {
  const copyRevisionId = Number(value?.copyRevisionId);
  const imageRunId = String(value?.imageRunId ?? '');
  if (!value || Number(value.taskId) !== taskId
      || !Number.isSafeInteger(copyRevisionId) || copyRevisionId < 1 || !imageRunId) {
    throw new ControlPlaneConflictError(
      'FINAL_DELIVERY_UNAVAILABLE',
      '中心服务无法确认交付版本，请升级中心服务后重试',
    );
  }
  return Object.freeze({ taskId, copyRevisionId, imageRunId });
}

async function currentDeliveryBinding(repository, taskId) {
  if (typeof repository.assertTaskReadyForDelivery !== 'function') {
    throw new ControlPlaneConflictError(
      'FINAL_DELIVERY_UNAVAILABLE',
      '中心服务无法确认交付版本，请升级中心服务后重试',
    );
  }
  return normalizedDeliveryBinding(await repository.assertTaskReadyForDelivery(taskId), taskId);
}

function assertMatchingBinding(task, binding) {
  if (Number(task.currentCopyRevisionId) !== binding.copyRevisionId
      || String(task.currentImageRunId ?? '') !== binding.imageRunId) {
    throw new ControlPlaneConflictError(
      'DELIVERY_VERSION_CHANGED',
      '交付版本已变化，请刷新交付池后重试',
    );
  }
}

export async function assertReadyDeliveryTask(repository, task) {
  if (task.state !== 'REVIEWED') {
    throw new ControlPlaneConflictError(
      'INVALID_TASK_STATE',
      '任务尚未通过图文终审并进入交付池，不能下载',
    );
  }
  const binding = await currentDeliveryBinding(repository, task.id);
  assertMatchingBinding(task, binding);
  return binding;
}

export async function loadReadyDeliveryTask(repository, taskId) {
  if (typeof repository.getTaskForDelivery === 'function') {
    const snapshot = await repository.getTaskForDelivery(taskId);
    if (snapshot) {
      const normalized = normalizedDeliveryBinding(snapshot.binding, normalizeTaskId(taskId));
      await assertReadyDeliveryTask({
        assertTaskReadyForDelivery: async () => normalized,
      }, snapshot.task);
      return { task: snapshot.task, binding: normalized };
    }
  }
  const task = await repository.getTask(taskId);
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  const binding = await assertReadyDeliveryTask(repository, task);
  return { task, binding };
}

export async function loadReadyDeliveryTasks(repository, taskIds) {
  const tasks = [];
  for (const taskId of taskIds) {
    tasks.push((await loadReadyDeliveryTask(repository, taskId)).task);
  }
  return tasks;
}

export async function assertDeliveryBindingsReady(repository, bindings) {
  if (typeof repository.assertTasksReadyForDelivery === 'function') {
    await repository.assertTasksReadyForDelivery(bindings);
    return;
  }
  if (bindings.length > 1) {
    throw new ControlPlaneConflictError(
      'FINAL_DELIVERY_UNAVAILABLE',
      '中心服务无法批量确认交付版本，请升级中心服务后重试',
    );
  }
  for (const expected of bindings) {
    const current = await currentDeliveryBinding(repository, normalizeTaskId(expected.taskId));
    if (current.copyRevisionId !== Number(expected.copyRevisionId)
        || current.imageRunId !== String(expected.imageRunId)) {
      throw new ControlPlaneConflictError(
        'DELIVERY_VERSION_CHANGED',
        '交付版本已变化，请刷新交付池后重试',
      );
    }
  }
}

function sameActor(left, right) {
  return left?.userId === right?.userId
    && left?.username === right?.username
    && left?.role === right?.role
    && left?.credentialVersion === right?.credentialVersion;
}

export function createDeliveryExportRegistry({
  ttlMs = DELIVERY_EXPORT_TTL_MS,
  downloadIdleTimeoutMs = DELIVERY_DOWNLOAD_IDLE_TIMEOUT_MS,
  now = () => Date.now(),
  maxConcurrentPreparations = MAX_CONCURRENT_DELIVERY_EXPORTS,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('delivery export ttl must be a positive integer');
  }
  if (!Number.isSafeInteger(maxConcurrentPreparations) || maxConcurrentPreparations < 1) {
    throw new RangeError('delivery export preparation limit must be a positive integer');
  }
  if (!Number.isSafeInteger(downloadIdleTimeoutMs) || downloadIdleTimeoutMs < 1) {
    throw new RangeError('delivery export idle timeout must be a positive integer');
  }
  const entries = new Map();
  const preparations = new Map();
  const pendingCleanups = new Set();
  let disposed = false;
  let disposePromise = null;

  function discard(record) {
    clearTimeout(record.timer);
    const cleanup = Promise.resolve().then(() => record.staged.cleanup());
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup)).catch(() => {});
    return cleanup;
  }

  function reportCleanupFailure(error) {
    console.error('failed to clean staged delivery export', error);
  }

  function expire(downloadId, record, reason) {
    if (entries.get(downloadId) !== record) return;
    entries.delete(downloadId);
    record.downloadController?.abort(reason);
    void discard(record).catch(reportCleanupFailure);
  }

  function armTimer(downloadId, record, delay, reason) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => expire(downloadId, record, reason), delay);
    record.timer.unref?.();
  }

  function preparedRecord(downloadId, actor) {
    const record = entries.get(String(downloadId));
    if (!record || record.state !== 'PREPARED' || !sameActor(record.actor, actor)) {
      throw new ControlPlaneNotFoundError('delivery export not found');
    }
    return record;
  }

  return Object.freeze({
    beginPreparation(actor, abort = () => {}) {
      if (disposed) {
        throw new ControlPlaneConflictError(
          'DELIVERY_EXPORT_UNAVAILABLE',
          '交付导出服务正在关闭，请稍后重试',
        );
      }
      const actorKey = String(actor?.userId ?? '');
      if (preparations.has(actorKey)
          || [...entries.values()].some((record) => record.actor.userId === actor?.userId)) {
        throw new ControlPlaneConflictError(
          'DELIVERY_EXPORT_IN_PROGRESS',
          '当前账号已有交付包正在准备或等待下载，请完成后再试',
        );
      }
      if (preparations.size + entries.size >= maxConcurrentPreparations) {
        throw new ControlPlaneConflictError(
          'DELIVERY_EXPORT_BUSY',
          '当前交付导出任务较多，请稍后再试',
        );
      }
      const marker = { abort };
      preparations.set(actorKey, marker);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (preparations.get(actorKey) === marker) preparations.delete(actorKey);
      };
    },

    issue(staged, actor, { fileName, taskCount, bindings }) {
      if (disposed) {
        throw new ControlPlaneConflictError(
          'DELIVERY_EXPORT_UNAVAILABLE',
          '交付导出服务正在关闭，请稍后重试',
        );
      }
      if (!Array.isArray(bindings) || bindings.length !== taskCount) {
        throw new TypeError('delivery export bindings must match the task count');
      }
      const downloadId = randomUUID();
      const expiresAtMs = now() + ttlMs;
      const record = {
        actor: { ...actor },
        staged,
        fileName,
        taskCount,
        bindings: bindings.map((binding) => ({ ...binding })),
        expiresAtMs,
        timer: null,
        state: 'PREPARED',
        downloadController: null,
      };
      armTimer(downloadId, record, ttlMs,
        new DOMException('delivery export token expired', 'AbortError'));
      entries.set(downloadId, record);
      return {
        downloadId,
        fileName,
        taskCount,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async peek(downloadId, actor) {
      const record = preparedRecord(downloadId, actor);
      if (record.expiresAtMs <= now()) {
        entries.delete(String(downloadId));
        await discard(record);
        throw new ControlPlaneNotFoundError('delivery export not found');
      }
      return record;
    },

    async take(downloadId, actor) {
      const record = preparedRecord(downloadId, actor);
      if (record.expiresAtMs <= now()) {
        entries.delete(String(downloadId));
        await discard(record);
        throw new ControlPlaneNotFoundError('delivery export not found');
      }
      clearTimeout(record.timer);
      record.state = 'ACTIVE';
      record.downloadController = new AbortController();
      record.downloadSignal = record.downloadController.signal;
      armTimer(String(downloadId), record, downloadIdleTimeoutMs,
        new DOMException('delivery export download made no progress', 'AbortError'));
      return record;
    },

    touch(downloadId, record) {
      const key = String(downloadId);
      if (entries.get(key) !== record || record.state !== 'ACTIVE') return false;
      armTimer(key, record, downloadIdleTimeoutMs,
        new DOMException('delivery export download made no progress', 'AbortError'));
      return true;
    },

    async complete(downloadId, record) {
      if (entries.get(String(downloadId)) !== record) return;
      entries.delete(String(downloadId));
      await discard(record);
    },

    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        for (const marker of preparations.values()) {
          try {
            marker.abort(new DOMException('control plane is shutting down', 'AbortError'));
          } catch {
            // Cancellation is best-effort; staged-file cleanup below remains authoritative.
          }
        }
        preparations.clear();
        const records = [...entries.values()];
        entries.clear();
        for (const record of records) {
          record.downloadController?.abort(
            new DOMException('control plane is shutting down', 'AbortError'),
          );
        }
        const cleanups = records.map(discard);
        const settled = await Promise.allSettled([...pendingCleanups, ...cleanups]);
        for (const result of settled) {
          if (result.status === 'rejected') reportCleanupFailure(result.reason);
        }
      })();
      return disposePromise;
    },
  });
}
