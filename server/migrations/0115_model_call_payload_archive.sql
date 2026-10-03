-- Keep trace metadata in the hot table. Delivery trace deletion cascades into
-- this archive, so archived bodies cannot outlive their visible call record.
ALTER TABLE model_call_traces ADD COLUMN payload_archived boolean NOT NULL DEFAULT false;
ALTER TABLE model_call_traces ADD CONSTRAINT model_call_traces_archived_payload_check
  CHECK (NOT payload_archived OR (status <> 'RUNNING' AND prompt = '' AND request = ''
    AND response IS NULL AND error IS NULL));

CREATE TABLE model_call_payload_archives (
  call_id uuid PRIMARY KEY REFERENCES model_call_traces(id) ON DELETE CASCADE,
  format_version smallint NOT NULL DEFAULT 1 CHECK (format_version = 1),
  payload bytea NOT NULL,
  raw_bytes integer NOT NULL CHECK (raw_bytes BETWEEN 1 AND 8388608),
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Begin with pending payloads, ordered by call finish time. Completed execution
-- metadata is read by its existing primary key, without scanning old snapshots.
CREATE INDEX model_call_traces_payload_archive_pending_idx
  ON model_call_traces(finished_at, execution_id, id)
  WHERE NOT payload_archived AND status <> 'RUNNING' AND finished_at IS NOT NULL;
