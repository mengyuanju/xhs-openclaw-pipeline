-- Build this concurrently before the transactional migration on populated
-- databases. The narrower task-list candidate query can use only index pages;
-- full task summaries are fetched after de-duplication and pagination.
CREATE INDEX IF NOT EXISTS tasks_content_query_identity_cover_idx
  ON tasks((lower(regexp_replace(btrim(query), '\s+', ' ', 'g'))), created_at DESC, id DESC)
  INCLUDE (query, priority_paused, priority_sort_at, state,
    created_by_user_id, assigned_to_user_id, assigned_at)
  WHERE task_kind = 'CONTENT'
    AND octet_length(query) + octet_length(lower(regexp_replace(btrim(query), '\s+', ' ', 'g')))
      + octet_length(COALESCE(created_by_user_id, ''))
      + octet_length(COALESCE(assigned_to_user_id, '')) <= 2300;

-- Bound all variable-width fields, leaving room for B-tree tuple overhead and
-- fixed-width attributes. Legal 500-character Unicode Queries and legacy long
-- identity values remain in a separate narrow index instead of failing writes.
-- Readers merge both sorted branches before DISTINCT, preserving cross-branch
-- identities such as long whitespace-heavy Query variants.
CREATE INDEX IF NOT EXISTS tasks_content_query_identity_long_idx
  ON tasks((lower(regexp_replace(btrim(query), '\s+', ' ', 'g'))), created_at DESC, id DESC)
  WHERE task_kind = 'CONTENT'
    AND octet_length(query) + octet_length(lower(regexp_replace(btrim(query), '\s+', ' ', 'g')))
      + octet_length(COALESCE(created_by_user_id, ''))
      + octet_length(COALESCE(assigned_to_user_id, '')) > 2300;

DROP INDEX IF EXISTS tasks_content_query_identity_latest_idx;
