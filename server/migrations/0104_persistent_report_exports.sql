CREATE TABLE task_report_exports (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  owner_account_id bigint NOT NULL,
  owner_username varchar(50) NOT NULL,
  credential_version integer NOT NULL,
  query jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','COMPLETE','FAILED','EXPIRED')),
  lease_token uuid,
  -- A replaced/expired lease keeps its file identities until deletion succeeds.
  -- This also retries Windows sharing violations after a process interruption.
  retired_lease_tokens uuid[] NOT NULL DEFAULT '{}',
  lease_until timestamptz,
  row_count bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  last_error varchar(500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  UNIQUE(owner_account_id,request_id)
);
CREATE INDEX task_report_exports_queue_idx ON task_report_exports(status,lease_until,id)
  WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX task_report_exports_owner_idx ON task_report_exports(owner_account_id,id DESC);
CREATE INDEX task_report_exports_expiry_idx ON task_report_exports(expires_at,id)
  WHERE status<>'EXPIRED';
CREATE INDEX task_report_exports_retired_files_idx ON task_report_exports(id)
  WHERE cardinality(retired_lease_tokens)>0;
