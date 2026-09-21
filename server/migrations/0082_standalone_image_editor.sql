-- Independent image uploads share only the execution infrastructure.
ALTER TABLE tasks ADD COLUMN task_kind text NOT NULL DEFAULT 'CONTENT'
  CHECK (task_kind IN ('CONTENT', 'STANDALONE_IMAGE_EDIT'));
CREATE TABLE standalone_image_workspaces (
  task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id bigint NOT NULL REFERENCES app_users(id),
  request_id uuid NOT NULL,
  upload_hash char(64) NOT NULL,
  title varchar(200) NOT NULL,
  limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, request_id)
);
CREATE INDEX standalone_image_workspaces_owner_idx ON standalone_image_workspaces(owner_id, task_id DESC);
CREATE INDEX tasks_content_state_idx ON tasks(state, id) WHERE task_kind='CONTENT';

-- A workspace cannot accidentally enter content generation, review or delivery.
ALTER TABLE tasks ADD CONSTRAINT standalone_image_workspace_state CHECK (
  task_kind <> 'STANDALONE_IMAGE_EDIT' OR (
    state='MANUAL_ARCHIVE' AND current_execution_id IS NULL AND production_batch_id IS NULL
    AND mandatory_copy_qc=false AND mandatory_image_qc=false
  )
);
