ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assigned_to_user_id varchar(50)
    REFERENCES app_users(username) ON DELETE SET NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assignment_source varchar(20)
    CHECK (assignment_source IN ('SELF', 'MANUAL', 'AUTO'));

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Preserve ordinary workers' existing personal queues. Administrator-created,
-- deleted-user and unattributed history intentionally remains unassigned so an
-- administrator can route it explicitly.
UPDATE tasks AS task
SET assigned_to_user_id = task.created_by_user_id,
    assignment_source = 'SELF',
    assigned_at = COALESCE(task.created_at, now())
FROM app_users AS creator
WHERE task.assigned_to_user_id IS NULL
  AND creator.username = task.created_by_user_id
  AND creator.role = 'USER'
  AND creator.status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS tasks_assignee_state_id_idx
  ON tasks(assigned_to_user_id, state, id)
  WHERE assigned_to_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_unassigned_copy_queue_idx
  ON tasks(id)
  WHERE assigned_to_user_id IS NULL AND state = 'COPY_QUEUED';

CREATE TABLE IF NOT EXISTS task_assignment_events (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_username varchar(50) NOT NULL,
  previous_assignee_user_id varchar(50),
  assignee_user_id varchar(50),
  source varchar(20) NOT NULL CHECK (source IN ('SELF', 'MANUAL', 'AUTO')),
  reason varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (assignee_user_id IS NOT NULL OR previous_assignee_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS task_assignment_events_task_created_idx
  ON task_assignment_events(task_id, created_at, id);

-- The pending-pool workbench is also a saveable administrator view.
ALTER TABLE saved_task_views
  DROP CONSTRAINT IF EXISTS saved_task_views_view_key_check;

ALTER TABLE saved_task_views
  ADD CONSTRAINT saved_task_views_view_key_check CHECK (view_key IN (
    'PERSONAL', 'UNASSIGNED', 'ALL_COPY', 'COPY_REVIEW', 'IMAGE_WORK',
    'MANUAL_ARCHIVE', 'COMPLETED', 'ALL_JOBS'
  ));
