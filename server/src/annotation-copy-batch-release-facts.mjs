// Used inside the first-verdict lookup, bound to that cycle's exact approval.
// Coverage preserves the real operation; status timestamps cover older releases.
export const ANNOTATION_COPY_RELEASES_SQL=`
  SELECT 'PASS'::text AS action,coverage.occurred_at,1 AS source_order,0::bigint AS sequence_id
  FROM quality_review_coverage_events coverage
  WHERE coverage.task_id=cohort.task_id AND coverage.stage='COPY' AND coverage.kind='BATCH_RELEASE'
    AND coverage.data->>'selected'='false'
    AND coverage.occurred_at>=cohort.submitted_at AND coverage.occurred_at<=$2::timestamptz
    AND coverage.data->>'exclusion' IS NULL
    AND (coverage.account_id IS NULL OR coverage.account_id<>cohort.account_id)
    AND (
      coverage.data->>'approvalId'=COALESCE(approval.id,cohort.approval_id)::text
      OR coverage.data->>'qaBatchId' IS NOT NULL AND EXISTS (
        SELECT 1 FROM copy_qa_batch_members_v2 member
        WHERE member.id::text=coverage.data->>'samplingItemId'
          AND member.batch_id::text=coverage.data->>'qaBatchId'
          AND member.approval_event_id=COALESCE(approval.id,cohort.approval_id))
      OR coverage.data->>'qaBatchId' IS NULL AND EXISTS (
        SELECT 1 FROM copy_sampling_items item WHERE item.id::text=coverage.data->>'samplingItemId'
          AND item.approval_event_id=COALESCE(approval.id,cohort.approval_id))
    )
  UNION ALL
  SELECT 'PASS',batch.completed_at,2,member.id
  FROM copy_qa_batch_members_v2 member JOIN copy_qa_batches_v2 batch ON batch.id=member.batch_id
  WHERE member.task_id=cohort.task_id AND member.approval_event_id=COALESCE(approval.id,cohort.approval_id)
    AND NOT member.selected AND member.status='RELEASED' AND batch.status='COMPLETED'
    AND member.created_at<=$2::timestamptz
    AND batch.completed_at>=cohort.submitted_at AND batch.completed_at<=$2::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM quality_review_coverage_events coverage WHERE coverage.stage='COPY'
        AND coverage.kind='BATCH_RELEASE' AND coverage.occurred_at<=$2::timestamptz
        AND (coverage.review_item_key='COPY:v2:'||member.id
          OR coverage.data->>'qaBatchId'=member.batch_id::text
            AND coverage.data->>'samplingItemId'=member.id::text)
    )
  UNION ALL
  SELECT 'PASS',event.created_at,2,event.id
  FROM copy_sampling_items item JOIN copy_sampling_events event ON event.freeze_id=item.freeze_id
  WHERE item.task_id=cohort.task_id AND item.approval_event_id=COALESCE(approval.id,cohort.approval_id)
    AND NOT item.selected AND event.action='RELEASE' AND item.created_at<=event.created_at
    AND event.details->'taskIds' @> jsonb_build_array(item.task_id)
    AND event.created_at>=cohort.submitted_at AND event.created_at<=$2::timestamptz
    AND (event.actor_account_id IS NULL OR event.actor_account_id<>cohort.account_id)
    AND NOT EXISTS (
      SELECT 1 FROM quality_review_coverage_events coverage WHERE coverage.task_id=item.task_id
        AND coverage.stage='COPY' AND coverage.kind='BATCH_RELEASE' AND coverage.occurred_at<=$2::timestamptz
        AND (coverage.data->>'approvalId'=item.approval_event_id::text
          OR coverage.data->>'qaBatchId' IS NULL AND coverage.data->>'samplingItemId'=item.id::text)
    )
  UNION ALL
  SELECT 'PASS',COALESCE(sampling_freeze.resolved_at,item.updated_at),3,item.id
  FROM copy_sampling_items item JOIN copy_sampling_freezes sampling_freeze ON sampling_freeze.id=item.freeze_id
  WHERE item.task_id=cohort.task_id AND item.approval_event_id=COALESCE(approval.id,cohort.approval_id)
    AND NOT item.selected AND item.status='RELEASED'
    AND sampling_freeze.status IN ('RELEASED','RELEASED_WITH_EXCEPTIONS') AND item.created_at<=$2::timestamptz
    AND COALESCE(sampling_freeze.resolved_at,item.updated_at)>=cohort.submitted_at
    AND COALESCE(sampling_freeze.resolved_at,item.updated_at)<=$2::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM copy_sampling_events event WHERE event.freeze_id=item.freeze_id AND event.action='RELEASE'
        AND event.details->'taskIds' @> jsonb_build_array(item.task_id) AND event.created_at<=$2::timestamptz
    )
    AND NOT EXISTS (
      SELECT 1 FROM quality_review_coverage_events coverage WHERE coverage.task_id=item.task_id
        AND coverage.stage='COPY' AND coverage.kind='BATCH_RELEASE' AND coverage.occurred_at<=$2::timestamptz
        AND (coverage.data->>'approvalId'=item.approval_event_id::text
          OR coverage.data->>'qaBatchId' IS NULL AND coverage.data->>'samplingItemId'=item.id::text)
    )`;
