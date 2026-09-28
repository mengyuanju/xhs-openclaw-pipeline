import { TASK_ACTIVITY_QA_CTES } from './task-activity-qa-facts.mjs';

// Live and reassignment archives refer to the same assessment ID. SAVE is a
// draft change; approval events are the canonical completed submissions.
const REVIEW_ACTIVITY_CTES = `assessments AS (
  SELECT DISTINCT ON(task_id,assessment_id) * FROM (
    SELECT a.task_id,a.id AS assessment_id,a.stage,a.action,a.created_at AS operated_at,
      a.reviewer_username,a.review_session_id,a.copy_revision_id,a.image_run_id,0 AS source_order
    FROM human_quality_assessments a WHERE a.action IN ('APPROVE','RETRY','DISCARD')
    UNION ALL
    SELECT a.task_id,a.assessment_id,a.stage,a.action,a.created_at,a.reviewer_username,
      NULL::uuid,NULL::bigint,NULL::uuid,1
    FROM task_reassignment_assessment_records a WHERE a.action IN ('APPROVE','RETRY','DISCARD')
  ) history ORDER BY task_id,assessment_id,source_order
), copy_submissions AS (
  SELECT DISTINCT ON(event_key) * FROM (
    SELECT 'copy-submit:'||a.id AS event_key,a.task_id,a.approved_at AS operated_at,
      a.approved_by_account_id AS subject_account_id,
      (r.revision_origin IN ('QA_RETURN','FINAL_REWORK') OR COALESCE(r.copy_rework_satisfied,false)) AS rework,
      0 AS source_order
    FROM copy_approval_events a JOIN copy_revisions r ON r.id=a.copy_revision_id
    WHERE a.approval_mode='MANUAL'
    UNION ALL
    SELECT e.event_key,e.task_id,e.occurred_at,e.account_id,
      e.data->>'rework'='true',1
    FROM operator_performance_events e
    WHERE e.kind='SUBMIT' AND e.stage='COPY' AND e.data->>'exclusion' IS NULL
      AND e.event_key LIKE 'copy-submit:%'
  ) submissions ORDER BY event_key,source_order
), copy_review_actions AS (
  SELECT a.task_id,a.operated_at,a.subject_account_id FROM copy_submissions a
  UNION ALL
  SELECT a.task_id,a.operated_at,u.id FROM assessments a
  LEFT JOIN app_users u ON u.username=a.reviewer_username AND u.created_at<=a.operated_at
  WHERE a.stage='COPY'
  UNION ALL
  SELECT r.task_id,r.approved_at,NULL::bigint FROM copy_revisions r
  WHERE r.approved_at IS NOT NULL AND r.approval_mode IS DISTINCT FROM 'ADMIN_BYPASS'
    AND NOT EXISTS(SELECT 1 FROM copy_approval_events a WHERE a.copy_revision_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM copy_qc_revision_inheritances inherited
      WHERE inherited.target_revision_id=r.id)
  UNION ALL
  SELECT t.id,t.finished_at,NULL::bigint FROM tasks t
  WHERE t.state='CANCELLED' AND t.cancelled_from_state='COPY_REVIEW_PENDING'
    AND t.progress_message='文案已被质检废弃'
), first_copy_reviews AS (
  -- Find the lifecycle's first action before applying the chosen interval/person.
  SELECT DISTINCT ON(task_id) task_id,operated_at,subject_account_id
  FROM copy_review_actions WHERE operated_at<=$3::timestamptz
  ORDER BY task_id,operated_at,subject_account_id NULLS LAST
), image_submissions AS (
  SELECT DISTINCT ON(event_key) * FROM (
    SELECT 'image-submit:'||a.id AS event_key,a.task_id,a.submitted_at AS operated_at,
      a.submitted_by_account_id AS subject_account_id,a.image_run_id::text AS image_run_id,
      a.review_session_id,a.submitted_by_username AS username,0 AS source_order
    FROM image_approval_events a
    UNION ALL
    SELECT e.event_key,e.task_id,e.occurred_at,e.account_id,e.data->>'imageRunId',
      NULL::uuid,e.data->>'username',1
    FROM operator_performance_events e
    WHERE e.kind='SUBMIT' AND e.stage='IMAGE' AND e.data->>'exclusion' IS NULL
      AND e.event_key LIKE 'image-submit:%'
  ) submissions ORDER BY event_key,source_order
), image_review_actions AS (
  SELECT a.task_id,a.operated_at,a.subject_account_id FROM image_submissions a
  UNION ALL
  SELECT a.task_id,a.operated_at,u.id FROM assessments a
  LEFT JOIN app_users u ON u.username=a.reviewer_username AND u.created_at<=a.operated_at
  WHERE a.stage='IMAGE' AND NOT (a.action='APPROVE' AND EXISTS(
    SELECT 1 FROM image_submissions submission WHERE submission.task_id=a.task_id
      AND (submission.review_session_id=a.review_session_id OR submission.image_run_id=a.image_run_id::text
        OR a.review_session_id IS NULL AND submission.operated_at=a.operated_at
          AND submission.username=a.reviewer_username)))
  UNION ALL
  SELECT d.task_id,d.created_at,d.actor_account_id FROM image_task_dispositions d
  WHERE d.from_state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING') AND NOT EXISTS(
    SELECT 1 FROM assessments a WHERE a.task_id=d.task_id AND a.stage='IMAGE'
      AND a.action='DISCARD' AND a.operated_at=d.created_at)
)`;

export async function readTaskActivityOverview(client, query, asOf) {
  const annotators = query.conditions.filter(condition => condition.field === 'ANNOTATOR');
  const params = [query.time.start, query.time.end, asOf, ...annotators.map(condition => condition.value)];
  const peopleFilter = annotators.length
    ? ` AND (${annotators.map((_, index) => `COALESCE(owner.account_id,operation.subject_account_id)=$${index + 4}::bigint`)
      .join(query.match === 'ANY' ? ' OR ' : ' AND ')})` : '';
  const row = (await client.query(`WITH report_tasks AS MATERIALIZED (
    SELECT t.id FROM tasks t WHERE t.task_kind='CONTENT'
      AND NOT (t.input @> '{"testRun":true}'::jsonb) AND t.created_at<=$3::timestamptz
  ), ${REVIEW_ACTIVITY_CTES}, ${TASK_ACTIVITY_QA_CTES}, activity AS (
    SELECT task_id,operated_at,subject_account_id,'COPY_REVIEW'::text AS metric,false AS passed
    FROM first_copy_reviews
    UNION ALL
    SELECT task_id,operated_at,subject_account_id,'COPY_REWORK',false FROM copy_submissions WHERE rework
    UNION ALL
    SELECT task_id,operated_at,subject_account_id,'IMAGE_REVIEW',false FROM image_review_actions
    UNION ALL
    SELECT task_id,operated_at,subject_account_id,stage||'_QA',passed FROM qa_activity
  ) SELECT
    count(*) FILTER(WHERE operation.metric='COPY_REVIEW')::integer AS copy_review,
    count(*) FILTER(WHERE operation.metric='COPY_REWORK')::integer AS copy_rework,
    count(*) FILTER(WHERE operation.metric='COPY_QA')::integer AS copy_qa,
    count(*) FILTER(WHERE operation.metric='IMAGE_REVIEW')::integer AS image_review,
    count(*) FILTER(WHERE operation.metric='IMAGE_QA')::integer AS image_qa,
    count(*) FILTER(WHERE operation.metric='IMAGE_QA' AND operation.passed)::integer AS image_qa_passed
  FROM activity operation JOIN report_tasks t ON t.id=operation.task_id
  LEFT JOIN LATERAL (
    SELECT history.account_id FROM (
      SELECT assignment.id,assignment.assigned_at,assignment.assignee_account_id AS account_id,0 AS source_order
      FROM task_assignment_records assignment WHERE assignment.task_id=t.id
        AND assignment.assigned_at<=operation.operated_at
        AND (assignment.ended_at IS NULL OR assignment.ended_at>operation.operated_at)
      UNION ALL
      SELECT event.id,event.created_at,account.id,1
      FROM task_assignment_events event LEFT JOIN app_users account
        ON account.username=event.assignee_user_id AND account.created_at<=event.created_at
      WHERE event.task_id=t.id AND event.created_at<=operation.operated_at
    ) history ORDER BY history.assigned_at DESC,history.source_order,history.id DESC LIMIT 1
  ) owner ON true
  WHERE operation.operated_at >= $1::timestamptz AND operation.operated_at < $2::timestamptz
    AND operation.operated_at <= $3::timestamptz${peopleFilter}`, params)).rows[0] ?? {};
  return {
    copyReview: Number(row.copy_review ?? 0), copyRework: Number(row.copy_rework ?? 0),
    copyQa: Number(row.copy_qa ?? 0), imageReview: Number(row.image_review ?? 0),
    imageQa: Number(row.image_qa ?? 0), imageQaPassed: Number(row.image_qa_passed ?? 0),
  };
}
