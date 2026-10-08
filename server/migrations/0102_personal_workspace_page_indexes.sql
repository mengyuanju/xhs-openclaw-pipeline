-- Build these concurrently ahead of the transactional migration when upgrading
-- a large production database. The migration itself does not run concurrently.
CREATE INDEX IF NOT EXISTS tasks_content_owner_created_page_idx
  ON tasks(assigned_to_user_id, created_at, id) WHERE task_kind='CONTENT';
CREATE INDEX IF NOT EXISTS tasks_content_creator_created_page_idx
  ON tasks(created_by_user_id, created_at, id) WHERE task_kind='CONTENT';

CREATE INDEX IF NOT EXISTS personal_image_returns_task_time_idx
  ON image_sampling_items(task_id, reviewed_at DESC)
  WHERE rework_target IS NOT NULL AND reviewed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_final_returns_task_time_idx
  ON human_quality_assessments(task_id, created_at DESC)
  WHERE rework_target IS NOT NULL;
