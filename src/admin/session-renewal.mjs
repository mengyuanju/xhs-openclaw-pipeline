import {
  ADMIN_SESSION_COOKIE,
  createSessionToken,
  verifySessionToken,
} from './auth.mjs';
import { ApiError } from './http.mjs';
import { SESSION_RENEW_BEFORE_SECONDS } from './session-policy.mjs';
import { sessionActorHeaders } from '../control-plane/session-actor-headers.mjs';

const currentSeconds = () => Math.floor(Date.now() / 1_000);

export function readRequestSession(request, sessionSecret, { nowSeconds = currentSeconds() } = {}) {
  const values = (request.headers.get('cookie') || '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    .map((part) => part.slice(ADMIN_SESSION_COOKIE.length + 1));
  if (values.length !== 1) return null;
  return verifySessionToken(values[0], sessionSecret, { nowSeconds, includeMetadata: true });
}

/** Only safe timing/identity metadata is sent to the browser; never the token or credential version. */
export function getSessionMetadata(session, { nowSeconds = currentSeconds() } = {}) {
  if (!session || typeof session.sessionId !== 'string') return null;
  return {
    sessionId: session.sessionId,
    userId: Number.isSafeInteger(session.userId) && session.userId > 0 ? session.userId : null,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    renewable: session.subject === 'user' && Number.isSafeInteger(session.userId) && session.userId > 0,
    serverTime: nowSeconds,
  };
}

function unavailable() {
  return new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '中心服务暂时不可用，请稍后重试');
}

function staleSession() {
  return new ApiError(401, 'SESSION_STALE', '登录已失效，请重新登录');
}

function assertSameIdentity(user, session) {
  if (!user || typeof user !== 'object' || Array.isArray(user)
    || !Number.isSafeInteger(user.id) || typeof user.username !== 'string'
    || typeof user.role !== 'string' || !Number.isSafeInteger(user.credentialVersion)
    || typeof user.status !== 'string') {
    throw unavailable();
  }
  if (user.status !== 'ACTIVE' || user.id !== session.userId || user.username !== session.username
    || session.roles.length !== 1 || user.role !== session.roles[0]
    || user.credentialVersion !== session.credentialVersion) {
    throw staleSession();
  }
  for (const property of ['mustChangePassword', 'copyReviewEnabled', 'copyQcEnabled', 'imageQcEnabled']) {
    if (user[property] !== undefined && typeof user[property] !== 'boolean') throw unavailable();
  }
}

/** Revalidate the existing signed actor before renewing; profile lookups never replace stale identity claims. */
export async function renewRequestSession(request, {
  sessionSecret,
  controlPlaneRoot,
  expectedSessionId,
  fetchImpl = fetch,
  now = currentSeconds,
}) {
  if (typeof expectedSessionId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(expectedSessionId)) {
    throw new ApiError(400, 'INVALID_INPUT', '会话标识无效');
  }
  const startedAt = now();
  const session = readRequestSession(request, sessionSecret, { nowSeconds: startedAt });
  if (!session) throw new ApiError(401, 'AUTH_REQUIRED', '登录已过期，请重新登录');
  if (session.sessionId !== expectedSessionId) {
    throw new ApiError(409, 'SESSION_CHANGED', '登录账号已变化，请刷新页面');
  }
  if (session.subject !== 'user' || !Number.isSafeInteger(session.userId) || session.userId < 1) {
    throw new ApiError(401, 'SESSION_REAUTH_REQUIRED', '请重新登录后启用自动续期');
  }
  if (session.expiresAt - startedAt > SESSION_RENEW_BEFORE_SECONDS
    || session.expiresAt >= session.absoluteExpiresAt) {
    return { metadata: getSessionMetadata(session, { nowSeconds: startedAt }), renewed: false, token: null, maxAge: null };
  }
  if (!controlPlaneRoot) throw unavailable();
  let response;
  try {
    response = await fetchImpl(`${controlPlaneRoot}/v1/profile`, {
      method: 'GET',
      headers: sessionActorHeaders(session),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable();
  }
  if (response.status === 401) throw staleSession();
  if (!response.ok) throw unavailable();
  const payload = await response.json().catch(() => null);
  assertSameIdentity(payload?.data, session);

  // A slow profile response must not revive a token that expired during the request.
  const completedAt = now();
  const current = readRequestSession(request, sessionSecret, { nowSeconds: completedAt });
  if (!current) throw new ApiError(401, 'AUTH_REQUIRED', '登录已过期，请重新登录');
  const user = payload.data;
  const token = createSessionToken(sessionSecret, {
    nowSeconds: completedAt,
    actor: {
      userId: current.userId,
      username: current.username,
      roles: current.roles,
      credentialVersion: current.credentialVersion,
      displayName: user.displayName,
      mustChangePassword: user.mustChangePassword,
      copyReviewEnabled: user.copyReviewEnabled,
      copyQcEnabled: user.copyQcEnabled,
      imageQcEnabled: user.imageQcEnabled,
    },
    renewal: { authenticatedAt: current.authenticatedAt, sessionId: current.sessionId },
  });
  const renewedSession = verifySessionToken(token, sessionSecret, { nowSeconds: completedAt });
  return {
    metadata: getSessionMetadata(renewedSession, { nowSeconds: completedAt }),
    renewed: true,
    token,
    maxAge: renewedSession.expiresAt - completedAt,
  };
}
