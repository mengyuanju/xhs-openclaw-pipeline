-- Fair replenishment reuses the immutable AUTO assignment audit as its durable
-- least-recently-served cursor. Keep that lookup bounded as history grows.
CREATE INDEX IF NOT EXISTS task_assignment_events_auto_assignee_id_idx
  ON task_assignment_events(assignee_user_id, id DESC)
  WHERE source = 'AUTO' AND assignee_user_id IS NOT NULL;
