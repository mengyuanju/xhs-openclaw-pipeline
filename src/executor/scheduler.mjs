import { randomUUID } from 'node:crypto';
import { executorConcurrency } from './config.mjs';

export function createExecutorScheduler({ agent, copyConcurrency = 1, imageConcurrency = 1,
  imageWorkerEnabled = false, pollMs = 5000, once = false, onOutcome = () => {}, onError = () => {} }) {
  executorConcurrency(copyConcurrency, 'copyConcurrency');
  executorConcurrency(imageConcurrency, 'imageConcurrency');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('pollMs must be positive');
  let stopping = false;
  let started = false;
  const pools = new Map();
  const notify = (callback, ...args) => { try { callback(...args); } catch { /* Logging cannot rerun work. */ } };

  async function runPool(kind, capacity) {
    const pool = { active: new Map(), request: null, wake: null };
    pools.set(kind, pool);
    let nextPollAt = 0;
    let attemptedOnce = false;
    function launch(entry) {
      entry.running = true;
      void Promise.resolve().then(() => agent.executeClaim(kind, entry.claim)).then(outcome => {
        pool.active.delete(entry.claim.execution.id);
        nextPollAt = 0;
        notify(onOutcome, outcome);
      }, error => {
        // executeClaim retries the saved failure report, never the generation.
        entry.running = false;
        entry.retryAt = Date.now() + pollMs;
        notify(onError, kind, error);
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
        if (!pool.request) pool.request = { requestId: randomUUID(), limit: once ? 1 : capacity - pool.active.size, reconcile: false };
        try {
          const response = await agent.claimBatch(kind, pool.request);
          if (response.status === 'PAUSED') {
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
            pool.request = null;
            attemptedOnce = true;
            nextPollAt = Date.now() + pollMs;
            for (const entry of entries) pool.active.set(entry.claim.execution.id, entry);
            for (const entry of entries) launch(entry);
          }
        } catch (error) {
          // The server may have committed before the response was lost. Keep its slots.
          pool.request.reconcile = true;
          nextPollAt = Date.now() + pollMs;
          notify(onError, kind, error);
        }
      }
      if ((stopping || (once && attemptedOnce)) && !pool.active.size && !pool.request) break;
      const due = [...pool.active.values()].filter(entry => !entry.running).map(entry => entry.retryAt);
      if (pool.request || (!stopping && !(once && attemptedOnce) && pool.active.size < capacity)) due.push(nextPollAt);
      await wait(due.length ? Math.min(...due) - Date.now() : 60000);
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
    status() {
      return Object.fromEntries([...pools].map(([kind, pool]) => [kind,
        { active: pool.active.size, reserved: pool.request?.limit ?? 0 }]));
    },
  };
}
