ALTER TABLE xhs_query_search_nodes
  ADD COLUMN account_label varchar(100),
  ADD COLUMN host_kind varchar(20) NOT NULL DEFAULT 'EXECUTOR'
    CHECK (host_kind IN ('CENTER', 'EXECUTOR')),
  ADD COLUMN auth_status varchar(30) NOT NULL DEFAULT 'UNKNOWN'
    CHECK (auth_status IN ('UNKNOWN', 'READY', 'LOGIN_REQUIRED', 'CAPTCHA_REQUIRED')),
  ADD COLUMN auth_status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN auth_checked_at timestamptz,
  ADD COLUMN last_job_id bigint REFERENCES xhs_query_search_jobs(id) ON DELETE SET NULL;

CREATE INDEX xhs_query_search_nodes_auth_attention_idx
  ON xhs_query_search_nodes(auth_status, auth_status_changed_at DESC)
  WHERE auth_status IN ('LOGIN_REQUIRED', 'CAPTCHA_REQUIRED');

COMMENT ON COLUMN xhs_query_search_nodes.account_label IS
  'Operator-provided non-secret label identifying the Xiaohongshu account used by this search executor.';

COMMENT ON COLUMN xhs_query_search_nodes.auth_status IS
  'Latest observed Xiaohongshu authentication state; machine online state is derived independently from last_seen_at.';
