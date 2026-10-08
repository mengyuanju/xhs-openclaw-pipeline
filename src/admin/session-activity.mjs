import {
  SESSION_ACTIVE_SECONDS,
  SESSION_RENEW_BEFORE_SECONDS,
} from './session-policy.mjs';

export function parseSessionMetadata(value) {
  if (!value || typeof value !== 'object'
    || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(value.sessionId)
    || !(value.userId === null || (Number.isSafeInteger(value.userId) && value.userId > 0))
    || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.absoluteExpiresAt)
    || value.expiresAt > value.absoluteExpiresAt || typeof value.renewable !== 'boolean') return null;
  return {
    sessionId: value.sessionId,
    userId: value.userId,
    expiresAt: value.expiresAt,
    absoluteExpiresAt: value.absoluteExpiresAt,
    renewable: value.renewable,
    ...(Number.isSafeInteger(value.serverTime) ? { serverTime: value.serverTime } : {}),
  };
}

/** Activity decides when to ask; the server still decides whether a session can renew. */
export function createSessionActivity({
  initialSession,
  renew,
  isVisible,
  onUnauthorized = () => {},
  onChanged = () => {},
  now = Date.now,
}) {
  let session = parseSessionMetadata(initialSession);
  let lastActivity = null;
  let stopped = false;
  let inFlight = null;
  let retryAt = 0;
  let clockOffset = 0;

  function update(value) {
    const next = parseSessionMetadata(value);
    if (!next) return;
    if (session && (next.sessionId !== session.sessionId || next.userId !== session.userId)) {
      stopped = true;
      onChanged();
      return;
    }
    session = next;
    if (next.serverTime !== undefined) clockOffset = next.serverTime * 1000 - now();
  }
  update(initialSession);

  const active = () => !stopped && isVisible() && lastActivity !== null
    && now() - lastActivity <= SESSION_ACTIVE_SECONDS * 1000;
  const nearExpiry = () => session?.renewable === true
    && session.expiresAt < session.absoluteExpiresAt
    && session.expiresAt * 1000 - (now() + clockOffset) <= SESSION_RENEW_BEFORE_SECONDS * 1000;

  function check() {
    if (inFlight) return inFlight;
    if (!active() || !nearExpiry() || now() < retryAt) return Promise.resolve();
    const expected = session;
    inFlight = Promise.resolve().then(() => renew(expected, active)).then(value => {
      if (!stopped && value) update(value);
      retryAt = now() + 5_000;
    }).catch(error => {
      if (stopped) return;
      if (error?.status === 401) {
        stopped = true;
        onUnauthorized();
      } else if (error?.status === 409) {
        stopped = true;
        onChanged();
      } else {
        // Temporary failures preserve the cookie. Retry on a later interaction/check.
        retryAt = now() + 30_000;
      }
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function recordActivity(trusted = true) {
    if (!trusted || stopped || !isVisible()) return Promise.resolve();
    lastActivity = now();
    return check();
  }

  return { check, recordActivity, update, stop: () => { stopped = true; } };
}
