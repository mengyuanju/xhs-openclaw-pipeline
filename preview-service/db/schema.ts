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
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('previews_public_id_uq').on(table.publicId),
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
