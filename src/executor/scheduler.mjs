import { createClaimRequestId } from '../control-plane/claim-request.mjs';
import { executorConcurrency } from './config.mjs';

export function executorIdlePollMs(pollMs, idleMaxPollMs, emptyStreak, random = Math.random) {
  const delay = Math.min(idleMaxPollMs, pollMs * 2 ** Math.min(16, Math.max(0, emptyStreak - 1)));
  // Never reduce the normal poll interval or exceed the configured idle bound.
  return Math.round(Math.max(pollMs, Math.min(idleMaxPollMs, delay * (0.9 + random() * 0.2))));
}

export function createExecutorScheduler({ agent, copyConcurrency = 1, imageConcurrency = 1,
  imageWorkerEnabled = false, pollMs = 5000, idleMaxPollMs = pollMs,
  random = Math.random, once = false, onOutcome = () => {}, onError = () => {} }) {
  executorConcurrency(copyConcurrency, 'copyConcurrency');
  executorConcurrency(imageConcurrency, 'imageConcurrency');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('pollMs must be positive');
  if (!Number.isFinite(idleMaxPollMs) || idleMaxPollMs < pollMs) throw new RangeError('idleMaxPollMs must be at least pollMs');
  let stopping = false;
  let workNotificationsOnline = false;
  let started = false;
  const pools = new Map();
  const notify = (callback, ...args) => { try { callback(...args); } catch { /* Logging cannot rerun work. */ } };

  async function runPool(kind, capacity) {
    const pool = { active: new Map(), request: null, wake: null };
    pools.set(kind, pool);
    let nextPollAt = 0;
    let emptyStreak = 0;
    let wakeRevision = 0;
    let attemptedOnce = false;
    pool.resetPolling = () => {
      wakeRevision++; emptyStreak = 0;
      // A notification cannot turn an uncertain receipt into a fresh claim or
      // accelerate its scheduled reconciliation retries.
      if (!pool.request?.reconcile) nextPollAt = 0;
      pool.wake?.();
    };
    function launch(entry) {
      entry.running = true;
      void Promise.resolve().then(() => agent.executeClaim(kind, entry.claim)).then(outcome => {
        pool.active.delete(entry.claim.execution.id);
        pool.resetPolling();
        notify(onOutcome, outcome);
      }, error => {
        // executeClaim retries the saved failure report, never the generation.
        entry.running = false;
        entry.retryAt = Date.now() + pollMs;
        notify(onError, kind, error, { taskId: entry.claim.task.id, executionId: entry.claim.execution.id });
      }).finally(() => pool.wake?.());
    }
    function wait(milliseconds) {
      return new Promise(resolve => {
        const finish = () => { clearTimeout(timer); pool.wake = null; resolve(); };
        const timer = setTimeout(finish, Math.max(1, milliseconds));
        pool.wake = finish;
      });
    }
    while (true) {
      for (const entry of pool.active.values()) {
        if (!entry.running && entry.retryAt <= Date.now()) launch(entry);
      }
      const canStart = !stopping && !(once && attemptedOnce);
      if ((pool.request || (canStart && pool.active.size < capacity)) && nextPollAt <= Date.now()) {
        if (!pool.request) pool.request = { requestId: createClaimRequestId(), limit: once ? 1 : capacity - pool.active.size, reconcile: false };
        try {
          const requestWakeRevision = wakeRevision;
          const response = await agent.claimBatch(kind, pool.request);
          if (response.status === 'PAUSED') {
            emptyStreak = 0;
            pool.request = null;
            nextPollAt = Date.now() + pollMs;
            if (once) attemptedOnce = true;
          } else {
            // Validate the entire response before releasing reservations or starting any work.
            if (response.requestId !== pool.request.requestId || !Array.isArray(response.claims)
              || response.claims.length > pool.request.limit
              || new Set(response.claims.map(c => c.execution.id)).size !== response.claims.length) {
              throw new Error('invalid batch claim response');
            }
            const entries = response.claims.filter(claim => claim.execution.status === 'RUNNING'
              && !pool.active.has(claim.execution.id)).map(claim => ({ claim, running: false, retryAt: 0 }));
            if (pool.active.size + entries.length > capacity) throw new Error('batch claim exceeds pool capacity');
            const freshRequest = !pool.request.reconcile;
            pool.request = null;
            attemptedOnce = true;
            emptyStreak = freshRequest && response.claims.length === 0 ? emptyStreak + 1 : 0;
            nextPollAt = Date.now() + (emptyStreak ? executorIdlePollMs(pollMs, workNotificationsOnline ? idleMaxPollMs : pollMs, emptyStreak, random) : pollMs);
            for (const entry of entries) pool.active.set(entry.claim.execution.id, entry);
            for (const entry of entries) launch(entry);
          }
          // A task can finish while the claim RPC is pending. Its wake must not
          // be overwritten by the slower RPC's newly calculated idle interval.
          if (wakeRevision !== requestWakeRevision) { emptyStreak = 0; nextPollAt = 0; }
        } catch (error) {
          emptyStreak = 0;
          // The server may have committed before the response was lost. Keep its slots.
          if (error?.claimRequestNotSent === true) {
            pool.request = null;
          } else if (['CLAIM_REQUEST_EXPIRED', 'CLAIM_REQUEST_CLOCK_SKEW'].includes(error?.code)) {
            // Both errors are definitive non-claims: replay is checked first and
            // no task selection can occur before request age/clock validation.
            pool.request = null;
            if (once) attemptedOnce = true;
          } else pool.request.reconcile = true;
          nextPollAt = Date.now() + pollMs;
          notify(onError, kind, error);
        }
      }
      if ((stopping || (once && attemptedOnce)) && !pool.active.size && !pool.request) break;
      const due = [...pool.active.values()].filter(entry => !entry.running).map(entry => entry.retryAt);
      if (pool.request || (!stopping && !(once && attemptedOnce) && pool.active.size < capacity)) due.push(nextPollAt);
      const delay = due.length ? Math.min(...due) - Date.now() : 60000;
      if (delay > 0) await wait(delay);
    }
  }
  return {
    start() {
      if (started) throw new Error('executor scheduler already started');
      started = true;
      const running = [runPool('COPY', copyConcurrency)];
      if (imageWorkerEnabled) running.push(runPool('IMAGE', imageConcurrency));
      return Promise.all(running);
    },
    stop() { stopping = true; for (const pool of pools.values()) pool.wake?.(); },
    // Existing development notifications can call this without changing the
    // durable claim protocol. Completion also wakes its pool immediately.
    wake(kind) {
      if (stopping) return;
      for (const [poolKind, pool] of pools) if (!kind || kind === poolKind) pool.resetPolling();
    },
    setWorkNotificationsOnline(online) {
      if (typeof online !== 'boolean') throw new TypeError('work notification status must be a boolean');
      if (stopping || online === workNotificationsOnline) return;
      workNotificationsOnline = online;
      for (const pool of pools.values()) pool.resetPolling();
    },
    status() {
      return Object.fromEntries([...pools].map(([kind, pool]) => [kind,
        { active: pool.active.size, reserved: pool.request?.limit ?? 0 }]));
    },
  };
}
