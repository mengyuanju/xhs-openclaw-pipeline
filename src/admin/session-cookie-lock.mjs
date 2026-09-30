export const SESSION_COOKIE_LOCK = 'xhs:session-cookie:v1';
const LEASE_MS = 60_000;

function abortReason(signal) {
  return signal.reason ?? new DOMException('Session operation cancelled', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function createSessionCookieLock({
  locks,
  leaseStore,
  now = Date.now,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  makeId = () => Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).join('-'),
}) {
  let queue = Promise.resolve();
  let leaseUnavailable = false;
  let everAcquiredLease = false;

  async function withLease(action, signal) {
    const owner = makeId();
    const deadline = now() + LEASE_MS;
    let acquired = false;
    let heartbeat;
    let pendingTouch = Promise.resolve();
    try {
      while (now() < deadline) {
        throwIfAborted(signal);
        acquired = await leaseStore.acquire(SESSION_COOKIE_LOCK, owner, now(), LEASE_MS);
        if (acquired) everAcquiredLease = true;
        // An acquire transaction may commit after its caller cancelled.
        throwIfAborted(signal);
        if (acquired) break;
        await waitWithSignal(delay(100), signal);
      }
      if (!acquired) throw new Error('Session coordination timed out');
      heartbeat = setInterval(() => {
        pendingTouch = pendingTouch.then(() => leaseStore.touch(SESSION_COOKIE_LOCK, owner, now(), LEASE_MS))
          .catch(() => {});
      }, 5_000);
      return await action();
    } finally {
      if (acquired) {
        clearInterval(heartbeat);
        // Complete pending refreshes before deleting this owner's lease.
        await pendingTouch;
        try {
          await leaseStore.release(SESSION_COOKIE_LOCK, owner);
        } catch { /* An expiring lease still permits another tab to recover. */ }
      }
    }
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} action
   * @param {{ shared?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  function withCookieLock(action, { shared = false, signal } = {}) {
    const run = async () => {
      throwIfAborted(signal);
      if (locks) return locks.request(SESSION_COOKIE_LOCK, { signal }, () => {
        throwIfAborted(signal);
        return action();
      });
      if (leaseStore && !leaseUnavailable) {
        try { return await withLease(action, signal); }
        catch (error) {
          if (error?.code !== 'SESSION_LOCK_UNAVAILABLE' || everAcquiredLease) throw error;
          // Only an initially prohibited IDB open can disable this fallback.
          leaseUnavailable = true;
        }
      }
      // Automatic renewals need coordination with other tabs; manual auth still works.
      if (shared) throw new Error('Cross-tab session coordination is unavailable');
      throwIfAborted(signal);
      return action();
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    // Keep the internal queue intact while a cancelled caller returns promptly.
    return waitWithSignal(result, signal);
  }
  return withCookieLock;
}
