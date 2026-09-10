import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
} from './domain.mjs';
import { resolveDeliveryArchiveSource } from './delivery-source.mjs';
import { normalizeListPagination } from './list-pagination.mjs';

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
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    query: row.query,
    queryPackageName: row.source_query_package_name ?? null,
    copyRevisionId: Number(row.copy_revision_id),
    imageRunId: row.image_run_id,
    status: row.status,
    approvedByUserId: row.approved_by_username,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

export async function createReadyDeliveryEntry(client, {
  taskId,
  copyRevisionId,
  imageRunId,
  actor,
}) {
  await assertDeliverySourceArchivable(client, { taskId, copyRevisionId, imageRunId });
  await client.query(`
    UPDATE delivery_entries SET status = 'WITHDRAWN', withdrawn_at = now()
    WHERE task_id = $1 AND status = 'READY'
  `, [taskId]);
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
    LEFT JOIN assets AS asset
      ON asset.task_id = $1 AND asset.image_run_id = image_run.id
      AND asset.media_type LIKE 'image/%'
    WHERE revision.id = $2 AND revision.task_id = $1
      AND revision.approved_at IS NOT NULL
    GROUP BY revision.content, image_run.result
  `, [taskId, copyRevisionId, imageRunId]);
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

export async function withdrawReadyDeliveryEntries(client, taskId) {
  await client.query(`
    UPDATE delivery_entries SET status = 'WITHDRAWN', withdrawn_at = now()
    WHERE task_id = $1 AND status = 'READY'
  `, [taskId]);
}

export async function assertTaskReadyForDelivery(queryable, rawTaskId) {
  const taskId = normalizeTaskId(rawTaskId);
  const result = await queryable.query(`
    SELECT delivery.*, task.query, task.source_query_package_name
    FROM tasks AS task
    JOIN delivery_entries AS delivery
      ON delivery.task_id = task.id AND delivery.status = 'READY'
      AND delivery.copy_revision_id = task.current_copy_revision_id
      AND delivery.image_run_id = task.current_image_run_id
    WHERE task.id = $1 AND task.state = 'REVIEWED'
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
} = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const queryPackageName = normalizeQueryPackageName(rawQueryPackageName);
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
  const limitParameter = filteredValues.length + 1;
  const values = [...filteredValues, limit, offset];
  const pagePromise = pool.query(`
    SELECT delivery.*, task.query, task.source_query_package_name
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY' ${visibility} ${packageFilter}
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
    WHERE delivery.status = 'READY' ${visibility} ${packageFilter}
  `, filteredValues), pool.query(`
    SELECT task.source_query_package_name AS name, COUNT(*)::bigint AS count
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY' ${visibility}
      AND task.source_query_package_name IS NOT NULL
    GROUP BY task.source_query_package_name
    ORDER BY lower(task.source_query_package_name), task.source_query_package_name
  `, visibilityValues)]);
  return {
    items: result.rows.map(deliveryFrom),
    total: Number(count.rows[0]?.total ?? 0),
    facets: {
      queryPackages: packageFacets.rows
        .filter((row) => typeof row.name === 'string' && row.name)
        .map((row) => ({ name: row.name, count: Number(row.count ?? 0) })),
    },
  };
}

export async function listAllDeliveryPoolTaskIds(pool, rawActor, {
  queryPackageName: rawQueryPackageName = null,
} = {}) {
  const actor = normalizeActor(rawActor);
  if (actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can export the full delivery pool');
  }
  const queryPackageName = normalizeQueryPackageName(rawQueryPackageName);
  const values = [];
  const packageFilter = queryPackageName === null ? '' : (() => {
    values.push(queryPackageName);
    return `AND task.source_query_package_name = $${values.length}`;
  })();
  const result = await pool.query(`
    SELECT task.id AS task_id
    FROM delivery_entries AS delivery
    JOIN tasks AS task ON task.id = delivery.task_id
      AND task.state = 'REVIEWED'
      AND task.current_copy_revision_id = delivery.copy_revision_id
      AND task.current_image_run_id = delivery.image_run_id
    WHERE delivery.status = 'READY' ${packageFilter}
    ORDER BY delivery.approved_at DESC, delivery.id DESC
  `, values);
  return result.rows.map((row) => Number(row.task_id));
}
