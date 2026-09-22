ALTER TABLE app_users
  ADD COLUMN copy_sampling_rate_bps_override integer
    CHECK (copy_sampling_rate_bps_override BETWEEN 0 AND 10000);

CREATE TABLE account_copy_sampling_policy_events (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  actor_account_id bigint,
  actor_username varchar(50) NOT NULL,
  previous_rate_bps_override integer CHECK (previous_rate_bps_override BETWEEN 0 AND 10000),
  rate_bps_override integer CHECK (rate_bps_override BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_copy_sampling_policy_events_account_idx
  ON account_copy_sampling_policy_events(account_id, id DESC);
COMMENT ON TABLE account_copy_sampling_policy_events IS
  'Historical account IDs intentionally have no foreign keys; deleting users must retain policy audit events.';

ALTER TABLE copy_sampling_freezes
  ADD COLUMN rate_source varchar(30) NOT NULL DEFAULT 'GLOBAL_DEFAULT'
    CHECK (rate_source IN ('GLOBAL_DEFAULT', 'ACCOUNT_OVERRIDE', 'MANDATORY_RECHECK')),
  ADD COLUMN account_policy_version bigint CHECK (account_policy_version > 0);

-- Label historical mandatory rounds without changing their members, rates or hashes.
UPDATE copy_sampling_freezes SET rate_source = 'MANDATORY_RECHECK'
WHERE algorithm_version = 'mandatory-recheck-v1';
