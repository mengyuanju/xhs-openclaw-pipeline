import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const previews = sqliteTable(
  'previews',
  {
    id: text('id').primaryKey(),
    publicId: text('public_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tagsJson: text('tags_json').notNull(),
    status: text('status').notNull(),
    imageCount: integer('image_count').notNull(),
    contentHash: text('content_hash').notNull(),
    sourceRef: text('source_ref'),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('previews_public_id_uq').on(table.publicId),
    uniqueIndex('previews_source_ref_uq').on(table.sourceRef),
    index('previews_created_idx').on(table.createdAt),
    check(
      'previews_status_check',
      sql`${table.status} in ('PUBLISHED', 'REVOKED')`,
    ),
    check('previews_image_count_check', sql`${table.imageCount} > 0`),
  ],
);

export const previewAssets = sqliteTable(
  'preview_assets',
  {
    id: text('id').primaryKey(),
    previewId: text('preview_id')
      .notNull()
      .references(() => previews.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    objectKey: text('object_key').notNull(),
    originalName: text('original_name').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('preview_assets_object_key_uq').on(table.objectKey),
    uniqueIndex('preview_assets_position_uq').on(
      table.previewId,
      table.position,
    ),
    check('preview_assets_position_check', sql`${table.position} > 0`),
    check('preview_assets_byte_size_check', sql`${table.byteSize} > 0`),
  ],
);

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    username: text('username').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('admin_sessions_token_hash_uq').on(table.tokenHash),
    index('admin_sessions_expires_idx').on(table.expiresAt),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopesJson: text('scopes_json').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('api_keys_key_prefix_uq').on(table.keyPrefix),
    index('api_keys_created_idx').on(table.createdAt),
  ],
);

export const apiRateLimits = sqliteTable('api_rate_limits', {
  keyId: text('key_id')
    .primaryKey()
    .references(() => apiKeys.id, { onDelete: 'cascade' }),
  windowStartedAt: integer('window_started_at').notNull(),
  requestCount: integer('request_count').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const authLoginAttempts = sqliteTable('auth_login_attempts', {
  identifierHash: text('identifier_hash').primaryKey(),
  windowStartedAt: integer('window_started_at').notNull(),
  failedCount: integer('failed_count').notNull(),
  lockedUntil: integer('locked_until'),
  updatedAt: integer('updated_at').notNull(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetId: text('target_id'),
    outcome: text('outcome').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('audit_logs_created_idx').on(table.createdAt)],
);
