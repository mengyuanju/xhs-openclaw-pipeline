-- NULL identifies legacy executions that have not negotiated task heartbeats.
ALTER TABLE task_executions ADD COLUMN heartbeat_at timestamptz;
CREATE INDEX task_executions_recovery_idx ON task_executions(last_activity_at, heartbeat_at)
  WHERE status = 'RUNNING';
