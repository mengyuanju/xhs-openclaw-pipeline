import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
} from './domain.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { normalizeClientBatchCode } from './client-batch.mjs';

const SCOPES = new Set(['ALL_READY', 'QUERY_PACKAGE', 'CLIENT_BATCH', 'SELECTED']);
const STATUSES = new Set(['GENERATED', 'DOWNLOADED', 'DELIVERED']);
const BATCH_KINDS = new Set(['ADMIN_DELIVERY', 'OPERATOR_DELIVERY']);
const CREATOR_ROLES = new Set(['ADMIN', 'USER']);

function normalizeActor(actor) {
  if (!actor || !['ADMIN', 'USER'].includes(actor.role)
      || !Number.isSafeInteger(Number(actor.userId))) {
    throw new ControlPlaneAuthorizationError('current role cannot manage delivery batches');
  }
  const normalized = {
    ...actor,
    userId: Number(actor.userId),
    username: String(actor.username ?? '').trim().toLowerCase(),
  };
  if (!normalized.username) {
    throw new ControlPlaneAuthorizationError('delivery batch actor is invalid');
  }
  return normalized;
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
  const batchKind = String(row.batch_kind ?? 'ADMIN_DELIVERY');
  const createdByRole = String(row.created_by_role ?? 'ADMIN');
  if (!Number.isSafeInteger(id) || id < 1 || !STATUSES.has(status)
      || !BATCH_KINDS.has(batchKind) || !CREATOR_ROLES.has(createdByRole)) {
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
    clientBatchCode: row.client_batch_code ?? null,
    status,
    batchKind,
    createdByRole,
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
    deliveredAt: row.delivered_at ?? null,
    deliveredByAccountId: row.delivered_by_account_id == null
      ? null : Number(row.delivered_by_account_id),
    deliveredByUsername: row.delivered_by_username ?? null,
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
    clientBatchCode: row.client_batch_code_snapshot ?? null,
  };
}

export async function createDeliveryBatch(client, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(input?.publicId, 'deliveryBatchId');
  const code = deliveryBatchCode(publicId);
  const scope = String(input?.scope ?? '');
  if (!SCOPES.has(scope)) throw new TypeError('delivery batch scope is invalid');
  if (actor.role === 'USER' && scope !== 'SELECTED') {
    throw new ControlPlaneAuthorizationError('operators may deliver only explicitly selected tasks');
  }
  const queryPackageName = normalizedPackageName(input?.queryPackageName, {
    required: scope === 'QUERY_PACKAGE',
  });
  if (scope !== 'QUERY_PACKAGE' && queryPackageName !== null) {
    throw new TypeError('only a query-package batch may store queryPackageName');
  }
  const clientBatchCode = normalizeClientBatchCode(input?.clientBatchCode, {
    optional: scope !== 'CLIENT_BATCH',
  });
  if (scope !== 'CLIENT_BATCH' && clientBatchCode !== null) {
    throw new TypeError('only a client-batch delivery may store clientBatchCode');
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
      task.source_query_package_snapshot_id, task.source_query_package_name,
      task.source_client_batch_code, task.assigned_to_user_id, task.assigned_at,
      assignee.id AS assigned_to_account_id
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
      AND assignee.created_at < task.assigned_at
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
    if (scope === 'CLIENT_BATCH' && row.source_client_batch_code !== clientBatchCode) {
      throw new ControlPlaneConflictError(
        'DELIVERY_SCOPE_CHANGED',
        '甲方批次交付范围已经变化，请刷新后重试',
      );
    }
    if (actor.role === 'USER' && (row.assigned_to_user_id !== actor.username
        || Number(row.assigned_to_account_id) !== actor.userId)) {
      throw new ControlPlaneAuthorizationError('operators may deliver only their own assigned tasks');
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
      public_id, code, scope, query_package_name, client_batch_code, archive_file_name,
      archive_byte_size, archive_sha256, task_count,
      created_by_account_id, created_by_username, batch_kind, created_by_role
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
  `, [publicId, code, scope, queryPackageName, clientBatchCode, fileName, byteSize, sha256,
    rows.length, actor.userId, actor.username,
    actor.role === 'USER' ? 'OPERATOR_DELIVERY' : 'ADMIN_DELIVERY', actor.role]);
  const batch = inserted.rows[0];
  await client.query(`
    INSERT INTO delivery_batch_items(
      delivery_batch_id, delivery_entry_id, ordinal, task_id,
      copy_revision_id, image_run_id, query_snapshot,
      query_package_id_snapshot, query_package_name_snapshot,
      client_batch_code_snapshot
    )
    SELECT $1, item.delivery_entry_id, item.ordinality::integer, item.task_id,
      item.copy_revision_id, item.image_run_id, item.query_snapshot,
      item.query_package_id_snapshot, item.query_package_name_snapshot,
      item.client_batch_code_snapshot
    FROM unnest(
      $2::bigint[], $3::bigint[], $4::bigint[], $5::uuid[], $6::text[],
      $7::bigint[], $8::varchar[], $9::varchar[]
    ) WITH ORDINALITY AS item(
      delivery_entry_id, task_id, copy_revision_id, image_run_id, query_snapshot,
      query_package_id_snapshot, query_package_name_snapshot,
      client_batch_code_snapshot, ordinality
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
    rows.map((row) => row.source_client_batch_code ?? null),
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
  clientBatchCode: rawClientBatchCode = null,
} = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const queryPackageName = normalizedPackageName(rawQueryPackageName);
  const clientBatchCode = normalizeClientBatchCode(rawClientBatchCode, { optional: true });
  const values = [];
  const clauses = [];
  if (actor.role === 'USER') {
    values.push(actor.userId, actor.username);
    clauses.push(`batch.batch_kind = 'OPERATOR_DELIVERY'
      AND batch.created_by_role = 'USER'
      AND batch.created_by_account_id = $1
      AND batch.created_by_username = $2`);
  }
  if (queryPackageName !== null) {
    values.push(queryPackageName);
    clauses.push(`EXISTS (
      SELECT 1 FROM delivery_batch_items AS filtered
      WHERE filtered.delivery_batch_id = batch.id
        AND filtered.query_package_name_snapshot = $${values.length}
    )`);
  }
  if (clientBatchCode !== null) {
    values.push(clientBatchCode);
    clauses.push(`EXISTS (
      SELECT 1 FROM delivery_batch_items AS filtered
      WHERE filtered.delivery_batch_id = batch.id
        AND filtered.client_batch_code_snapshot = $${values.length}
    )`);
  }
  const filter = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const values = [publicId];
  const visibility = actor.role === 'USER' ? `
    AND batch.batch_kind = 'OPERATOR_DELIVERY'
    AND batch.created_by_role = 'USER'
    AND batch.created_by_account_id = $2
    AND batch.created_by_username = $3
  ` : '';
  if (actor.role === 'USER') values.push(actor.userId, actor.username);
  const batch = await pool.query(`
    SELECT batch.*, COALESCE(packages.names, ARRAY[]::varchar[]) AS query_package_names
    FROM delivery_batches AS batch
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT item.query_package_name_snapshot
        ORDER BY item.query_package_name_snapshot)
        FILTER (WHERE item.query_package_name_snapshot IS NOT NULL) AS names
      FROM delivery_batch_items AS item WHERE item.delivery_batch_id = batch.id
    ) AS packages ON true
    WHERE batch.public_id = $1 ${visibility}
  `, values);
  if (!batch.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  const items = await pool.query(`
    SELECT * FROM delivery_batch_items
    WHERE delivery_batch_id = $1 ORDER BY ordinal
  `, [batch.rows[0].id]);
  return { ...batchFrom(batch.rows[0]), items: items.rows.map(batchItemFrom) };
}

export async function getDeliveryBatchArtifact(pool, rawPublicId, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const values = [publicId];
  const visibility = actor.role === 'USER' ? `
    AND batch_kind = 'OPERATOR_DELIVERY'
    AND created_by_role = 'USER'
    AND created_by_account_id = $2
    AND created_by_username = $3
  ` : '';
  if (actor.role === 'USER') values.push(actor.userId, actor.username);
  const result = await pool.query(`
    SELECT * FROM delivery_batches WHERE public_id = $1 ${visibility}
  `, values);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  return batchFrom(result.rows[0]);
}

export async function recordDeliveryBatchDownload(client, rawPublicId, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const values = [publicId];
  const visibility = actor.role === 'USER' ? `
    AND batch_kind = 'OPERATOR_DELIVERY'
    AND created_by_role = 'USER'
    AND created_by_account_id = $2
    AND created_by_username = $3
  ` : '';
  if (actor.role === 'USER') values.push(actor.userId, actor.username);
  const updated = await client.query(`
    UPDATE delivery_batches
    SET status = CASE WHEN status = 'GENERATED' THEN 'DOWNLOADED' ELSE status END,
      first_downloaded_at = COALESCE(first_downloaded_at, now()),
      last_downloaded_at = now(), download_count = download_count + 1
    WHERE public_id = $1 ${visibility}
    RETURNING *
  `, values);
  if (!updated.rows[0]) throw new ControlPlaneNotFoundError('delivery batch not found');
  await client.query(`
    INSERT INTO delivery_batch_download_events(
      delivery_batch_id, actor_account_id, actor_username
    ) VALUES ($1, $2, $3)
  `, [updated.rows[0].id, actor.userId, actor.username]);
  return batchFrom(updated.rows[0]);
}

export async function confirmDeliveryBatch(client, rawPublicId, rawActor) {
  const actor = normalizeActor(rawActor);
  const publicId = normalizeUuid(rawPublicId, 'deliveryBatchId');
  const values = [publicId];
  const visibility = actor.role === 'USER' ? `
    AND batch_kind = 'OPERATOR_DELIVERY'
    AND created_by_role = 'USER'
    AND created_by_account_id = $2
    AND created_by_username = $3
  ` : '';
  if (actor.role === 'USER') values.push(actor.userId, actor.username);
  const locked = await client.query(`
    SELECT * FROM delivery_batches
    WHERE public_id = $1 ${visibility}
    FOR UPDATE
  `, values);
  const batch = locked.rows[0];
  if (!batch) throw new ControlPlaneNotFoundError('delivery batch not found');
  if (batch.status === 'DELIVERED') return batchFrom(batch);
  if (batch.status !== 'DOWNLOADED' || Number(batch.download_count ?? 0) < 1) {
    throw new ControlPlaneConflictError(
      'DELIVERY_BATCH_NOT_DOWNLOADED',
      '请先完整下载交付包，再确认已经完成交付',
    );
  }
  const updated = await client.query(`
    UPDATE delivery_batches
    SET status = 'DELIVERED', delivered_at = now(),
      delivered_by_account_id = $2, delivered_by_username = $3
    WHERE id = $1
    RETURNING *
  `, [batch.id, actor.userId, actor.username]);
  await client.query(`
    INSERT INTO delivery_batch_confirmation_events(
      delivery_batch_id, actor_account_id, actor_username
    ) VALUES ($1, $2, $3)
  `, [batch.id, actor.userId, actor.username]);
  return batchFrom(updated.rows[0]);
}
