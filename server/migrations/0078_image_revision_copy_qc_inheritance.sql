-- Image regeneration and deterministic reprocessing create immutable PLAN_EDIT
-- revisions even though title, body and tags do not change. Extend the 0067
-- lineage guard to those entry points and repair tasks stranded by the missing
-- inheritance record.

CREATE OR REPLACE FUNCTION validate_copy_qc_revision_inheritance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_revision copy_revisions%ROWTYPE;
  target_revision copy_revisions%ROWTYPE;
  valid_live_source boolean := false;
  valid_stranded_repair boolean := false;
BEGIN
  SELECT * INTO source_revision FROM copy_revisions WHERE id = NEW.source_revision_id;
  SELECT * INTO target_revision FROM copy_revisions WHERE id = NEW.target_revision_id;

  IF source_revision.id IS NOT NULL AND target_revision.id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM tasks AS task
      WHERE task.id = NEW.task_id
        AND task.state IN ('MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED')
        AND task.current_copy_revision_id = source_revision.id
        AND task.copy_qc_released_revision_id = source_revision.id
        AND task.mandatory_copy_qc = false
        AND copy_quality_image_eligible(task.id, source_revision.id, false)
    ) INTO valid_live_source;

    SELECT EXISTS (
      SELECT 1 FROM tasks AS task
      WHERE task.id = NEW.task_id
        AND task.state = 'COPY_REVIEW_PENDING'
        AND task.current_copy_revision_id = target_revision.id
        AND task.mandatory_copy_qc = true
        AND task.mandatory_copy_qc_origin = 'QA_RETURN'
        AND NOT EXISTS (
          SELECT 1 FROM copy_sampling_items AS active_recheck
          WHERE active_recheck.task_id = task.id
            AND active_recheck.sample_kind = 'MANDATORY_RECHECK'
            AND active_recheck.copy_revision_id = target_revision.id
            AND active_recheck.status = 'PENDING'
        )
        AND EXISTS (
          SELECT 1
          FROM copy_sampling_items AS item
          JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
          JOIN copy_sampling_events AS supersede_event ON supersede_event.sampling_item_id = item.id
            AND supersede_event.action = 'SUPERSEDE'
            AND supersede_event.details->>'newRevisionId' = target_revision.id::text
          WHERE item.task_id = task.id
            AND item.copy_revision_id = source_revision.id
            AND item.status = 'SUPERSEDED'
            AND sampling_freeze.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')
        )
    ) INTO valid_stranded_repair;
  END IF;

  IF source_revision.id IS NULL OR target_revision.id IS NULL
    OR source_revision.task_id IS DISTINCT FROM NEW.task_id
    OR target_revision.task_id IS DISTINCT FROM NEW.task_id
    OR target_revision.parent_revision_id IS DISTINCT FROM source_revision.id
    OR target_revision.revision_origin IS DISTINCT FROM 'PLAN_EDIT'
    OR target_revision.approved_at IS NULL
    OR target_revision.content #>> '{imageRevision,operation}' NOT IN ('REGENERATE', 'REPROCESS')
    OR target_revision.content #>> '{imageRevision,baseRevisionId}' IS DISTINCT FROM source_revision.id::text
    OR copy_revision_copy_payload(target_revision.content)
      IS DISTINCT FROM copy_revision_copy_payload(source_revision.content)
    OR NOT (valid_live_source OR valid_stranded_repair) THEN
    RAISE EXCEPTION 'invalid copy-QA revision inheritance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

WITH repair_candidates AS (
  SELECT task.id AS task_id, target.id AS target_revision_id,
    source.id AS source_revision_id,
    COALESCE(NULLIF(target.content #>> '{imageRevision,actorUsername}', ''), 'system') AS actor_username
  FROM tasks AS task
  JOIN copy_revisions AS target ON target.id = task.current_copy_revision_id
  JOIN copy_revisions AS source ON source.id = target.parent_revision_id
    AND source.task_id = task.id
  WHERE task.state = 'COPY_REVIEW_PENDING'
    AND task.mandatory_copy_qc = true
    AND task.mandatory_copy_qc_origin = 'QA_RETURN'
    AND target.revision_origin = 'PLAN_EDIT'
    AND target.approved_at IS NOT NULL
    AND target.content #>> '{imageRevision,operation}' IN ('REGENERATE', 'REPROCESS')
    AND target.content #>> '{imageRevision,baseRevisionId}' = source.id::text
    AND copy_revision_copy_payload(target.content) = copy_revision_copy_payload(source.content)
    AND NOT EXISTS (
      SELECT 1 FROM copy_sampling_items AS active_recheck
      WHERE active_recheck.task_id = task.id
        AND active_recheck.sample_kind = 'MANDATORY_RECHECK'
        AND active_recheck.copy_revision_id = target.id
        AND active_recheck.status = 'PENDING'
    )
    AND EXISTS (
      SELECT 1
      FROM copy_sampling_items AS item
      JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
      JOIN copy_sampling_events AS supersede_event ON supersede_event.sampling_item_id = item.id
        AND supersede_event.action = 'SUPERSEDE'
        AND supersede_event.details->>'newRevisionId' = target.id::text
      WHERE item.task_id = task.id
        AND item.copy_revision_id = source.id
        AND item.status = 'SUPERSEDED'
        AND sampling_freeze.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')
    )
)
INSERT INTO copy_qc_revision_inheritances(
  target_revision_id, task_id, source_revision_id, inherited_by_username, reason
)
SELECT target_revision_id, task_id, source_revision_id, left(actor_username, 50), 'IMAGE_PLAN_RETRY'
FROM repair_candidates
ON CONFLICT (target_revision_id) DO NOTHING;

UPDATE copy_sampling_items AS item
SET status = CASE WHEN EXISTS (
    SELECT 1 FROM copy_sampling_events AS pass_event
    WHERE pass_event.sampling_item_id = item.id AND pass_event.action = 'PASS'
  ) THEN 'PASSED' ELSE 'RELEASED' END,
  updated_at = now()
FROM copy_qc_revision_inheritances AS inheritance,
  copy_sampling_freezes AS sampling_freeze
WHERE inheritance.source_revision_id = item.copy_revision_id
  AND inheritance.task_id = item.task_id
  AND sampling_freeze.id = item.freeze_id
  AND sampling_freeze.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')
  AND item.status = 'SUPERSEDED'
  AND EXISTS (
    SELECT 1 FROM copy_sampling_events AS supersede_event
    WHERE supersede_event.sampling_item_id = item.id
      AND supersede_event.action = 'SUPERSEDE'
      AND supersede_event.details->>'newRevisionId' = inheritance.target_revision_id::text
  );

UPDATE tasks AS task
SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
  progress_percent = 0,
  progress_message = '图片版本继承文案质检结论，等待图片执行机重新生成',
  copy_qc_released_revision_id = inheritance.target_revision_id,
  mandatory_copy_qc = false, mandatory_copy_qc_origin = NULL,
  current_execution_id = NULL, current_image_run_id = NULL,
  pending_snapshot = NULL, execution_started_at = NULL, finished_at = NULL,
  error = NULL, last_activity_at = now(), updated_at = now()
FROM copy_qc_revision_inheritances AS inheritance
WHERE inheritance.task_id = task.id
  AND inheritance.target_revision_id = task.current_copy_revision_id
  AND task.state = 'COPY_REVIEW_PENDING'
  AND task.mandatory_copy_qc = true
  AND task.mandatory_copy_qc_origin = 'QA_RETURN';
