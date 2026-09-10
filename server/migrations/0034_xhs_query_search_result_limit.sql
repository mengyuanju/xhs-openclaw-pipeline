-- Administrators control how many ranked Xiaohongshu notes each newly claimed
-- search keeps. Existing jobs retain the historical default; every later claim
-- freezes the then-current setting onto its job row.
INSERT INTO global_settings(key, value)
VALUES ('xhs_query_search', '{"resultLimit":3}'::jsonb)
ON CONFLICT(key) DO NOTHING;

ALTER TABLE xhs_query_search_jobs
  ADD COLUMN result_limit smallint NOT NULL DEFAULT 3
    CHECK (result_limit BETWEEN 1 AND 10);

COMMENT ON COLUMN xhs_query_search_jobs.result_limit IS
  'Administrator-configured ranked-result cap frozen when the search job is claimed.';
