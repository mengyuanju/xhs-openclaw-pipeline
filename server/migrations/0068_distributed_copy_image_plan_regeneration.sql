-- Image-plan regeneration is interactive copy work, but the control plane must
-- never execute the model itself. Keep a dedicated job lifecycle while using a
-- synthetic COPY execution for the existing Codex pool, heartbeat and tracing.
ALTER TABLE executor_nodes
  ADD COLUMN copy_image_plan_regeneration_version integer NOT NULL DEFAULT 0
    CHECK (copy_image_plan_regeneration_version >= 0);

CREATE TABLE copy_image_plan_regeneration_jobs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id),
  requested_by_account_id bigint NOT NULL REFERENCES app_users(id),
  requested_by_username varchar(100) NOT NULL,
  copy_payload jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STALE')),
  execution_id uuid UNIQUE REFERENCES task_executions(id),
  claimed_by_node_id varchar(100) REFERENCES executor_nodes(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX copy_image_plan_regeneration_one_active_idx
  ON copy_image_plan_regeneration_jobs(task_id, requested_by_account_id)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX copy_image_plan_regeneration_queue_idx
  ON copy_image_plan_regeneration_jobs(created_at, id)
  WHERE status = 'QUEUED';

CREATE INDEX copy_image_plan_regeneration_running_execution_idx
  ON copy_image_plan_regeneration_jobs(execution_id)
  WHERE status = 'RUNNING';
