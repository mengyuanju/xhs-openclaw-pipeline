export async function readAccountQualityFacts(client, { start, end, accountId=null, stage='', batchId=null }) {
  const rows=(await client.query(`SELECT r.*,EXISTS(SELECT 1 FROM tasks WHERE id=r.task_id) AS task_exists
    FROM account_quality_records r WHERE first_qa_at >= $1 AND first_qa_at < $2
      AND ($3::bigint IS NULL OR operator_account_id=$3) AND ($4::text='' OR stage=$4)
      AND ($5::bigint IS NULL OR (data->>'batchId')::bigint=$5)
    ORDER BY first_qa_at,id LIMIT 50001`,[start,end,accountId,stage,batchId])).rows;
  if(rows.length>50000)throw new RangeError('统计范围超过 50,000 条判定，请缩小日期或选择人员');
  return rows.map(r=>({...r.data,id:`account-quality:${r.id}`,kind:'ACCOUNT_QUALITY',taskId:Number(r.task_id),
    stage:r.stage,accountId:Number(r.operator_account_id),at:r.first_qa_at.toISOString(),
    bucket:r.current_bucket,outcome:r.current_bucket,firstQaAt:r.first_qa_at.toISOString(),
    outcomeChangedAt:r.outcome_changed_at.toISOString(),outcomeVersion:Number(r.outcome_version),
    reassigned:r.reassigned,canOpen:r.task_exists}));
}
