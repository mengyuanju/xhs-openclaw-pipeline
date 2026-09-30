import { TASK_ACTIVITY_QA_CTES } from './task-activity-qa-facts.mjs';
import { readTaskCopyActivityOverview } from './task-copy-activity-overview.mjs';

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
    ? ` AND (${annotators.map((_, index) => `operation.account_id=$${index + 4}::bigint`)
      .join(query.match === 'ANY' ? ' OR ' : ' AND ')})` : '';
  const copy = await readTaskCopyActivityOverview(client, query, asOf);
  const rows = (await client.query(`WITH report_tasks AS MATERIALIZED (
    SELECT t.id FROM tasks t WHERE t.task_kind='CONTENT'
      AND NOT (t.input @> '{"testRun":true}'::jsonb) AND t.created_at<=$3::timestamptz
  ), ${REVIEW_ACTIVITY_CTES}, ${TASK_ACTIVITY_QA_CTES}, period_image_tasks AS (
    SELECT DISTINCT task_id FROM image_review_actions
    WHERE operated_at >= $1::timestamptz AND operated_at < $2::timestamptz
      AND operated_at <= $3::timestamptz
  ), activity AS (
    SELECT task_id,operated_at,subject_account_id,'IMAGE_REVIEW'::text AS metric,false AS passed
    FROM image_review_actions
    UNION ALL
    SELECT task_id,operated_at,subject_account_id,stage||'_QA',passed FROM qa_activity
  ), attributed AS MATERIALIZED (
    SELECT row_number() OVER () AS event_id,operation.*,
      COALESCE(owner.account_id,operation.subject_account_id) AS account_id
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
    WHERE operation.operated_at < $2::timestamptz AND operation.operated_at <= $3::timestamptz
      AND (operation.operated_at >= $1::timestamptz
        OR operation.metric='IMAGE_REVIEW' AND EXISTS (
          SELECT 1 FROM period_image_tasks period WHERE period.task_id=operation.task_id))
  ), image_ranked AS (
    SELECT operation.event_id,row_number() OVER (
      PARTITION BY operation.task_id,operation.account_id,handoff.last_other_assignment_at
      ORDER BY operation.operated_at,operation.event_id) AS image_number
    FROM attributed operation
    LEFT JOIN LATERAL (
      SELECT max(transition.assigned_at) AS last_other_assignment_at FROM (
        SELECT event.created_at AS assigned_at,account.id AS account_id
        FROM task_assignment_events event LEFT JOIN app_users account
          ON account.username=event.assignee_user_id AND account.created_at<=event.created_at
        WHERE event.task_id=operation.task_id AND event.created_at<=operation.operated_at
        UNION ALL
        SELECT assignment.assigned_at,assignment.assignee_account_id
        FROM task_assignment_records assignment
        WHERE assignment.task_id=operation.task_id AND assignment.assigned_at<=operation.operated_at
      ) transition WHERE transition.account_id IS DISTINCT FROM operation.account_id
    ) handoff ON true
    WHERE operation.metric='IMAGE_REVIEW' AND operation.operated_at<=$3::timestamptz
  ) SELECT
    GROUPING(operation.account_id) AS all_people,operation.account_id,
    count(*) FILTER(WHERE operation.metric='COPY_QA')::integer AS copy_qa,
    count(*) FILTER(WHERE operation.metric='IMAGE_REVIEW')::integer AS image_review,
    count(*) FILTER(WHERE operation.metric='IMAGE_REVIEW' AND image.image_number=1)::integer AS image_first_review,
    count(*) FILTER(WHERE operation.metric='IMAGE_REVIEW' AND image.image_number>1)::integer AS image_rework,
    count(*) FILTER(WHERE operation.metric='IMAGE_QA')::integer AS image_qa,
    count(*) FILTER(WHERE operation.metric='IMAGE_QA' AND operation.passed)::integer AS image_qa_passed
  FROM attributed operation LEFT JOIN image_ranked image ON image.event_id=operation.event_id
  WHERE operation.operated_at >= $1::timestamptz AND operation.operated_at < $2::timestamptz
    AND operation.operated_at <= $3::timestamptz${peopleFilter}
  GROUP BY GROUPING SETS ((operation.account_id), ())`, params)).rows;
  const row = rows.find(item => Number(item.all_people) === 1) ?? {};
  return {
    overview: {
      ...copy.counts,
      copyQa: Number(row.copy_qa ?? 0), imageReview: Number(row.image_review ?? 0),
      imageQa: Number(row.image_qa ?? 0), imageQaPassed: Number(row.image_qa_passed ?? 0),
    },
    people: [...copy.people, ...rows.filter(item => Number(item.all_people) === 0
      && Number(item.image_review) > 0).map(item => ({
      accountId: item.account_id == null ? null : Number(item.account_id),
      imageReview: Number(item.image_review ?? 0),
      imageFirstReview: Number(item.image_first_review ?? 0),
      imageRework: Number(item.image_rework ?? 0),
    }))],
  };
}
