const MAX_FACTS = 50_000;
const iso = value => value instanceof Date ? value.toISOString() : value;

export const PERSONAL_QA_COVERAGE_SQL = `SELECT e.* FROM quality_review_coverage_events e
  WHERE e.account_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
  ORDER BY e.occurred_at,e.event_key LIMIT ${MAX_FACTS + 1}`;

// Older copy v2 batch impacts are durable producer facts, but reviewerId is the
// triggering reviewer. The top-level account_id belongs to the annotator.
export const PERSONAL_LEGACY_COPY_IMPACTS_SQL = `SELECT e.* FROM account_quality_events e
  WHERE e.data->>'source'='BATCH_AFFECTED' AND e.action='RETURN'
    AND e.data->>'reviewerId'=$1::text AND e.occurred_at >= $2 AND e.occurred_at < $3
    AND NOT EXISTS (SELECT 1 FROM quality_review_coverage_events covered
      WHERE covered.stage='COPY' AND covered.kind='BATCH_RETURN'
        AND covered.review_item_key='COPY:v2:'||(e.data->>'samplingItemId'))
  ORDER BY e.occurred_at,e.event_key LIMIT ${MAX_FACTS + 1}`;

// Historical releases do not carry a trustworthy member-level personal owner.
// Report the gap only to a reviewer who participated in that affected batch.
export const PERSONAL_UNATTRIBUTED_RELEASES_SQL = `SELECT DISTINCT missing.stage FROM (
  SELECT 'COPY'::text AS stage FROM copy_qa_batches_v2 batch
  WHERE batch.completed_at >= $2 AND batch.completed_at < $3
    AND EXISTS (SELECT 1 FROM copy_qa_batch_members_v2 member
      WHERE member.batch_id=batch.id AND member.status='RELEASED')
    AND EXISTS (SELECT 1 FROM quality_review_activity_events activity
      WHERE activity.account_id=$1 AND activity.stage='COPY'
        AND activity.data->>'qaBatchId'=batch.id::text AND activity.data->>'exclusion' IS NULL)
    AND NOT EXISTS (SELECT 1 FROM quality_review_coverage_events covered
      WHERE covered.stage='COPY' AND covered.kind='BATCH_RELEASE' AND covered.data->>'qaBatchId'=batch.id::text)
  UNION ALL
  SELECT 'IMAGE' FROM image_sampling_events released
  WHERE released.action='RELEASE' AND released.actor_account_id=$1
    AND released.created_at >= $2 AND released.created_at < $3
    AND released.details->>'coverageRecorded' IS DISTINCT FROM 'true'
    AND NOT EXISTS (SELECT 1 FROM quality_review_coverage_events covered
      WHERE covered.stage='IMAGE' AND covered.kind='BATCH_RELEASE'
        AND covered.data->>'sourceEventId'=released.id::text)
) missing`;

export async function readPersonalQaCoverage(client, actor, range) {
  const values = [actor.userId, new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString()];
  const current = (await client.query(PERSONAL_QA_COVERAGE_SQL, values)).rows;
  const legacy = (await client.query(PERSONAL_LEGACY_COPY_IMPACTS_SQL, values)).rows;
  const missing = (await client.query(PERSONAL_UNATTRIBUTED_RELEASES_SQL, values)).rows;
  if (current.length + legacy.length > MAX_FACTS) throw new RangeError('今日质检覆盖记录超出统计上限');
  return [...current.map(row => ({ ...row.data, id:row.event_key, accountId:Number(row.account_id),
    taskId:Number(row.task_id), stage:row.stage, kind:row.kind, at:iso(row.occurred_at),
    reviewItemKey:row.review_item_key, operationKey:row.operation_key,
    outcome:row.kind === 'BATCH_RELEASE' ? 'RELEASE' : 'RETURN' })),
  ...legacy.map(row => ({ ...row.data, id:`legacy-coverage:${row.event_key}`, accountId:actor.userId,
    taskId:Number(row.task_id), stage:row.stage, kind:'BATCH_RETURN', at:iso(row.occurred_at), outcome:'RETURN',
    reviewItemKey:`COPY:v2:${row.data.samplingItemId}`, operationKey:`COPY:v2:${row.data.qaBatchId}:BATCH_RETURN` })),
  ...missing.map(row => ({ id:`unknown-release:${row.stage}`, stage:row.stage, kind:'COVERAGE_UNKNOWN' }))];
}
