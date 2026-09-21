-- An image-only retry may create a new immutable PLAN_EDIT revision after the
-- copy has already passed QA. Carry the copy-QA release explicitly instead of
-- treating that approved image-plan revision as a copy rewrite.

CREATE TABLE copy_qc_revision_inheritances (
  target_revision_id bigint PRIMARY KEY REFERENCES copy_revisions(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  inherited_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  inherited_by_username varchar(50) NOT NULL,
  reason varchar(40) NOT NULL CHECK (reason = 'IMAGE_PLAN_RETRY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_revision_id <> source_revision_id)
);
CREATE INDEX copy_qc_revision_inheritances_task_idx
  ON copy_qc_revision_inheritances(task_id, source_revision_id);

CREATE FUNCTION copy_revision_copy_payload(content_arg jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'title', COALESCE(content_arg #> '{copy,title}', content_arg #> '{reviewed,copy,title}', content_arg #> '{post,title}'),
    'body', COALESCE(content_arg #> '{copy,body}', content_arg #> '{reviewed,copy,body}', content_arg #> '{post,body}'),
    'tags', COALESCE(content_arg #> '{copy,tags}', content_arg #> '{reviewed,copy,tags}', content_arg #> '{post,tags}')
  )
$$;

-- Repair only the already-stranded shape produced by the bug: an approved
-- image retry revision with byte-equivalent copy fields whose previously
-- released QA item was superseded by the generic revision trigger.
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
    AND target.content #>> '{imageRevision,operation}' = 'REGENERATE'
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

-- Restore the immutable QA verdict that the faulty trigger superseded. The
-- SUPERSEDE event remains in history; the inheritance row records why the
-- status was reinstated.
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

CREATE OR REPLACE FUNCTION copy_quality_image_eligible(
  task_id_arg bigint,
  revision_id_arg bigint,
  mandatory_arg boolean
)
RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE release_lineage(revision_id, depth) AS (
   SELECT revision_id_arg, 0
   UNION ALL
   SELECT inheritance.source_revision_id, release_lineage.depth + 1
   FROM release_lineage
   JOIN copy_qc_revision_inheritances AS inheritance
     ON inheritance.target_revision_id = release_lineage.revision_id
    AND inheritance.task_id = task_id_arg
   WHERE release_lineage.depth < 100
 )
 SELECT NOT mandatory_arg
   AND EXISTS (SELECT 1 FROM copy_revisions r WHERE r.task_id = task_id_arg
     AND r.id = revision_id_arg AND r.approved_at IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id = i.freeze_id
     WHERE i.task_id = task_id_arg AND f.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED')
   )
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg
       AND i.copy_revision_id = revision_id_arg
       AND i.status IN ('PENDING', 'NOT_SELECTED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'SUPERSEDED')
   )
   AND (
     NOT EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg)
     OR EXISTS (
       SELECT 1
       FROM release_lineage
       JOIN copy_sampling_items i ON i.task_id = task_id_arg
         AND i.copy_revision_id = release_lineage.revision_id
       JOIN copy_sampling_freezes f ON f.id = i.freeze_id
       WHERE i.status IN ('PASSED', 'RELEASED')
         AND f.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')
     )
   )
$$;

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

-- Put repaired image-only retries back onto the image queue. The current
-- revision does not change here, so the revision trigger does not replay.
UPDATE tasks AS task
SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
  progress_percent = 0,
  progress_message = '图片文案规划已修正，等待图片执行机重新生成',
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

CREATE FUNCTION validate_copy_qc_revision_inheritance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_revision copy_revisions%ROWTYPE;
  target_revision copy_revisions%ROWTYPE;
BEGIN
  SELECT * INTO source_revision FROM copy_revisions WHERE id = NEW.source_revision_id;
  SELECT * INTO target_revision FROM copy_revisions WHERE id = NEW.target_revision_id;
  IF source_revision.id IS NULL OR target_revision.id IS NULL
    OR source_revision.task_id IS DISTINCT FROM NEW.task_id
    OR target_revision.task_id IS DISTINCT FROM NEW.task_id
    OR target_revision.parent_revision_id IS DISTINCT FROM source_revision.id
    OR target_revision.revision_origin IS DISTINCT FROM 'PLAN_EDIT'
    OR target_revision.approved_at IS NULL
    OR target_revision.content #>> '{imageRevision,operation}' IS DISTINCT FROM 'REGENERATE'
    OR target_revision.content #>> '{imageRevision,baseRevisionId}' IS DISTINCT FROM source_revision.id::text
    OR copy_revision_copy_payload(target_revision.content)
      IS DISTINCT FROM copy_revision_copy_payload(source_revision.content)
    OR NOT EXISTS (
      SELECT 1 FROM tasks AS task
      WHERE task.id = NEW.task_id
        AND task.state = 'MANUAL_ARCHIVE'
        AND task.current_copy_revision_id = source_revision.id
        AND task.copy_qc_released_revision_id = source_revision.id
        AND task.mandatory_copy_qc = false
        AND copy_quality_image_eligible(task.id, source_revision.id, false)
    ) THEN
    RAISE EXCEPTION 'invalid copy-QA revision inheritance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER copy_qc_revision_inheritance_guard
BEFORE INSERT OR UPDATE ON copy_qc_revision_inheritances
FOR EACH ROW EXECUTE FUNCTION validate_copy_qc_revision_inheritance();
