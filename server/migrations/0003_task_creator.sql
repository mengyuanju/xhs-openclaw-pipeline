-- Node identity is execution metadata, not account ownership. Existing tasks
-- have no reliable account attribution and remain visible in global lists.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_user_id varchar(100);
CREATE INDEX IF NOT EXISTS tasks_creator_id_idx ON tasks(created_by_user_id, id DESC);
