-- Widen workflow status fields before writing the longest valid status.
ALTER TABLE production_batches
  ALTER COLUMN status TYPE varchar(32);

ALTER TABLE copy_sampling_freezes
  ALTER COLUMN status TYPE varchar(32);

-- Image-retry exhaustion can require a new one-task mandatory copy check.
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_mandatory_copy_qc_origin_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_mandatory_copy_qc_origin_check CHECK (
    mandatory_copy_qc_origin IS NULL
    OR mandatory_copy_qc_origin IN ('QA_RETURN', 'FINAL_REWORK', 'IMAGE_RETRY_REVIEW')
  );

ALTER TABLE human_quality_assessments
  ADD COLUMN rework_details jsonb,
  ADD CONSTRAINT human_quality_assessments_rework_details_check CHECK (
    rework_details IS NULL OR jsonb_typeof(rework_details) = 'object'
  );

-- Keep a stable source identity after the source package itself is permanently removed.
ALTER TABLE tasks
  ADD COLUMN source_query_package_snapshot_id bigint;

UPDATE tasks
SET source_query_package_snapshot_id = source_query_package_id
WHERE source_query_package_snapshot_id IS NULL
  AND source_query_package_id IS NOT NULL;

CREATE INDEX tasks_source_query_package_snapshot_idx
  ON tasks(source_query_package_snapshot_id, id)
  WHERE source_query_package_snapshot_id IS NOT NULL;

-- A withdrawn delivery is revoked asynchronously.  The durable job is deliberately
-- not tied to cascading task/delivery foreign keys so it survives permanent cleanup.
ALTER TABLE delivery_entries
  DROP CONSTRAINT IF EXISTS delivery_entries_preview_binding_check,
  DROP CONSTRAINT IF EXISTS delivery_entries_preview_status_check;

ALTER TABLE delivery_entries
  ADD CONSTRAINT delivery_entries_preview_status_check CHECK (
    preview_status IS NULL
    OR preview_status IN ('PUBLISHED', 'REVOKING', 'REVOKE_FAILED', 'REVOKED')
  ),
  ADD CONSTRAINT delivery_entries_preview_binding_check CHECK (
    (preview_id IS NULL
      AND preview_note_id IS NULL
      AND preview_content_hash IS NULL
      AND preview_status IS NULL
      AND preview_uploaded_by_account_id IS NULL
      AND preview_uploaded_by_username IS NULL
      AND preview_published_at IS NULL
      AND preview_revoked_at IS NULL)
    OR
    (preview_id IS NOT NULL
      AND preview_note_id ~ '^[0-9a-f]{32}$'
      AND preview_content_hash ~ '^[0-9a-f]{64}$'
      AND preview_status IS NOT NULL
      AND preview_uploaded_by_account_id IS NOT NULL
      AND preview_uploaded_by_username IS NOT NULL
      AND preview_published_at IS NOT NULL
      AND ((preview_status IN ('PUBLISHED', 'REVOKING', 'REVOKE_FAILED') AND preview_revoked_at IS NULL)
        OR (preview_status = 'REVOKED' AND preview_revoked_at IS NOT NULL)))
  );

CREATE TABLE delivery_preview_revocation_jobs (
  id bigserial PRIMARY KEY,
  preview_id uuid NOT NULL UNIQUE,
  delivery_entry_id bigint,
  task_id bigint,
  reason varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX delivery_preview_revocation_jobs_claim_idx
  ON delivery_preview_revocation_jobs(next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRY', 'PROCESSING');
