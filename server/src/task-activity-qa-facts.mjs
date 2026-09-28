// Operation facts for task overview counts. These CTEs intentionally do not
// filter current task state, revision, date or person. The caller applies its
// task scope and resolves the assignee at operated_at, using the preserved
// approval submitter only when assignment history is unavailable.
//
// Canonical keys deduplicate source copies. They keep separate raw decisions
// on the same task/item, while automatic finalization after a human PASS does
// not create an additional acceptance. Coverage is the preferred batch source.
export const TASK_ACTIVITY_QA_CTES = String.raw`
qa_copy_legacy_manual AS (
  SELECT 'copy:decision:'||e.id||':'||i.task_id AS fact_key,
    i.task_id,'COPY'::text AS stage,e.created_at AS operated_at,
    e.action='PASS' AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    10 AS source_priority,i.id AS item_id
  FROM copy_sampling_events e JOIN copy_sampling_items i ON i.id=e.sampling_item_id
  LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE e.action IN ('PASS','RETURN_SINGLE','ESCALATE_ADMIN')
), qa_copy_legacy_batch AS (
  SELECT 'copy:decision:'||e.id||':'||i.task_id AS fact_key,
    i.task_id,'COPY'::text AS stage,e.created_at AS operated_at,false AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    10 AS source_priority,i.id AS item_id
  FROM copy_sampling_events e JOIN copy_sampling_items i
    ON i.freeze_id=e.freeze_id AND i.created_at<=e.created_at
  LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE e.action='RETURN_BATCH'
    AND NOT COALESCE((e.details->'alreadyReturnedItemIds')
      @> jsonb_build_array(i.public_id::text),false)
    AND (
      i.id=e.sampling_item_id
      OR (e.details->'affectedItemIds') @> jsonb_build_array(i.public_id::text)
      OR (jsonb_typeof(e.details->'affectedItemIds') IS DISTINCT FROM 'array'
        AND (e.details->'affectedTaskIds') @> jsonb_build_array(i.task_id))
      OR (jsonb_typeof(e.details->'affectedItemIds') IS DISTINCT FROM 'array'
        AND jsonb_typeof(e.details->'affectedTaskIds') IS DISTINCT FROM 'array'
        AND i.status IN ('BATCH_AFFECTED','BATCH_RETURNED'))
    )
), qa_copy_legacy_release AS (
  SELECT 'copy:release:'||i.id AS fact_key,i.task_id,'COPY'::text AS stage,
    e.created_at AS operated_at,true AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    10 AS source_priority
  FROM copy_sampling_events e JOIN copy_sampling_items i
    ON i.freeze_id=e.freeze_id AND i.created_at<=e.created_at
  LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE e.action='RELEASE'
    AND (e.details->'taskIds') @> jsonb_build_array(i.task_id)
    AND NOT EXISTS (SELECT 1 FROM copy_sampling_events verdict
      WHERE verdict.sampling_item_id=i.id AND verdict.action='PASS'
        AND (verdict.created_at,verdict.id)<=(e.created_at,e.id))
), qa_copy_v2_coverage AS (
  SELECT CASE WHEN c.kind='BATCH_RETURN' THEN 'copy:v2:decision:' ELSE 'copy:v2:release:' END
      ||COALESCE(m.id::text,c.data->>'samplingItemId') AS fact_key,
    c.task_id,'COPY'::text AS stage,c.occurred_at AS operated_at,
    c.kind='BATCH_RELEASE' AS passed,
    COALESCE(m.approver_account_id,a.approved_by_account_id,
      producer.account_id) AS subject_account_id,0 AS source_priority
  FROM quality_review_coverage_events c
  LEFT JOIN copy_qa_batch_members_v2 m ON m.id=(c.data->>'samplingItemId')::bigint
  LEFT JOIN copy_approval_events a ON a.id=m.approval_event_id
  LEFT JOIN LATERAL (
    SELECT q.account_id FROM account_quality_events q
    WHERE q.stage='COPY' AND q.task_id=c.task_id
      AND q.data->>'samplingItemId'=c.data->>'samplingItemId'
      AND q.data->>'qaBatchId'=c.data->>'qaBatchId'
    ORDER BY q.occurred_at,q.sequence_id LIMIT 1
  ) producer ON true
  WHERE c.stage='COPY' AND c.kind IN ('BATCH_RETURN','BATCH_RELEASE')
    AND c.review_item_key LIKE 'COPY:v2:%'
), qa_copy_v2_manual AS (
  SELECT 'copy:v2:decision:'||m.id AS fact_key,m.task_id,'COPY'::text AS stage,
    COALESCE(d.created_at,m.decided_at) AS operated_at,m.status='PASSED' AS passed,
    COALESCE(a.approved_by_account_id,m.approver_account_id) AS subject_account_id,
    10 AS source_priority
  FROM copy_qa_batch_members_v2 m JOIN copy_qa_batches_v2 b ON b.id=m.batch_id
  LEFT JOIN copy_approval_events a ON a.id=m.approval_event_id
  LEFT JOIN copy_qa_dispositions_v2 d ON d.member_id=m.id
  WHERE m.status IN ('PASSED','RETURNED','BATCH_AFFECTED','DISCARDED')
    AND COALESCE(d.created_at,m.decided_at) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT item_id,operated_at,passed FROM qa_copy_legacy_manual
        UNION ALL SELECT item_id,operated_at,passed FROM qa_copy_legacy_batch
      ) legacy JOIN copy_sampling_items i ON i.id=legacy.item_id
      WHERE b.legacy_freeze_id=i.freeze_id AND i.task_id=m.task_id
        AND i.copy_revision_id=m.copy_revision_id
        AND legacy.operated_at=COALESCE(d.created_at,m.decided_at)
        AND legacy.passed=(m.status='PASSED')
    )
), qa_copy_v2_release AS (
  SELECT 'copy:v2:release:'||m.id AS fact_key,m.task_id,'COPY'::text AS stage,
    b.completed_at AS operated_at,true AS passed,
    COALESCE(a.approved_by_account_id,m.approver_account_id) AS subject_account_id,
    20 AS source_priority
  FROM copy_qa_batch_members_v2 m JOIN copy_qa_batches_v2 b ON b.id=m.batch_id
  LEFT JOIN copy_approval_events a ON a.id=m.approval_event_id
  WHERE m.status='RELEASED' AND b.completed_at IS NOT NULL
), qa_copy_migrated_return AS (
  SELECT 'copy:legacy-return:'||i.id AS fact_key,e.task_id,'COPY'::text AS stage,
    e.created_at AS operated_at,false AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    40 AS source_priority
  FROM copy_qa_return_events_v2 e JOIN copy_sampling_items i ON i.id=e.legacy_item_id
  LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE NOT EXISTS (SELECT 1 FROM qa_copy_legacy_manual actual
      WHERE actual.item_id=i.id AND NOT actual.passed)
    AND NOT EXISTS (SELECT 1 FROM qa_copy_legacy_batch actual WHERE actual.item_id=i.id)
), qa_copy_legacy_release_fallback AS (
  SELECT 'copy:release:'||i.id AS fact_key,i.task_id,'COPY'::text AS stage,
    COALESCE(f.resolved_at,i.updated_at) AS operated_at,true AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    50 AS source_priority
  FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id=i.freeze_id
  LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE i.status='RELEASED'
    AND f.status IN ('RELEASED','RELEASED_WITH_EXCEPTIONS')
    AND NOT EXISTS (SELECT 1 FROM copy_sampling_events e
      WHERE e.sampling_item_id=i.id AND e.action='PASS')
), qa_copy_admin_pass_fallback AS (
  SELECT 'copy:admin-pass:'||d.id AS fact_key,d.task_id,'COPY'::text AS stage,
    d.created_at AS operated_at,true AS passed,a.approved_by_account_id AS subject_account_id,
    40 AS source_priority
  FROM copy_qa_admin_direct_approvals d
  LEFT JOIN copy_approval_events a ON a.id=d.approval_event_id
  WHERE NOT EXISTS (SELECT 1 FROM copy_sampling_events e
    JOIN copy_sampling_items i ON i.id=e.sampling_item_id
    WHERE i.approval_event_id=d.approval_event_id AND e.action='PASS')
), qa_copy_legacy_pass_fallback AS (
  SELECT 'copy:legacy-pass:'||i.id AS fact_key,i.task_id,'COPY'::text AS stage,
    i.reviewed_at AS operated_at,true AS passed,
    COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS subject_account_id,
    50 AS source_priority
  FROM copy_sampling_items i LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
  WHERE i.status='PASSED' AND i.reviewed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM copy_sampling_events e
      WHERE e.sampling_item_id=i.id AND e.action='PASS')
    AND NOT EXISTS (SELECT 1 FROM copy_qa_admin_direct_approvals d
      WHERE d.approval_event_id=i.approval_event_id)
), qa_copy_candidates AS (
  SELECT fact_key,task_id,stage,operated_at,passed,subject_account_id,source_priority
    FROM qa_copy_legacy_manual
  UNION ALL SELECT fact_key,task_id,stage,operated_at,passed,subject_account_id,source_priority
    FROM qa_copy_legacy_batch
  UNION ALL SELECT * FROM qa_copy_legacy_release
  UNION ALL SELECT * FROM qa_copy_v2_coverage
  UNION ALL SELECT * FROM qa_copy_v2_manual
  UNION ALL SELECT * FROM qa_copy_v2_release
  UNION ALL SELECT * FROM qa_copy_migrated_return
  UNION ALL SELECT * FROM qa_copy_legacy_release_fallback
  UNION ALL SELECT * FROM qa_copy_admin_pass_fallback
  UNION ALL SELECT * FROM qa_copy_legacy_pass_fallback
),
qa_image_single AS (
  SELECT 'image:decision:'||e.id||':'||i.task_id AS fact_key,
    i.task_id,'IMAGE'::text AS stage,e.created_at AS operated_at,
    e.action='PASS' AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id) AS subject_account_id,
    10 AS source_priority
  FROM image_sampling_events e JOIN image_sampling_items i ON i.id=e.sampling_item_id
  LEFT JOIN image_approval_events a ON a.id=i.approval_event_id
  WHERE e.action IN ('PASS','RETURN_SINGLE','ESCALATE_ADMIN')
), qa_image_discard AS (
  SELECT 'image:disposition:'||d.id AS fact_key,
    d.task_id,'IMAGE'::text AS stage,d.created_at AS operated_at,false AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id,l.submitter_id) AS subject_account_id,
    10 AS source_priority
  FROM image_task_dispositions d
  LEFT JOIN image_sampling_items i ON i.id=d.sampling_item_id
  LEFT JOIN image_approval_events a ON a.task_id=d.task_id AND a.image_run_id=d.image_run_id
  LEFT JOIN quality_inspection_links l ON l.stage='IMAGE' AND l.item_id=d.sampling_item_id
  WHERE d.from_state='IMAGE_QC_PENDING'
), qa_image_batch_coverage AS (
  SELECT CASE WHEN COALESCE(c.data->>'sourceEventId',e.id::text) IS NOT NULL
      THEN 'image:decision:'||COALESCE(c.data->>'sourceEventId',e.id::text)||':'||c.task_id
      ELSE 'image:operation:'||c.operation_key||':'||c.task_id END AS fact_key,
    c.task_id,'IMAGE'::text AS stage,c.occurred_at AS operated_at,false AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id,l.submitter_id) AS subject_account_id,
    0 AS source_priority
  FROM quality_review_coverage_events c
  LEFT JOIN image_sampling_events e ON e.action='RETURN_BATCH' AND (
    e.id::text=c.data->>'sourceEventId'
    OR (c.data->>'sourceEventId' IS NULL AND e.freeze_id::text=c.data->>'freezeId'
      AND e.request_id::text=substring(c.operation_key from
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
  LEFT JOIN image_sampling_items i ON i.id::text=c.data->>'samplingItemId' AND i.task_id=c.task_id
  LEFT JOIN image_approval_events a
    ON a.id::text=COALESCE(c.data->>'approvalId',i.approval_event_id::text) AND a.task_id=c.task_id
  LEFT JOIN quality_inspection_links l ON l.stage='IMAGE'
    AND l.item_id::text=c.data->>'samplingItemId' AND l.task_id=c.task_id
  WHERE c.stage='IMAGE' AND c.kind='BATCH_RETURN'
), qa_image_batch_raw AS (
  SELECT 'image:decision:'||e.id||':'||i.task_id AS fact_key,
    i.task_id,'IMAGE'::text AS stage,e.created_at AS operated_at,false AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id) AS subject_account_id,
    10 AS source_priority
  FROM image_sampling_events e JOIN image_sampling_items i ON i.freeze_id=e.freeze_id
    AND i.sample_kind='RANDOM' AND i.created_at<=e.created_at
  LEFT JOIN image_approval_events a ON a.id=i.approval_event_id
  WHERE e.action='RETURN_BATCH' AND (
    (e.details->'affectedTaskIds') @> jsonb_build_array(i.task_id)
    OR (jsonb_typeof(e.details->'affectedTaskIds') IS DISTINCT FROM 'array'
      AND i.reviewed_at=e.created_at
      AND i.reviewed_by_account_id IS NOT DISTINCT FROM e.actor_account_id)
  )
), qa_image_release_coverage AS (
  SELECT 'image:release:'||(c.data->>'samplingItemId') AS fact_key,
    c.task_id,'IMAGE'::text AS stage,c.occurred_at AS operated_at,true AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id,l.submitter_id) AS subject_account_id,
    0 AS source_priority
  FROM quality_review_coverage_events c
  LEFT JOIN image_sampling_items i ON i.id::text=c.data->>'samplingItemId' AND i.task_id=c.task_id
  LEFT JOIN image_approval_events a
    ON a.id::text=COALESCE(c.data->>'approvalId',i.approval_event_id::text) AND a.task_id=c.task_id
  LEFT JOIN quality_inspection_links l ON l.stage='IMAGE'
    AND l.item_id::text=c.data->>'samplingItemId' AND l.task_id=c.task_id
  WHERE c.stage='IMAGE' AND c.kind='BATCH_RELEASE'
    AND c.data->>'selected'='false'
    AND (c.data->>'samplingItemId') ~ '^[1-9][0-9]*$'
    AND NOT EXISTS (SELECT 1 FROM image_sampling_events verdict
      WHERE verdict.sampling_item_id::text=c.data->>'samplingItemId' AND verdict.action='PASS'
        AND verdict.created_at<=c.occurred_at)
), qa_image_release_entry AS (
  SELECT 'image:release:'||i.id AS fact_key,
    i.task_id,'IMAGE'::text AS stage,d.approved_at AS operated_at,true AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id) AS subject_account_id,
    30 AS source_priority
  FROM delivery_entries d JOIN image_approval_events a ON a.task_id=d.task_id
    AND a.copy_revision_id=d.copy_revision_id AND a.image_run_id=d.image_run_id
  JOIN image_sampling_items i ON i.approval_event_id=a.id AND i.task_id=d.task_id
  WHERE NOT i.selected AND i.sample_kind='RANDOM' AND d.approved_at>=i.created_at
    AND EXISTS (SELECT 1 FROM image_sampling_events released
      WHERE released.freeze_id=i.freeze_id AND released.action='RELEASE'
        AND released.created_at>=i.created_at AND released.created_at>=d.approved_at)
    AND NOT EXISTS (SELECT 1 FROM image_sampling_events verdict
      WHERE verdict.sampling_item_id=i.id AND verdict.action='PASS'
        AND verdict.created_at<=d.approved_at)
), qa_image_legacy_pass_fallback AS (
  SELECT 'image:legacy-pass:'||i.id AS fact_key,i.task_id,'IMAGE'::text AS stage,
    i.reviewed_at AS operated_at,true AS passed,
    COALESCE(a.submitted_by_account_id,i.submitter_account_id) AS subject_account_id,
    50 AS source_priority
  FROM image_sampling_items i LEFT JOIN image_approval_events a ON a.id=i.approval_event_id
  WHERE i.status='PASSED' AND i.reviewed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM image_sampling_events e
      WHERE e.sampling_item_id=i.id AND e.action='PASS')
), qa_image_candidates AS (
  SELECT * FROM qa_image_single
  UNION ALL SELECT * FROM qa_image_discard
  UNION ALL SELECT * FROM qa_image_batch_coverage
  UNION ALL SELECT * FROM qa_image_batch_raw
  UNION ALL SELECT * FROM qa_image_release_coverage
  UNION ALL SELECT * FROM qa_image_release_entry
  UNION ALL SELECT * FROM qa_image_legacy_pass_fallback
),
qa_activity_candidates AS (
  SELECT * FROM qa_copy_candidates
  UNION ALL SELECT * FROM qa_image_candidates
), qa_activity AS (
  SELECT DISTINCT ON (fact_key)
    task_id,stage,operated_at,passed,subject_account_id
  FROM qa_activity_candidates
  WHERE fact_key IS NOT NULL AND operated_at IS NOT NULL
  ORDER BY fact_key,source_priority,operated_at,subject_account_id NULLS LAST
)`;
