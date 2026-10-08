export function createExecutorWorkNotifications({ waitForWork, scheduler, invalidateSettings = () => {},
  waitMs = 20_000, reconnectMs = 5_000, random = Math.random, onError = () => {} }) {
  if (typeof waitForWork !== 'function') throw new TypeError('work notification transport is required');
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 20_000) throw new RangeError('work notification wait must be from 1 to 20000 milliseconds');
  if (!Number.isFinite(reconnectMs) || reconnectMs <= 0) throw new RangeError('work notification reconnect delay must be positive');
  const controller = new AbortController();
  let online = false;
  let started = false;
  let running = null;
  let cursor = { epoch: null, revision: null };
  let settingsRevision = null;

  function offline() {
    online = false;
    scheduler.setWorkNotificationsOnline(false);
  }

  function retryDelay() {
    const delay = Math.max(1, Math.round(reconnectMs * (0.8 + random() * 0.4)));
    return new Promise(resolve => {
      if (controller.signal.aborted) { resolve(); return; }
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, delay);
      controller.signal.addEventListener('abort', finish, { once: true });
    });
  }

  async function subscribe() {
    while (!controller.signal.aborted) {
      try {
        const response = await waitForWork({ ...cursor, timeoutMs: waitMs }, { signal: controller.signal });
        if (controller.signal.aborted) break;
        // The client validates transport data. Keep direct adapters equally
        // strict before treating notification delivery as an online guarantee.
        if (typeof response?.epoch !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(response.epoch)
            || !Number.isSafeInteger(response.revision) || response.revision < 0
            || !Number.isSafeInteger(response.settingsRevision) || response.settingsRevision < 0
            || typeof response.changed !== 'boolean' || typeof response.timedOut !== 'boolean'
            || (response.changed && response.timedOut)
            || (cursor.epoch !== null && (response.epoch !== cursor.epoch || response.revision !== cursor.revision)
              && !response.changed)) throw new Error('invalid work notification response');
        const reconnected = !online;
        const settingsChanged = reconnected || cursor.epoch !== response.epoch || settingsRevision !== response.settingsRevision;
        if (settingsChanged) invalidateSettings();
        cursor = { epoch: response.epoch, revision: response.revision };
        settingsRevision = response.settingsRevision;
        online = true;
        scheduler.setWorkNotificationsOnline(true);
        // Initial/reconnected handshakes also wake: work can be committed
        // between the first empty claim and obtaining its initial cursor.
        if (response.changed || reconnected || settingsChanged) scheduler.wake();
      } catch (error) {
        offline();
        if (controller.signal.aborted) break;
        try { onError(error); } catch { /* Logging cannot stop fallback polling. */ }
        if (error?.status === 404 || error?.status === 501) break;
        await retryDelay();
      }
    }
    offline();
  }

  return {
    start() {
      if (started) throw new Error('executor work notifications already started');
      started = true;
      running = subscribe();
      return running;
    },
    stop() { controller.abort(); offline(); },
    async dispose() { controller.abort(); offline(); await running; },
    status() { return { online, epoch: cursor.epoch, revision: cursor.revision }; },
  };
}
