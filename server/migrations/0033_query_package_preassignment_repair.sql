-- Query-package production used to copy the package owner onto every task at
-- creation time. V3 keeps copy generation in the shared machine queue and only
-- assigns a human after the copy reaches COPY_REVIEW_PENDING. Repair only rows
-- that still carry the exact, unaudited creation-time signature of that legacy
-- path. Every ambiguous or subsequently assigned task is deliberately retained.
WITH candidates AS MATERIALIZED (
  SELECT
    task.id,
    task.assigned_to_user_id AS previous_assignee_user_id
  FROM tasks AS task
  WHERE task.source_query_package_id IS NOT NULL
    AND task.source_query_package_item_id IS NOT NULL
    AND task.production_batch_id IS NOT NULL
    AND task.assigned_to_user_id IS NOT NULL
    AND task.assignment_source = 'MANUAL'
    AND task.assigned_at = task.created_at
    AND COALESCE(task.skip_copy_review, false) = false
    AND (
      task.state IN ('COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED')
      OR (
        task.state = 'COPY_REVIEW_PENDING'
        AND task.current_stage = 'COPY_REVIEW_PENDING'
      )
    )
    AND EXISTS (
      SELECT 1
      FROM production_batch_items AS batch_item
      JOIN production_batches AS batch
        ON batch.id = batch_item.production_batch_id
      WHERE batch_item.task_id = task.id
        AND batch_item.production_batch_id = task.production_batch_id
        AND batch_item.source_query_package_item_id = task.source_query_package_item_id
        AND batch.query_package_id = task.source_query_package_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM task_assignment_events AS assignment_event
      WHERE assignment_event.task_id = task.id
    )
  FOR UPDATE OF task
), cleared AS (
  UPDATE tasks AS task
  SET assigned_to_user_id = NULL,
      assignment_source = NULL,
      assigned_at = NULL,
      progress_message = CASE
        WHEN task.state = 'COPY_REVIEW_PENDING'
          THEN '文案生成完成，等待分配负责人后审核'
        ELSE task.progress_message
      END
  FROM candidates AS candidate
  WHERE task.id = candidate.id
  RETURNING task.id, candidate.previous_assignee_user_id
)
INSERT INTO task_assignment_events(
  task_id,
  actor_username,
  previous_assignee_user_id,
  assignee_user_id,
  source,
  reason
)
SELECT
  cleared.id,
  'migration-0033-query-preassignment',
  cleared.previous_assignee_user_id,
  NULL,
  'MANUAL',
  '迁移 0033：移除旧版 Query 词包在作业创建时写入的预分配'
FROM cleared;
