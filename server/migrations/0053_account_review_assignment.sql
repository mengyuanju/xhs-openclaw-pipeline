-- Reconcile the 0050 balanced queues with the account-level permissions added
-- by 0051. Image review uses copy_review_enabled; copy QA uses copy_qc_enabled.

-- 0050 is the single owner of rework_count/priority. Keep 0051's revision and
-- QC-gate invalidation, but remove its duplicate counter mutation.
CREATE OR REPLACE FUNCTION invalidate_copy_quality_revision() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END $$;

-- Preserve a specific reason supplied by a caller/trigger and do not count the
-- same transition twice if a future trigger already incremented rework_count.
CREATE OR REPLACE FUNCTION refresh_task_priority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id THEN
      NEW.queue_entered_at := now();
    END IF;
    IF (OLD.state = 'COPY_QC_PENDING' AND NEW.state IN ('COPY_REVIEW_PENDING', 'COPY_QUEUED'))
      OR (OLD.state IN ('MANUAL_ARCHIVE', 'REVIEWED')
        AND NEW.state IN ('COPY_REVIEW_PENDING', 'COPY_QUEUED', 'IMAGE_QUEUED'))
      OR (OLD.state = 'COPY_REVIEW_PENDING' AND NEW.state = 'COPY_REVIEW_PENDING'
        AND NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id) THEN
      IF NEW.rework_count = OLD.rework_count THEN
        NEW.rework_count := OLD.rework_count + 1;
      END IF;
      IF NEW.requeue_reason IS NOT DISTINCT FROM OLD.requeue_reason THEN
        NEW.requeue_reason := 'REWORK';
      END IF;
      NEW.queue_entered_at := now();
    ELSIF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('COPY_QUEUED', 'IMAGE_QUEUED')
      AND OLD.state IN ('COPY_RUNNING', 'IMAGE_RUNNING', 'COPY_FAILED', 'IMAGE_FAILED')
      AND NEW.requeue_reason <> 'MANUAL_RETRY' THEN
      NEW.requeue_reason := 'AUTO_RECOVERY';
    END IF;
  ELSE
    NEW.queue_entered_at := COALESCE(NEW.created_at, now());
  END IF;
  NEW.system_priority := CASE
    WHEN NEW.mandatory_copy_qc OR NEW.rework_count >= 2 OR NEW.requeue_reason = 'MANDATORY_RECHECK' THEN 400
    WHEN NEW.rework_count > 0 OR NEW.requeue_reason IN ('REWORK', 'IMAGE_REVIEW_RETURN', 'IMAGE_RETURN', 'QA_RETURN') THEN 300
    WHEN NEW.requeue_reason = 'MANUAL_RETRY' THEN 200
    WHEN NEW.requeue_reason = 'AUTO_RECOVERY' THEN 150 ELSE 100 END;
  NEW.manual_priority := CASE NEW.priority_mode
    WHEN 'HIGHEST' THEN 500 WHEN 'HIGH' THEN 350 WHEN 'NORMAL' THEN 100 WHEN 'DEFER' THEN 10 ELSE NULL END;
  NEW.priority_paused := NEW.priority_mode = 'PAUSE';
  NEW.effective_priority := COALESCE(NEW.manual_priority, NEW.system_priority);
  NEW.queue_entered_at := date_trunc('milliseconds', NEW.queue_entered_at);
  NEW.priority_sort_at := NEW.queue_entered_at - NEW.effective_priority * interval '10 minutes';
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION choose_priority_reviewer(excluded_account bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE chosen bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(4310, 8250);
  SELECT u.id INTO chosen FROM app_users u
  WHERE u.status = 'ACTIVE' AND u.role IN ('REVIEWER', 'USER')
    AND CASE WHEN excluded_account IS NULL THEN u.copy_review_enabled ELSE u.copy_qc_enabled END
    AND (excluded_account IS NULL OR u.id <> excluded_account)
  ORDER BY (
    SELECT COALESCE(sum(1 + greatest(0, t.effective_priority - 100)::numeric / 100
      + least(3, t.rework_count) + CASE WHEN t.current_execution_id IS NULL THEN 0 ELSE 2 END), 0)
    FROM tasks t WHERE (t.assigned_to_user_id = u.username
        OR (t.state = 'MANUAL_ARCHIVE' AND t.review_assigned_to_account_id = u.id))
      AND t.state NOT IN ('REVIEWED', 'CANCELLED')
  ) + (
    SELECT COALESCE(sum(1 + greatest(0, t.effective_priority - 100)::numeric / 100 + least(3, t.rework_count)), 0)
    FROM copy_sampling_items i JOIN tasks t ON t.id = i.task_id
    WHERE i.assigned_review_account_id = u.id AND i.status = 'PENDING'
  ), (SELECT max(e.id) FROM review_queue_assignment_events e WHERE e.account_id = u.id) NULLS FIRST, u.id
  LIMIT 1;
  RETURN chosen;
END $$;

UPDATE tasks task SET review_assigned_to_account_id = NULL, review_assigned_at = NULL
WHERE task.state = 'MANUAL_ARCHIVE' AND task.review_assigned_to_account_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = task.review_assigned_to_account_id
    AND u.status = 'ACTIVE' AND u.role IN ('REVIEWER', 'USER') AND u.copy_review_enabled);
UPDATE copy_sampling_items item SET assigned_review_account_id = NULL, assigned_review_at = NULL
WHERE item.selected AND item.status = 'PENDING' AND item.assigned_review_account_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = item.assigned_review_account_id
    AND u.status = 'ACTIVE' AND u.role IN ('REVIEWER', 'USER') AND u.copy_qc_enabled);
UPDATE tasks SET state = state WHERE state = 'MANUAL_ARCHIVE' AND review_assigned_to_account_id IS NULL;
UPDATE copy_sampling_items SET status = status WHERE selected AND status = 'PENDING' AND assigned_review_account_id IS NULL;
