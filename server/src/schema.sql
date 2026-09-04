BEGIN;

CREATE TABLE IF NOT EXISTS executor_nodes (
  id varchar(100) PRIMARY KEY,
  name varchar(100) NOT NULL,
  image_worker_enabled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id bigserial PRIMARY KEY,
  kind varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  content_sha256 char(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(template_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_one_published_idx
  ON prompt_versions(template_id) WHERE status = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS knowledge_items (
  id bigserial PRIMARY KEY,
  kind varchar(20) NOT NULL CHECK (kind IN ('COPY', 'VISUAL')),
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_path text,
  content_sha256 char(64),
  status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(item_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_versions_one_published_idx
  ON knowledge_versions(item_id) WHERE status = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS global_settings (
  key varchar(100) PRIMARY KEY,
  value jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id bigserial PRIMARY KEY,
  query varchar(500) NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_image_count varchar(8) NOT NULL DEFAULT 'auto'
    CHECK (requested_image_count IN ('auto', '3', '4', '5')),
  state varchar(40) NOT NULL DEFAULT 'COPY_QUEUED'
    CHECK (state IN (
      'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
      'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
      'DELIVERY_REVIEW_PENDING', 'COMPLETED', 'CANCELLED'
    )),
  created_by_node_id varchar(100) NOT NULL REFERENCES executor_nodes(id),
  copy_executor_node_id varchar(100) NOT NULL REFERENCES executor_nodes(id),
  current_copy_revision_id bigint,
  current_image_run_id uuid,
  current_execution_id uuid,
  current_stage varchar(64),
  progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  progress_message varchar(500) NOT NULL DEFAULT '',
  pending_snapshot jsonb,
  execution_started_at timestamptz,
  last_activity_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_copy_queue_idx
  ON tasks(copy_executor_node_id, id) WHERE state = 'COPY_QUEUED';
CREATE INDEX IF NOT EXISTS tasks_image_queue_idx
  ON tasks(id) WHERE state = 'IMAGE_QUEUED';
CREATE INDEX IF NOT EXISTS tasks_state_updated_idx ON tasks(state, updated_at DESC);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_snapshot jsonb;

CREATE TABLE IF NOT EXISTS task_executions (
  id uuid PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('COPY', 'IMAGE')),
  node_id varchar(100) NOT NULL REFERENCES executor_nodes(id),
  status varchar(20) NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  stage varchar(64) NOT NULL,
  progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  progress_message varchar(500) NOT NULL DEFAULT '',
  progress_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS task_executions_task_idx ON task_executions(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS copy_revisions (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id uuid UNIQUE REFERENCES task_executions(id),
  revision integer NOT NULL,
  content jsonb NOT NULL,
  approved_at timestamptz,
  approved_by_node_id varchar(100) REFERENCES executor_nodes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, revision)
);

-- Human copy review creates a new immutable revision without pretending that a
-- model execution produced it. Existing databases originally required this ID.
ALTER TABLE copy_revisions ALTER COLUMN execution_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS image_runs (
  id uuid PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL UNIQUE REFERENCES task_executions(id),
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id),
  status varchar(20) NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ABANDONED')),
  result jsonb,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  image_run_id uuid NOT NULL REFERENCES image_runs(id) ON DELETE CASCADE,
  media_type varchar(100) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 char(64) NOT NULL,
  storage_path text NOT NULL UNIQUE,
  original_name varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_current_copy_revision_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_current_copy_revision_fk
      FOREIGN KEY (current_copy_revision_id) REFERENCES copy_revisions(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_current_image_run_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_current_image_run_fk
      FOREIGN KEY (current_image_run_id) REFERENCES image_runs(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_current_execution_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_current_execution_fk
      FOREIGN KEY (current_execution_id) REFERENCES task_executions(id);
  END IF;
END $$;

INSERT INTO global_settings(key, value)
VALUES ('production', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
