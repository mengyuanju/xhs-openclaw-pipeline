-- Keep reference identity and edit bindings for audit after the uploaded bytes
-- have been removed. A durable queue retries file deletion after commit.
-- The id watermark records exactly which uploads preceded a READY transition.
-- Timestamp defaults use transaction-start time and cannot order concurrent
-- transactions that waited on the task row lock.
ALTER TABLE delivery_entries ADD COLUMN reference_asset_id_cutoff bigint;

CREATE TABLE image_reference_cleanup_jobs (
  asset_id bigint PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  task_id bigint NOT NULL,
  storage_path text NOT NULL,
  sha256 char(64) NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text
);

CREATE INDEX image_reference_cleanup_pending_idx
  ON image_reference_cleanup_jobs(next_attempt_at, asset_id);

CREATE INDEX assets_active_reference_quota_idx
  ON assets(task_id, asset_role)
  WHERE content_cleared_at IS NULL AND asset_role = 'REFERENCE';
