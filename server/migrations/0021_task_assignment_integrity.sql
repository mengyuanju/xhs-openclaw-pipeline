-- Migration 0017 identified creators by mutable usernames. If an account was
-- deleted and the username recreated before that migration, its historical
-- tasks were incorrectly self-assigned to the replacement account. Remove only
-- unaudited SELF assignments that cannot be proven to post-date the current
-- account. Equal timestamps are deliberately fail-closed because now() is
-- transaction-scoped and the username alone cannot establish identity.
UPDATE tasks AS task
SET assigned_to_user_id = NULL,
    assignment_source = NULL,
    assigned_at = NULL,
    progress_message = CASE
      WHEN task.state IN ('COPY_QUEUED', 'IMAGE_QUEUED')
        AND task.progress_message IN (
          '等待管理员分配作业员',
          '负责人待分配，等待文案执行机领取',
          '等待文案执行机领取',
          '等待图片执行机领取',
          '文案审核通过，等待图片执行机领取'
        )
        THEN '等待分配负责人'
      ELSE task.progress_message
    END
FROM app_users AS creator
WHERE task.assigned_to_user_id = task.created_by_user_id
  AND task.assignment_source = 'SELF'
  AND creator.username = task.created_by_user_id
  AND (task.created_at IS NULL OR creator.created_at >= task.created_at)
  AND NOT EXISTS (
    SELECT 1 FROM task_assignment_events AS assignment_event
    WHERE assignment_event.task_id = task.id
  );

-- Reconcile tasks written by a pre-assignment center during a rolling upgrade.
-- An explicit assignment/unassignment always has an audit event and must win.
UPDATE tasks AS task
SET assigned_to_user_id = task.created_by_user_id,
    assignment_source = 'SELF',
    assigned_at = COALESCE(task.created_at, now()),
    progress_message = CASE
      WHEN task.state = 'COPY_QUEUED'
        AND task.progress_message IN ('等待分配负责人', '等待管理员分配作业员', '负责人待分配，等待文案执行机领取')
        THEN '等待文案执行机领取'
      WHEN task.state = 'IMAGE_QUEUED'
        AND task.progress_message IN ('等待分配负责人', '等待管理员分配作业员')
        THEN '等待图片执行机领取'
      ELSE task.progress_message
    END
FROM app_users AS creator
WHERE task.assigned_to_user_id IS NULL
  AND task.assignment_source IS NULL
  AND task.assigned_at IS NULL
  AND creator.username = task.created_by_user_id
  AND creator.role = 'USER'
  AND creator.status = 'ACTIVE'
  AND task.created_at IS NOT NULL
  AND creator.created_at < task.created_at
  AND NOT EXISTS (
    SELECT 1 FROM task_assignment_events AS assignment_event
    WHERE assignment_event.task_id = task.id
  );

-- Repair metadata left behind by the former ON DELETE SET NULL relationship.
UPDATE tasks
SET assignment_source = NULL,
    assigned_at = NULL
WHERE assigned_to_user_id IS NULL
  AND (assignment_source IS NOT NULL OR assigned_at IS NOT NULL);

-- Pending work is no longer claimable before assignment; remove legacy text
-- that incorrectly tells operators it is already waiting for an executor.
UPDATE tasks
SET progress_message = '等待分配负责人'
WHERE assigned_to_user_id IS NULL
  AND state IN ('COPY_QUEUED', 'IMAGE_QUEUED')
  AND progress_message IN (
    '等待管理员分配作业员',
    '负责人待分配，等待文案执行机领取',
    '等待文案执行机领取',
    '等待图片执行机领取',
    '文案审核通过，等待图片执行机领取'
  );

-- Make every assigned task satisfy the complete assignment metadata invariant.
UPDATE tasks
SET assignment_source = COALESCE(
      assignment_source,
      CASE WHEN assigned_to_user_id = created_by_user_id THEN 'SELF' ELSE 'MANUAL' END
    ),
    assigned_at = COALESCE(assigned_at, updated_at, created_at, now())
WHERE assigned_to_user_id IS NOT NULL
  AND (assignment_source IS NULL OR assigned_at IS NULL);

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_assigned_to_user_id_fkey;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_assigned_to_user_id_fkey
  FOREIGN KEY (assigned_to_user_id)
  REFERENCES app_users(username) ON DELETE RESTRICT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_assignment_metadata_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_assignment_metadata_check CHECK (
    (assigned_to_user_id IS NULL AND assignment_source IS NULL AND assigned_at IS NULL)
    OR
    (assigned_to_user_id IS NOT NULL AND assignment_source IS NOT NULL AND assigned_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS tasks_unassigned_active_state_id_idx
  ON tasks(state, id)
  WHERE assigned_to_user_id IS NULL
    AND state NOT IN ('REVIEWED', 'CANCELLED');
