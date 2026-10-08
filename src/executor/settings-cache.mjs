// Share only settings transport. Local model capacity is checked on every claim.
export function createExecutorSettingsReader(read, { ttlMs = 15_000, now = Date.now } = {}) {
  if (typeof read !== 'function') throw new TypeError('settings reader is required');
  if (!Number.isInteger(ttlMs) || ttlMs < 0 || ttlMs > 60_000) {
    throw new RangeError('settings cache must be between 0 and 60000 milliseconds');
  }
  let cached;
  let expiresAt = 0;
  let inFlight = null;
  let revision = 0;
  function readSettings() {
    if (inFlight) return inFlight;
    if (cached !== undefined && now() < expiresAt) return Promise.resolve(cached);
    // An expired value is never used when refreshing fails.
    cached = undefined;
    inFlight = Promise.resolve().then(async () => {
      while (true) {
        const before = revision;
        const value = await read();
        if (value !== undefined && !Array.isArray(value)) throw new TypeError('executor settings response must be an array');
        // A settings notification can arrive while the old response is still
        // in flight. Refresh before any waiting availability check can claim.
        if (before !== revision) continue;
        cached = value;
        expiresAt = now() + ttlMs;
        return value;
      }
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  readSettings.invalidate = () => { revision++; cached = undefined; expiresAt = 0; };
  return readSettings;
}
