const LIMIT = 50_000;
const iso = value => value instanceof Date ? value.toISOString() : value;

export const QA_ACTIVITY_SQL = `SELECT e.*,EXISTS(SELECT 1 FROM tasks t WHERE t.id=e.task_id) AS task_exists
  FROM quality_review_activity_events e
  WHERE occurred_at >= $1 AND occurred_at < $2 AND occurred_at <= $3
    AND ($4::bigint IS NULL OR account_id=$4) AND ($5::text='' OR stage=$5)
    AND ($6::bigint IS NULL OR (data->>'batchId')::bigint=$6)
  ORDER BY occurred_at,event_key LIMIT ${LIMIT+1}`;

export const QA_PENDING_SQL = `WITH assigned AS (
  SELECT 'COPY'::text AS stage,i.id,i.public_id,i.task_id,NULL::bigint AS account_id,
    i.created_at AS assigned_review_at,i.sample_kind,i.final_approver_account_id AS submitter_id,
    i.copy_revision_id,NULL::uuid AS image_run_id,f.production_batch_id AS batch_id,
    t.query,t.priority_paused,false AS editing
  FROM copy_sampling_items i JOIN tasks t ON t.id=i.task_id JOIN copy_sampling_freezes f ON f.id=i.freeze_id
  WHERE i.selected AND i.status='PENDING' AND t.state='COPY_QC_PENDING' AND i.copy_revision_id=t.current_copy_revision_id
  UNION ALL
  SELECT 'IMAGE',i.id,i.public_id,i.task_id,NULL::bigint,i.created_at,i.sample_kind,
    i.submitter_account_id,i.copy_revision_id,i.image_run_id,f.production_batch_id,t.query,t.priority_paused,
    EXISTS(SELECT 1 FROM image_edit_requests edit WHERE edit.task_id=t.id AND edit.source_image_run_id=i.image_run_id
      AND edit.status IN ('DRAFT','QUEUED','RUNNING','PREVIEW_READY'))
  FROM image_sampling_items i JOIN tasks t ON t.id=i.task_id JOIN image_sampling_freezes f ON f.id=i.freeze_id
  WHERE i.selected AND i.status='PENDING' AND t.state='IMAGE_QC_PENDING'
    AND i.copy_revision_id=t.current_copy_revision_id AND i.image_run_id=t.current_image_run_id
)
SELECT a.*,u.id AS account_id,u.username,u.display_name,
  (a.priority_paused OR ($1::bigint IS NOT NULL AND (u.status<>'ACTIVE' OR NOT
    (u.role='ADMIN' OR (a.submitter_id<>u.id AND CASE WHEN a.stage='COPY' THEN u.copy_qc_enabled
      ELSE u.role='REVIEWER' AND u.image_qc_enabled END))))) AS blocked
FROM assigned a LEFT JOIN app_users u ON u.id=$1
WHERE ($1::bigint IS NULL OR (u.status='ACTIVE' AND (u.role='ADMIN' OR (a.submitter_id<>u.id AND CASE WHEN a.stage='COPY' THEN u.copy_qc_enabled ELSE u.role='REVIEWER' AND u.image_qc_enabled END)))) AND ($2::text='' OR a.stage=$2)
  AND ($3::bigint IS NULL OR a.batch_id=$3)
ORDER BY a.stage,a.id LIMIT ${LIMIT+1}`;

// Older batch events may predate affectedCount/affectedTaskIds. A freeze can
// only be batch-returned once, and its retained item statuses identify the
// affected members without assigning them to the content submitters.
async function legacyBatchImpactCounts(client, history) {
  const missing = history.filter(row => row.kind === 'QA_BATCH_RETURN'
    && !(Number.isSafeInteger(row.data?.affectedCount) && row.data.affectedCount >= 0)
    && !(Array.isArray(row.data?.affectedTaskIds)
      && row.data.affectedTaskIds.every(id => Number.isSafeInteger(id) && id > 0)));
  const result = new Map();
  for (const [stage, freezeTable, itemTable, status] of [
    ['COPY', 'copy_sampling_freezes', 'copy_sampling_items', 'BATCH_AFFECTED'],
    ['IMAGE', 'image_sampling_freezes', 'image_sampling_items', 'BATCH_RETURNED'],
  ]) {
    const ids = [...new Set(missing.filter(row => row.stage === stage)
      .map(row => Number(row.data?.freezeId)).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) continue;
    const rows = (await client.query(`SELECT f.id, count(i.id)::int AS affected_count
      FROM ${freezeTable} f LEFT JOIN ${itemTable} i ON i.freeze_id=f.id AND i.status=$2
      WHERE f.id=ANY($1::bigint[]) GROUP BY f.id`, [ids, status])).rows;
    for (const row of rows) result.set(`${stage}:${row.id}`, Number(row.affected_count));
  }
  return result;
}

export async function readQaFacts(client, { range, accountId = null, stage = '', batchId = null, asOf = new Date().toISOString() }) {
  const history = (await client.query(QA_ACTIVITY_SQL, [new Date(range.startMs).toISOString(),new Date(range.endMs).toISOString(),asOf,accountId,stage,batchId])).rows;
  const pending = (await client.query(QA_PENDING_SQL,[accountId,stage,batchId])).rows;
  if (history.length + pending.length > LIMIT) throw new RangeError('质检记录超过 50,000 条，请缩小统计范围');
  const recoveredCounts=await legacyBatchImpactCounts(client,history);
  return [...history.map(row=>({
    ...row.data,
    ...(recoveredCounts.has(`${row.stage}:${row.data?.freezeId}`)
      && !(Number.isSafeInteger(row.data?.affectedCount) && row.data.affectedCount >= 0)
      && !(Array.isArray(row.data?.affectedTaskIds) && row.data.affectedTaskIds.every(id => Number.isSafeInteger(id) && id > 0))
      ? {affectedCount:recoveredCounts.get(`${row.stage}:${row.data?.freezeId}`),affectedCountRecovered:true} : {}),
    id:row.event_key,accountId:row.account_id==null?null:Number(row.account_id),
    taskId:row.task_id==null?null:Number(row.task_id),stage:row.stage,kind:row.kind,at:iso(row.occurred_at),canOpen:row.task_exists})),
  ...pending.map(row=>({id:`qa-pending:${row.stage}:${row.id}`,accountId:row.account_id==null?null:Number(row.account_id),taskId:Number(row.task_id),
    username:row.username,displayName:row.display_name,query:row.query,stage:row.stage,kind:'QA_PENDING',at:iso(row.assigned_review_at),
    batchId:Number(row.batch_id),samplingItemId:Number(row.id),samplingItemPublicId:row.public_id,sampleKind:row.sample_kind,
    copyRevisionId:Number(row.copy_revision_id),imageRunId:row.image_run_id,blocked:row.blocked,passBlocked:row.editing,canOpen:true}))];
}
