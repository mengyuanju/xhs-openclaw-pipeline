// Canonical report source queries. Aggregation uses the full SQL relations;
// the legacy JavaScript oracle adds its own bounded reads.

export const OPERATOR_EVENTS_SOURCE_SQL=`SELECT e.*,EXISTS(SELECT 1 FROM tasks t WHERE t.id=e.task_id) AS task_exists,
    (SELECT bool_or(s.data->>'selected'='true') FROM operator_performance_events s WHERE s.task_id=e.task_id AND s.stage=e.stage
      AND s.kind='SAMPLE' AND s.data->>'sampleKind'='RANDOM' AND s.data->>'approvalId'=e.data->>'approvalId') AS sample_selected,
    previous.occurred_at AS previous_submitted_at,
    (SELECT max(r.occurred_at) FROM operator_performance_events r WHERE r.task_id=e.task_id
      AND r.occurred_at<e.occurred_at AND (previous.occurred_at IS NULL OR r.occurred_at>=previous.occurred_at)
      AND (r.kind IN ('RETURN','BATCH_RETURN') OR r.kind='QUALITY' AND r.data->>'outcome'='RETURN')
      AND COALESCE(r.data->>'target',r.stage) IN (e.stage,'BOTH')) AS returned_at,
    NULL::bigint AS return_round
  FROM operator_performance_events e
  LEFT JOIN LATERAL(SELECT occurred_at FROM operator_performance_events p WHERE p.task_id=e.task_id AND p.stage=e.stage
    AND p.kind='SUBMIT' AND p.data->>'exclusion' IS NULL AND (p.occurred_at,p.sequence_id)<(e.occurred_at,e.sequence_id)
    ORDER BY p.occurred_at DESC,p.sequence_id DESC LIMIT 1) previous ON e.kind='SUBMIT'
  WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND e.occurred_at <= $3
    AND ($4::bigint IS NULL OR e.account_id=$4) AND ($5::text='' OR e.stage=$5)
    AND ($6::bigint IS NULL OR (e.data->>'batchId')::bigint=$6)
  ORDER BY e.occurred_at,e.event_key`;

export const OPERATOR_CURRENT_SOURCE_SQL=`SELECT latest.*,t.query,t.production_batch_id AS batch_id,t.assigned_at,
    COALESCE(quality.data,quality_wide.data) AS last_quality,
    CASE WHEN latest.baseline THEN greatest(t.personal_stage_entered_at,
      CASE WHEN t.state='COPY_REVIEW_PENDING' THEN
        COALESCE(regenerated.finished_at,regenerated_wide.finished_at) END,
      CASE WHEN t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING') THEN
        COALESCE(edited.updated_at,edited_wide.updated_at) END)
      ELSE latest.occurred_at END AS waiting_at,
    COALESCE(u.display_name,latest.username,'历史身份未确认') AS display_name
  FROM operator_stage_current latest
  JOIN tasks t ON t.id=latest.task_id LEFT JOIN app_users u ON u.id=latest.account_id
  -- Narrow account/batch scopes look up only their current task keys. Wide
  -- team scopes keep batch aggregation instead of one lookup per open task.
  LEFT JOIN (SELECT task_id,copy_revision_id,max(finished_at) AS finished_at
    FROM copy_image_plan_regeneration_jobs WHERE status='SUCCEEDED' AND $1::bigint IS NULL AND $3::bigint IS NULL
    GROUP BY task_id,copy_revision_id) regenerated_wide
    ON regenerated_wide.task_id=t.id AND regenerated_wide.copy_revision_id=t.current_copy_revision_id AND t.state='COPY_REVIEW_PENDING'
  LEFT JOIN (SELECT task_id,copy_revision_id,max(updated_at) AS updated_at
    FROM image_edit_requests WHERE status='PREVIEW_READY' AND $1::bigint IS NULL AND $3::bigint IS NULL
    GROUP BY task_id,copy_revision_id) edited_wide
    ON edited_wide.task_id=t.id AND edited_wide.copy_revision_id=t.current_copy_revision_id AND t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING')
  LEFT JOIN (SELECT DISTINCT ON(q.task_id,q.stage) q.task_id,q.stage,
    q.data||jsonb_build_object('id',q.event_key,'taskId',q.task_id,'accountId',q.account_id,
      'stage',q.stage,'kind',q.kind,'at',q.occurred_at) AS data
    FROM operator_performance_events q WHERE q.kind='QUALITY' AND ($2::text='' OR q.stage=$2)
      AND $1::bigint IS NULL AND $3::bigint IS NULL
    ORDER BY q.task_id,q.stage,q.occurred_at DESC,q.sequence_id DESC) quality_wide
    ON quality_wide.task_id=latest.task_id AND quality_wide.stage=latest.stage
  LEFT JOIN LATERAL (SELECT max(p.finished_at) AS finished_at
    FROM copy_image_plan_regeneration_jobs p WHERE p.task_id=t.id AND p.copy_revision_id=t.current_copy_revision_id
      AND p.status='SUCCEEDED' AND latest.baseline AND t.state='COPY_REVIEW_PENDING'
      AND ($1::bigint IS NOT NULL OR $3::bigint IS NOT NULL)) regenerated ON true
  LEFT JOIN LATERAL (SELECT max(edit.updated_at) AS updated_at
    FROM image_edit_requests edit WHERE edit.task_id=t.id AND edit.copy_revision_id=t.current_copy_revision_id
      AND edit.status='PREVIEW_READY' AND latest.baseline AND t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING')
      AND ($1::bigint IS NOT NULL OR $3::bigint IS NOT NULL)) edited ON true
  LEFT JOIN LATERAL (SELECT
    q.data||jsonb_build_object('id',q.event_key,'taskId',q.task_id,'accountId',q.account_id,
      'stage',q.stage,'kind',q.kind,'at',q.occurred_at) AS data
    FROM operator_performance_events q WHERE q.task_id=latest.task_id AND q.stage=latest.stage AND q.kind='QUALITY'
      AND ($1::bigint IS NOT NULL OR $3::bigint IS NOT NULL)
    ORDER BY q.occurred_at DESC,q.sequence_id DESC LIMIT 1) quality ON true
  WHERE latest.phase<>'CLOSED' AND ($1::bigint IS NULL OR latest.account_id=$1)
    AND ($2::text='' OR latest.stage=$2) AND ($3::bigint IS NULL OR t.production_batch_id=$3)
  ORDER BY latest.task_id`;

export const OPERATOR_PENDING_SOURCE_SQL=`SELECT q.*,t.query,COALESCE(u.display_name,q.username,'历史身份未确认') AS display_name
  FROM operator_quality_samples q JOIN tasks t ON t.id=q.task_id LEFT JOIN app_users u ON u.id=q.account_id
  WHERE q.outcome IS NULL AND ((q.selected AND q.status='PENDING') OR (q.exclusion IS NOT NULL AND q.created_at >= $1 AND q.created_at < $2))
    AND ($3::bigint IS NULL OR q.account_id=$3) AND ($4::text='' OR q.stage=$4)
    AND ($5::bigint IS NULL OR q.batch_id=$5)
  ORDER BY q.created_at,q.id`;
