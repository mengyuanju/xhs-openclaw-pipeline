import { annotateInspectionRounds } from '../../src/quality-rounds.mjs';

export async function readInspectionRounds(client,events,asOf) {
  const taskIds=[...new Set(events.map(row=>row.taskId).filter(Number.isSafeInteger))];
  if(!taskIds.length) return events;
  const result=await client.query(`SELECT l.*,e.data->>'outcome' AS outcome,e.data->>'exclusion' AS exclusion
    FROM quality_inspection_links l LEFT JOIN operator_performance_events e
      ON e.event_key=lower(l.stage)||'-qa:'||l.item_id AND e.occurred_at <= $2
    WHERE l.task_id=ANY($1::bigint[]) AND l.created_at <= $2 LIMIT 50001`,[taskIds,asOf]);
  if(result.rows.length>50000) throw new RangeError('质检轮次记录超出统计上限，请缩小范围');
  const links=result.rows.map(row=>({stage:row.stage,itemId:Number(row.item_id),taskId:Number(row.task_id),
    approvalId:Number(row.approval_id),parentItemId:row.parent_item_id==null?null:Number(row.parent_item_id),
    sampleKind:row.sample_kind,submitterId:row.submitter_id==null?null:Number(row.submitter_id),outcome:row.outcome,exclusion:row.exclusion}));
  return annotateInspectionRounds(events,links);
}
