import type {
  PreviewAssetRecord,
  PreviewStatus,
  PreviewSummary,
  PublicPreview,
} from '@/lib/preview-types';
import { getBindings } from '@/lib/server/bindings';

interface PreviewRow {
  id: string;
  public_id: string;
  title: string;
  body: string;
  tags_json: string;
  status: PreviewStatus;
  image_count: number;
  content_hash: string;
  created_at: number;
  published_at: number;
  revoked_at: number | null;
}

interface PublicPreviewRow {
  public_id: string;
  title: string;
  body: string;
  tags_json: string;
  status: PreviewStatus;
  image_count: number;
  published_at: number;
  revoked_at: number | null;
}

interface AssetRow {
  id: string;
  preview_id: string;
  position: number;
  object_key: string;
  original_name: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  created_at: number;
}

export interface CreatePreviewRecord {
  preview: PreviewSummary;
  assets: PreviewAssetRecord[];
}

export async function listPreviews(limit = 100): Promise<PreviewSummary[]> {
  const { db } = getBindings();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = await db
    .prepare(
      `SELECT id, public_id, title, body, tags_json, status, image_count,
              content_hash, created_at, published_at, revoked_at
         FROM previews
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(safeLimit)
    .all<PreviewRow>();

  return result.results.map(mapPreviewRow);
}

export async function insertPreview({ preview, assets }: CreatePreviewRecord) {
  await insertPreviews([{ preview, assets }]);
}

export async function insertPreviews(records: CreatePreviewRecord[]) {
  if (records.length === 0) {
    return;
  }

  const { db } = getBindings();
  const statements = records.flatMap(({ preview, assets }) => [
    db
      .prepare(
        `INSERT INTO previews (
          id, public_id, title, body, tags_json, status, image_count,
          content_hash, created_at, published_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        preview.id,
        preview.publicId,
        preview.title,
        preview.body,
        JSON.stringify(preview.tags),
        preview.status,
        preview.imageCount,
        preview.contentHash,
        preview.createdAt,
        preview.publishedAt,
        preview.revokedAt,
      ),
    ...assets.map((asset) =>
      db
        .prepare(
          `INSERT INTO preview_assets (
            id, preview_id, position, object_key, original_name,
            media_type, byte_size, sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          asset.id,
          asset.previewId,
          asset.position,
          asset.objectKey,
          asset.originalName,
          asset.mediaType,
          asset.byteSize,
          asset.sha256,
          asset.createdAt,
        ),
    ),
  ]);

  await db.batch(statements);
}

export async function getPublicPreview(
  publicId: string,
): Promise<PublicPreview | null> {
  const { db } = getBindings();
  const row = await db
    .prepare(
      `SELECT public_id, title, body, tags_json, status, image_count,
              published_at, revoked_at
         FROM previews
        WHERE public_id = ?
        LIMIT 1`,
    )
    .bind(publicId)
    .first<PublicPreviewRow>();

  if (!row) {
    return null;
  }

  return {
    publicId: row.public_id,
    title: row.title,
    body: row.body,
    tags: decodeTags(row.tags_json),
    status: row.status,
    imageCount: row.image_count,
    publishedAt: row.published_at,
    revokedAt: row.revoked_at,
  };
}

export async function getPublishedImage(
  publicId: string,
  position: number,
): Promise<PreviewAssetRecord | null> {
  const { db } = getBindings();
  const row = await db
    .prepare(
      `SELECT a.id, a.preview_id, a.position, a.object_key, a.original_name,
              a.media_type, a.byte_size, a.sha256, a.created_at
         FROM preview_assets AS a
         JOIN previews AS p ON p.id = a.preview_id
        WHERE p.public_id = ?
          AND p.status = 'PUBLISHED'
          AND a.position = ?
        LIMIT 1`,
    )
    .bind(publicId, position)
    .first<AssetRow>();

  return row ? mapAssetRow(row) : null;
}

export async function revokePreview(id: string): Promise<{
  outcome: 'revoked' | 'already-revoked' | 'not-found';
  revokedAt: number | null;
}> {
  const { db } = getBindings();
  const revokedAt = Date.now();
  const result = await db
    .prepare(
      `UPDATE previews
          SET status = 'REVOKED', revoked_at = ?
        WHERE id = ? AND status = 'PUBLISHED'`,
    )
    .bind(revokedAt, id)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    return { outcome: 'revoked', revokedAt };
  }

  const existing = await db
    .prepare('SELECT status, revoked_at FROM previews WHERE id = ? LIMIT 1')
    .bind(id)
    .first<{ status: PreviewStatus; revoked_at: number | null }>();

  return existing
    ? { outcome: 'already-revoked', revokedAt: existing.revoked_at }
    : { outcome: 'not-found', revokedAt: null };
}

function mapPreviewRow(row: PreviewRow): PreviewSummary {
  return {
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    body: row.body,
    tags: decodeTags(row.tags_json),
    status: row.status,
    imageCount: row.image_count,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    revokedAt: row.revoked_at,
  };
}

function mapAssetRow(row: AssetRow): PreviewAssetRecord {
  return {
    id: row.id,
    previewId: row.preview_id,
    position: row.position,
    objectKey: row.object_key,
    originalName: row.original_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function decodeTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}
