-- Trigram indexes keep substring search bounded on a large task/package history.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX tasks_query_trgm_idx ON tasks USING gin (lower(query) gin_trgm_ops);
CREATE INDEX query_packages_name_trgm_idx ON query_packages USING gin (lower(name) gin_trgm_ops);
CREATE INDEX tasks_query_package_name_trgm_idx
  ON tasks USING gin (lower(COALESCE(source_query_package_name, '')) gin_trgm_ops);

CREATE INDEX tasks_created_id_idx ON tasks(created_at DESC, id DESC);
CREATE INDEX tasks_state_created_id_idx ON tasks(state, created_at DESC, id DESC);

CREATE INDEX tasks_priority_created_id_idx ON tasks (
  (CASE
    WHEN state = 'COPY_REVIEW_PENDING' THEN 1
    WHEN state = 'COPY_QC_PENDING' THEN 2
    WHEN state = 'MANUAL_ARCHIVE' THEN 3
    WHEN state = 'COPY_RUNNING' THEN 4
    WHEN state = 'IMAGE_RUNNING' THEN 5
    WHEN state IN ('COPY_FAILED', 'IMAGE_FAILED') THEN 6
    WHEN state IN ('COPY_QUEUED', 'IMAGE_QUEUED') THEN 7
    WHEN state = 'REVIEWED' THEN 8
    WHEN state = 'CANCELLED' THEN 9
    ELSE 10
  END),
  created_at DESC,
  id DESC
);
