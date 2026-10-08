ALTER TABLE app_users
  ADD COLUMN default_copy_qa_pass boolean NOT NULL DEFAULT false;

ALTER TABLE tasks
  ADD COLUMN copy_qa_auto_passed_revision_id bigint REFERENCES copy_revisions(id);
