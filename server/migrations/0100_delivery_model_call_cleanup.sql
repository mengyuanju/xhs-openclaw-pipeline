-- A delivery captures execution identities once. Later retries cannot widen
-- this set to include executions created by a subsequent rework cycle.
CREATE TABLE delivery_model_call_cleanup (
  delivery_entry_id bigint PRIMARY KEY REFERENCES delivery_entries(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_ids uuid[] NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DEFERRED', 'COMPLETE')),
  deleted_count bigint NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  attempts integer NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  last_error varchar(500)
);
CREATE INDEX delivery_model_call_cleanup_pending_idx
  ON delivery_model_call_cleanup(next_attempt_at, task_id, delivery_entry_id)
  WHERE status <> 'COMPLETE';
CREATE INDEX delivery_model_call_cleanup_task_idx
  ON delivery_model_call_cleanup(task_id, delivery_entry_id DESC);
CREATE TABLE delivery_model_call_cleanup_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_delivery_entry_id bigint NOT NULL DEFAULT 0
);
INSERT INTO delivery_model_call_cleanup_cursor(singleton) VALUES (true);
