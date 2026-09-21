-- Keep rolling upgrades safe when the database is upgraded before an older
-- control-plane process has restarted. New code inserts the inheritance row
-- explicitly; this trigger fallback accepts only the same strictly validated
-- image-only lineage and becomes a no-op once the new code is active.

CREATE OR REPLACE FUNCTION invalidate_copy_quality_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inherits_copy_release boolean := false;
BEGIN
  IF NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id THEN
    SELECT EXISTS (
      SELECT 1 FROM copy_qc_revision_inheritances AS inheritance
      WHERE inheritance.task_id = NEW.id
        AND inheritance.target_revision_id = NEW.current_copy_revision_id
        AND inheritance.source_revision_id = OLD.current_copy_revision_id
    ) INTO inherits_copy_release;

    IF NOT inherits_copy_release
      AND NEW.state = 'IMAGE_QUEUED'
      AND NOT NEW.mandatory_copy_qc
      AND OLD.state IN ('MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED')
      AND OLD.copy_qc_released_revision_id = OLD.current_copy_revision_id
      AND copy_quality_image_eligible(OLD.id, OLD.current_copy_revision_id, false) THEN
      INSERT INTO copy_qc_revision_inheritances(
        target_revision_id, task_id, source_revision_id,
        inherited_by_username, reason
      )
      SELECT target.id, OLD.id, source.id,
        left(COALESCE(NULLIF(target.content #>> '{imageRevision,actorUsername}', ''), 'system'), 50),
        'IMAGE_PLAN_RETRY'
      FROM copy_revisions AS target
      JOIN copy_revisions AS source ON source.id = OLD.current_copy_revision_id
        AND source.task_id = OLD.id
      WHERE target.id = NEW.current_copy_revision_id
        AND target.task_id = OLD.id
        AND target.parent_revision_id = source.id
        AND target.revision_origin = 'PLAN_EDIT'
        AND target.approved_at IS NOT NULL
        AND target.content #>> '{imageRevision,operation}' IN ('REGENERATE', 'REPROCESS')
        AND target.content #>> '{imageRevision,baseRevisionId}' = source.id::text
        AND copy_revision_copy_payload(target.content) = copy_revision_copy_payload(source.content)
      ON CONFLICT (target_revision_id) DO NOTHING;

      SELECT EXISTS (
        SELECT 1 FROM copy_qc_revision_inheritances AS inheritance
        WHERE inheritance.task_id = NEW.id
          AND inheritance.target_revision_id = NEW.current_copy_revision_id
          AND inheritance.source_revision_id = OLD.current_copy_revision_id
      ) INTO inherits_copy_release;
    END IF;

    IF inherits_copy_release AND NOT NEW.mandatory_copy_qc AND NEW.state = 'IMAGE_QUEUED' THEN
      NEW.copy_qc_released_revision_id := NEW.current_copy_revision_id;
    ELSE
      IF NOT NEW.mandatory_copy_qc AND EXISTS (SELECT 1 FROM copy_sampling_items WHERE task_id = NEW.id) THEN
        NEW.mandatory_copy_qc := true;
        NEW.mandatory_copy_qc_origin := 'QA_RETURN';
        NEW.state := 'COPY_REVIEW_PENDING';
        NEW.current_stage := 'COPY_REVIEW_PENDING';
        NEW.progress_message := '文案版本已变化，需要修改审核并强制复检';
      END IF;
      IF NEW.copy_qc_released_revision_id IS DISTINCT FROM NEW.current_copy_revision_id
        OR NEW.mandatory_copy_qc
        OR NOT EXISTS (SELECT 1 FROM copy_revisions r WHERE r.id = NEW.current_copy_revision_id AND r.approved_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = NEW.id) THEN
        NEW.copy_qc_released_revision_id := NULL;
      END IF;
      INSERT INTO copy_sampling_events(freeze_id, sampling_item_id, action, actor_username, request_id, details)
        SELECT freeze_id, id, 'SUPERSEDE', 'system', gen_random_uuid(),
          jsonb_build_object('oldRevisionId', copy_revision_id, 'newRevisionId', NEW.current_copy_revision_id)
        FROM copy_sampling_items WHERE task_id = NEW.id
          AND copy_revision_id IS DISTINCT FROM NEW.current_copy_revision_id
          AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
      UPDATE copy_sampling_items SET status = 'SUPERSEDED', updated_at = now()
      WHERE task_id = NEW.id AND copy_revision_id IS DISTINCT FROM NEW.current_copy_revision_id
        AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
    END IF;
  END IF;
  RETURN NEW;
END $$;
