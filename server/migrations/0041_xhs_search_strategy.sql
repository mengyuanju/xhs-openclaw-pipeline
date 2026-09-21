-- Preserve historical jobs as multi-round searches, while making every new
-- administrator setting default to the first-screen fastest strategy.
UPDATE global_settings
SET value = CASE
  WHEN value ? 'searchMode' THEN value
  ELSE value || '{"searchMode":"FASTEST"}'::jsonb
END,
updated_at = now()
WHERE key = 'xhs_query_search';

ALTER TABLE xhs_query_search_jobs
  ADD COLUMN search_mode varchar(20) NOT NULL DEFAULT 'THOROUGH'
    CHECK (search_mode IN ('FASTEST', 'THOROUGH'));

COMMENT ON COLUMN xhs_query_search_jobs.search_mode IS
  'Administrator-configured search strategy frozen when the search job is claimed.';
