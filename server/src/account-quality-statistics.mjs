const LIMIT = 50_000;
const iso = value => value instanceof Date ? value.toISOString() : value;

function batchCount(data) {
  const count=data?.affectedCount;
  const value=Number(count);
  if ((typeof count==='number' || typeof count==='string' && /^\d+$/u.test(count))
    && Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(data?.affectedTaskIds)
    && data.affectedTaskIds.every(id => Number.isSafeInteger(Number(id)) && Number(id) > 0)) {
    return data.affectedTaskIds.length;
  }
  return null;
}

export async function readAccountQualityFacts(client, { start, end, accountId = null, stage = '', batchId = null }) {
  const rows = (await client.query(`SELECT r.*,EXISTS(SELECT 1 FROM tasks WHERE id=r.task_id) AS task_exists,
      u.username AS current_username,u.display_name AS current_display_name
    FROM account_quality_records r LEFT JOIN app_users u ON u.id=r.operator_account_id
    WHERE r.first_qa_at >= $1 AND r.first_qa_at < $2
      AND ($3::bigint IS NULL OR r.operator_account_id=$3) AND ($4::text='' OR r.stage=$4)
      AND ($5::bigint IS NULL OR (r.data->>'batchId')::bigint=$5)
    ORDER BY r.first_qa_at,r.id LIMIT ${LIMIT+1}`,[start,end,accountId,stage,batchId])).rows;
  if (rows.length > LIMIT) throw new RangeError('统计范围超过 50,000 条判定，请缩小日期或选择人员');
  const facts = rows.map(row => {
    const common = { ...row.data,taskId:Number(row.task_id),stage:row.stage,
      accountId:Number(row.operator_account_id),at:iso(row.first_qa_at),
      username:row.current_username ?? row.data?.username,
      displayName:row.current_display_name ?? row.data?.displayName,
      firstQaAt:iso(row.first_qa_at),outcomeChangedAt:iso(row.outcome_changed_at),
      outcomeVersion:Number(row.outcome_version),reassigned:row.reassigned,canOpen:row.task_exists };
    return { ...common,id:`account-quality:${row.id}`,kind:'ACCOUNT_QUALITY',
      bucket:row.current_bucket,outcome:row.current_bucket };
  });

  // Every valid QA decision counts on its Beijing day. A copy batch trigger
  // can also have an individual QUALITY return for the very same operation;
  // suppress only that matched duplicate, keeping other affected members.
  const verdicts = (await client.query(`WITH decisions AS (
      SELECT e.*,to_char(e.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS verdict_day
      FROM account_quality_events e
      WHERE e.action IN ('PASS','RETURN') AND e.occurred_at >= $1 AND e.occurred_at < $2
        AND ($3::bigint IS NULL OR e.account_id=$3) AND ($4::text='' OR e.stage=$4)
        AND ($5::bigint IS NULL OR (e.data->>'batchId')::bigint=$5)
        AND NOT (COALESCE(e.data->>'source'='BATCH_RETURN',false) AND EXISTS (
          SELECT 1 FROM account_quality_events individual
          WHERE individual.task_id=e.task_id AND individual.stage=e.stage
            AND individual.account_id=e.account_id AND individual.action='RETURN'
            AND individual.data->>'source' IS DISTINCT FROM 'BATCH_RETURN'
            AND date_trunc('milliseconds',individual.occurred_at)=date_trunc('milliseconds',e.occurred_at)
            AND individual.data->>'samplingItemId'=COALESCE(e.data->>'samplingItemId',
              substring(e.event_key from '[0-9]+$'))))
        AND NOT (COALESCE(e.data->>'source'='BATCH_RETURN',false) AND EXISTS (
          SELECT 1 FROM account_quality_events duplicate
          WHERE duplicate.task_id=e.task_id AND duplicate.stage=e.stage
            AND duplicate.account_id=e.account_id AND duplicate.action='RETURN'
            AND duplicate.data->>'source'='BATCH_RETURN'
            AND date_trunc('milliseconds',duplicate.occurred_at)=date_trunc('milliseconds',e.occurred_at)
            AND duplicate.sequence_id<e.sequence_id
            AND COALESCE('item:'||(duplicate.data->>'samplingItemId'),
              'item:'||substring(duplicate.event_key from '[0-9]+$'),
              'freeze:'||(duplicate.data->>'freezeId'),'batch:'||(duplicate.data->>'batchId'))
              =COALESCE('item:'||(e.data->>'samplingItemId'),
                'item:'||substring(e.event_key from '[0-9]+$'),
                'freeze:'||(e.data->>'freezeId'),'batch:'||(e.data->>'batchId'))))
      ORDER BY e.occurred_at,e.sequence_id LIMIT ${LIMIT+1}
    ) SELECT decisions.*,r.first_qa_at,r.outcome_changed_at,r.outcome_version,r.reassigned,
        r.data AS record_data,u.username AS current_username,u.display_name AS current_display_name,
        t.query AS current_query,t.production_batch_id, (t.id IS NOT NULL) AS task_exists,
        EXISTS (SELECT 1 FROM account_quality_events previous
          WHERE previous.task_id=decisions.task_id AND previous.stage=decisions.stage
            AND previous.account_id=decisions.account_id AND previous.action='RETURN'
            AND (previous.occurred_at,previous.sequence_id)<(decisions.occurred_at,decisions.sequence_id)) AS had_return,
        (COALESCE(decisions.data->>'source'='BATCH_RETURN',false) OR decisions.action='RETURN' AND EXISTS (
          SELECT 1 FROM account_quality_events batch
          WHERE batch.task_id=decisions.task_id AND batch.stage=decisions.stage
            AND batch.account_id=decisions.account_id AND batch.action='RETURN'
            AND batch.data->>'source'='BATCH_RETURN'
            AND date_trunc('milliseconds',batch.occurred_at)=date_trunc('milliseconds',decisions.occurred_at)
            AND COALESCE(batch.data->>'samplingItemId',substring(batch.event_key from '[0-9]+$'))
              =decisions.data->>'samplingItemId')) AS from_batch
      FROM decisions LEFT JOIN account_quality_records r ON r.task_id=decisions.task_id AND r.stage=decisions.stage
        AND r.operator_account_id=decisions.account_id
      LEFT JOIN app_users u ON u.id=decisions.account_id LEFT JOIN tasks t ON t.id=decisions.task_id
      ORDER BY decisions.occurred_at,decisions.sequence_id`,[start,end,accountId,stage,batchId])).rows;
  if (verdicts.length > LIMIT) throw new RangeError('统计范围超过 50,000 次判定，请缩小日期或选择人员');
  for (const row of verdicts) {
    const day=row.verdict_day;
    const finalPassed=row.action==='PASS';
    const firstPassed=finalPassed && !row.had_return
      && (row.data?.sampleKind??row.record_data?.sampleKind)!=='MANDATORY_RECHECK';
    const factBatchId=row.data?.batchId??row.record_data?.batchId??row.production_batch_id;
    facts.push({...row.record_data,...row.data,
      id:`annotation-quality:${row.event_key}`,
      kind:'ANNOTATION_QUALITY',taskId:Number(row.task_id),stage:row.stage,
      accountId:Number(row.account_id),at:iso(row.occurred_at),day,
      username:row.current_username??row.data?.username??row.record_data?.username,
      displayName:row.current_display_name??row.data?.displayName??row.record_data?.displayName,
      query:row.current_query??row.data?.query??row.record_data?.query,
      batchId:factBatchId==null?null:Number(factBatchId),
      firstQaAt:iso(row.first_qa_at),outcomeChangedAt:iso(row.outcome_changed_at),
      outcomeVersion:row.outcome_version==null?null:Number(row.outcome_version),
      reassigned:row.reassigned??false,canOpen:row.task_exists,exclusion:null,
      outcome:row.action,firstPassed,reworkPassed:finalPassed&&!firstPassed,finalPassed,
      fromBatch:row.from_batch});
  }
  if (accountId !== null) return facts;

  // A batch's stored total cannot be charged to individual annotators when
  // no durable member/approval identity can be recovered. Expose the gap.
  const batches = (await client.query(`SELECT batch.event_key,batch.stage,batch.occurred_at,batch.data,
      count(DISTINCT COALESCE('item:'||(member.data->>'samplingItemId'),
        'item:'||substring(member.event_key from '[0-9]+$'),
        'task:'||member.task_id::text||':'||member.account_id::text))
        FILTER (WHERE member.data->>'batchTrigger'='false')::int AS known_count
    FROM quality_review_activity_events batch LEFT JOIN account_quality_events member
      ON member.stage=batch.stage AND member.data->>'source'='BATCH_RETURN'
      AND (member.data->>'freezeId'=batch.data->>'freezeId'
        OR (member.data->>'freezeId' IS NULL
          AND date_trunc('milliseconds',member.occurred_at)=date_trunc('milliseconds',batch.occurred_at)
          AND member.data->>'batchId'=batch.data->>'batchId'))
    WHERE batch.kind='QA_BATCH_RETURN' AND batch.occurred_at >= $1 AND batch.occurred_at < $2
      AND ($3::text='' OR batch.stage=$3)
      AND ($4::bigint IS NULL OR (batch.data->>'batchId')::bigint=$4)
    GROUP BY batch.event_key,batch.stage,batch.occurred_at,batch.data
    ORDER BY batch.occurred_at,batch.event_key LIMIT ${LIMIT+1}`,[start,end,stage,batchId])).rows;
  if (batches.length > LIMIT) throw new RangeError('统计范围超过 50,000 次整批打回，请缩小日期');
  for (const batch of batches) {
    if (batch.data?.exclusion === 'SIMULATED') continue;
    const total = batchCount(batch.data),known = Number(batch.known_count);
    const unknownCount = total === null ? null : Math.max(0,total-known);
    if (unknownCount === 0) continue;
    facts.push({ id:`annotation-unknown-batch:${batch.event_key}`,kind:'ANNOTATION_UNKNOWN_BATCH',
      taskId:null,accountId:null,stage:batch.stage,at:iso(batch.occurred_at),
      batchId:batch.data?.batchId == null ? null : Number(batch.data.batchId),
      affectedCount:total,knownCount:known,unknownCount,unknownScope:total === null });
  }
  return facts;
}
