import { env } from 'cloudflare:workers';

import {
  isApiKeyScope,
  type ApiKeyScope,
  type ApiKeySummary,
} from '@/lib/auth-contract';
import { ApiError, sha256Hex } from '@/lib/preview-contract';
import {
  randomBase64Url,
  timingSafeEqualText,
  verifyPasswordHash,
} from '@/lib/server/auth-crypto';
import {
  clearLoginAttempt,
  consumeApiRateLimit,
  deleteAdminSessionByTokenHash,
  findAdminSessionByTokenHash,
  findApiKeyByPrefix,
  getLoginAttempt,
  insertAdminSession,
  insertApiKey,
  insertAuditLog,
  listApiKeyRows,
  pruneExpiredAdminSessions,
  revokeApiKeyRecord,
  saveLoginAttempt,
  touchApiKey,
  type AdminSessionRow,
  type ApiKeyRow,
} from '@/lib/server/auth-repository';

const LOCAL_SESSION_COOKIE = 'haimo_session';
const SECURE_SESSION_COOKIE = '__Host-haimo_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const API_RATE_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT = 60;
const API_KEY_PATTERN = /^(hm_xhs_live_[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export interface AdminAuthContext {
  type: 'admin';
  id: string;
  username: string;
  expiresAt: number;
}

export interface ApiKeyAuthContext {
  type: 'api-key';
  id: string;
  name: string;
  scopes: ApiKeyScope[];
}

export type AuthContext = AdminAuthContext | ApiKeyAuthContext;

export async function loginAdmin(
  request: Request,
  usernameValue: unknown,
  passwordValue: unknown,
) {
  const username =
    typeof usernameValue === 'string' ? usernameValue.trim() : '';
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (
    !username ||
    username.length > 100 ||
    !password ||
    password.length > 256
  ) {
    throw new ApiError('账号或密码错误。', 401, 'INVALID_CREDENTIALS');
  }

  const config = getAdminConfig();
  const now = Date.now();
  const identifierHash = await sha256Hex(
    `${normalizeUsername(username)}\u0000${getClientAddress(request)}`,
  );
  const attempt = await getLoginAttempt(identifierHash);
  if (attempt?.locked_until && attempt.locked_until > now) {
    throw new ApiError(
      '登录尝试次数过多，请稍后再试。',
      429,
      'LOGIN_RATE_LIMITED',
    );
  }

  const passwordValid = await verifyPasswordHash(password, config.passwordHash);
  const usernameValid = timingSafeEqualText(
    normalizeUsername(username),
    normalizeUsername(config.username),
  );
  if (!passwordValid || !usernameValid) {
    const withinWindow = Boolean(
      attempt && now - attempt.window_started_at < LOGIN_WINDOW_MS,
    );
    const failedCount = withinWindow ? attempt!.failed_count + 1 : 1;
    const lockedUntil =
      failedCount >= MAX_LOGIN_FAILURES ? now + LOGIN_LOCK_MS : null;
    await saveLoginAttempt({
      identifierHash,
      windowStartedAt: withinWindow ? attempt!.window_started_at : now,
      failedCount,
      lockedUntil,
      updatedAt: now,
    });
    await safeAudit({
      actorType: 'anonymous',
      actorId: null,
      action: 'auth.login',
      outcome: 'failure',
      createdAt: now,
    });
    if (lockedUntil) {
      throw new ApiError(
        '登录尝试次数过多，请稍后再试。',
        429,
        'LOGIN_RATE_LIMITED',
      );
    }
    throw new ApiError('账号或密码错误。', 401, 'INVALID_CREDENTIALS');
  }

  await clearLoginAttempt(identifierHash);
  await pruneExpiredAdminSessions(now);
  const token = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const session = {
    id: crypto.randomUUID(),
    tokenHash,
    username: config.username,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };
  await insertAdminSession(session);
  await safeAudit({
    actorType: 'admin',
    actorId: config.username,
    action: 'auth.login',
    outcome: 'success',
    createdAt: now,
  });

  return {
    token,
    username: config.username,
    expiresAt: session.expiresAt,
  };
}

export async function getAdminSessionFromRequest(request: Request) {
  return findAdminSessionByTokens(
    readSessionTokens(request.headers.get('Cookie')),
  );
}

export async function findAdminSessionByTokens(tokens: string[]) {
  const now = Date.now();
  for (const token of tokens.slice(0, 2)) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      continue;
    }
    const tokenHash = await sha256Hex(token);
    const session = await findAdminSessionByTokenHash(tokenHash);
    if (session && !session.revoked_at && session.expires_at > now) {
      return adminContextFromRow(session);
    }
    if (session) {
      await deleteAdminSessionByTokenHash(tokenHash);
    }
  }
  return null;
}

export async function requireAdminSession(request: Request) {
  const session = await getAdminSessionFromRequest(request);
  if (!session) {
    throw new ApiError('登录状态已失效，请重新登录。', 401, 'UNAUTHORIZED');
  }
  return session;
}

export async function logoutAdmin(request: Request) {
  const tokens = readSessionTokens(request.headers.get('Cookie'));
  for (const token of tokens.slice(0, 2)) {
    if (/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      await deleteAdminSessionByTokenHash(await sha256Hex(token));
    }
  }
}

export function createSessionCookie(request: Request, token: string) {
  const secure = new URL(request.url).protocol === 'https:';
  const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE;
  return serializeCookie(name, token, {
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
}

export function expireSessionCookies(request: Request) {
  const secure = new URL(request.url).protocol === 'https:';
  return [
    serializeCookie(LOCAL_SESSION_COOKIE, '', { maxAge: 0, secure: false }),
    serializeCookie(SECURE_SESSION_COOKIE, '', { maxAge: 0, secure }),
  ];
}

export async function requireApiKey(request: Request, scope: ApiKeyScope) {
  const authorization = request.headers.get('Authorization') ?? '';
  const bearerMatch = /^Bearer\s+(.+)$/iu.exec(authorization);
  const presentedKey = bearerMatch?.[1]?.trim() ?? '';
  const keyMatch = API_KEY_PATTERN.exec(presentedKey);
  if (!keyMatch) {
    throw new ApiError('缺少或无效的 API 密钥。', 401, 'INVALID_API_KEY');
  }

  const keyPrefix = keyMatch[1];
  const row = await findApiKeyByPrefix(keyPrefix);
  const now = Date.now();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) {
    throw new ApiError('缺少或无效的 API 密钥。', 401, 'INVALID_API_KEY');
  }

  const actualHash = await sha256Hex(presentedKey);
  if (!timingSafeEqualText(actualHash, row.key_hash)) {
    throw new ApiError('缺少或无效的 API 密钥。', 401, 'INVALID_API_KEY');
  }

  const scopes = parseStoredScopes(row.scopes_json);
  if (!scopes.includes(scope)) {
    throw new ApiError('API 密钥没有执行此操作的权限。', 403, 'FORBIDDEN');
  }

  const allowed = await consumeApiRateLimit({
    keyId: row.id,
    now,
    windowMs: API_RATE_WINDOW_MS,
    limit: API_RATE_LIMIT,
  });
  if (!allowed) {
    throw new ApiError('接口调用过于频繁，请稍后再试。', 429, 'RATE_LIMITED');
  }
  await touchApiKey(row.id, now);

  return {
    type: 'api-key',
    id: row.id,
    name: row.name,
    scopes,
  } satisfies ApiKeyAuthContext;
}

export async function listApiKeys() {
  return (await listApiKeyRows()).map(apiKeySummaryFromRow);
}

export async function createApiKey(input: { name: unknown; scopes: unknown }) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 60) {
    throw new ApiError('密钥名称需要填写，且不能超过 60 个字符。');
  }
  if (!Array.isArray(input.scopes)) {
    throw new ApiError('请至少选择一项密钥权限。');
  }
  const scopes = [...new Set(input.scopes.filter(isApiKeyScope))];
  if (scopes.length === 0 || scopes.length !== input.scopes.length) {
    throw new ApiError('密钥权限设置无效。');
  }

  const id = crypto.randomUUID();
  const keyPrefix = `hm_xhs_live_${id.replaceAll('-', '').slice(0, 12)}`;
  const rawKey = `${keyPrefix}.${randomBase64Url(32)}`;
  const row: ApiKeyRow = {
    id,
    name,
    key_prefix: keyPrefix,
    key_hash: await sha256Hex(rawKey),
    scopes_json: JSON.stringify(scopes),
    created_at: Date.now(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  };
  await insertApiKey({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    scopesJson: row.scopes_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
  return { apiKey: rawKey, key: apiKeySummaryFromRow(row) };
}

export async function revokeApiKey(id: string) {
  return revokeApiKeyRecord(id, Date.now());
}

export async function auditAuthAction(input: {
  actor: AuthContext;
  action: string;
  targetId?: string | null;
  outcome: 'success' | 'failure';
}) {
  await safeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: input.action,
    targetId: input.targetId,
    outcome: input.outcome,
  });
}

export function readSessionTokens(cookieHeader: string | null) {
  if (!cookieHeader) {
    return [];
  }
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }
  return [
    cookies.get(SECURE_SESSION_COOKIE),
    cookies.get(LOCAL_SESSION_COOKIE),
  ].filter((value): value is string => Boolean(value));
}

function getAdminConfig() {
  const username = env.ADMIN_USERNAME?.trim();
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim();
  if (!username || !passwordHash) {
    throw new ApiError(
      '管理员登录尚未配置，请先设置部署密钥。',
      503,
      'AUTH_NOT_CONFIGURED',
    );
  }
  return { username, passwordHash };
}

function adminContextFromRow(row: AdminSessionRow): AdminAuthContext {
  return {
    type: 'admin',
    id: row.id,
    username: row.username,
    expiresAt: row.expires_at,
  };
}

function apiKeySummaryFromRow(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: parseStoredScopes(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function parseStoredScopes(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isApiKeyScope) : [];
  } catch {
    return [];
  }
}

function normalizeUsername(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function getClientAddress(request: Request) {
  const cloudflareAddress = request.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflareAddress) {
    return cloudflareAddress;
  }
  const forwardedAddress = request.headers
    .get('X-Forwarded-For')
    ?.split(',')[0]
    ?.trim();
  return forwardedAddress || 'local';
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
) {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    options.secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

async function safeAudit(input: Parameters<typeof insertAuditLog>[0]) {
  try {
    await insertAuditLog(input);
  } catch (error) {
    console.error('auth_audit_log_failed', error);
  }
}
