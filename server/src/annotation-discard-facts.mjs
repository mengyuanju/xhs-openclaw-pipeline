const LIMIT=50_000;

const DISCARDS_SQL=`WITH discards AS (
  SELECT 'copy-review:'||assessment.id AS event_key,assessment.task_id,
    actor.id AS account_id,assessment.reviewer_username AS username,
    'COPY'::text AS stage,assessment.created_at AS occurred_at,
    (revision.revision_origin IN ('QA_RETURN','FINAL_REWORK')
      OR COALESCE(revision.copy_rework_satisfied,false)) AS rework
  FROM human_quality_assessments assessment
  JOIN app_users actor ON actor.username=assessment.reviewer_username
  JOIN copy_revisions revision ON revision.id=assessment.copy_revision_id
  WHERE assessment.stage='COPY' AND assessment.action='DISCARD'
    AND assessment.created_at>=$1 AND assessment.created_at<$2 AND assessment.created_at<=$3
  UNION ALL
  SELECT 'image-review:'||assessment.id,assessment.task_id,
    actor.id,assessment.reviewer_username,'IMAGE',assessment.created_at,
    (EXISTS(SELECT 1 FROM human_quality_assessments previous
      WHERE previous.task_id=assessment.task_id AND previous.stage='IMAGE'
        AND (previous.created_at,previous.id)<(assessment.created_at,assessment.id))
      OR EXISTS(SELECT 1 FROM image_approval_events previous
        WHERE previous.task_id=assessment.task_id AND previous.submitted_at<assessment.created_at))
  FROM human_quality_assessments assessment
  JOIN app_users actor ON actor.username=assessment.reviewer_username
  WHERE assessment.stage='IMAGE' AND assessment.action='DISCARD'
    AND assessment.created_at>=$1 AND assessment.created_at<$2 AND assessment.created_at<=$3
  UNION ALL
  SELECT 'copy-return:'||disposition.id,disposition.task_id,
    disposition.actor_account_id,disposition.actor_username,
    'COPY',disposition.created_at,true
  FROM copy_return_dispositions disposition
  WHERE disposition.created_at>=$1 AND disposition.created_at<$2 AND disposition.created_at<=$3
  UNION ALL
  SELECT 'image-disposition:'||disposition.id,disposition.task_id,
    disposition.actor_account_id,disposition.actor_username,
    'IMAGE',disposition.created_at,
    (disposition.from_state='IMAGE_REWORK_PENDING'
      OR EXISTS(SELECT 1 FROM human_quality_assessments previous
        WHERE previous.task_id=disposition.task_id AND previous.stage='IMAGE'
          AND previous.created_at<disposition.created_at)
      OR EXISTS(SELECT 1 FROM image_approval_events previous
        WHERE previous.task_id=disposition.task_id AND previous.submitted_at<disposition.created_at))
  FROM image_task_dispositions disposition
  WHERE disposition.from_state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING')
    AND disposition.created_at>=$1 AND disposition.created_at<$2 AND disposition.created_at<=$3
)
SELECT discard.*,COALESCE(actor.display_name,discard.username) AS display_name,
  task.query,task.production_batch_id AS batch_id
FROM discards discard
LEFT JOIN app_users actor ON actor.id=discard.account_id
JOIN tasks task ON task.id=discard.task_id
WHERE ($4::bigint IS NULL OR discard.account_id=$4)
  AND ($5::text='' OR discard.stage=$5)
  AND ($6::bigint IS NULL OR task.production_batch_id=$6)
ORDER BY discard.occurred_at,discard.event_key
LIMIT 50001`;

export async function readAnnotationDiscardFacts(client,{start,end,asOf,accountId=null,stage='',batchId=null}) {
  const rows=(await client.query(DISCARDS_SQL,[start,end,asOf,accountId,stage,batchId])).rows;
  if(rows.length>LIMIT) throw new RangeError('统计范围超过 50,000 次废弃操作，请缩小日期或选择人员');
  return rows.map(row=>({
    id:'annotation-discard:'+row.event_key,kind:'ANNOTATION_DISCARD',
    taskId:Number(row.task_id),accountId:Number(row.account_id),
    stage:row.stage,at:row.occurred_at instanceof Date?row.occurred_at.toISOString():row.occurred_at,
    username:row.username,displayName:row.display_name,query:row.query,
    batchId:row.batch_id==null?null:Number(row.batch_id),rework:row.rework===true,exclusion:null,
  }));
}
