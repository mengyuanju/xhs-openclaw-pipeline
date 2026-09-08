-- Keep scheduling fairness independently from task audit rows. Task assignment
-- events are deleted with their task, while this worker cursor must survive.
CREATE TABLE IF NOT EXISTS task_auto_assignment_cursors (
  username varchar(50) PRIMARY KEY
    REFERENCES app_users(username) ON DELETE CASCADE,
  last_auto_event_id bigint NOT NULL CHECK (last_auto_event_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO task_auto_assignment_cursors(username, last_auto_event_id)
SELECT assignment_event.assignee_user_id, MAX(assignment_event.id)
FROM task_assignment_events AS assignment_event
JOIN app_users AS app_user
  ON app_user.username = assignment_event.assignee_user_id
WHERE assignment_event.source = 'AUTO'
  AND assignment_event.assignee_user_id IS NOT NULL
  AND assignment_event.created_at > app_user.created_at
GROUP BY assignment_event.assignee_user_id
ON CONFLICT(username) DO UPDATE SET
  last_auto_event_id = GREATEST(
    task_auto_assignment_cursors.last_auto_event_id,
    excluded.last_auto_event_id
  ),
  updated_at = now();
