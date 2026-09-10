import { getDatabaseBinding } from '@/lib/server/bindings';

export interface AdminSessionRow {
  id: string;
  token_hash: string;
  username: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface LoginAttemptRow {
  identifier_hash: string;
  window_started_at: number;
  failed_count: number;
  locked_until: number | null;
  updated_at: number;
}

export async function insertAdminSession(input: {
  id: string;
  tokenHash: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}) {
  await getDatabaseBinding()
    .prepare(
      `INSERT INTO admin_sessions (
         id, token_hash, username, created_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.id,
      input.tokenHash,
      input.username,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}

export async function findAdminSessionByTokenHash(tokenHash: string) {
  return getDatabaseBinding()
    .prepare(
      `SELECT id, token_hash, username, created_at, expires_at, revoked_at
         FROM admin_sessions
        WHERE token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .first<AdminSessionRow>();
}

export async function deleteAdminSessionByTokenHash(tokenHash: string) {
  await getDatabaseBinding()
    .prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .run();
}

export async function pruneExpiredAdminSessions(now: number) {
  await getDatabaseBinding()
    .prepare(
      `DELETE FROM admin_sessions
        WHERE expires_at <= ? OR revoked_at IS NOT NULL`,
    )
    .bind(now)
    .run();
}

export async function getLoginAttempt(identifierHash: string) {
  return getDatabaseBinding()
    .prepare(
      `SELECT identifier_hash, window_started_at, failed_count,
              locked_until, updated_at
         FROM auth_login_attempts
        WHERE identifier_hash = ?
        LIMIT 1`,
    )
    .bind(identifierHash)
    .first<LoginAttemptRow>();
}

export async function saveLoginAttempt(input: {
  identifierHash: string;
  windowStartedAt: number;
  failedCount: number;
  lockedUntil: number | null;
  updatedAt: number;
}) {
  await getDatabaseBinding()
    .prepare(
      `INSERT INTO auth_login_attempts (
         identifier_hash, window_started_at, failed_count, locked_until, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(identifier_hash) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         failed_count = excluded.failed_count,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.identifierHash,
      input.windowStartedAt,
      input.failedCount,
      input.lockedUntil,
      input.updatedAt,
    )
    .run();
}

export async function clearLoginAttempt(identifierHash: string) {
  await getDatabaseBinding()
    .prepare('DELETE FROM auth_login_attempts WHERE identifier_hash = ?')
    .bind(identifierHash)
    .run();
}

export async function insertApiKey(input: {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopesJson: string;
  createdAt: number;
  expiresAt: number | null;
}) {
  await getDatabaseBinding()
    .prepare(
      `INSERT INTO api_keys (
         id, name, key_prefix, key_hash, scopes_json, created_at,
         expires_at, last_used_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      input.id,
      input.name,
      input.keyPrefix,
      input.keyHash,
      input.scopesJson,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}

export async function listApiKeyRows() {
  const result = await getDatabaseBinding()
    .prepare(
      `SELECT id, name, key_prefix, key_hash, scopes_json, created_at,
              expires_at, last_used_at, revoked_at
         FROM api_keys
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all<ApiKeyRow>();
  return result.results;
}

export async function findApiKeyByPrefix(keyPrefix: string) {
  return getDatabaseBinding()
    .prepare(
      `SELECT id, name, key_prefix, key_hash, scopes_json, created_at,
              expires_at, last_used_at, revoked_at
         FROM api_keys
        WHERE key_prefix = ?
        LIMIT 1`,
    )
    .bind(keyPrefix)
    .first<ApiKeyRow>();
}

export async function touchApiKey(id: string, usedAt: number) {
  await getDatabaseBinding()
    .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(usedAt, id)
    .run();
}

export async function revokeApiKeyRecord(id: string, revokedAt: number) {
  const changed = await getDatabaseBinding()
    .prepare(
      `UPDATE api_keys
          SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(revokedAt, id)
    .run();
  if (changed.meta.changes > 0) {
    return { outcome: 'revoked' as const, revokedAt };
  }

  const existing = await getDatabaseBinding()
    .prepare('SELECT revoked_at FROM api_keys WHERE id = ? LIMIT 1')
    .bind(id)
    .first<{ revoked_at: number | null }>();
  return existing
    ? { outcome: 'already-revoked' as const, revokedAt: existing.revoked_at }
    : { outcome: 'not-found' as const, revokedAt: null };
}

export async function consumeApiRateLimit(input: {
  keyId: string;
  now: number;
  windowMs: number;
  limit: number;
}) {
  const database = getDatabaseBinding();
  const current = await database
    .prepare(
      `SELECT window_started_at, request_count
         FROM api_rate_limits
        WHERE key_id = ?
        LIMIT 1`,
    )
    .bind(input.keyId)
    .first<{ window_started_at: number; request_count: number }>();

  if (!current || input.now - current.window_started_at >= input.windowMs) {
    await database
      .prepare(
        `INSERT INTO api_rate_limits (
           key_id, window_started_at, request_count, updated_at
         ) VALUES (?, ?, 1, ?)
         ON CONFLICT(key_id) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = 1,
           updated_at = excluded.updated_at`,
      )
      .bind(input.keyId, input.now, input.now)
      .run();
    return true;
  }

  if (current.request_count >= input.limit) {
    return false;
  }

  const incremented = await database
    .prepare(
      `UPDATE api_rate_limits
          SET request_count = request_count + 1, updated_at = ?
        WHERE key_id = ? AND request_count < ?`,
    )
    .bind(input.now, input.keyId, input.limit)
    .run();
  return incremented.meta.changes > 0;
}

export async function insertAuditLog(input: {
  actorType: 'admin' | 'api-key' | 'anonymous';
  actorId: string | null;
  action: string;
  targetId?: string | null;
  outcome: 'success' | 'failure';
  createdAt?: number;
}) {
  await getDatabaseBinding()
    .prepare(
      `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, target_id, outcome, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorType,
      input.actorId,
      input.action,
      input.targetId ?? null,
      input.outcome,
      input.createdAt ?? Date.now(),
    )
    .run();
}
