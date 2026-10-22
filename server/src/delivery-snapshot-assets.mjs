import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ControlPlaneConflictError, normalizeTaskId, normalizeUuid } from './domain.mjs';

function storagePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError('交付快照原图必须使用绝对存储路径');
  }
  return value;
}

/** Call inside a transaction, after task locks, before checking or deleting files. */
export async function lockDeliverySnapshotAssetPaths(client, paths) {
  for (const path of [...new Set(paths.map(storagePath))].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('delivery-snapshot-asset:' || $1, 0))", [path],
    );
  }
}

/** Keeps the path locks until the caller commits, including during filesystem IO. */
export async function protectedDeliverySnapshotPaths(client, paths) {
  const unique = [...new Set(paths.map(storagePath))];
  if (!unique.length) return new Set();
  await lockDeliverySnapshotAssetPaths(client, unique);
  const rows = (await client.query(`
    SELECT DISTINCT storage_path FROM delivery_snapshot_assets WHERE storage_path=ANY($1::text[])
  `, [unique])).rows;
  return new Set(rows.map(row => row.storage_path));
}

async function verifyFile(asset) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(asset.storagePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== asset.byteSize || hash.digest('hex') !== asset.sha256) {
    throw new ControlPlaneConflictError('DELIVERY_SNAPSHOT_ASSET_CHANGED', '交付快照原图缺失或校验失败');
  }
}

function normalizeAsset(input) {
  const asset = {
    storagePath: storagePath(input?.storagePath),
    sha256: String(input?.sha256 ?? ''),
    byteSize: Number(input?.byteSize),
    taskId: normalizeTaskId(input?.taskId),
    assetId: input?.assetId == null ? null : normalizeTaskId(input.assetId),
  };
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256) || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0) {
    throw new TypeError('交付快照原图大小或校验值无效');
  }
  return asset;
}

/**
 * Register in the same transaction as the delivery batch. Optional verify(asset)
 * must reject missing/mismatched bytes; by default SHA256 and size are streamed.
 * Never pass a pool: transaction/task/path locks must use the same client.
 */
export async function registerDeliverySnapshotAssets(client, snapshotPublicId, inputs, { verify = verifyFile } = {}) {
  const publicId = normalizeUuid(snapshotPublicId, 'snapshotPublicId');
  if (!Array.isArray(inputs)) throw new TypeError('交付快照原图列表无效');
  const assets = new Map();
  for (const input of inputs) {
    const asset = normalizeAsset(input), existing = assets.get(asset.storagePath);
    if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) {
      throw new TypeError('同一交付快照原图路径的元数据不一致');
    }
    assets.set(asset.storagePath, asset);
  }
  if (!assets.size) return 0;
  const taskIds = [...new Set([...assets.values()].map(asset => asset.taskId))].sort((a, b) => a - b);
  await client.query('SELECT id FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [taskIds]);
  await lockDeliverySnapshotAssetPaths(client, [...assets.keys()]);
  const current = (await client.query(`
    SELECT id,task_id,storage_path,sha256,byte_size,content_cleared_at
    FROM assets WHERE storage_path=ANY($1::text[]) ORDER BY id FOR UPDATE
  `, [[...assets.keys()]])).rows;
  for (const row of current) {
    const asset = assets.get(row.storage_path);
    if (row.content_cleared_at != null || Number(row.task_id) !== asset.taskId
      || (asset.assetId != null && Number(row.id) !== asset.assetId)
      || row.sha256 !== asset.sha256 || Number(row.byte_size) !== asset.byteSize) {
      throw new ControlPlaneConflictError('DELIVERY_SNAPSHOT_ASSET_CHANGED', '交付快照原图版本已变化或已清理');
    }
  }
  if ([...assets.values()].some(asset => asset.assetId != null && !current.some(row => Number(row.id) === asset.assetId))) {
    throw new ControlPlaneConflictError('DELIVERY_SNAPSHOT_ASSET_CHANGED', '交付快照原图记录缺失');
  }
  for (const asset of assets.values()) {
    await verify(asset);
    const result = await client.query(`
      INSERT INTO delivery_snapshot_assets(snapshot_public_id,storage_path,sha256,byte_size,task_id,asset_id)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(snapshot_public_id,storage_path) DO UPDATE SET sha256=delivery_snapshot_assets.sha256
      WHERE delivery_snapshot_assets.sha256=EXCLUDED.sha256
        AND delivery_snapshot_assets.byte_size=EXCLUDED.byte_size
        AND delivery_snapshot_assets.task_id=EXCLUDED.task_id
        AND delivery_snapshot_assets.asset_id IS NOT DISTINCT FROM EXCLUDED.asset_id
      RETURNING storage_path
    `, [publicId, asset.storagePath, asset.sha256, asset.byteSize, asset.taskId, asset.assetId]);
    if (!result.rowCount) {
      throw new ControlPlaneConflictError('DELIVERY_SNAPSHOT_ASSET_CHANGED', '交付快照原图引用不可改写');
    }
  }
  return assets.size;
}
