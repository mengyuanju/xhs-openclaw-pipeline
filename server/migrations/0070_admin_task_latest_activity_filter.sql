-- Administrator date filters use the latest task mutation or execution
-- activity, so work resumed today remains visible even when created earlier.
CREATE INDEX tasks_latest_activity_idx
  ON tasks ((GREATEST(created_at, updated_at, COALESCE(last_activity_at, updated_at))) DESC, id DESC);
