ALTER TABLE tasks
  ADD COLUMN system_priority integer NOT NULL DEFAULT 100,
  ADD COLUMN manual_priority integer CHECK (manual_priority IN (500, 350, 100, 10)),
  ADD COLUMN effective_priority integer NOT NULL DEFAULT 100,
  ADD COLUMN priority_mode varchar(10) NOT NULL DEFAULT 'SYSTEM'
    CHECK (priority_mode IN ('SYSTEM', 'HIGHEST', 'HIGH', 'NORMAL', 'DEFER', 'PAUSE')),
  ADD COLUMN priority_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN queue_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN priority_sort_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rework_count integer NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  ADD COLUMN requeue_reason varchar(30) NOT NULL DEFAULT 'FIRST',
  ADD COLUMN priority_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN priority_updated_by varchar(50),
  ADD COLUMN priority_updated_at timestamptz,
  ADD COLUMN priority_reason text;

-- QA return placeholders and final-review assessments represent distinct rework rounds.
-- Approved edits and execution attempts must not inflate this count.
UPDATE tasks t SET queue_entered_at = COALESCE(t.last_activity_at, t.created_at),
  rework_count = (SELECT count(*) FROM human_quality_assessments a
    WHERE a.task_id = t.id AND a.rework_target IS NOT NULL)
    + (SELECT count(*) FROM copy_revisions r WHERE r.task_id = t.id AND r.revision_origin = 'QA_RETURN');

CREATE FUNCTION refresh_task_priority() RETURNS trigger LANGUAGE plpgsql AS $$
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
      NEW.rework_count := OLD.rework_count + 1;
      NEW.requeue_reason := 'REWORK';
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
    WHEN NEW.rework_count > 0 OR NEW.requeue_reason IN ('REWORK', 'IMAGE_REVIEW_RETURN') THEN 300
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
CREATE TRIGGER tasks_refresh_priority BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION refresh_task_priority();
UPDATE tasks SET system_priority = system_priority;
CREATE INDEX tasks_priority_claim_idx ON tasks(state, priority_sort_at, queue_entered_at, id)
  WHERE priority_paused = false;
CREATE INDEX tasks_owner_priority_idx ON tasks(assigned_to_user_id, state, priority_sort_at, id)
  WHERE priority_paused = false;
CREATE INDEX task_assignment_latest_any_source_idx ON task_assignment_events(assignee_user_id, id DESC)
  WHERE assignee_user_id IS NOT NULL;

-- No FK to tasks/accounts: audit evidence survives permanent task/account deletion.
CREATE TABLE task_priority_events (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  previous_mode varchar(10) NOT NULL,
  mode varchar(10) NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  version bigint NOT NULL,
  scope jsonb NOT NULL,
  previous_hash text NOT NULL,
  event_hash char(64) NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, version)
);
CREATE FUNCTION reject_priority_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'priority audit is append-only'; END $$;
CREATE TRIGGER task_priority_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON task_priority_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_priority_audit_change();

-- Review ownership is separate from the production owner used by image round-robin.
ALTER TABLE tasks ADD COLUMN review_assigned_to_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN review_assigned_at timestamptz;
ALTER TABLE copy_sampling_items ADD COLUMN assigned_review_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN assigned_review_at timestamptz;
CREATE TABLE review_queue_assignment_events (
  id bigserial PRIMARY KEY, account_id bigint NOT NULL, task_id bigint NOT NULL,
  queue_kind varchar(20) NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION choose_priority_reviewer(excluded_account bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE chosen bigint;
BEGIN
  -- Serialize all review allocations; existing task/item owners are never recalculated on reprioritization.
  PERFORM pg_advisory_xact_lock(4310, 8250);
  SELECT u.id INTO chosen FROM app_users u
  WHERE u.status = 'ACTIVE' AND u.role IN ('REVIEWER', 'ADMIN')
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
CREATE FUNCTION assign_priority_review_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    IF NEW.state = 'MANUAL_ARCHIVE' AND NEW.priority_paused THEN
      IF TG_OP = 'INSERT' OR OLD.state <> 'MANUAL_ARCHIVE' THEN
        NEW.review_assigned_to_account_id := NULL;
        NEW.review_assigned_at := NULL;
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.state = 'MANUAL_ARCHIVE' AND
      (TG_OP = 'INSERT' OR OLD.state <> 'MANUAL_ARCHIVE' OR NEW.review_assigned_to_account_id IS NULL) THEN
      NEW.review_assigned_to_account_id := choose_priority_reviewer(NULL);
      NEW.review_assigned_at := now();
      IF NEW.review_assigned_to_account_id IS NOT NULL THEN
        INSERT INTO review_queue_assignment_events(account_id, task_id, queue_kind)
          VALUES (NEW.review_assigned_to_account_id, NEW.id, 'IMAGE_REVIEW');
      END IF;
    END IF;
  ELSE
    IF NEW.selected AND NEW.status = 'PENDING' AND NEW.assigned_review_account_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND priority_paused) THEN
      NEW.assigned_review_account_id := choose_priority_reviewer(NEW.final_approver_account_id);
      NEW.assigned_review_at := now();
      IF NEW.assigned_review_account_id IS NOT NULL THEN
        INSERT INTO review_queue_assignment_events(account_id, task_id, queue_kind)
          VALUES (NEW.assigned_review_account_id, NEW.task_id, 'COPY_QA');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_z_assign_review BEFORE INSERT OR UPDATE OF state, priority_mode ON tasks
  FOR EACH ROW EXECUTE FUNCTION assign_priority_review_queue();
CREATE TRIGGER sampling_assign_review BEFORE INSERT OR UPDATE OF status ON copy_sampling_items
  FOR EACH ROW EXECUTE FUNCTION assign_priority_review_queue();
CREATE INDEX tasks_review_priority_idx ON tasks(review_assigned_to_account_id, priority_sort_at, id)
  WHERE state = 'MANUAL_ARCHIVE';
CREATE INDEX sampling_reviewer_pending_idx ON copy_sampling_items(assigned_review_account_id, task_id)
  WHERE status = 'PENDING' AND selected;
CREATE FUNCTION resume_priority_review_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE copy_sampling_items SET status = status
    WHERE task_id = NEW.id AND selected AND status = 'PENDING' AND assigned_review_account_id IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER priority_resume_review_items AFTER UPDATE OF priority_mode ON tasks
  FOR EACH ROW WHEN (OLD.priority_paused AND NOT NEW.priority_paused)
  EXECUTE FUNCTION resume_priority_review_items();
UPDATE tasks SET state = state WHERE state = 'MANUAL_ARCHIVE';
UPDATE copy_sampling_items SET status = status WHERE selected AND status = 'PENDING';
