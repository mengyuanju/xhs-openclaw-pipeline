CREATE TABLE query_packages (
  id bigserial PRIMARY KEY,
  name varchar(200) NOT NULL,
  source_file_name varchar(255),
  status varchar(30) NOT NULL DEFAULT 'IMPORTED'
    CHECK (status IN ('IMPORTED', 'SCREENING', 'READY', 'PARTIALLY_USED', 'USED_UP', 'ABANDONED')),
  created_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  created_by_username varchar(50) NOT NULL,
  assigned_to_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  assigned_to_username varchar(50),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_packages_assignee_status_idx
  ON query_packages(assigned_to_account_id, status, id DESC);

CREATE TABLE query_package_items (
  id bigserial PRIMARY KEY,
  query_package_id bigint NOT NULL REFERENCES query_packages(id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number > 0),
  external_id varchar(200),
  raw_query text NOT NULL CHECK (char_length(raw_query) <= 5000),
  query varchar(500),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_image_count varchar(8) NOT NULL DEFAULT 'auto'
    CHECK (requested_image_count IN ('auto', '3', '4', '5')),
  status varchar(20) NOT NULL DEFAULT 'READY'
    CHECK (status IN ('READY', 'DUPLICATE', 'INVALID', 'TASK_CREATED')),
  validation_errors text[] NOT NULL DEFAULT '{}'::text[],
  screening_decision varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (screening_decision IN ('PENDING', 'SELECTED', 'REJECTED')),
  screening_reason varchar(500),
  screened_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  screened_by_username varchar(50),
  screened_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(query_package_id, row_number)
);

CREATE INDEX query_package_items_package_decision_idx
  ON query_package_items(query_package_id, screening_decision, id);

CREATE TABLE query_package_screening_events (
  id bigserial PRIMARY KEY,
  query_package_id bigint NOT NULL REFERENCES query_packages(id) ON DELETE CASCADE,
  query_package_item_id bigint NOT NULL REFERENCES query_package_items(id) ON DELETE CASCADE,
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  previous_decision varchar(20) NOT NULL,
  decision varchar(20) NOT NULL,
  reason varchar(500),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE production_batches (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  query_package_id bigint REFERENCES query_packages(id) ON DELETE SET NULL,
  query_package_name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'FROZEN', 'REVIEW_REQUIRED', 'RELEASED', 'RELEASED_WITH_EXCEPTIONS', 'BATCH_RETURNED', 'CANCELLED')),
  sampling_status varchar(20) NOT NULL DEFAULT 'OPEN'
    CHECK (sampling_status IN ('OPEN', 'FROZEN', 'COMPLETED', 'RETURNED', 'CANCELLED')),
  created_by_account_id bigint REFERENCES app_users(id) ON DELETE SET NULL,
  created_by_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by_username, request_id)
);

CREATE TABLE production_batch_items (
  id bigserial PRIMARY KEY,
  production_batch_id bigint NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  source_query_package_item_id bigint REFERENCES query_package_items(id) ON DELETE SET NULL,
  source_external_id varchar(200),
  query_snapshot varchar(500) NOT NULL,
  task_id bigint UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(production_batch_id, source_query_package_item_id)
);

ALTER TABLE tasks
  ADD COLUMN source_query_package_id bigint REFERENCES query_packages(id) ON DELETE SET NULL,
  ADD COLUMN source_query_package_item_id bigint REFERENCES query_package_items(id) ON DELETE SET NULL,
  ADD COLUMN source_query_package_name varchar(200),
  ADD COLUMN source_query_package_external_id varchar(200),
  ADD COLUMN production_batch_id bigint REFERENCES production_batches(id) ON DELETE SET NULL;

CREATE INDEX tasks_production_batch_state_idx
  ON tasks(production_batch_id, state, id) WHERE production_batch_id IS NOT NULL;

CREATE TABLE query_package_mutation_requests (
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  operation varchar(30) NOT NULL CHECK (operation IN ('CREATE', 'SCREEN', 'PRODUCE', 'ABANDON', 'DELETE')),
  query_package_id bigint,
  request_fingerprint char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_username, request_id)
);

-- Permanent deletion deliberately records no Query, input, filename or item
-- content. Production tasks and batch snapshots are retained separately.
CREATE TABLE query_package_deletion_audits (
  id bigserial PRIMARY KEY,
  deleted_query_package_id bigint NOT NULL,
  deleted_item_count integer NOT NULL CHECK (deleted_item_count >= 0),
  detached_task_count integer NOT NULL CHECK (detached_task_count >= 0),
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  reason varchar(500) NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_username, request_id)
);

CREATE TABLE query_package_lifecycle_audits (
  id bigserial PRIMARY KEY,
  query_package_id bigint NOT NULL,
  action varchar(20) NOT NULL CHECK (action IN ('ABANDON')),
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  reason varchar(500) NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_username, request_id)
);
