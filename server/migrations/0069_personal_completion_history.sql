CREATE INDEX IF NOT EXISTS copy_approval_events_actor_completed_idx
  ON copy_approval_events(approved_by_account_id, approved_at DESC, task_id)
  WHERE approved_by_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS image_approval_events_actor_completed_idx
  ON image_approval_events(submitted_by_account_id, submitted_at DESC, task_id);
