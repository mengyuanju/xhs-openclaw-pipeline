-- Add administrator-controlled pacing defaults without overriding any fields
-- that may already have been written during a staged rollout.
UPDATE global_settings
SET value = '{
  "minimumIntervalSeconds": 60,
  "hourlyLimit": 30,
  "dailyLimit": 150
}'::jsonb || value,
updated_at = now()
WHERE key = 'xhs_query_search';

-- Every claim is a real external search attempt, regardless of whether the
-- browser later succeeds, fails, or encounters an account challenge.
CREATE TABLE xhs_query_search_attempts (
  id bigserial PRIMARY KEY,
  search_job_id bigint REFERENCES xhs_query_search_jobs(id) ON DELETE SET NULL,
  node_id varchar(100) NOT NULL,
  minimum_interval_seconds integer NOT NULL CHECK (minimum_interval_seconds BETWEEN 10 AND 3600),
  hourly_limit integer NOT NULL CHECK (hourly_limit BETWEEN 1 AND 360),
  daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 8640),
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX xhs_query_search_attempts_started_at_idx
  ON xhs_query_search_attempts(started_at DESC);

COMMENT ON TABLE xhs_query_search_attempts IS
  'Immutable external-search attempt ledger used for rolling interval, hourly, and daily limits.';
