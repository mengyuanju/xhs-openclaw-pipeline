ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
  'COPY_QC_PENDING',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
  'MANUAL_ARCHIVE', 'REVIEWED', 'CANCELLED'
));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cancelled_from_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_cancelled_from_state_check CHECK (
  cancelled_from_state IS NULL OR cancelled_from_state IN (
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'COPY_QC_PENDING',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED'
  )
);

CREATE TABLE workflow_quality_settings (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  query_package_worker_import_enabled boolean NOT NULL DEFAULT false,
  copy_sampling_enabled boolean NOT NULL DEFAULT false,
  copy_sampling_rate_bps integer NOT NULL DEFAULT 0
    CHECK (copy_sampling_rate_bps BETWEEN 0 AND 10000),
  blind_review_enabled boolean NOT NULL DEFAULT false,
  reviewer_batch_return_enabled boolean NOT NULL DEFAULT false,
  sampling_seed varchar(200) NOT NULL DEFAULT 'copy-sampling-v1',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_username varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workflow_quality_settings(singleton) VALUES (1);

CREATE TABLE copy_approval_events (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  assessment_id bigint REFERENCES human_quality_assessments(id) ON DELETE SET NULL,
  approval_mode varchar(20) NOT NULL CHECK (approval_mode IN ('MANUAL', 'ADMIN_BYPASS')),
  approved_by_account_id bigint,
  approved_by_username varchar(50) NOT NULL,
  review_session_id uuid,
  content_sha256 char(64) NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, copy_revision_id, review_session_id)
);

CREATE UNIQUE INDEX copy_approval_events_one_revision_idx
  ON copy_approval_events(task_id, copy_revision_id);

CREATE INDEX copy_approval_events_batch_lookup_idx
  ON copy_approval_events(task_id, approved_at DESC, id DESC);

CREATE TABLE copy_sampling_freezes (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  production_batch_id bigint NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  freeze_version integer NOT NULL DEFAULT 1 CHECK (freeze_version > 0),
  policy_version bigint NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  seed varchar(200) NOT NULL,
  algorithm_version varchar(80) NOT NULL,
  blind_review_enabled boolean NOT NULL,
  population_count integer NOT NULL CHECK (population_count > 0),
  sample_count integer NOT NULL CHECK (sample_count BETWEEN 0 AND population_count),
  snapshot_sha256 char(64) NOT NULL,
  frozen_by_account_id bigint,
  frozen_by_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'INSPECTING'
    CHECK (status IN ('INSPECTING', 'REVIEW_REQUIRED', 'RELEASED', 'RELEASED_WITH_EXCEPTIONS', 'BATCH_RETURNED', 'CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(production_batch_id, freeze_version),
  UNIQUE(frozen_by_username, request_id)
);

CREATE TABLE copy_sampling_strata (
  freeze_id bigint NOT NULL REFERENCES copy_sampling_freezes(id) ON DELETE CASCADE,
  final_approver_account_id bigint NOT NULL,
  population_count integer NOT NULL CHECK (population_count > 0),
  quota integer NOT NULL CHECK (quota BETWEEN 0 AND population_count),
  PRIMARY KEY(freeze_id, final_approver_account_id)
);

CREATE TABLE copy_sampling_items (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  freeze_id bigint NOT NULL REFERENCES copy_sampling_freezes(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_event_id bigint NOT NULL REFERENCES copy_approval_events(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  content_sha256 char(64) NOT NULL,
  final_approver_account_id bigint NOT NULL,
  final_approver_username varchar(50) NOT NULL,
  rank_hash char(64) NOT NULL,
  selected boolean NOT NULL,
  sample_kind varchar(20) NOT NULL DEFAULT 'RANDOM'
    CHECK (sample_kind IN ('RANDOM', 'MANDATORY_RECHECK')),
  parent_item_id bigint REFERENCES copy_sampling_items(id) ON DELETE SET NULL,
  status varchar(30) NOT NULL
    CHECK (status IN ('NOT_SELECTED', 'PENDING', 'PASSED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'RELEASED', 'SUPERSEDED')),
  reviewed_by_account_id bigint,
  reviewed_by_username varchar(50),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(freeze_id, task_id, approval_event_id)
);

CREATE INDEX copy_sampling_items_queue_idx
  ON copy_sampling_items(status, id) WHERE selected = true;

ALTER TABLE tasks
  ADD COLUMN mandatory_copy_qc boolean NOT NULL DEFAULT false,
  ADD COLUMN mandatory_copy_qc_origin varchar(30)
    CHECK (mandatory_copy_qc_origin IS NULL OR mandatory_copy_qc_origin IN ('QA_RETURN', 'FINAL_REWORK'));

CREATE TABLE copy_sampling_events (
  id bigserial PRIMARY KEY,
  freeze_id bigint NOT NULL REFERENCES copy_sampling_freezes(id) ON DELETE CASCADE,
  sampling_item_id bigint REFERENCES copy_sampling_items(id) ON DELETE CASCADE,
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

CREATE TABLE copy_sampling_mutation_requests (
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  operation varchar(30) NOT NULL CHECK (operation IN ('FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE')),
  request_fingerprint char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_username, request_id)
);
