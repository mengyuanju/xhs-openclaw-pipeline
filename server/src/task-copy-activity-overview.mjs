import { isAnnotationWork } from '../../src/annotation-assignment-cycles.mjs';
import { readAnnotationAssignmentWork } from './annotation-assignment-report.mjs';

const PERIOD_TASKS_SQL=`WITH operations AS (
  SELECT task_id,occurred_at FROM operator_performance_events
  WHERE kind='SUBMIT' AND stage='COPY' AND account_id IS NOT NULL AND data->>'exclusion' IS NULL
  UNION ALL
  SELECT task_id,created_at FROM human_quality_assessments WHERE stage='COPY' AND action='DISCARD'
  UNION ALL
  SELECT task_id,created_at FROM task_reassignment_assessment_records WHERE stage='COPY' AND action='DISCARD'
  UNION ALL
  SELECT task_id,created_at FROM copy_return_dispositions
)
SELECT DISTINCT task.id FROM operations operation JOIN tasks task ON task.id=operation.task_id
WHERE task.task_kind='CONTENT' AND NOT (task.input @> '{"testRun":true}'::jsonb)
  AND task.created_at<=$3::timestamptz
  AND operation.occurred_at>=$1::timestamptz AND operation.occurred_at<$2::timestamptz
  AND operation.occurred_at<=$3::timestamptz
LIMIT 50001`;

export async function readTaskCopyActivityOverview(client,query,asOf) {
  const tasks=(await client.query(PERIOD_TASKS_SQL,[query.time.start,query.time.end,asOf])).rows;
  if(tasks.length>50_000) throw new RangeError('标注作业概览涉及超过 50,000 个任务，请缩小日期或选择人员');
  const {work}=await readAnnotationAssignmentWork(client,{taskIds:tasks.map(row=>Number(row.id)),asOf});
  const annotators=query.conditions.filter(condition=>condition.field==='ANNOTATOR').map(condition=>condition.value);
  const start=Date.parse(query.time.start),end=Date.parse(query.time.end),snapshot=Date.parse(asOf);
  const counts={copyReview:0,copyRework:0};
  const people=new Map();
  for(const row of work) {
    const at=Date.parse(row.at);
    if(!isAnnotationWork(row) || row.stage!=='COPY' || at<start || at>=end || at>snapshot) continue;
    if(annotators.length && !(query.match==='ANY'
      ?annotators.some(accountId=>row.accountId===accountId)
      :annotators.every(accountId=>row.accountId===accountId))) continue;
    const metric=row.annotationFirst?'copyReview':'copyRework';
    counts[metric]++;
    const person=people.get(row.accountId)??{accountId:row.accountId,copyReview:0,copyRework:0};
    person[metric]++;
    people.set(row.accountId,person);
  }
  return {counts,people:[...people.values()]};
}
