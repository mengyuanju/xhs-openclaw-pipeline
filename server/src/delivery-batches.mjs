import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
} from './domain.mjs';
import { normalizeListPagination } from './list-pagination.mjs';

const SCOPES = new Set(['ALL_READY', 'QUERY_PACKAGE', 'SELECTED']);
const STATUSES = new Set(['GENERATED', 'DOWNLOADED']);

function normalizeActor(actor) {
  if (!actor || actor.role !== 'ADMIN' || !Number.isSafeInteger(Number(actor.userId))) {
    throw new ControlPlaneAuthorizationError('only administrators can manage delivery batches');
  }
  return {
    ...actor,
    userId: Number(actor.userId),
    username: String(actor.username ?? '').trim().toLowerCase(),
  };
}

function normalizedPackageName(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError('queryPackageName is required');
    return null;
  }
  if (typeof value !== 'string') throw new TypeError('queryPackageName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 200) {
    throw new RangeError('queryPackageName must contain between 1 and 200 characters');
  }
  return name;
}

function normalizedFileName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 180 || !name.endsWith('.zip')
      || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    throw new TypeError('delivery batch archive file name is invalid');
  }
  return name;
}

function normalizedBindings(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new TypeError('delivery batch bindings must be a non-empty array');
  }
  const bindings = value.map((binding) => ({
    taskId: normalizeTaskId(binding?.taskId),
    copyRevisionId: normalizeTaskId(binding?.copyRevisionId),
    imageRunId: normalizeUuid(binding?.imageRunId, 'imageRunId'),
  }));
  if (new Set(bindings.map((binding) => binding.taskId)).size !== bindings.length) {
    throw new TypeError('delivery batch task ids must be unique');
  }
  return bindings;
}

export function deliveryBatchCode(publicId) {
  return `JF-${normalizeUuid(publicId, 'deliveryBatchId').slice(0, 8).toUpperCase()}`;
}

function batchFrom(row) {
  const id = Number(row.id);
  const status = String(row.status);
  if (!Number.isSafeInteger(id) || id < 1 || !STATUSES.has(status)) {
    throw new TypeError('delivery batch row is invalid');
  }
  const packageNames = Array.isArray(row.query_package_names)
    ? row.query_package_names.filter((name) => typeof name === 'string' && name)
    : row.query_package_name ? [row.query_package_name] : [];
  return {
    id,
    publicId: row.public_id,
    code: row.code,
    scope: row.scope,
    queryPackageName: row.query_package_name ?? null,
    queryPackageNames: packageNames,
    status,
    fileName: row.archive_file_name,
    byteSize: Number(row.archive_byte_size),
    sha256: row.archive_sha256,
    taskCount: Number(row.task_count),
    createdByAccountId: Number(row.created_by_account_id),
    createdByUsername: row.created_by_username,
    createdAt: row.created_at,
    firstDownloadedAt: row.first_downloaded_at ?? null,
    lastDownloadedAt: row.last_downloaded_at ?? null,
    downloadCount: Number(row.download_count ?? 0),
  };
}

function batchItemFrom(row) {
  return {
    id: Number(row.id),
    ordinal: Number(row.ordinal),
    taskId: Number(row.task_id),
    copyRevisionId: Number(row.copy_revision_id),
    imageRunId: row.image_run_id,
    query: row.query_snapshot,
    queryPackageId: row.query_package_id_snapshot == null
      ? null : Number(row.query_package_id_snapshot),
    queryPackageName: row.query_package_name_snapshot ?? null,
  };
}

export async function createDeliveryBatch(client, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(input?.publicId, 'deliveryBatchId');
  const code = deliveryBatchCode(publicId);
  const scope = String(input?.scope ?? '');
  if (!SCOPES.has(scope)) throw new TypeError('delivery batch scope is invalid');
  const queryPackageName = normalizedPackageName(input?.queryPackageName, {
    required: scope === 'QUERY_PACKAGE',
  });
  if (scope !== 'QUERY_PACKAGE' && queryPackageName !== null) {
    throw new TypeError('only a query-package batch may store queryPackageName');
  }
  const fileName = normalizedFileName(input?.fileName);
  const byteSize = Number(input?.byteSize);
  const sha256 = String(input?.sha256 ?? '').trim().toLowerCase();
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
    throw new TypeError('delivery batch archive byte size is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new TypeError('delivery batch archive hash is invalid');
  }
  const bindings = normalizedBindings(input?.bindings);
  const taskIds = [...bindings.map((binding) => binding.taskId)].sort((left, right) => left - right);
  const locked = await client.query(`
    SELECT delivery.id AS delivery_entry_id, delivery.task_id, delivery.copy_revision_id,
      delivery.image_run_id, task.query, task.source_query_package_id,
      task.source_query_package_snapshot_id, task.source_query_package_name
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY' AND delivery.task_id = ANY($1::bigint[])
    ORDER BY delivery.id
    FOR UPDATE OF delivery
  `, [taskIds]);
  const rowsByTask = new Map(locked.rows.map((row) => [Number(row.task_id), row]));
  if (rowsByTask.size !== bindings.length) {
    throw new ControlPlaneConflictError(
      'DELIVERY_VERSION_CHANGED',
      '部分交付项的状态或版本已经变化，请刷新后重新创建交付批次',
    );
  }
  const rows = bindings.map((binding) => {
    const row = rowsByTask.get(binding.taskId);
    if (!row || Number(row.copy_revision_id) !== binding.copyRevisionId
        || String(row.image_run_id) !== binding.imageRunId) {
      throw new ControlPlaneConflictError(
        'DELIVERY_VERSION_CHANGED',
        '部分交付项的状态或版本已经变化，请刷新后重新创建交付批次',
      );
    }
    if (scope === 'QUERY_PACKAGE' && row.source_query_package_name !== queryPackageName) {
      throw new ControlPlaneConflictError(
        'DELIVERY_SCOPE_CHANGED',
        '词包交付范围已经变化，请刷新后重试',
      );
    }
    return row;
  });
  const duplicates = await client.query(`
    WITH expected AS (
      SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::uuid[])
        AS item(task_id, copy_revision_id, image_run_id)
    )
    SELECT existing.task_id, batch.code
    FROM expected
    JOIN delivery_batch_items AS existing
      ON existing.task_id = expected.task_id
      AND existing.copy_revision_id = expected.copy_revision_id
      AND existing.image_run_id = expected.image_run_id
    JOIN delivery_batches AS batch ON batch.id = existing.delivery_batch_id
    ORDER BY existing.task_id
  `, [
    bindings.map((binding) => binding.taskId),
    bindings.map((binding) => binding.copyRevisionId),
    bindings.map((binding) => binding.imageRunId),
  ]);
  if (duplicates.rows.length > 0) {
    const preview = duplicates.rows.slice(0, 5)
      .map((row) => `#${row.task_id}（${row.code}）`).join('、');
    throw new ControlPlaneConflictError(
      'DELIVERY_ALREADY_PACKED',
      `所选内容中有 ${duplicates.rows.length} 条当前版本已经打包：${preview}。请刷新后仅选择待交付内容`,
    );
  }
  const inserted = await client.query(`
    INSERT INTO delivery_batches(
      public_id, code, scope, query_package_name, archive_file_name,
      archive_byte_size, archive_sha256, task_count,
      created_by_account_id, created_by_username
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [publicId, code, scope, queryPackageName, fileName, byteSize, sha256,
    rows.length, actor.userId, actor.username]);
  const batch = inserted.rows[0];
  await client.query(`
    INSERT INTO delivery_batch_items(
      delivery_batch_id, delivery_entry_id, ordinal, task_id,
      copy_revision_id, image_run_id, query_snapshot,
      query_package_id_snapshot, query_package_name_snapshot
    )
    SELECT $1, item.delivery_entry_id, item.ordinality::integer, item.task_id,
      item.copy_revision_id, item.image_run_id, item.query_snapshot,
      item.query_package_id_snapshot, item.query_package_name_snapshot
    FROM unnest(
      $2::bigint[], $3::bigint[], $4::bigint[], $5::uuid[], $6::text[], $7::bigint[], $8::varchar[]
    ) WITH ORDINALITY AS item(
      delivery_entry_id, task_id, copy_revision_id, image_run_id, query_snapshot,
      query_package_id_snapshot, query_package_name_snapshot, ordinality
    )
  `, [
    batch.id,
    rows.map((row) => Number(row.delivery_entry_id)),
    rows.map((row) => Number(row.task_id)),
    rows.map((row) => Number(row.copy_revision_id)),
    rows.map((row) => row.image_run_id),
    rows.map((row) => String(row.query ?? '')),
    rows.map((row) => row.source_query_package_id ?? row.source_query_package_snapshot_id ?? null),
    rows.map((row) => row.source_query_package_name ?? null),
  ]);
  return batchFrom({
    ...batch,
    query_package_names: [...new Set(rows.map((row) => row.source_query_package_name).filter(Boolean))],
  });
}

export async function listDeliveryBatches(pool, {
  limit: rawLimit = 50,
  offset: rawOffset = 0,
  queryPackageName: rawQueryPackageName = null,
} = {}, rawActor) {
  normalizeActor(rawActor);
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const queryPackageName = normalizedPackageName(rawQueryPackageName);
  const values = [];
  const filter = queryPackageName === null ? '' : (() => {
    values.push(queryPackageName);
    return `WHERE EXISTS (
      SELECT 1 FROM delivery_batch_items AS filtered
      WHERE filtered.delivery_batch_id = batch.id
        AND filtered.query_package_name_snapshot = $${values.length}
    )`;
  })();
  const page = await pool.query(`
    SELECT batch.*, COALESCE(packages.names, ARRAY[]::varchar[]) AS query_package_names
    FROM delivery_batches AS batch
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT item.query_package_name_snapshot
        ORDER BY item.query_package_name_snapshot)
        FILTER (WHERE item.query_package_name_snapshot IS NOT NULL) AS names
      FROM delivery_batch_items AS item WHERE item.delivery_batch_id = batch.id
    ) AS packages ON true
    ${filter}
    ORDER BY batch.created_at DESC, batch.id DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, [...values, limit, offset]);
  const count = await pool.query(`
    SELECT COUNT(*)::bigint AS total FROM delivery_batches AS batch ${filter}
  `, values);
  return {
    items: page.rows.map(batchFrom),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

export async function getDeliveryBatch(pool, rawPublicId, rawActor) {
  normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const batch = await pool.query(`
    SELECT batch.*, COALESCE(packages.names, ARRAY[]::varchar[]) AS query_package_names
    FROM delivery_batches AS batch
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT item.query_package_name_snapshot
        ORDER BY item.query_package_name_snapshot)
        FILTER (WHERE item.query_package_name_snapshot IS NOT NULL) AS names
      FROM delivery_batch_items AS item WHERE item.delivery_batch_id = batch.id
    ) AS packages ON true
    WHERE batch.public_id = $1
  `, [publicId]);
  if (!batch.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  const items = await pool.query(`
    SELECT * FROM delivery_batch_items
    WHERE delivery_batch_id = $1 ORDER BY ordinal
  `, [batch.rows[0].id]);
  return { ...batchFrom(batch.rows[0]), items: items.rows.map(batchItemFrom) };
}

export async function getDeliveryBatchArtifact(pool, rawPublicId, rawActor) {
  normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const result = await pool.query(`
    SELECT * FROM delivery_batches WHERE public_id = $1
  `, [publicId]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  return batchFrom(result.rows[0]);
}

export async function recordDeliveryBatchDownload(client, rawPublicId, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const updated = await client.query(`
    UPDATE delivery_batches
    SET status = 'DOWNLOADED',
      first_downloaded_at = COALESCE(first_downloaded_at, now()),
      last_downloaded_at = now(), download_count = download_count + 1
    WHERE public_id = $1
    RETURNING *
  `, [publicId]);
  if (!updated.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  await client.query(`
    INSERT INTO delivery_batch_download_events(
      delivery_batch_id, actor_account_id, actor_username
    ) VALUES ($1, $2, $3)
  `, [updated.rows[0].id, actor.userId, actor.username]);
  return batchFrom(updated.rows[0]);
}
