-- Build these CONCURRENTLY in the deployment preparation step for populated
-- production databases; this ordinary migration is transactional. Neither long
-- task queries nor generated JSON are stored in these bounded index entries.
CREATE INDEX IF NOT EXISTS tasks_content_owner_personal_count_idx
  ON tasks(assigned_to_user_id,id)
  INCLUDE (assigned_at,created_at,state,current_stage,personal_stage_entered_at,
    mandatory_copy_qc,mandatory_image_qc,mandatory_copy_qc_origin,
    current_copy_revision_id,current_image_run_id)
  WHERE task_kind='CONTENT';

CREATE INDEX IF NOT EXISTS tasks_content_creator_personal_count_idx
  ON tasks(created_by_user_id,id)
  INCLUDE (assigned_to_user_id,assigned_at,created_at,state,current_stage,personal_stage_entered_at,
    mandatory_copy_qc,mandatory_image_qc,mandatory_copy_qc_origin,
    current_copy_revision_id,current_image_run_id)
  WHERE task_kind='CONTENT';

CREATE INDEX IF NOT EXISTS personal_revision_origin_lookup_idx
  ON copy_revisions(id) INCLUDE (revision_origin);
