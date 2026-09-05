ALTER TABLE executor_nodes
  ADD COLUMN copy_concurrency integer NOT NULL DEFAULT 1 CHECK (copy_concurrency BETWEEN 1 AND 32),
  ADD COLUMN image_concurrency integer NOT NULL DEFAULT 1 CHECK (image_concurrency BETWEEN 1 AND 32);

CREATE INDEX task_executions_running_node_kind_idx
  ON task_executions(node_id, kind) WHERE status = 'RUNNING';

CREATE TABLE execution_claim_requests (
  node_id varchar(100) NOT NULL REFERENCES executor_nodes(id),
  kind varchar(10) NOT NULL CHECK (kind IN ('COPY', 'IMAGE')),
  request_id uuid NOT NULL,
  requested_limit integer NOT NULL CHECK (requested_limit BETWEEN 1 AND 32),
  execution_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, kind, request_id)
);
