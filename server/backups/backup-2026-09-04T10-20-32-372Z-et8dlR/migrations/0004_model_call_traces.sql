CREATE TABLE model_call_traces (
  id uuid PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  stage varchar(64) NOT NULL,
  provider varchar(64) NOT NULL,
  operation varchar(64) NOT NULL,
  model varchar(200) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  prompt text NOT NULL,
  request text NOT NULL,
  response text,
  error text,
  truncated boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms bigint CHECK (duration_ms >= 0)
);
CREATE INDEX model_call_traces_task_idx ON model_call_traces(task_id, execution_id, sequence, id);
