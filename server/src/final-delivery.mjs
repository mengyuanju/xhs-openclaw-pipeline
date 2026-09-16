import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
  redactExecutionError,
} from './domain.mjs';
import { resolveDeliveryArchiveSource } from './delivery-source.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { normalizeClientBatchCode } from './client-batch.mjs';

const DELIVERY_IMAGE_MEDIA_TYPES = Object.freeze(
  Object.values(IMAGE_FORMATS).map((format) => format.mediaType),
);

function normalizeActor(actor) {
  if (!actor || !['ADMIN', 'USER'].includes(actor.role)
      || !Number.isSafeInteger(Number(actor.userId))) {
    throw new ControlPlaneAuthorizationError('current role cannot access the delivery pool');
  }
  const normalized = { ...actor, userId: Number(actor.userId), username: String(actor.username).toLowerCase() };
  if (normalized.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can access the delivery pool');
  }
  return normalized;
}

function normalizeQueryPackageName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('queryPackageName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 200) {
    throw new RangeError('queryPackageName must contain between 1 and 200 characters');
  }
  return name;
}

function deliveryFrom(row) {
  const preview = row.preview_id ? {
    id: row.preview_id,
    noteId: row.preview_note_id,
    contentHash: row.preview_content_hash,
    status: row.preview_status,
    publishedAt: row.preview_published_at,
    revokedAt: row.preview_revoked_at,
  } : null;
  const batch = row.delivery_batch_public_id ? {
    id: Number(row.delivery_batch_id),
    publicId: row.delivery_batch_public_id,
    code: row.delivery_batch_code,
    status: row.delivery_batch_status,
    batchKind: row.delivery_batch_kind,
    createdByRole: row.delivery_batch_created_by_role,
    createdByUsername: row.delivery_batch_created_by_username,
    createdAt: row.delivery_batch_created_at,
    downloadedAt: row.delivery_batch_last_downloaded_at ?? null,
    deliveredAt: row.delivery_batch_delivered_at ?? null,
    deliveredByUsername: row.delivery_batch_delivered_by_username ?? null,
  } : null;
  const previousBatch = !batch && row.previous_delivery_batch_public_id ? {
    id: Number(row.previous_delivery_batch_id),
    publicId: row.previous_delivery_batch_public_id,
    code: row.previous_delivery_batch_code,
    createdAt: row.previous_delivery_batch_created_at,
  } : null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    query: row.query,
    queryPackageId: row.source_query_package_id != null
      ? Number(row.source_query_package_id)
      : row.source_query_package_snapshot_id != null
        ? Number(row.source_query_package_snapshot_id) : null,
    queryPackageDeleted: row.source_query_package_id == null
      && row.source_query_package_snapshot_id != null,
    queryPackageName: row.source_query_package_name ?? null,
    clientBatchCode: row.source_client_batch_code ?? null,
    copyRevisionId: Number(row.copy_revision_id),
    imageRunId: row.image_run_id,
    status: row.status,
    approvedByUserId: row.approved_by_username,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    preview,
    packingState: batch ? 'PACKED' : previousBatch ? 'VERSION_UPDATED' : 'UNPACKED',
    deliveryBatch: batch,
    previousDeliveryBatch: previousBatch,
  };
}

function normalizePackingState(value) {
  const state = String(value ?? 'ALL').trim().toUpperCase();
  if (!['ALL', 'PENDING', 'PACKED'].includes(state)) {
    throw new TypeError('delivery packingState must be ALL, PENDING or PACKED');
  }
  return state;
}

function normalizePreviewLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError('preview upload limit must be an integer from 1 to 200');
  }
  return limit;
}

function normalizePreviewQueryPackageIds(value) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new RangeError('queryPackageIds must contain between 0 and 200 items');
  }
  const ids = [...value];
  if (ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
      || new Set(ids).size !== ids.length) {
    throw new TypeError('queryPackageIds must contain unique positive integers');
  }
  return ids;
}

function normalizePreviewTaskIds(value) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new RangeError('taskIds must contain between 0 and 200 items');
  }
  const ids = [...value];
  if (ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
      || new Set(ids).size !== ids.length) {
    throw new TypeError('taskIds must contain unique positive integers');
  }
  return ids;
}

function normalizePreviewBinding(value) {
  const noteId = String(value?.noteId ?? '').trim().toLowerCase();
  const contentHash = String(value?.contentHash ?? '').trim().toLowerCase();
  const publishedAt = new Date(Number(value?.publishedAt));
  if (!/^[0-9a-f]{32}$/u.test(noteId)) throw new TypeError('preview noteId is invalid');
  if (!/^[0-9a-f]{64}$/u.test(contentHash)) throw new TypeError('preview content hash is invalid');
  if (!Number.isFinite(publishedAt.valueOf())) throw new TypeError('preview publishedAt is invalid');
  return {
    deliveryEntryId: normalizeTaskId(value?.deliveryEntryId),
    taskId: normalizeTaskId(value?.taskId),
    copyRevisionId: normalizeTaskId(value?.copyRevisionId),
    imageRunId: normalizeUuid(value?.imageRunId, 'imageRunId'),
    previewId: normalizeUuid(value?.previewId, 'previewId'),
    noteId,
    contentHash,
    publishedAt,
  };
}

export async function createReadyDeliveryEntry(client, {
  taskId,
  copyRevisionId,
  imageRunId,
  actor,
}) {
  const qualityGate = await client.query(`
    SELECT task.image_qc_legacy_accepted,
      approval.id AS release_event_id
    FROM tasks AS task
    LEFT JOIN image_approval_events AS approval
      ON approval.id = task.image_qc_released_approval_event_id
      AND approval.task_id = task.id
      AND approval.copy_revision_id = task.current_copy_revision_id
      AND approval.image_run_id = task.current_image_run_id
    WHERE task.id = $1 AND task.current_copy_revision_id = $2
      AND task.current_image_run_id = $3
  `, [taskId, copyRevisionId, imageRunId]);
  if (!qualityGate.rows[0]
      || (!qualityGate.rows[0].image_qc_legacy_accepted && !qualityGate.rows[0].release_event_id)) {
    throw new ControlPlaneConflictError(
      'IMAGE_QA_NOT_RELEASED',
      '当前图片尚未通过图片质检抽检，不能进入交付池',
    );
  }
  await assertDeliverySourceArchivable(client, { taskId, copyRevisionId, imageRunId });
  const pendingEdits = await client.query("SELECT id FROM image_edit_requests WHERE task_id=$1 AND source_image_run_id=$2 AND status IN ('DRAFT','QUEUED','RUNNING','PREVIEW_READY') LIMIT 1", [taskId, imageRunId]);
  if (pendingEdits.rows.length) throw new TypeError('请先采用、拒绝或取消待处理的图片修改，再审核归档');
  await withdrawReadyDeliveryEntries(client, taskId, 'SUPERSEDED_DELIVERY');
  const result = await client.query(`
    INSERT INTO delivery_entries(
      task_id, copy_revision_id, image_run_id,
      approved_by_account_id, approved_by_username
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [taskId, copyRevisionId, imageRunId, actor?.userId ?? null, actor?.username ?? 'system']);
  return result.rows[0];
}

export async function assertDeliverySourceArchivable(queryable, {
  taskId: rawTaskId,
  copyRevisionId: rawCopyRevisionId,
  imageRunId,
}) {
  const taskId = normalizeTaskId(rawTaskId);
  const copyRevisionId = normalizeTaskId(rawCopyRevisionId);
  const result = await queryable.query(`
    SELECT
      revision.content AS copy_content,
      image_run.result AS image_result,
      COALESCE(
        array_agg(asset.id) FILTER (WHERE asset.id IS NOT NULL),
        ARRAY[]::bigint[]
      ) AS available_asset_ids
    FROM copy_revisions AS revision
    JOIN image_runs AS image_run
      ON image_run.id = $3 AND image_run.task_id = $1
      AND image_run.copy_revision_id = $2 AND image_run.status = 'COMPLETED'
    LEFT JOIN image_run_asset_view AS asset
      ON asset.task_id = $1 AND asset.image_run_id = image_run.id
      AND asset.media_type = ANY($4::varchar[])
    WHERE revision.id = $2 AND revision.task_id = $1
      AND revision.approved_at IS NOT NULL
    GROUP BY revision.content, image_run.result
  `, [taskId, copyRevisionId, imageRunId, DELIVERY_IMAGE_MEDIA_TYPES]);
  const source = result.rows[0];
  try {
    if (!source) throw new TypeError('delivery source is missing');
    resolveDeliveryArchiveSource({
      content: source.copy_content,
      imageResult: source.image_result,
      availableAssetIds: source.available_asset_ids,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ControlPlaneConflictError(
      'DELIVERY_SOURCE_NOT_ARCHIVABLE',
      '当前图文版本的交付文件不完整，请重新生成图片后再通过终审',
    );
  }
  return { taskId, copyRevisionId, imageRunId };
}

export async function withdrawReadyDeliveryEntries(client, rawTaskId, reason = 'TASK_LEFT_DELIVERY') {
  const taskId = normalizeTaskId(rawTaskId);
  const safeReason = String(reason ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(safeReason)) throw new TypeError('delivery withdrawal reason is invalid');
  const withdrawn = await client.query(`
    UPDATE delivery_entries
    SET status = 'WITHDRAWN', withdrawn_at = COALESCE(withdrawn_at, now()),
      preview_status = CASE
        WHEN preview_status IN ('PUBLISHED', 'REVOKE_FAILED') THEN 'REVOKING'
        ELSE preview_status
      END
    WHERE task_id = $1 AND status = 'READY'
    RETURNING id, task_id, preview_id, preview_status
  `, [taskId]);
  const previews = withdrawn.rows.filter((row) => row.preview_id
    && ['REVOKING', 'PUBLISHED', 'REVOKE_FAILED'].includes(row.preview_status));
  for (const row of previews) {
    await client.query(`
      INSERT INTO delivery_preview_revocation_jobs(
        preview_id, delivery_entry_id, task_id, reason, status, next_attempt_at
      ) VALUES ($1, $2, $3, $4, 'PENDING', now())
      ON CONFLICT(preview_id) DO UPDATE SET
        reason = EXCLUDED.reason,
        status = CASE
          WHEN delivery_preview_revocation_jobs.status = 'COMPLETED' THEN 'COMPLETED'
          ELSE 'PENDING'
        END,
        next_attempt_at = now(), lease_expires_at = NULL, updated_at = now()
    `, [row.preview_id, row.id, row.task_id, safeReason]);
  }
  return { withdrawnCount: withdrawn.rows.length, revocationCount: previews.length };
}

export async function claimDeliveryPreviewRevocationJobs(queryable, rawLimit = 10) {
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('revocation job limit must be between 1 and 50');
  }
  const result = await queryable.query(`
    WITH candidates AS (
      SELECT id FROM delivery_preview_revocation_jobs
      WHERE (status IN ('PENDING', 'RETRY') AND next_attempt_at <= now())
         OR (status = 'PROCESSING' AND lease_expires_at <= now())
      ORDER BY next_attempt_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE delivery_preview_revocation_jobs AS job
    SET status = 'PROCESSING', attempt_count = attempt_count + 1,
      lease_expires_at = now() + interval '5 minutes', updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.id, job.preview_id, job.attempt_count
  `, [limit]);
  return result.rows.map((row) => ({
    id: Number(row.id),
    previewId: row.preview_id,
    attemptCount: Number(row.attempt_count),
  }));
}

export async function failDeliveryPreviewRevocationJob(queryable, rawJobId, error) {
  const jobId = normalizeTaskId(rawJobId);
  const message = [...redactExecutionError(error ?? 'preview revoke failed')]
    .slice(0, 500).join('');
  await queryable.query(`
    WITH failed AS (
      UPDATE delivery_preview_revocation_jobs
      SET status = CASE WHEN attempt_count >= 12 THEN 'FAILED' ELSE 'RETRY' END,
        next_attempt_at = now() + LEAST(interval '1 hour', interval '5 seconds' * power(2, LEAST(attempt_count, 10))),
        lease_expires_at = NULL, last_error = $2, updated_at = now()
      WHERE id = $1 AND status = 'PROCESSING'
      RETURNING preview_id, status
    )
    UPDATE delivery_entries AS delivery
    SET preview_status = 'REVOKE_FAILED'
    FROM failed
    WHERE delivery.preview_id = failed.preview_id
      AND failed.status = 'FAILED'
  `, [jobId, message]);
}

export async function assertTaskReadyForDelivery(queryable, rawTaskId) {
  const taskId = normalizeTaskId(rawTaskId);
  const result = await queryable.query(`
    SELECT delivery.*, task.query, task.source_query_package_id,
      task.source_query_package_snapshot_id,
      task.source_query_package_name
    FROM tasks AS task
    JOIN delivery_entries AS delivery
      ON delivery.task_id = task.id AND delivery.status = 'READY'
      AND delivery.copy_revision_id = task.current_copy_revision_id
      AND delivery.image_run_id = task.current_image_run_id
    WHERE task.id = $1 AND task.state = 'REVIEWED'
      AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)
  `, [taskId]);
  if (!result.rows[0]) {
    const task = await queryable.query('SELECT state FROM tasks WHERE id = $1', [taskId]);
    if (!task.rows[0]) throw new ControlPlaneNotFoundError('task not found');
    throw new ControlPlaneConflictError(
      'DELIVERY_NOT_READY',
      '任务尚未通过图文终审并进入交付池，不能下载',
    );
  }
  return deliveryFrom(result.rows[0]);
}

export async function assertTasksReadyForDelivery(queryable, rawBindings) {
  if (!Array.isArray(rawBindings) || rawBindings.length < 1) {
    throw new TypeError('delivery bindings must be a non-empty array');
  }
  const bindings = rawBindings.map((binding) => ({
    taskId: normalizeTaskId(binding?.taskId),
    copyRevisionId: normalizeTaskId(binding?.copyRevisionId),
    imageRunId: String(binding?.imageRunId ?? ''),
  }));
  if (bindings.some((binding) => !binding.imageRunId)
      || new Set(bindings.map((binding) => binding.taskId)).size !== bindings.length) {
    throw new TypeError('delivery bindings are invalid');
  }
  const result = await queryable.query(`
    WITH expected AS (
      SELECT *
      FROM unnest($1::bigint[], $2::bigint[], $3::uuid[])
        AS value(task_id, copy_revision_id, image_run_id)
    )
    SELECT COUNT(*)::integer AS matched_count
    FROM expected
    JOIN tasks AS task
      ON task.id = expected.task_id AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = expected.copy_revision_id
      AND task.current_image_run_id = expected.image_run_id
      AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)
    JOIN delivery_entries AS delivery
      ON delivery.task_id = expected.task_id AND delivery.status = 'READY'
      AND delivery.copy_revision_id = expected.copy_revision_id
      AND delivery.image_run_id = expected.image_run_id
  `, [
    bindings.map((binding) => binding.taskId),
    bindings.map((binding) => binding.copyRevisionId),
    bindings.map((binding) => binding.imageRunId),
  ]);
  if (Number(result.rows[0]?.matched_count) !== bindings.length) {
    throw new ControlPlaneConflictError(
      'DELIVERY_VERSION_CHANGED',
      '交付版本已变化，请刷新交付池后重试',
    );
  }
  return bindings;
}

export async function listDeliveryPool(pool, {
  limit: rawLimit = 50,
  offset: rawOffset = 0,
  includeTotal = false,
  queryPackageName: rawQueryPackageName = null,
  clientBatchCode: rawClientBatchCode = null,
  packingState: rawPackingState = 'ALL',
} = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const queryPackageName = normalizeQueryPackageName(rawQueryPackageName);
  const clientBatchCode = normalizeClientBatchCode(rawClientBatchCode, { optional: true });
  const packingState = normalizePackingState(rawPackingState);
  const visibilityValues = actor.role === 'ADMIN' ? [] : [actor.username, actor.userId];
  const filteredValues = [...visibilityValues];
  const visibility = actor.role === 'ADMIN' ? '' : `
    AND task.assigned_to_user_id = $1
    AND EXISTS (
      SELECT 1 FROM app_users AS assignee
      WHERE assignee.id = $2 AND assignee.username = task.assigned_to_user_id
        AND assignee.created_at < task.assigned_at
    )
  `;
  const packageFilter = queryPackageName === null ? '' : (() => {
    filteredValues.push(queryPackageName);
    return `AND task.source_query_package_name = $${filteredValues.length}`;
  })();
  const clientBatchFilter = clientBatchCode === null ? '' : (() => {
    filteredValues.push(clientBatchCode);
    return `AND task.source_client_batch_code = $${filteredValues.length}`;
  })();
  const packingFilter = packingState === 'PENDING'
    ? `AND NOT EXISTS (
      SELECT 1 FROM delivery_batch_items AS packed_item
      WHERE packed_item.task_id = delivery.task_id
        AND packed_item.copy_revision_id = delivery.copy_revision_id
        AND packed_item.image_run_id = delivery.image_run_id
    )`
    : packingState === 'PACKED'
      ? `AND EXISTS (
        SELECT 1 FROM delivery_batch_items AS packed_item
        WHERE packed_item.task_id = delivery.task_id
          AND packed_item.copy_revision_id = delivery.copy_revision_id
          AND packed_item.image_run_id = delivery.image_run_id
      )`
      : '';
  const limitParameter = filteredValues.length + 1;
  const values = [...filteredValues, limit, offset];
  const pagePromise = pool.query(`
    SELECT delivery.*, task.query, task.source_query_package_id,
      task.source_query_package_snapshot_id, task.source_query_package_name,
      task.source_client_batch_code,
      packed.id AS delivery_batch_id, packed.public_id AS delivery_batch_public_id,
      packed.code AS delivery_batch_code, packed.status AS delivery_batch_status,
      packed.batch_kind AS delivery_batch_kind,
      packed.created_by_role AS delivery_batch_created_by_role,
      packed.created_by_username AS delivery_batch_created_by_username,
      packed.created_at AS delivery_batch_created_at,
      packed.last_downloaded_at AS delivery_batch_last_downloaded_at,
      packed.delivered_at AS delivery_batch_delivered_at,
      packed.delivered_by_username AS delivery_batch_delivered_by_username,
      previous.id AS previous_delivery_batch_id,
      previous.public_id AS previous_delivery_batch_public_id,
      previous.code AS previous_delivery_batch_code,
      previous.created_at AS previous_delivery_batch_created_at
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
      AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)
    LEFT JOIN LATERAL (
      SELECT batch.id, batch.public_id, batch.code, batch.status,
        batch.batch_kind, batch.created_by_role, batch.created_by_username,
        batch.created_at, batch.last_downloaded_at, batch.delivered_at,
        batch.delivered_by_username
      FROM delivery_batch_items AS item
      JOIN delivery_batches AS batch ON batch.id = item.delivery_batch_id
      WHERE item.task_id = delivery.task_id
        AND item.copy_revision_id = delivery.copy_revision_id
        AND item.image_run_id = delivery.image_run_id
      ORDER BY batch.id LIMIT 1
    ) AS packed ON true
    LEFT JOIN LATERAL (
      SELECT batch.id, batch.public_id, batch.code, batch.created_at
      FROM delivery_batch_items AS item
      JOIN delivery_batches AS batch ON batch.id = item.delivery_batch_id
      WHERE item.task_id = task.id
        AND (item.copy_revision_id <> delivery.copy_revision_id
          OR item.image_run_id <> delivery.image_run_id)
      ORDER BY item.id DESC LIMIT 1
    ) AS previous ON packed.id IS NULL
    WHERE delivery.status = 'READY' ${visibility} ${packageFilter} ${clientBatchFilter} ${packingFilter}
    ORDER BY delivery.approved_at DESC, delivery.id DESC
    LIMIT $${limitParameter} OFFSET $${limitParameter + 1}
  `, values);
  if (!includeTotal) {
    const result = await pagePromise;
    return result.rows.map(deliveryFrom);
  }
  const [result, count, packageFacets] = await Promise.all([pagePromise, pool.query(`
    SELECT COUNT(*)::bigint AS total
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
      AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)
    WHERE delivery.status = 'READY' ${visibility} ${packageFilter} ${clientBatchFilter} ${packingFilter}
  `, filteredValues), pool.query(`
    SELECT COALESCE(task.source_query_package_id, task.source_query_package_snapshot_id) AS id,
      task.source_query_package_name AS name,
      task.source_client_batch_code AS client_batch_code,
      (task.source_query_package_id IS NULL
        AND task.source_query_package_snapshot_id IS NOT NULL) AS deleted,
      COUNT(*)::bigint AS count,
      COUNT(*) FILTER (WHERE delivery.preview_id IS NULL)::bigint AS unuploaded_count,
      COUNT(*) FILTER (WHERE delivery.preview_status = 'PUBLISHED')::bigint AS published_count,
      COUNT(*) FILTER (WHERE delivery.preview_status = 'REVOKED')::bigint AS revoked_count,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM delivery_batch_items AS packed_item
        WHERE packed_item.task_id = delivery.task_id
          AND packed_item.copy_revision_id = delivery.copy_revision_id
          AND packed_item.image_run_id = delivery.image_run_id
      ))::bigint AS packed_count,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM delivery_batch_items AS packed_item
        WHERE packed_item.task_id = delivery.task_id
          AND packed_item.copy_revision_id = delivery.copy_revision_id
          AND packed_item.image_run_id = delivery.image_run_id
      ))::bigint AS pending_count,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM delivery_batch_items AS packed_item
        WHERE packed_item.task_id = delivery.task_id
          AND packed_item.copy_revision_id = delivery.copy_revision_id
          AND packed_item.image_run_id = delivery.image_run_id
      ) AND EXISTS (
        SELECT 1 FROM delivery_batch_items AS previous_item
        WHERE previous_item.task_id = task.id
          AND (previous_item.copy_revision_id <> delivery.copy_revision_id
            OR previous_item.image_run_id <> delivery.image_run_id)
      ))::bigint AS updated_count
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
      AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)
    WHERE delivery.status = 'READY' ${visibility}
    GROUP BY COALESCE(task.source_query_package_id, task.source_query_package_snapshot_id),
      task.source_query_package_name, task.source_client_batch_code,
      (task.source_query_package_id IS NULL AND task.source_query_package_snapshot_id IS NOT NULL)
    ORDER BY lower(task.source_query_package_name), task.source_query_package_name
  `, visibilityValues)]);
  const unassigned = packageFacets.rows
    .filter((row) => row.id === null || row.id === undefined)
    .reduce((summary, row) => ({
      count: summary.count + Number(row.count ?? 0),
      unuploadedCount: summary.unuploadedCount + Number(row.unuploaded_count ?? 0),
      publishedCount: summary.publishedCount + Number(row.published_count ?? 0),
      revokedCount: summary.revokedCount + Number(row.revoked_count ?? 0),
      packedCount: summary.packedCount + Number(row.packed_count ?? 0),
      pendingCount: summary.pendingCount + Number(row.pending_count ?? row.count ?? 0),
      updatedCount: summary.updatedCount + Number(row.updated_count ?? 0),
    }), { count: 0, unuploadedCount: 0, publishedCount: 0, revokedCount: 0,
      packedCount: 0, pendingCount: 0, updatedCount: 0 });
  const facetRows = packageFacets.rows.map((row) => ({
    id: row.id == null ? null : Number(row.id),
    name: row.name ?? null,
    clientBatchCode: row.client_batch_code ?? null,
    count: Number(row.count ?? 0),
    pendingCount: Number(row.pending_count ?? row.count ?? 0),
    packedCount: Number(row.packed_count ?? 0),
    updatedCount: Number(row.updated_count ?? 0),
  }));
  const summaryRows = facetRows.filter((row) =>
    (queryPackageName === null || row.name === queryPackageName)
      && (clientBatchCode === null || row.clientBatchCode === clientBatchCode));
  const summary = summaryRows.reduce((current, row) => ({
    readyCount: current.readyCount + row.count,
    pendingCount: current.pendingCount + row.pendingCount,
    packedCount: current.packedCount + row.packedCount,
    updatedCount: current.updatedCount + row.updatedCount,
  }), { readyCount: 0, pendingCount: 0, packedCount: 0, updatedCount: 0 });
  const clientBatchMap = new Map();
  for (const row of facetRows) {
    if (typeof row.clientBatchCode !== 'string') continue;
    const current = clientBatchMap.get(row.clientBatchCode) ?? {
      code: row.clientBatchCode,
      count: 0,
      pendingCount: 0,
      packedCount: 0,
      updatedCount: 0,
      queryPackageCount: 0,
    };
    current.count += row.count;
    current.pendingCount += row.pendingCount;
    current.packedCount += row.packedCount;
    current.updatedCount += row.updatedCount;
    if (row.id !== null) current.queryPackageCount += 1;
    clientBatchMap.set(row.clientBatchCode, current);
  }
  return {
    items: result.rows.map(deliveryFrom),
    total: Number(count.rows[0]?.total ?? 0),
    facets: {
      queryPackages: packageFacets.rows
        .filter((row) => Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0
          && typeof row.name === 'string' && row.name)
        .map((row) => ({
          id: Number(row.id),
          name: row.name,
          clientBatchCode: row.client_batch_code ?? null,
          deleted: row.deleted === true,
          count: Number(row.count ?? 0),
          unuploadedCount: Number(row.unuploaded_count ?? 0),
          publishedCount: Number(row.published_count ?? 0),
          revokedCount: Number(row.revoked_count ?? 0),
          pendingCount: Number(row.pending_count ?? row.count ?? 0),
          packedCount: Number(row.packed_count ?? 0),
          updatedCount: Number(row.updated_count ?? 0),
        })),
      clientBatches: [...clientBatchMap.values()]
        .sort((left, right) => left.code.localeCompare(right.code)),
      unassigned: unassigned.count > 0 ? unassigned : null,
    },
    summary,
  };
}

export async function listAllDeliveryPoolTaskIds(pool, rawActor, {
  queryPackageName: rawQueryPackageName = null,
  clientBatchCode: rawClientBatchCode = null,
  unpackedOnly = false,
} = {}) {
  const actor = normalizeActor(rawActor);
  if (actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can export the full delivery pool');
  }
  const queryPackageName = normalizeQueryPackageName(rawQueryPackageName);
  const clientBatchCode = normalizeClientBatchCode(rawClientBatchCode, { optional: true });
  const values = [];
  const packageFilter = queryPackageName === null ? '' : (() => {
    values.push(queryPackageName);
    return `AND task.source_query_package_name = $${values.length}`;
  })();
  const clientBatchFilter = clientBatchCode === null ? '' : (() => {
    values.push(clientBatchCode);
    return `AND task.source_client_batch_code = $${values.length}`;
  })();
  if (typeof unpackedOnly !== 'boolean') throw new TypeError('unpackedOnly must be boolean');
  const packedFilter = unpackedOnly ? `AND NOT EXISTS (
    SELECT 1 FROM delivery_batch_items AS packed_item
    WHERE packed_item.task_id = delivery.task_id
      AND packed_item.copy_revision_id = delivery.copy_revision_id
      AND packed_item.image_run_id = delivery.image_run_id
  )` : '';
  const result = await pool.query(`
    SELECT task.id AS task_id
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY' ${packageFilter} ${clientBatchFilter} ${packedFilter}
    ORDER BY delivery.approved_at DESC, delivery.id DESC
  `, values);
  return result.rows.map((row) => Number(row.task_id));
}

export async function listDeliveryPoolTaskIdsForPreview(pool, rawActor, {
  queryPackageIds: rawQueryPackageIds,
  includeUnassigned: rawIncludeUnassigned = false,
  taskIds: rawTaskIds = [],
  testTaskId: rawTestTaskId = null,
  limit: rawLimit = 50,
} = {}) {
  normalizeActor(rawActor);
  const queryPackageIds = normalizePreviewQueryPackageIds(rawQueryPackageIds);
  if (typeof rawIncludeUnassigned !== 'boolean') {
    throw new TypeError('includeUnassigned must be a boolean');
  }
  const includeUnassigned = rawIncludeUnassigned;
  if (queryPackageIds.length + Number(includeUnassigned) < 1
      || queryPackageIds.length + Number(includeUnassigned) > 200) {
    throw new RangeError('preview upload must explicitly select between 1 and 200 delivery sources');
  }
  const limit = normalizePreviewLimit(rawLimit);
  const testTaskId = rawTestTaskId === null || rawTestTaskId === undefined
    ? null
    : normalizeTaskId(rawTestTaskId);
  const taskIds = normalizePreviewTaskIds(rawTaskIds);
  if (testTaskId !== null && taskIds.length > 0) {
    throw new TypeError('testTaskId and taskIds cannot be used together');
  }
  if (testTaskId !== null && limit !== 1) {
    throw new RangeError('single-task preview testing requires limit 1');
  }
  if (taskIds.length > 0 && limit !== taskIds.length) {
    throw new RangeError('selected preview upload limit must match taskIds count');
  }
  const selectedTaskIds = taskIds.length > 0
    ? taskIds
    : testTaskId === null ? [] : [testTaskId];
  const values = [queryPackageIds, includeUnassigned, selectedTaskIds, limit];
  const result = await pool.query(`
    SELECT task.id AS task_id
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY'
      AND delivery.preview_id IS NULL
      AND (
        COALESCE(task.source_query_package_id, task.source_query_package_snapshot_id) = ANY($1::bigint[])
        OR ($2::boolean AND task.source_query_package_id IS NULL
          AND task.source_query_package_snapshot_id IS NULL)
      )
      AND (cardinality($3::bigint[]) = 0 OR task.id = ANY($3::bigint[]))
    ORDER BY delivery.approved_at DESC, delivery.id DESC
    LIMIT $4
  `, values);
  const matchedTaskIds = result.rows.map((row) => Number(row.task_id));
  if (selectedTaskIds.length > 0 && matchedTaskIds.length !== selectedTaskIds.length) {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_SELECTION_CHANGED',
      '所选交付项已上传或版本已变化，请刷新交付池后重新选择',
    );
  }
  return matchedTaskIds;
}

export async function recordDeliveryPreviewLinks(queryable, rawRecords, rawActor) {
  const actor = normalizeActor(rawActor);
  if (!Array.isArray(rawRecords) || rawRecords.length < 1 || rawRecords.length > 10) {
    throw new RangeError('preview links must contain between 1 and 10 items');
  }
  const records = rawRecords.map(normalizePreviewBinding);
  if (new Set(records.map((record) => record.deliveryEntryId)).size !== records.length
      || new Set(records.map((record) => record.previewId)).size !== records.length
      || new Set(records.map((record) => record.noteId)).size !== records.length) {
    throw new TypeError('preview link bindings must be unique');
  }

  const saved = [];
  for (const record of records) {
    const locked = await queryable.query(`
      SELECT delivery.preview_id, delivery.task_id, delivery.copy_revision_id,
        delivery.image_run_id, delivery.status,
        task.state, task.current_copy_revision_id, task.current_image_run_id
      FROM delivery_entries AS delivery
      JOIN tasks AS task ON task.id = delivery.task_id
      WHERE delivery.id = $1
      FOR UPDATE OF delivery
    `, [record.deliveryEntryId]);
    const row = locked.rows[0];
    if (!row || Number(row.task_id) !== record.taskId
        || Number(row.copy_revision_id) !== record.copyRevisionId
        || String(row.image_run_id) !== record.imageRunId) {
      throw new ControlPlaneConflictError(
        'DELIVERY_VERSION_CHANGED',
        '交付版本已变化，请刷新交付池后重试',
      );
    }
    if (row.preview_id && String(row.preview_id) !== record.previewId) {
      throw new ControlPlaneConflictError(
        'DELIVERY_PREVIEW_CONFLICT',
        '当前交付版本已经绑定其他预览链接',
      );
    }
    await queryable.query(`
      UPDATE delivery_entries
      SET preview_id = $2,
          preview_note_id = $3,
          preview_content_hash = $4,
          preview_status = 'PUBLISHED',
          preview_uploaded_by_account_id = $5,
          preview_uploaded_by_username = $6,
          preview_published_at = $7,
          preview_revoked_at = NULL
      WHERE id = $1
    `, [
      record.deliveryEntryId,
      record.previewId,
      record.noteId,
      record.contentHash,
      actor.userId,
      actor.username,
      record.publishedAt,
    ]);
    const currentReady = row.status === 'READY'
      && row.state === 'REVIEWED'
      && Number(row.current_copy_revision_id) === record.copyRevisionId
      && String(row.current_image_run_id) === record.imageRunId;
    saved.push({ ...record, currentReady });
  }
  return saved;
}

export async function markDeliveryPreviewRevoked(queryable, rawPreviewId, revokedAt = new Date()) {
  const previewId = normalizeUuid(rawPreviewId, 'previewId');
  const timestamp = new Date(revokedAt);
  if (!Number.isFinite(timestamp.valueOf())) throw new TypeError('preview revokedAt is invalid');
  await queryable.query(`
    WITH completed AS (
      UPDATE delivery_preview_revocation_jobs
      SET status = 'COMPLETED', completed_at = $2, lease_expires_at = NULL,
        last_error = NULL, updated_at = now()
      WHERE preview_id = $1
      RETURNING preview_id
    )
    UPDATE delivery_entries
    SET preview_status = 'REVOKED', preview_revoked_at = $2
    WHERE preview_id = $1
  `, [previewId, timestamp]);
}
