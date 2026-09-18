-- Human waiting time must not restart when a draft creates another revision.
-- Existing rows retain the last known stage timestamp; no historical wait is invented.
ALTER TABLE tasks ADD COLUMN personal_stage_entered_at timestamptz;
UPDATE tasks SET personal_stage_entered_at = queue_entered_at;
ALTER TABLE tasks ALTER COLUMN personal_stage_entered_at SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN personal_stage_entered_at SET DEFAULT now();

CREATE FUNCTION refresh_personal_stage_entered_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
    OR NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id THEN
    NEW.personal_stage_entered_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_personal_stage_entered_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION refresh_personal_stage_entered_at();

CREATE INDEX personal_plan_latest_idx ON copy_image_plan_regeneration_jobs(task_id,copy_revision_id,created_at DESC,id DESC);
CREATE INDEX personal_image_edit_latest_idx ON image_edit_requests(task_id,copy_revision_id,target_page,created_at DESC,id DESC)
  WHERE status <> 'DRAFT';
CREATE INDEX personal_copy_returns_idx ON copy_revisions(task_id,created_at DESC) WHERE revision_origin='QA_RETURN';
