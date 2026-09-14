ALTER TABLE app_users
  ADD COLUMN copy_review_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN copy_qc_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rework_count integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requeue_reason text;
ALTER TABLE tasks ADD COLUMN copy_qc_released_revision_id bigint;
UPDATE tasks SET copy_qc_released_revision_id = current_copy_revision_id
WHERE state IN ('IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED')
  AND NOT mandatory_copy_qc;

CREATE TABLE copy_sampling_remainders (
  final_approver_account_id bigint PRIMARY KEY,
  remainder_bps integer NOT NULL DEFAULT 0 CHECK (remainder_bps BETWEEN 0 AND 9999),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE copy_sampling_freezes
  ADD COLUMN final_approver_account_id bigint,
  ADD COLUMN remainder_before integer NOT NULL DEFAULT 0,
  ADD COLUMN remainder_after integer NOT NULL DEFAULT 0,
  ADD COLUMN close_reason text;
CREATE INDEX copy_sampling_items_task_revision_idx ON copy_sampling_items(task_id, copy_revision_id);

-- A revision change invalidates verdicts, while return records remain immutable
-- parents of the mandatory recheck chain.
CREATE FUNCTION invalidate_copy_quality_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id THEN
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
      FROM copy_sampling_items WHERE task_id = NEW.id AND copy_revision_id IS DISTINCT FROM NEW.current_copy_revision_id
        AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
    UPDATE copy_sampling_items SET status = 'SUPERSEDED', updated_at = now()
    WHERE task_id = NEW.id AND copy_revision_id IS DISTINCT FROM NEW.current_copy_revision_id
      AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
  END IF;
  IF NEW.state = 'COPY_REVIEW_PENDING' AND NEW.mandatory_copy_qc
     AND (OLD.state <> 'COPY_REVIEW_PENDING' OR NOT OLD.mandatory_copy_qc) THEN
    NEW.rework_count := OLD.rework_count + 1;
    NEW.requeue_reason := NEW.mandatory_copy_qc_origin;
  ELSIF NEW.state = 'IMAGE_QUEUED' AND OLD.state = 'MANUAL_ARCHIVE' AND NOT NEW.mandatory_copy_qc THEN
    NEW.rework_count := OLD.rework_count + 1;
    NEW.requeue_reason := 'IMAGE_RETURN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_copy_quality_revision BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION invalidate_copy_quality_revision();

-- Called again by both image-claim queries, regardless of who queued a task.
CREATE FUNCTION copy_quality_image_eligible(task_id_arg bigint, revision_id_arg bigint, mandatory_arg boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT mandatory_arg
   AND EXISTS (SELECT 1 FROM copy_revisions r WHERE r.task_id = task_id_arg
     AND r.id = revision_id_arg AND r.approved_at IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id = i.freeze_id
     WHERE i.task_id = task_id_arg AND f.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED')
   )
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg
       AND i.copy_revision_id = revision_id_arg AND i.status IN ('PENDING', 'NOT_SELECTED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'SUPERSEDED')
   )
   AND (NOT EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg)
     OR EXISTS (SELECT 1 FROM copy_sampling_items i
       JOIN copy_sampling_freezes f ON f.id = i.freeze_id
       WHERE i.task_id = task_id_arg AND i.copy_revision_id = revision_id_arg
         AND i.status IN ('PASSED', 'RELEASED') AND f.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')))
$$;

CREATE TABLE copy_quality_queue_events (
  id bigserial PRIMARY KEY, task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state varchar(40) NOT NULL, copy_revision_id bigint, rework_count integer NOT NULL,
  requeue_reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION record_copy_quality_queue_enter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('COPY_REVIEW_PENDING', 'COPY_QC_PENDING', 'IMAGE_QUEUED') THEN
    INSERT INTO copy_quality_queue_events(task_id, state, copy_revision_id, rework_count, requeue_reason)
    VALUES (NEW.id, NEW.state, NEW.current_copy_revision_id, NEW.rework_count, NEW.requeue_reason);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_copy_quality_queue_enter AFTER UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION record_copy_quality_queue_enter();

CREATE TABLE copy_quality_permission_events (
  id bigserial PRIMARY KEY, account_id bigint NOT NULL, actor_username text,
  previous_permissions jsonb NOT NULL, permissions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_copy_review_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_to_user_id IS NOT NULL AND NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.username = NEW.assigned_to_user_id
      AND u.status = 'ACTIVE' AND u.copy_review_enabled) THEN
    RAISE EXCEPTION 'review assignee permission is disabled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_copy_review_assignment BEFORE UPDATE OF assigned_to_user_id ON tasks
FOR EACH ROW EXECUTE FUNCTION guard_copy_review_assignment();

CREATE FUNCTION protect_approved_copy_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content AND (OLD.approved_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM copy_approval_events WHERE copy_revision_id = OLD.id
  )) THEN
    RAISE EXCEPTION 'approved copy is immutable; append a new revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER copy_revisions_protect_approved BEFORE UPDATE OF content ON copy_revisions
FOR EACH ROW EXECUTE FUNCTION protect_approved_copy_content();
