ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS deletion_password_hash varchar(500);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS cancelled_from_state varchar(40)
    CHECK (cancelled_from_state IS NULL OR cancelled_from_state IN (
      'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
      'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED'
    ));
