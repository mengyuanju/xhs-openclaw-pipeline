/** Serial, time-based progress updates also renew an idle export's lease. */
export function createExportProgressLease(renew, {
  intervalMs = 1500, heartbeatMs = 30_000, now = Date.now,
} = {}) {
  if (typeof renew !== 'function' || !Number.isFinite(intervalMs) || intervalMs < 1
    || !Number.isFinite(heartbeatMs) || heartbeatMs < intervalMs) throw new TypeError('Invalid export progress options');
  const controller = new AbortController();
  let rows = 0, writtenRows = 0, lastWritten = now(), flight = null, stopped = false;
  async function flush(force = false) {
    while (flight) await flight;
    controller.signal.throwIfAborted();
    if (stopped) return;
    const elapsed = now() - lastWritten;
    if (!force && (elapsed < intervalMs || rows === writtenRows && elapsed < heartbeatMs)) return;
    const snapshot = rows;
    flight = Promise.resolve().then(() => renew(snapshot)).then(() => {
      writtenRows = snapshot; lastWritten = now();
    }).catch(error => { controller.abort(error); throw error; });
    try { await flight; } finally { flight = null; }
  }
  const timer = setInterval(() => { void flush().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    setRows(value) { controller.signal.throwIfAborted(); rows = value; },
    flush,
    abort(reason) { controller.abort(reason); },
    async dispose() {
      stopped = true; clearInterval(timer);
      await flight?.catch(() => {});
    },
  };
}
