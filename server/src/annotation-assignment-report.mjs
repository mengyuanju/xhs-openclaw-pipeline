import { annotateAssignmentCycles, firstCopyAssignmentCohort, isAnnotationWork } from '../../src/annotation-assignment-cycles.mjs';
import { readAnnotationDiscardFacts } from './annotation-discard-facts.mjs';

const LIMIT=50_000,MERGED_LIMIT=200_000;
const iso=value=>value instanceof Date?value.toISOString():value;
const id=value=>value==null?null:Number(value);

export const ANNOTATION_SUBMISSIONS_SQL=`/* annotation-assignment:submissions */
  SELECT event_key,task_id,account_id,stage,occurred_at,sequence_id,data
  FROM operator_performance_events
  WHERE task_id=ANY($1::bigint[]) AND occurred_at<=$2::timestamptz
    AND kind='SUBMIT' AND account_id IS NOT NULL AND data->>'exclusion' IS NULL
  ORDER BY occurred_at,sequence_id LIMIT 50001`;

export const ANNOTATION_ASSIGNMENTS_SQL=`/* annotation-assignment:assignments */
  SELECT 'event:'||event.id AS id,event.id AS ordering,event.task_id,'EVENT'::text AS kind,
    current_actor.id AS account_id,event.assignee_user_id AS username,event.created_at AS occurred_at,
    previous_actor.id AS previous_account_id,event.previous_assignee_user_id AS previous_username,
    NULL::timestamptz AS ended_at,false AS baseline
  FROM task_assignment_events event
  LEFT JOIN app_users current_actor ON current_actor.username=event.assignee_user_id
    AND current_actor.created_at<=event.created_at
  LEFT JOIN app_users previous_actor ON previous_actor.username=event.previous_assignee_user_id
    AND previous_actor.created_at<=event.created_at
  WHERE event.task_id=ANY($1::bigint[]) AND event.created_at<=$2::timestamptz
  UNION ALL
  SELECT 'record:'||record.id,record.id,record.task_id,'RECORD',record.assignee_account_id,
    record.assignee_username_snapshot,record.assigned_at,NULL::bigint,NULL::text,record.ended_at,
    (record.baseline OR record.source='MIGRATION_BASELINE')
  FROM task_assignment_records record
  WHERE record.task_id=ANY($1::bigint[]) AND record.assigned_at<=$2::timestamptz
  ORDER BY task_id,occurred_at,ordering LIMIT 50001`;

// Each cohort row names the exact first approval in one person's handoff cycle.
// Later revisions, old owners and a former cycle of the same person cannot
// supply its result. Batch returns are effective failed submissions too.
export const ANNOTATION_FIRST_COPY_SQL=`/* annotation-assignment:first-copy */
  WITH cohort AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
      cycle_key text,task_id bigint,account_id bigint,approval_id bigint,
      copy_revision_id bigint,submitted_at timestamptz)
  )
  SELECT cohort.cycle_key,cohort.task_id,cohort.account_id,quality.action AS outcome,
    CASE WHEN quality.action IS NOT NULL THEN NULL
      WHEN direct.present THEN 'ADMIN_DIRECT'
      WHEN sampling.pending THEN 'PENDING'
      WHEN sampling.not_selected THEN 'NOT_SELECTED'
      WHEN sampling.sample_count=0 AND task.state='COPY_QC_PENDING'
        AND task.current_copy_revision_id=approval.copy_revision_id THEN 'PENDING'
      ELSE 'NO_RECORD' END AS reason
  FROM cohort
  LEFT JOIN LATERAL (
    SELECT approved.* FROM copy_approval_events approved
    WHERE approved.task_id=cohort.task_id AND approved.approved_by_account_id=cohort.account_id
      AND (cohort.approval_id IS NOT NULL AND approved.id=cohort.approval_id
        OR cohort.approval_id IS NULL AND approved.copy_revision_id=cohort.copy_revision_id)
      AND approved.approved_at<=$2::timestamptz
    ORDER BY approved.approved_at,approved.id LIMIT 1
  ) approval ON true
  LEFT JOIN tasks task ON task.id=cohort.task_id
  LEFT JOIN LATERAL (
    SELECT EXISTS(SELECT 1 FROM copy_qa_admin_direct_approvals bypass
      WHERE bypass.approval_event_id=COALESCE(approval.id,cohort.approval_id)
        AND bypass.created_at<=$2::timestamptz) AS present
  ) direct ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS sample_count,
      COALESCE(bool_or(sample.selected AND sample.status='PENDING'),false) AS pending,
      COALESCE(bool_or(NOT sample.selected),false) AS not_selected
    FROM (
      SELECT item.selected,item.status FROM copy_sampling_items item
      WHERE item.approval_event_id=COALESCE(approval.id,cohort.approval_id)
        AND item.created_at<=$2::timestamptz
      UNION ALL
      SELECT member.selected,member.status FROM copy_qa_batch_members_v2 member
      WHERE member.approval_event_id=COALESCE(approval.id,cohort.approval_id)
        AND member.created_at<=$2::timestamptz
    ) sample
  ) sampling ON true
  LEFT JOIN LATERAL (
    SELECT verdict.action FROM account_quality_events verdict
    WHERE verdict.task_id=cohort.task_id AND verdict.stage='COPY'
      AND verdict.account_id=cohort.account_id AND verdict.establishes_sample
      AND verdict.action IN ('PASS','RETURN','DISCARD')
      AND verdict.occurred_at>=cohort.submitted_at AND verdict.occurred_at<=$2::timestamptz
      AND NOT direct.present
      AND (verdict.data->>'reviewerId' IS NULL OR verdict.data->>'reviewerId'<>cohort.account_id::text)
      AND (verdict.data->>'exclusion' IS NULL OR verdict.data->>'exclusion'='SELF_REVIEW'
        AND verdict.data->>'reviewerId' IS NOT NULL AND verdict.data->>'reviewerId'<>cohort.account_id::text)
      AND verdict.data->>'directAdminApproval' IS DISTINCT FROM 'true'
      AND verdict.data->>'source' IS DISTINCT FROM 'ADMIN_DIRECT'
      AND (
        verdict.data->>'approvalId'=COALESCE(approval.id,cohort.approval_id)::text
        OR verdict.data->>'qaBatchId' IS NOT NULL AND EXISTS (
          SELECT 1 FROM copy_qa_batch_members_v2 member
          WHERE member.id::text=verdict.data->>'samplingItemId'
            AND member.batch_id::text=verdict.data->>'qaBatchId'
            AND member.approval_event_id=COALESCE(approval.id,cohort.approval_id))
        OR verdict.data->>'qaBatchId' IS NULL AND EXISTS (
          SELECT 1 FROM copy_sampling_items item
          WHERE item.id::text=verdict.data->>'samplingItemId'
            AND item.approval_event_id=COALESCE(approval.id,cohort.approval_id))
        OR verdict.data->>'approvalId' IS NULL AND verdict.data->>'samplingItemId' IS NULL
          AND verdict.data->>'copyRevisionId'=COALESCE(approval.copy_revision_id,cohort.copy_revision_id)::text
      )
    ORDER BY verdict.occurred_at,verdict.sequence_id LIMIT 1
  ) quality ON true
  ORDER BY cohort.task_id,cohort.cycle_key LIMIT 50001`;

function complete(rows,message) {
  if(rows.length>LIMIT) throw new RangeError(message);
  return rows;
}

export async function readAnnotationAssignmentReport(client,report) {
  const taskIds=[...new Set(report.rows.filter(isAnnotationWork).map(row=>row.taskId))];
  if(!taskIds.length) return {report,firstCopyVerdicts:[]};
  const submissions=complete((await client.query(ANNOTATION_SUBMISSIONS_SQL,[taskIds,report.asOf])).rows,
    '接手统计涉及超过 50,000 次历史提交，请缩小日期或选择人员').map(row=>({
      ...row.data,id:row.event_key,taskId:Number(row.task_id),accountId:id(row.account_id),stage:row.stage,
      kind:'SUBMIT',at:iso(row.occurred_at),sequence:Number(row.sequence_id),
      approvalId:id(row.data?.approvalId),copyRevisionId:id(row.data?.copyRevisionId),
    }));
  const discards=await readAnnotationDiscardFacts(client,{
    start:'0001-01-01T00:00:00Z',end:new Date(Date.parse(report.asOf)+1).toISOString(),
    asOf:report.asOf,taskIds,
  });
  const assignments=complete((await client.query(ANNOTATION_ASSIGNMENTS_SQL,[taskIds,report.asOf])).rows,
    '接手统计涉及超过 50,000 条历史分配记录，请缩小日期或选择人员').map(row=>({
      id:row.id,order:Number(row.ordering),kind:row.kind,taskId:Number(row.task_id),
      accountId:id(row.account_id),username:row.username,at:iso(row.occurred_at),
      previousAccountId:id(row.previous_account_id),previousUsername:row.previous_username,
      endedAt:iso(row.ended_at),baseline:row.baseline===true,
    }));
  if(report.rows.length+submissions.length+discards.length+assignments.length>MERGED_LIMIT)
    throw new RangeError('接手统计合并事实超过 200,000 条，请缩小日期或选择人员');
  const work=annotateAssignmentCycles([...submissions,...discards],assignments);
  const byId=new Map(work.map(row=>[row.id,row]));
  const annotationReport={...report,rows:report.rows.map(row=>{
    const annotated=byId.get(row.id);
    return annotated?.annotationCycleKey?{...row,annotationCycleKey:annotated.annotationCycleKey,
      annotationFirst:annotated.annotationFirst}:row;
  })};
  const cohort=firstCopyAssignmentCohort(work,annotationReport.rows);
  const submitted=cohort.filter(row=>row.submitted);
  const results=submitted.length?complete((await client.query(ANNOTATION_FIRST_COPY_SQL,[
    JSON.stringify(submitted.map(row=>({cycle_key:row.cycleKey,task_id:row.taskId,account_id:row.accountId,
      approval_id:row.approvalId,copy_revision_id:row.copyRevisionId,submitted_at:row.submittedAt}))),report.asOf,
  ])).rows,'接手统计涉及超过 50,000 个首次质检轮次，请缩小日期或选择人员'):[];
  if(report.rows.length+submissions.length+discards.length+assignments.length+results.length>MERGED_LIMIT)
    throw new RangeError('接手统计合并事实超过 200,000 条，请缩小日期或选择人员');
  const byCycle=new Map(results.map(row=>[row.cycle_key,row]));
  const firstCopyVerdicts=cohort.map(row=>{
    const verdict=byCycle.get(row.cycleKey);
    const outcome=['PASS','RETURN','DISCARD'].includes(verdict?.outcome)?verdict.outcome:null;
    return {cycleKey:row.cycleKey,taskId:row.taskId,accountId:row.accountId,submitted:row.submitted,outcome,
      ...(row.submitted&&!outcome?{reason:['PENDING','ADMIN_DIRECT','NOT_SELECTED','NO_RECORD'].includes(verdict?.reason)
        ?verdict.reason:'NO_RECORD'}:{})};
  });
  return {report:annotationReport,firstCopyVerdicts};
}