-- Existing tasks keep their manual review policy. Only authenticated admin
-- task creation may enable this flag; model output and task input cannot.
ALTER TABLE tasks ADD COLUMN skip_copy_review boolean NOT NULL DEFAULT false;
ALTER TABLE copy_revisions ADD COLUMN approval_mode varchar(20)
  CHECK (approval_mode IN ('MANUAL', 'ADMIN_BYPASS'));
