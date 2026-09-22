import { ControlPlaneAuthorizationError, ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { assertTasksReadyForDelivery } from './final-delivery.mjs';

export function deliveryActor(raw) {
  if (!raw || !['ADMIN', 'USER'].includes(raw.role) || !Number.isSafeInteger(raw.userId) || raw.userId < 1
      || typeof raw.username !== 'string' || !raw.username.trim()) throw new ControlPlaneAuthorizationError();
  return { ...raw, username: raw.username.trim().toLowerCase() };
}

function enumValue(value, choices, fallback) {
  const normalized = value === undefined || value === '' ? fallback : value;
  if (!choices.includes(normalized)) throw new TypeError('交付筛选条件无效');
  return normalized;
}

export function deliveryDateBoundary(value, end = false) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError('日期格式应为 YYYY-MM-DD');
  const midnight = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(midnight) || new Date(midnight + 8 * 3600_000).toISOString().slice(0, 10) !== value) {
    throw new TypeError('交付日期无效');
  }
  return new Date(midnight + (end ? 86400_000 : 0)).toISOString();
}

export function normalizeDeliveryFilters(input = {}) {
  const from = deliveryDateBoundary(input.from), to = deliveryDateBoundary(input.to, true);
  if (from && to && from >= to) throw new TypeError('结束日期不能早于开始日期');
  const search = String(input.search ?? '').trim();
  if (search.length > 1000) throw new RangeError('搜索内容过长');
  const account = key => input[key] == null || input[key] === '' ? null : normalizeTaskId(input[key]);
  return {
    view: enumValue(input.view, ['CURRENT', 'HISTORY'], 'CURRENT'),
    state: enumValue(input.state, ['ALL', 'PENDING', 'UNPACKED', 'PACKED', 'DELIVERED'], 'ALL'),
    dateField: enumValue(input.dateField, ['READY', 'PACKED', 'DELIVERED', 'UPDATED'], 'READY'),
    archiveState: enumValue(input.archiveState, ['ALL', 'NO', 'YES'], 'ALL'),
    versionState: enumValue(input.versionState, ['ALL', 'UPDATED', 'HISTORICAL'], 'ALL'),
    from, to, search, assigneeId: account('assigneeId'), deliveredById: account('deliveredById'), packedById: account('packedById'),
    packageName: String(input.packageName ?? '').trim(), clientBatchCode: String(input.clientBatchCode ?? '').trim(),
  };
}

const CURRENT = `task.state='REVIEWED' AND delivery.status='READY'
  AND task.current_copy_revision_id=delivery.copy_revision_id AND task.current_image_run_id=delivery.image_run_id
  AND NOT (task.input @> '{"testRun":true}'::jsonb)
  AND (task.image_qc_legacy_accepted OR task.image_qc_released_approval_event_id IS NOT NULL)`;

// Both views use the same version identity, state, permissions and filter SQL.
export function deliveryLedgerQuery(input, rawActor, { itemIds, ignoreState = false } = {}) {
  const actor = deliveryActor(rawActor), filter = normalizeDeliveryFilters(input);
  const values = [actor.userId, actor.username];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const history = filter.view === 'HISTORY';
  const source = history
    ? `delivery_batch_items item LEFT JOIN tasks task ON task.id=item.task_id
       LEFT JOIN LATERAL (SELECT d.* FROM delivery_entries d WHERE d.task_id=item.task_id
         AND d.copy_revision_id=item.copy_revision_id AND d.image_run_id=item.image_run_id
         ORDER BY (d.status='READY') DESC,d.id DESC LIMIT 1) delivery ON true`
    : `delivery_entries delivery JOIN tasks task ON task.id=delivery.task_id
       LEFT JOIN delivery_batch_items item ON item.task_id=delivery.task_id
         AND item.copy_revision_id=delivery.copy_revision_id AND item.image_run_id=delivery.image_run_id`;
  const visibility = actor.role === 'ADMIN' ? 'true' : history
    ? `(assignee.id=$1 OR owner.account_id=$1 OR batch.created_by_account_id=$1 OR confirmation.actor_account_id=$1)`
    : 'assignee.id=$1';
  const clauses = [visibility, `$2::text<>''`];
  if (!history) clauses.push(CURRENT);
  else clauses.push(`(task.id IS NULL OR NOT (task.input @> '{"testRun":true}'::jsonb))`);
  if (itemIds) clauses.push(`item.id=ANY(${bind(itemIds)}::bigint[])`);
  const taskId = history ? 'item.task_id' : 'delivery.task_id';
  const revisionId = history ? 'item.copy_revision_id' : 'delivery.copy_revision_id';
  const runId = history ? 'item.image_run_id' : 'delivery.image_run_id';
  const query = history ? 'item.query_snapshot' : 'task.query';
  const packageName = history ? 'item.query_package_name_snapshot' : 'task.source_query_package_name';
  const clientBatch = history ? 'item.client_batch_code_snapshot' : 'task.source_client_batch_code';
  if (filter.assigneeId) clauses.push(`COALESCE(${history ? 'owner.account_id,' : ''}assignee.id)=${bind(filter.assigneeId)}`);
  if (filter.deliveredById) clauses.push(`confirmation.actor_account_id=${bind(filter.deliveredById)}`);
  if (filter.packedById) clauses.push(`batch.created_by_account_id=${bind(filter.packedById)}`);
  if (filter.packageName) clauses.push(`${packageName}=${bind(filter.packageName)}`);
  if (filter.clientBatchCode) clauses.push(`${clientBatch}=${bind(filter.clientBatchCode)}`);
  if (filter.search) {
    const term = bind(`%${filter.search.replace(/[\\%_]/gu, '\\$&')}%`);
    clauses.push(`(${query} ILIKE ${term} OR ${taskId}::text ILIKE ${term} OR batch.code ILIKE ${term})`);
  }
  const readyAt = 'COALESCE(delivery.approved_at,item.created_at)';
  const updatedAt = `GREATEST(${readyAt},batch.created_at,confirmation.confirmed_at)`;
  const dateSql = { READY: readyAt, PACKED: 'batch.created_at', DELIVERED: 'confirmation.confirmed_at', UPDATED: updatedAt }[filter.dateField];
  if (filter.from) clauses.push(`${dateSql}>=${bind(filter.from)}::timestamptz`);
  if (filter.to) clauses.push(`${dateSql}<${bind(filter.to)}::timestamptz`);
  const derived = [];
  if (!ignoreState && filter.state !== 'ALL') derived.push(filter.state === 'PENDING' ? `delivery_state<>'DELIVERED'` : `delivery_state=${bind(filter.state)}`);
  if (filter.archiveState !== 'ALL') derived.push(`archived_at IS ${filter.archiveState === 'YES' ? 'NOT ' : ''}NULL`);
  if (filter.versionState === 'UPDATED') derived.push(`version_updated`);
  if (filter.versionState === 'HISTORICAL') derived.push(`NOT is_current`);
  return { values, sql: `WITH records AS (
    SELECT item.id AS item_id,delivery.id AS entry_id,${taskId} AS task_id,${revisionId} AS copy_revision_id,${runId} AS image_run_id,
      ${query} AS query,${packageName} AS package_name,${clientBatch} AS client_batch_code,
      assignee.id AS assignee_id,task.assigned_to_user_id AS assignee_username,
      owner.account_id AS owner_id,owner.username AS owner_username,
      batch.id AS batch_id,batch.public_id AS batch_public_id,batch.code AS batch_code,
      batch.created_at AS packed_at,batch.created_by_username AS packed_by,batch.created_by_account_id AS packed_by_id,
      batch.archive_sha256 AS source_sha256,batch.archive_byte_size AS source_byte_size,
      batch_summary.visible_count AS batch_visible_count,batch_summary.delivered_count AS batch_delivered_count,
      confirmation.confirmed_at AS delivered_at,confirmation.actor_username AS delivered_by,
      confirmation.actor_account_id AS delivered_by_id,
      CASE WHEN confirmation.item_id IS NOT NULL THEN 'DELIVERED' WHEN item.id IS NOT NULL THEN 'PACKED' ELSE 'UNPACKED' END AS delivery_state,
      ${readyAt} AS ready_at,${updatedAt} AS updated_at,
      COALESCE((${CURRENT}) AND task.current_copy_revision_id=${revisionId} AND task.current_image_run_id=${runId},false) AS is_current,
      EXISTS (SELECT 1 FROM delivery_batch_items old JOIN delivery_item_confirmations c ON c.item_id=old.id
        WHERE old.task_id=${taskId} AND (old.copy_revision_id<>${revisionId} OR old.image_run_id<>${runId}))
        AND confirmation.item_id IS NULL AS version_updated,
      EXISTS (SELECT 1 FROM delivery_item_download_events e WHERE e.item_id=item.id AND e.actor_account_id=$1) AS downloaded_by_me,
      (SELECT max(j.finished_at) FROM delivery_archive_items a JOIN delivery_archive_jobs j ON j.id=a.job_id
        WHERE a.item_id=item.id AND j.kind='ARCHIVE' AND j.status='SUCCEEDED') AS archived_at,
      ${actor.role === 'ADMIN' ? 'true' : 'assignee.id=$1'} AS may_confirm
    FROM ${source}
    LEFT JOIN app_users assignee ON assignee.username=task.assigned_to_user_id AND assignee.created_at<task.assigned_at
    LEFT JOIN delivery_batches batch ON batch.id=item.delivery_batch_id
    LEFT JOIN delivery_item_owners owner ON owner.item_id=item.id
    LEFT JOIN delivery_item_confirmations confirmation ON confirmation.item_id=item.id
    LEFT JOIN LATERAL (SELECT count(*)::integer AS visible_count,
      count(*) FILTER (WHERE mc.item_id IS NOT NULL)::integer AS delivered_count
      FROM delivery_batch_items mi LEFT JOIN delivery_item_confirmations mc ON mc.item_id=mi.id
      LEFT JOIN delivery_item_owners mo ON mo.item_id=mi.id LEFT JOIN tasks mt ON mt.id=mi.task_id
      LEFT JOIN app_users ma ON ma.username=mt.assigned_to_user_id AND ma.created_at<mt.assigned_at
      WHERE mi.delivery_batch_id=batch.id AND ${actor.role === 'ADMIN' ? 'true' : '(mo.account_id=$1 OR ma.id=$1 OR batch.created_by_account_id=$1 OR mc.actor_account_id=$1)'}
    ) batch_summary ON batch.id IS NOT NULL
    WHERE ${clauses.join(' AND ')}
  ) SELECT * FROM records ${derived.length ? `WHERE ${derived.join(' AND ')}` : ''}` };
}

const iso = value => value instanceof Date ? value.toISOString() : value ?? null;
export function deliveryItemFrom(row, rawActor) {
  const actor = deliveryActor(rawActor);
  return {
    itemId: row.item_id == null ? null : Number(row.item_id), entryId: row.entry_id == null ? null : Number(row.entry_id),
    taskId: Number(row.task_id), copyRevisionId: Number(row.copy_revision_id), imageRunId: row.image_run_id, query: row.query,
    packageName: actor.role === 'ADMIN' ? row.package_name : null, clientBatchCode: actor.role === 'ADMIN' ? row.client_batch_code : null,
    assigneeId: row.assignee_id == null ? null : Number(row.assignee_id), assigneeUsername: row.assignee_username,
    ownerUsername: row.owner_username, batchCode: row.batch_code, batchPublicId: row.batch_public_id,
    batchVisibleCount: Number(row.batch_visible_count ?? 0), batchDeliveredCount: Number(row.batch_delivered_count ?? 0),
    state: row.delivery_state, packedBy: row.packed_by, packedAt: iso(row.packed_at),
    deliveredBy: row.delivered_by, deliveredAt: iso(row.delivered_at), readyAt: iso(row.ready_at), updatedAt: iso(row.updated_at),
    archivedAt: actor.role === 'ADMIN' ? iso(row.archived_at) : null,
    isCurrent: row.is_current === true, versionUpdated: row.version_updated === true,
    downloadedByMe: row.downloaded_by_me === true,
    canConfirm: row.may_confirm === true && row.is_current === true && row.delivery_state === 'PACKED' && row.downloaded_by_me === true,
  };
}

export async function inDeliveryTransaction(pool, operation, { readOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function listDeliveryItems(pool, input, rawActor) {
  const actor = deliveryActor(rawActor), { limit, offset } = normalizeListPagination(input.limit ?? 50, input.offset ?? 0);
  return inDeliveryTransaction(pool, async client => {
    const query = deliveryLedgerQuery(input, actor), summaryQuery = deliveryLedgerQuery(input, actor, { ignoreState: true });
    const rows = await client.query(`${query.sql} ORDER BY updated_at DESC,task_id DESC,item_id DESC NULLS LAST
      LIMIT $${query.values.length+1} OFFSET $${query.values.length+2}`, [...query.values, limit, offset]);
    const total = (await client.query(`SELECT count(*)::integer AS total FROM (${query.sql}) q`,query.values)).rows[0].total;
    const summary = (await client.query(`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE delivery_state='UNPACKED')::integer AS unpacked,
      count(*) FILTER (WHERE delivery_state='PACKED')::integer AS packed,
      count(*) FILTER (WHERE delivery_state='DELIVERED')::integer AS delivered,
      count(*) FILTER (WHERE version_updated)::integer AS updated FROM (${summaryQuery.sql}) q`,summaryQuery.values)).rows[0];
    return { items: rows.rows.map(row=>deliveryItemFrom(row,actor)), total, summary, updatedAt:new Date().toISOString() };
  }, { readOnly:true });
}

export function normalizeDeliveryItemIds(input, maximum = 200) {
  if (!Array.isArray(input) || !input.length || input.length > maximum) throw new RangeError(`请选择 1 至 ${maximum} 条内容`);
  const ids = input.map(normalizeTaskId);
  if (new Set(ids).size !== ids.length) throw new TypeError('选择的内容不能重复');
  return ids.sort((a,b)=>a-b);
}

export async function confirmDeliveryItems(pool, input, rawActor) {
  return inDeliveryTransaction(pool, client => confirmDeliveryItemSelection(client, input, rawActor));
}

export async function confirmDeliveryItemSelection(client, input, rawActor) {
  const actor = deliveryActor(rawActor), ids = normalizeDeliveryItemIds(input.itemIds);
    // Always lock batches in the same order as the legacy whole-batch path.
    await client.query(`SELECT id FROM delivery_batches WHERE id IN
      (SELECT delivery_batch_id FROM delivery_batch_items WHERE id=ANY($1::bigint[])) ORDER BY id FOR UPDATE`,[ids]);
    await client.query(`SELECT id FROM tasks WHERE id IN
      (SELECT task_id FROM delivery_batch_items WHERE id=ANY($1::bigint[])) ORDER BY id FOR UPDATE`,[ids]);
    const query = deliveryLedgerQuery({view:'HISTORY'},actor,{itemIds:ids});
    const rows = (await client.query(query.sql,query.values)).rows;
    if (rows.length!==ids.length) throw new ControlPlaneAuthorizationError('部分交付内容不存在或无权操作');
    const pending = rows.filter(row=>row.delivery_state!=='DELIVERED');
    if (pending.some(row=>!row.may_confirm)) throw new ControlPlaneAuthorizationError('只能确认当前本人负责的内容');
    if (pending.some(row=>!row.is_current)) throw new ControlPlaneConflictError('DELIVERY_VERSION_CHANGED','部分内容已返工或版本变化，请刷新后重试');
    if (pending.some(row=>!row.downloaded_by_me)) throw new ControlPlaneConflictError('DELIVERY_BATCH_NOT_DOWNLOADED','请先下载所选内容，实际发送后再确认交付');
    // Lock the same readiness rows as original packaging and recheck all gates.
    if (pending.length) {
      await client.query('SELECT id FROM delivery_entries WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[pending.map(row=>row.entry_id)]);
      await assertTasksReadyForDelivery(client,pending.map(row=>({taskId:Number(row.task_id),copyRevisionId:Number(row.copy_revision_id),imageRunId:row.image_run_id})));
      await client.query(`INSERT INTO delivery_item_confirmations(item_id,actor_account_id,actor_username,source)
        SELECT id,$2,$3,'ITEM' FROM delivery_batch_items WHERE id=ANY($1::bigint[]) ON CONFLICT DO NOTHING`,[pending.map(row=>row.item_id),actor.userId,actor.username]);
      await client.query(`UPDATE delivery_batches batch SET status='DELIVERED',delivered_at=now(),
        delivered_by_account_id=$2,delivered_by_username=$3
        WHERE batch.id=ANY($1::bigint[]) AND batch.status<>'DELIVERED' AND NOT EXISTS
          (SELECT 1 FROM delivery_batch_items i LEFT JOIN delivery_item_confirmations c ON c.item_id=i.id
            WHERE i.delivery_batch_id=batch.id AND c.item_id IS NULL)`,[[...new Set(pending.map(row=>row.batch_id))],actor.userId,actor.username]);
    }
    return { confirmed:pending.length,alreadyConfirmed:rows.length-pending.length };
}

export async function confirmDeliveryBatchMembers(client, rawPublicId, rawActor) {
  const actor=deliveryActor(rawActor),publicId=normalizeUuid(rawPublicId,'deliveryBatchId');
  const batch=(await client.query('SELECT * FROM delivery_batches WHERE public_id=$1 FOR UPDATE',[publicId])).rows[0];
  if(!batch || (actor.role==='USER' && (batch.created_by_role!=='USER'
    || Number(batch.created_by_account_id)!==actor.userId || batch.created_by_username!==actor.username))) {
    throw new ControlPlaneNotFoundError('delivery batch not found');
  }
  if(batch.status==='DELIVERED')return;
  const ids=(await client.query('SELECT id FROM delivery_batch_items WHERE delivery_batch_id=$1 ORDER BY id',[batch.id])).rows.map(row=>Number(row.id));
  if(ids.length!==Number(batch.task_count))throw new ControlPlaneConflictError('DELIVERY_BATCH_SOURCE_MISSING','原批次成员不完整，无法确认交付');
  for(let offset=0;offset<ids.length;offset+=200) {
    await confirmDeliveryItemSelection(client,{itemIds:ids.slice(offset,offset+200)},actor);
  }
  await client.query(`INSERT INTO delivery_batch_confirmation_events(delivery_batch_id,actor_account_id,actor_username)
    VALUES ($1,$2,$3)`,[batch.id,actor.userId,actor.username]);
}

export async function selectDeliveryArchiveItems(client, input, rawActor) {
  const actor = deliveryActor(rawActor);
  const kind = enumValue(input.kind,['DOWNLOAD','ARCHIVE'],'ARCHIVE');
  if (kind==='ARCHIVE' && actor.role!=='ADMIN') throw new ControlPlaneAuthorizationError();
  const ids = input.itemIds ? normalizeDeliveryItemIds(input.itemIds,2000) : null;
  if (!ids && kind!=='ARCHIVE') throw new TypeError('下载需要明确选择内容');
  const query = deliveryLedgerQuery(ids ? {view:'HISTORY'} : {...input.filters,state:'DELIVERED'},actor,{itemIds:ids});
  const rows = (await client.query(`SELECT selected.*,source.issued_query FROM (${query.sql}) selected
    LEFT JOIN tasks source_task ON source_task.id=selected.task_id
    LEFT JOIN query_package_items source ON source.id=source_task.source_query_package_item_id
    ORDER BY selected.task_id,selected.item_id LIMIT 2001`,query.values)).rows;
  if (ids && rows.length!==ids.length) throw new ControlPlaneAuthorizationError('部分内容不存在或无权访问');
  if (!rows.length) throw new ControlPlaneConflictError('DELIVERY_EMPTY','当前范围没有可保存内容');
  if (rows.length>2000) throw new RangeError('单次最多汇总 2000 条，请缩小日期或人员范围');
  if (rows.some(row=>!row.item_id || (kind==='ARCHIVE' && row.delivery_state!=='DELIVERED'))) {
    throw new ControlPlaneConflictError('DELIVERY_STATE_CHANGED','汇总保存只能包含已确认交付的内容，请刷新选择');
  }
  return {kind, rows};
}
