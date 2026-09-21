-- Manual image edits are image-executor work. A synthetic IMAGE execution keeps
-- them inside the same node and shared Codex concurrency limits as generation.
ALTER TABLE image_edit_requests
  ADD COLUMN execution_id uuid UNIQUE REFERENCES task_executions(id);

CREATE INDEX image_edit_executor_queue_idx
  ON image_edit_requests(status, task_id, created_at, id)
  WHERE status = 'QUEUED';

CREATE INDEX image_edit_running_execution_idx
  ON image_edit_requests(execution_id)
  WHERE status = 'RUNNING';
