ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;

UPDATE tasks
SET state = 'MANUAL_ARCHIVE',
    current_stage = 'MANUAL_ARCHIVE',
    progress_percent = 100,
    progress_message = '图片生成完成，等待人工归档',
    finished_at = COALESCE(finished_at, now()),
    updated_at = now()
WHERE state IN ('DELIVERY_REVIEW_PENDING', 'COMPLETED');

ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
  'MANUAL_ARCHIVE', 'CANCELLED'
));
