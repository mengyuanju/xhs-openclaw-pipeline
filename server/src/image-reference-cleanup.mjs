import { realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';

const IN_USE_STATUSES = ['DRAFT', 'QUEUED', 'RUNNING', 'FAILED'];
const REFERENCE_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function inside(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part);
}

async function inTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockTask(client, taskId) {
  await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
}

async function scheduleAssets(client, taskId, assetIds, { rejectInUse = false, inUseStatuses = IN_USE_STATUSES } = {}) {
  if (!assetIds.length) return 0;
  const rows = (await client.query(`
    SELECT a.id, a.storage_path, a.sha256, a.content_cleared_at,
      EXISTS (
        SELECT 1 FROM image_edit_reference_assets binding
        JOIN image_edit_requests edit ON edit.id = binding.request_id
        WHERE binding.asset_id = a.id AND edit.status = ANY($3::text[])
      ) AS in_use
    FROM assets a
    WHERE a.task_id=$1 AND a.asset_role='REFERENCE' AND a.id=ANY($2::bigint[])
    ORDER BY a.id FOR UPDATE OF a
  `, [taskId, assetIds, inUseStatuses])).rows;
  if (rejectInUse && rows.some(row => row.in_use && !row.content_cleared_at)) {
    throw new ControlPlaneConflictError('IMAGE_REFERENCE_IN_USE', '参考图仍被草稿、执行中或可重试的图片修改使用，请先取消相关请求');
  }
  let scheduled = 0;
  for (const row of rows) {
    if (row.in_use || row.content_cleared_at) continue;
    await client.query(`
      INSERT INTO image_reference_cleanup_jobs(asset_id,task_id,storage_path,sha256)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(asset_id) DO UPDATE SET storage_path=EXCLUDED.storage_path,
        sha256=EXCLUDED.sha256, next_attempt_at=clock_timestamp(), last_error=NULL
    `, [row.id, taskId, row.storage_path, row.sha256]);
    await client.query(`
      UPDATE assets SET content_cleared_at=clock_timestamp(),active=false
      WHERE id=$1 AND task_id=$2 AND asset_role='REFERENCE' AND content_cleared_at IS NULL
    `, [row.id, taskId]);
    scheduled++;
  }
  return scheduled;
}

/** Call inside the edit action's transaction, after it reaches REJECTED/CANCELLED. */
export async function scheduleReferenceCleanupForEdit(client, rawEditId) {
  const editId = normalizeUuid(rawEditId, 'editId');
  const edit = (await client.query('SELECT task_id,status FROM image_edit_requests WHERE id=$1', [editId])).rows[0];
  if (!edit || !['REJECTED', 'CANCELLED'].includes(edit.status)) return 0;
  const taskId = normalizeTaskId(edit.task_id);
  await lockTask(client, taskId);
  const ids = (await client.query('SELECT asset_id FROM image_edit_reference_assets WHERE request_id=$1 ORDER BY asset_id', [editId])).rows
    .map(row => normalizeTaskId(row.asset_id));
  return scheduleAssets(client, taskId, ids);
}

/** Call inside the same transaction that inserts a READY delivery entry. */
export async function scheduleReferenceCleanupForTask(client, rawTaskId, { before } = {}) {
  const taskId = normalizeTaskId(rawTaskId);
  await lockTask(client, taskId);
  // A transaction may start before this READY transaction yet upload after it
  // releases the task lock. Sequence IDs capture commit ordering for this task;
  // legacy delivery rows without a watermark keep their timestamp fallback.
  const delivery = (await client.query(`
    SELECT id,created_at,reference_asset_id_cutoff FROM delivery_entries
    WHERE task_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2)
    ORDER BY id DESC LIMIT 1
  `, [taskId, before ?? null])).rows[0];
  if (!delivery) return 0;
  let cutoffId = delivery.reference_asset_id_cutoff;
  if (before != null && cutoffId == null) {
    cutoffId = (await client.query(`
      UPDATE delivery_entries SET reference_asset_id_cutoff=(
        SELECT COALESCE(max(id),0) FROM assets
        WHERE task_id=$2 AND asset_role='REFERENCE'
      ) WHERE id=$1 AND reference_asset_id_cutoff IS NULL
      RETURNING reference_asset_id_cutoff
    `, [delivery.id, taskId])).rows[0]?.reference_asset_id_cutoff ?? null;
  }
  const ids = (await client.query(`
    SELECT id FROM assets
    WHERE task_id=$1 AND asset_role='REFERENCE' AND content_cleared_at IS NULL
      AND (($2::bigint IS NOT NULL AND id <= $2)
        OR ($2::bigint IS NULL AND created_at <= $3::timestamptz))
    ORDER BY id
  `, [taskId, cutoffId, delivery.created_at])).rows.map(row => normalizeTaskId(row.id));
  return scheduleAssets(client, taskId, ids);
}

/** A manual removal conflicts only with references needed by unfinished work. */
export async function scheduleReferenceCleanupForAsset(client, rawTaskId, rawAssetId) {
  const taskId = normalizeTaskId(rawTaskId);
  const assetId = normalizeTaskId(rawAssetId);
  await lockTask(client, taskId);
  const asset = (await client.query("SELECT id FROM assets WHERE id=$1 AND task_id=$2 AND asset_role='REFERENCE'", [assetId, taskId])).rows[0];
  if (!asset) throw new ControlPlaneNotFoundError('reference asset not found');
  return scheduleAssets(client, taskId, [assetId], { rejectInUse: true });
}

/** A hidden standalone workspace cannot retry its edits, including FAILED ones. */
export async function scheduleReferenceCleanupForDeletedWorkspace(client, rawTaskId) {
  const taskId = normalizeTaskId(rawTaskId);
  await lockTask(client, taskId);
  const deleted = (await client.query(`
    SELECT 1 FROM standalone_image_workspaces workspace
    WHERE workspace.task_id=$1 AND EXISTS (
      SELECT 1 FROM image_edit_events event
      WHERE event.task_id=workspace.task_id AND event.action='DELETE_WORKSPACE'
    )
  `, [taskId])).rows[0];
  if (!deleted) throw new ControlPlaneConflictError('IMAGE_EDITOR_NOT_DELETED', '图片编辑记录尚未删除');
  const ids = (await client.query(`
    SELECT id FROM assets WHERE task_id=$1 AND asset_role='REFERENCE' AND content_cleared_at IS NULL ORDER BY id
  `, [taskId])).rows.map(row => normalizeTaskId(row.id));
  return scheduleAssets(client, taskId, ids, { inUseStatuses: [] });
}

async function removeWithinStorage(realRoot, path) {
  const parent = await realpath(dirname(path)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!parent) return;
  if (!inside(realRoot, parent)) throw new Error('参考图清理目录越界');
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function deleteJobFiles(storageRoot, job) {
  const root = resolve(storageRoot);
  const realRoot = await realpath(root);
  const taskId = normalizeTaskId(job.task_id);
  const assetId = normalizeTaskId(job.asset_id);
  const original = resolve(job.storage_path);
  const fileName = basename(original);
  if (!REFERENCE_FILE_NAME.test(fileName)
    || original !== resolve(root, 'image-edits', String(taskId), fileName)
    || !inside(root, original) || !SHA256.test(String(job.sha256))) {
    throw new Error('参考图资产路径或校验值无效');
  }
  const thumbnail = resolve(root, 'thumbnails', String(taskId), `${assetId}-${job.sha256}-thumb-480-v1.webp`);
  await removeWithinStorage(realRoot, original);
  await removeWithinStorage(realRoot, thumbnail);
}

/** Files are deleted only after their asset tombstone has committed. */
export async function drainReferenceCleanup(pool, storageRoot, { taskId, assetId, limit = 100 } = {}) {
  const normalizedTaskId = taskId == null ? null : normalizeTaskId(taskId);
  const normalizedAssetId = assetId == null ? null : normalizeTaskId(assetId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('参考图清理批量大小无效');
  let processed = 0, failed = 0;
  for (let index = 0; index < limit; index++) {
    const candidate = (await pool.query(`
      SELECT asset_id,task_id FROM image_reference_cleanup_jobs
      WHERE next_attempt_at <= clock_timestamp()
        AND ($1::bigint IS NULL OR task_id=$1)
        AND ($2::bigint IS NULL OR asset_id=$2)
      ORDER BY next_attempt_at,asset_id LIMIT 1
    `, [normalizedTaskId, normalizedAssetId])).rows[0];
    if (!candidate) break;
    const outcome = await inTransaction(pool, async client => {
      // Permanent task deletion quarantines files while holding this task lock.
      // Take the same lock before touching a job or its file so rollback can
      // restore the directory without leaving a deleted queue entry behind.
      await lockTask(client, normalizeTaskId(candidate.task_id));
      const job = (await client.query(`
        SELECT * FROM image_reference_cleanup_jobs
        WHERE asset_id=$3 AND next_attempt_at <= clock_timestamp()
          AND ($1::bigint IS NULL OR task_id=$1)
          AND ($2::bigint IS NULL OR asset_id=$2)
        FOR UPDATE SKIP LOCKED
      `, [normalizedTaskId, normalizedAssetId, candidate.asset_id])).rows[0];
      if (!job) return 'skip';
      try {
        await deleteJobFiles(storageRoot, job);
        await client.query('DELETE FROM image_reference_cleanup_jobs WHERE asset_id=$1', [job.asset_id]);
        return true;
      } catch (error) {
        await client.query(`
          UPDATE image_reference_cleanup_jobs SET attempts=attempts+1,
            next_attempt_at=clock_timestamp()+interval '1 minute',last_error=$2
          WHERE asset_id=$1
        `, [job.asset_id, String(error?.message ?? error).slice(0, 500)]);
        return false;
      }
    });
    if (outcome === 'skip') continue;
    if (outcome) processed++; else failed++;
  }
  return { processed, failed };
}

/** Schedules old terminal edits, delivered references and deleted workspaces. */
export async function backfillEligibleReferenceCleanup(pool, { limitTasks = 100 } = {}) {
  if (!Number.isInteger(limitTasks) || limitTasks < 1 || limitTasks > 1000) throw new TypeError('参考图补扫批量大小无效');
  const tasks = (await pool.query(`
    SELECT DISTINCT a.task_id FROM assets a
    WHERE a.asset_role='REFERENCE' AND a.content_cleared_at IS NULL
      AND (
        EXISTS (SELECT 1 FROM delivery_entries d WHERE d.task_id=a.task_id AND (
          (d.reference_asset_id_cutoff IS NOT NULL AND a.id<=d.reference_asset_id_cutoff)
          OR (d.reference_asset_id_cutoff IS NULL AND a.created_at<=d.created_at)))
        OR EXISTS (
          SELECT 1 FROM image_edit_reference_assets binding
          JOIN image_edit_requests edit ON edit.id=binding.request_id
          WHERE binding.asset_id=a.id AND edit.status IN ('REJECTED','CANCELLED')
        )
        OR EXISTS (
          SELECT 1 FROM standalone_image_workspaces workspace
          JOIN image_edit_events event ON event.task_id=workspace.task_id AND event.action='DELETE_WORKSPACE'
          WHERE workspace.task_id=a.task_id
        )
      )
      AND (
        EXISTS (
          SELECT 1 FROM standalone_image_workspaces workspace
          JOIN image_edit_events event ON event.task_id=workspace.task_id AND event.action='DELETE_WORKSPACE'
          WHERE workspace.task_id=a.task_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM image_edit_reference_assets binding
          JOIN image_edit_requests edit ON edit.id=binding.request_id
          WHERE binding.asset_id=a.id AND edit.status = ANY($1::text[])
        )
      )
    ORDER BY a.task_id LIMIT $2
  `, [IN_USE_STATUSES, limitTasks])).rows;
  let scheduled = 0;
  for (const task of tasks) {
    const taskId = normalizeTaskId(task.task_id);
    scheduled += await inTransaction(pool, async client => {
      await lockTask(client, taskId);
      const deletedWorkspace = (await client.query(`
        SELECT 1 FROM standalone_image_workspaces workspace
        JOIN image_edit_events event ON event.task_id=workspace.task_id AND event.action='DELETE_WORKSPACE'
        WHERE workspace.task_id=$1 LIMIT 1
      `, [taskId])).rows.length > 0;
      if (deletedWorkspace) return scheduleReferenceCleanupForDeletedWorkspace(client, taskId);
      const ids = (await client.query(`
        SELECT a.id FROM assets a
        WHERE a.task_id=$1 AND a.asset_role='REFERENCE' AND a.content_cleared_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM delivery_entries d WHERE d.task_id=a.task_id AND (
              (d.reference_asset_id_cutoff IS NOT NULL AND a.id<=d.reference_asset_id_cutoff)
              OR (d.reference_asset_id_cutoff IS NULL AND a.created_at<=d.created_at)))
            OR EXISTS (
              SELECT 1 FROM image_edit_reference_assets binding
              JOIN image_edit_requests edit ON edit.id=binding.request_id
              WHERE binding.asset_id=a.id AND edit.status IN ('REJECTED','CANCELLED')
            )
          )
        ORDER BY a.id
      `, [taskId])).rows.map(row => normalizeTaskId(row.id));
      return scheduleAssets(client, taskId, ids);
    });
  }
  return { tasks: tasks.length, scheduled };
}
