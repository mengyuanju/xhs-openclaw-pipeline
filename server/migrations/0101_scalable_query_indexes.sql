-- Ordinary migrations are transactional. For a populated production database,
-- build these indexes CONCURRENTLY in a separate deployment step before applying
-- this migration; IF NOT EXISTS then preserves the already validated indexes.
-- Do not put CREATE INDEX CONCURRENTLY inside this transaction.

CREATE INDEX IF NOT EXISTS tasks_content_priority_page_idx
  ON tasks(priority_paused, priority_sort_at, id) WHERE task_kind = 'CONTENT';
CREATE INDEX IF NOT EXISTS tasks_content_state_priority_page_idx
  ON tasks(state, priority_paused, priority_sort_at, id) WHERE task_kind = 'CONTENT';
CREATE INDEX IF NOT EXISTS tasks_content_owner_priority_page_idx
  ON tasks(assigned_to_user_id, priority_paused, priority_sort_at, id) WHERE task_kind = 'CONTENT';
CREATE INDEX IF NOT EXISTS tasks_content_creator_priority_page_idx
  ON tasks(created_by_user_id, priority_paused, priority_sort_at, id) WHERE task_kind = 'CONTENT';

CREATE INDEX IF NOT EXISTS tasks_current_execution_lookup_idx
  ON tasks(current_execution_id) WHERE current_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_current_copy_lookup_idx
  ON tasks(current_copy_revision_id) WHERE current_copy_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_current_image_lookup_idx
  ON tasks(current_image_run_id) WHERE current_image_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS image_runs_task_created_idx
  ON image_runs(task_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS copy_revisions_history_page_idx
  ON copy_revisions(task_id, created_at DESC, id DESC) WHERE content_cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS task_executions_history_page_idx
  ON task_executions(task_id, started_at DESC, id DESC) WHERE content_cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS image_runs_copy_revision_idx ON image_runs(copy_revision_id);
CREATE INDEX IF NOT EXISTS assets_task_id_idx ON assets(task_id, id);
CREATE INDEX IF NOT EXISTS assets_run_id_idx ON assets(image_run_id, id);
CREATE INDEX IF NOT EXISTS image_run_asset_members_asset_idx
  ON image_run_asset_members(asset_id, image_run_id);

CREATE INDEX IF NOT EXISTS production_batch_items_source_item_idx
  ON production_batch_items(source_query_package_item_id)
  WHERE source_query_package_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_batches_package_id_idx
  ON production_batches(query_package_id, id DESC) WHERE query_package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS query_packages_updated_id_idx
  ON query_packages(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS query_package_items_assignee_visibility_idx
  ON query_package_items(screening_assigned_to_account_id, screening_assigned_to_username, query_package_id)
  WHERE screening_assigned_to_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_content_query_identity_latest_idx
  ON tasks((lower(regexp_replace(btrim(query), '\s+', ' ', 'g'))), created_at DESC, id DESC)
  WHERE task_kind = 'CONTENT';
CREATE INDEX IF NOT EXISTS image_edit_requests_task_created_idx
  ON image_edit_requests(task_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS image_edit_events_edit_id_idx ON image_edit_events(edit_id, id);
CREATE INDEX IF NOT EXISTS model_call_traces_execution_id_idx ON model_call_traces(execution_id, id);

-- The previous CASE/state priority index became obsolete when queue priority
-- changed to a stable priority_sort_at. Retain the queue-claim indexes.
DROP INDEX IF EXISTS tasks_priority_created_id_idx;
