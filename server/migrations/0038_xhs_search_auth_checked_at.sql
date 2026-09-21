ALTER TABLE xhs_query_search_nodes
  ADD COLUMN auth_checked_at timestamptz;

COMMENT ON COLUMN xhs_query_search_nodes.auth_checked_at IS
  'Most recent time a search attempt explicitly observed the Xiaohongshu authentication state.';
