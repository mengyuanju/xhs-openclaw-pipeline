-- Separate worker-owned image self review from reviewer/admin image QA.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
  'COPY_QC_PENDING',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
  'MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING',
  'REVIEWED', 'CANCELLED'
));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cancelled_from_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_cancelled_from_state_check CHECK (
  cancelled_from_state IS NULL OR cancelled_from_state IN (
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'COPY_QC_PENDING',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE',
    'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING', 'REVIEWED'
  )
);

ALTER TABLE workflow_quality_settings
  ADD COLUMN image_sampling_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN image_sampling_rate_bps integer NOT NULL DEFAULT 2000
    CHECK (image_sampling_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN image_blind_review_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN image_reviewer_batch_return_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN image_sampling_seed varchar(200) NOT NULL DEFAULT 'image-sampling-v1';

ALTER TABLE app_users
  ADD COLUMN image_qc_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tasks
  ADD COLUMN mandatory_image_qc boolean NOT NULL DEFAULT false,
  ADD COLUMN mandatory_image_qc_origin varchar(30)
    CHECK (mandatory_image_qc_origin IS NULL OR mandatory_image_qc_origin IN ('QA_RETURN', 'BATCH_RETURN')),
  ADD COLUMN image_qc_released_approval_event_id bigint,
  ADD COLUMN image_qc_legacy_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN image_rework_source_run_id uuid REFERENCES image_runs(id) ON DELETE SET NULL;

-- Existing deliveries pre-date the image-QA gate and remain valid. Any later
-- image version change clears this compatibility marker.
UPDATE tasks AS task SET image_qc_legacy_accepted = true
WHERE task.state = 'REVIEWED' AND EXISTS (
  SELECT 1 FROM delivery_entries AS delivery
  WHERE delivery.task_id = task.id AND delivery.status = 'READY'
    AND delivery.copy_revision_id = task.current_copy_revision_id
    AND delivery.image_run_id = task.current_image_run_id
);

CREATE TABLE image_approval_events (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  image_run_id uuid NOT NULL REFERENCES image_runs(id) ON DELETE CASCADE,
  submitted_by_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  submitted_by_username varchar(50) NOT NULL,
  review_session_id uuid NOT NULL,
  image_set_sha256 char(64) NOT NULL,
  submission_mode varchar(30) NOT NULL DEFAULT 'SELF_REVIEW'
    CHECK (submission_mode IN ('SELF_REVIEW', 'MANDATORY_RECHECK')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, image_run_id),
  UNIQUE(submitted_by_username, review_session_id)
);
CREATE INDEX image_approval_events_batch_lookup_idx
  ON image_approval_events(task_id, submitted_at DESC, id DESC);

ALTER TABLE tasks ADD CONSTRAINT tasks_image_qc_release_event_fk
  FOREIGN KEY (image_qc_released_approval_event_id)
  REFERENCES image_approval_events(id) ON DELETE SET NULL;

CREATE TABLE image_sampling_freezes (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  production_batch_id bigint NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  freeze_version integer NOT NULL DEFAULT 1 CHECK (freeze_version > 0),
  policy_version bigint NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  seed varchar(200) NOT NULL,
  algorithm_version varchar(80) NOT NULL,
  blind_review_enabled boolean NOT NULL,
  submitter_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  population_count integer NOT NULL CHECK (population_count > 0),
  sample_count integer NOT NULL CHECK (sample_count BETWEEN 0 AND population_count),
  remainder_before integer NOT NULL DEFAULT 0 CHECK (remainder_before BETWEEN 0 AND 9999),
  remainder_after integer NOT NULL DEFAULT 0 CHECK (remainder_after BETWEEN 0 AND 9999),
  snapshot_sha256 char(64) NOT NULL,
  frozen_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  frozen_by_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  close_reason varchar(30) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'INSPECTING'
    CHECK (status IN ('INSPECTING', 'REVIEW_REQUIRED', 'RELEASED', 'RELEASED_WITH_EXCEPTIONS', 'BATCH_RETURNED', 'CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(production_batch_id, submitter_account_id, freeze_version),
  UNIQUE(frozen_by_username, request_id)
);

CREATE TABLE image_sampling_items (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  freeze_id bigint NOT NULL REFERENCES image_sampling_freezes(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_event_id bigint NOT NULL REFERENCES image_approval_events(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  image_run_id uuid NOT NULL REFERENCES image_runs(id) ON DELETE CASCADE,
  image_set_sha256 char(64) NOT NULL,
  submitter_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  submitter_username varchar(50) NOT NULL,
  rank_hash char(64) NOT NULL,
  selected boolean NOT NULL,
  sample_kind varchar(30) NOT NULL DEFAULT 'RANDOM'
    CHECK (sample_kind IN ('RANDOM', 'MANDATORY_RECHECK')),
  parent_item_id bigint REFERENCES image_sampling_items(id) ON DELETE SET NULL,
  status varchar(30) NOT NULL CHECK (status IN (
    'NOT_SELECTED', 'PENDING', 'PASSED', 'RETURNED', 'BATCH_AFFECTED',
    'BATCH_RETURNED', 'RELEASED', 'SUPERSEDED'
  )),
  assigned_review_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  assigned_review_at timestamptz,
  reviewed_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  reviewed_by_username varchar(50),
  score_x10 integer CHECK (score_x10 IS NULL OR score_x10 BETWEEN 10 AND 50),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  problem_asset_ids bigint[] NOT NULL DEFAULT '{}'::bigint[],
  copy_fields text[] NOT NULL DEFAULT '{}'::text[],
  rework_target varchar(10) CHECK (rework_target IS NULL OR rework_target IN ('COPY', 'IMAGE', 'BOTH')),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(freeze_id, task_id, approval_event_id)
);
CREATE INDEX image_sampling_items_queue_idx
  ON image_sampling_items(assigned_review_account_id, status, id)
  WHERE selected = true;
CREATE INDEX image_sampling_items_task_run_idx
  ON image_sampling_items(task_id, image_run_id);

CREATE TABLE image_sampling_remainders (
  production_batch_id bigint NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  submitter_account_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  remainder_bps integer NOT NULL DEFAULT 0 CHECK (remainder_bps BETWEEN 0 AND 9999),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(production_batch_id, submitter_account_id)
);

CREATE TABLE image_sampling_events (
  id bigserial PRIMARY KEY,
  freeze_id bigint NOT NULL REFERENCES image_sampling_freezes(id) ON DELETE CASCADE,
  sampling_item_id bigint REFERENCES image_sampling_items(id) ON DELETE CASCADE,
  action varchar(40) NOT NULL CHECK (action IN (
    'FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE', 'SUPERSEDE'
  )),
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  request_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE image_sampling_mutation_requests (
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  operation varchar(30) NOT NULL CHECK (operation IN ('SELF_REVIEW', 'FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE')),
  request_fingerprint char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_username, request_id)
);

CREATE TABLE image_quality_permission_events (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  actor_username text,
  previous_permissions jsonb NOT NULL,
  permissions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Image initial review belongs to the production owner. Reviewer assignment is
-- only created for selected image-QA items and never for MANUAL_ARCHIVE tasks.
CREATE OR REPLACE FUNCTION choose_image_quality_reviewer(excluded_account bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE chosen bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(4310, 8251);
  SELECT u.id INTO chosen FROM app_users u
  WHERE u.status = 'ACTIVE' AND u.role = 'REVIEWER' AND u.image_qc_enabled
    AND u.id <> excluded_account
  ORDER BY (
    SELECT count(*) FROM image_sampling_items i
    WHERE i.assigned_review_account_id = u.id AND i.status = 'PENDING'
  ), (SELECT max(e.id) FROM review_queue_assignment_events e WHERE e.account_id = u.id) NULLS FIRST, u.id
  LIMIT 1;
  RETURN chosen;
END $$;

CREATE OR REPLACE FUNCTION assign_priority_review_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    IF NEW.state = 'MANUAL_ARCHIVE' THEN
      NEW.review_assigned_to_account_id := NULL;
      NEW.review_assigned_at := NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'copy_sampling_items' THEN
    IF NEW.selected AND NEW.status = 'PENDING' AND NEW.assigned_review_account_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND priority_paused) THEN
      NEW.assigned_review_account_id := choose_priority_reviewer(NEW.final_approver_account_id);
      NEW.assigned_review_at := now();
      IF NEW.assigned_review_account_id IS NOT NULL THEN
        INSERT INTO review_queue_assignment_events(account_id, task_id, queue_kind)
          VALUES (NEW.assigned_review_account_id, NEW.task_id, 'COPY_QA');
      END IF;
    END IF;
  ELSE
    IF NEW.selected AND NEW.status = 'PENDING' AND NEW.assigned_review_account_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND priority_paused) THEN
      NEW.assigned_review_account_id := choose_image_quality_reviewer(NEW.submitter_account_id);
      NEW.assigned_review_at := now();
      IF NEW.assigned_review_account_id IS NOT NULL THEN
        INSERT INTO review_queue_assignment_events(account_id, task_id, queue_kind)
          VALUES (NEW.assigned_review_account_id, NEW.task_id, 'IMAGE_QA');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER image_sampling_assign_review
  BEFORE INSERT OR UPDATE OF status ON image_sampling_items
  FOR EACH ROW EXECUTE FUNCTION assign_priority_review_queue();

CREATE OR REPLACE FUNCTION resume_priority_review_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE copy_sampling_items SET status = status
    WHERE task_id = NEW.id AND selected AND status = 'PENDING' AND assigned_review_account_id IS NULL;
  UPDATE image_sampling_items SET status = status
    WHERE task_id = NEW.id AND selected AND status = 'PENDING' AND assigned_review_account_id IS NULL;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION refresh_task_priority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id THEN
      NEW.queue_entered_at := now();
    END IF;
    IF (OLD.state = 'COPY_QC_PENDING' AND NEW.state IN ('COPY_REVIEW_PENDING', 'COPY_QUEUED'))
      OR (OLD.state IN ('MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING', 'REVIEWED')
        AND NEW.state IN ('COPY_REVIEW_PENDING', 'COPY_QUEUED', 'IMAGE_QUEUED', 'IMAGE_REWORK_PENDING'))
      OR (OLD.state = 'COPY_REVIEW_PENDING' AND NEW.state = 'COPY_REVIEW_PENDING'
        AND NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id) THEN
      IF NEW.rework_count = OLD.rework_count THEN NEW.rework_count := OLD.rework_count + 1; END IF;
      IF NEW.requeue_reason IS NOT DISTINCT FROM OLD.requeue_reason THEN NEW.requeue_reason := 'REWORK'; END IF;
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
    WHEN NEW.mandatory_copy_qc OR NEW.mandatory_image_qc OR NEW.rework_count >= 2
      OR NEW.requeue_reason = 'MANDATORY_RECHECK' THEN 400
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

CREATE FUNCTION invalidate_image_quality_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_image_run_id IS DISTINCT FROM OLD.current_image_run_id THEN
    NEW.image_qc_released_approval_event_id := NULL;
    NEW.image_qc_legacy_accepted := false;
    INSERT INTO image_sampling_events(freeze_id, sampling_item_id, action, actor_username, request_id, details)
      SELECT freeze_id, id, 'SUPERSEDE', 'system', gen_random_uuid(),
        jsonb_build_object('oldImageRunId', image_run_id, 'newImageRunId', NEW.current_image_run_id)
      FROM image_sampling_items
      WHERE task_id = NEW.id AND image_run_id IS DISTINCT FROM NEW.current_image_run_id
        AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
    UPDATE image_sampling_items SET status = 'SUPERSEDED', updated_at = now()
    WHERE task_id = NEW.id AND image_run_id IS DISTINCT FROM NEW.current_image_run_id
      AND status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RELEASED');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_image_quality_version BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION invalidate_image_quality_version();

UPDATE tasks SET review_assigned_to_account_id = NULL, review_assigned_at = NULL
WHERE state = 'MANUAL_ARCHIVE';
