ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
  'MANUAL_ARCHIVE', 'REVIEWED', 'CANCELLED'
));

ALTER TABLE tasks ADD COLUMN image_reviewed_at timestamptz;
ALTER TABLE tasks ADD COLUMN image_reviewed_by_user_id varchar(100);
