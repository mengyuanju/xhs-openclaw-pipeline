import { randomUUID } from 'node:crypto';
import { normalizeNodeId } from './domain.mjs';
import { subscribeExecutionWorkChanges } from './task-list-facts.mjs';

export const EXECUTION_WORK_NOTIFICATIONS_VERSION = 1;
export const EXECUTION_WORK_WAIT_MAX_MS = 20_000;
const PROGRESS_FIELDS = new Set(['progress_percent', 'progress_message', 'progress_details', 'current_stage', 'last_activity_at', 'updated_at']);

export class ExecutionWorkWaitError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function affectsClaim(change) {
  // Unknown/complex writes are conservatively useful. Display-only progress
  // does not change claim eligibility; settings refresh also wakes executors.
  return !change || change.table !== 'tasks' || !change.fields?.length
    || change.fields.some(field => !PROGRESS_FIELDS.has(field));
}

function cursor(input) {
  const nodeId = normalizeNodeId(input?.nodeId);
  const first = input.epoch == null && (input.revision == null || input.revision === 0);
  if (!first && (typeof input.epoch !== 'string' || !input.epoch.length || input.epoch.length > 100
    || !Number.isSafeInteger(input.revision) || input.revision < 0)) throw new TypeError('work notification cursor is invalid');
  const timeoutMs = input.timeoutMs ?? EXECUTION_WORK_WAIT_MAX_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('work notification timeout is invalid');
  return { nodeId, first, epoch: input.epoch, revision: input.revision, timeoutMs: Math.min(timeoutMs, EXECUTION_WORK_WAIT_MAX_MS) };
}

/** Lightweight, single-center notifications. A bounded timeout also checks
 * work written outside this process; notification responses contain no tasks. */
export function createExecutionWorkNotifications({ pool, epoch = randomUUID(), maxWaiters = 256 } = {}) {
  if (!pool || !Number.isSafeInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 256) throw new TypeError('work notification options are invalid');
  let revision = 0, settingsRevision = 0, stopped = false;
  const waiters = new Map();
  const snapshot = (changed = false, timedOut = false) => ({ epoch, revision, settingsRevision, changed, timedOut });
  const unsubscribe = subscribeExecutionWorkChanges(pool, changes => {
    if (stopped || !changes.some(affectsClaim)) return;
    revision++;
    if (changes.some(change => change?.table === 'global_settings')) settingsRevision++;
    for (const waiter of [...waiters.values()]) waiter.finish(null, snapshot(true));
  });
  const stoppedError = () => new ExecutionWorkWaitError(503, 'WORK_NOTIFICATIONS_STOPPED', 'work notifications are stopping');
  const wait = (input, { signal } = {}) => {
    const request = cursor(input);
    if (stopped) return Promise.reject(stoppedError());
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('request cancelled', 'AbortError'));
    if (request.first) return Promise.resolve(snapshot());
    if (request.epoch !== epoch || request.revision !== revision) return Promise.resolve(snapshot(true));
    if (request.timeoutMs === 0) return Promise.resolve(snapshot(false, true));
    if (waiters.has(request.nodeId) || waiters.size >= maxWaiters) {
      return Promise.reject(new ExecutionWorkWaitError(429, 'WORK_NOTIFICATIONS_BUSY', 'work notification wait limit reached'));
    }
    // Registration and cursor comparison run synchronously, so a commit cannot
    // fall between them. A commit before this call is caught by the comparison.
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => finish(signal.reason ?? new DOMException('request cancelled', 'AbortError'));
      const finish = (error, value) => {
        if (waiters.get(request.nodeId)?.finish !== finish) return;
        waiters.delete(request.nodeId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      waiters.set(request.nodeId, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(null, snapshot(false, true)), request.timeoutMs);
      timer.unref?.();
    });
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    for (const waiter of [...waiters.values()]) waiter.finish(stoppedError());
  };
  return { wait, dispose, get pendingCount() { return waiters.size; } };
}
