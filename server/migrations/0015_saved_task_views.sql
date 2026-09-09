CREATE TABLE IF NOT EXISTS saved_task_views (
  id bigserial PRIMARY KEY,
  owner_username varchar(50) NOT NULL REFERENCES app_users(username) ON DELETE CASCADE,
  name varchar(50) NOT NULL,
  view_key varchar(40) NOT NULL CHECK (view_key IN (
    'PERSONAL', 'ALL_COPY', 'COPY_REVIEW', 'IMAGE_WORK', 'MANUAL_ARCHIVE', 'COMPLETED', 'ALL_JOBS'
  )),
  filters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_username, name)
);

CREATE INDEX IF NOT EXISTS saved_task_views_owner_updated_idx
  ON saved_task_views(owner_username, updated_at DESC, id DESC);
