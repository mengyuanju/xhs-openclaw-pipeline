import { ADMIN_SESSION_COOKIE, readAuthConfig, verifySessionToken } from './auth.mjs';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isPrivateIpv4(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  return parts[0] === 127
    || parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

function isPrivateIpv6(hostname) {
  if (hostname === '::1') return true;
  if (!hostname.includes(':')) return false;
  const firstHextet = Number.parseInt(hostname.split(':', 1)[0], 16);
  if (!Number.isInteger(firstHextet)) return false;
  return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
    || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
}

function parseAllowedHosts(value) {
  if (typeof value !== 'string') return new Set();
  return new Set(value.split(',')
    .map((host) => normalizeHostname(host.trim()))
    .filter((host) => host.length > 0 && host.length <= 253));
}

export function isAllowedAdminHostname(hostname, allowedHosts = process.env.XHS_ALLOWED_HOSTS) {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost'
    || isPrivateIpv4(normalized)
    || isPrivateIpv6(normalized)
    || parseAllowedHosts(allowedHosts).has(normalized);
}

export function assertLocalRequest(request, {
  mutation = false,
  allowedHosts = process.env.XHS_ALLOWED_HOSTS,
} = {}) {
  const target = new URL(request.url);
  const host = request.headers.get('host') || target.host;
  let publicOrigin;
  try {
    publicOrigin = new URL(`${target.protocol}//${host}`);
  } catch {
    throw new ApiError(403, 'PRIVATE_NETWORK_ONLY', '后台仅接受 private network requests');
  }
  if (!isAllowedAdminHostname(publicOrigin.hostname, allowedHosts)) {
    throw new ApiError(403, 'PRIVATE_NETWORK_ONLY', '后台仅接受 private network requests');
  }
  if (!mutation) return;
  const origin = request.headers.get('origin');
  let requestOrigin;
  try {
    requestOrigin = origin ? new URL(origin).origin : null;
  } catch {
    requestOrigin = null;
  }
  if (!requestOrigin || requestOrigin !== publicOrigin.origin) {
    throw new ApiError(403, 'SAME_ORIGIN_REQUIRED', '写操作必须来自 same-origin 页面');
  }
}

function readCookieValues(request, name) {
  const header = request.headers.get('cookie') || '';
  return header.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}

export function assertAuthenticatedRequest(request, environment = process.env) {
  const config = readAuthConfig(environment);
  const sessions = readCookieValues(request, ADMIN_SESSION_COOKIE);
  const session = config && sessions.length === 1
    ? verifySessionToken(sessions[0], config.sessionSecret)
    : null;
  if (!session) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to continue');
  }
  return session;
}

export function parsePositiveId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError('invalid id');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new TypeError('invalid id');
  return id;
}

export function assertRequestSize(request, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('request size limit is invalid');
  const declared = request.headers.get('content-length');
  if (declared === null) return;
  if (!/^\d+$/.test(declared)) throw new ApiError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length 无效');
  if (Number(declared) > maxBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
  }
}

export function errorToApiResponse(error) {
  if (error instanceof ApiError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    return Response.json(body, { status: error.status });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return Response.json({
      error: { code: 'INVALID_INPUT', message: error.message.slice(0, 500) },
    }, { status: 400 });
  }
  return Response.json({
    error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
  }, { status: 500 });
}

export function notFound(message = '资源不存在') {
  throw new ApiError(404, 'NOT_FOUND', message);
}
