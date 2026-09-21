-- A client batch is the customer's logical delivery unit. Query packages remain
-- independent import/screening units, while multiple packages may share one
-- client batch code and therefore be exported together.
ALTER TABLE query_packages
  ADD COLUMN client_batch_code varchar(32)
    NOT NULL DEFAULT 'b9759aad96a94c109fdce96ab4455294'
    CHECK (client_batch_code ~ '^[0-9a-f]{32}$');
ALTER TABLE query_packages ALTER COLUMN client_batch_code DROP DEFAULT;
CREATE INDEX query_packages_client_batch_idx
  ON query_packages(client_batch_code, id DESC);

ALTER TABLE production_batches
  ADD COLUMN client_batch_code varchar(32)
    NOT NULL DEFAULT 'b9759aad96a94c109fdce96ab4455294'
    CHECK (client_batch_code ~ '^[0-9a-f]{32}$');
ALTER TABLE production_batches ALTER COLUMN client_batch_code DROP DEFAULT;
CREATE INDEX production_batches_client_batch_idx
  ON production_batches(client_batch_code, id DESC);

ALTER TABLE tasks
  ADD COLUMN source_client_batch_code varchar(32)
    CHECK (source_client_batch_code IS NULL OR source_client_batch_code ~ '^[0-9a-f]{32}$');

-- Only Query-package sourced tasks belong to the known historical customer
-- batch. Standalone/manual tasks intentionally remain unassigned.
UPDATE tasks
SET source_client_batch_code = 'b9759aad96a94c109fdce96ab4455294'
WHERE source_query_package_id IS NOT NULL
   OR source_query_package_snapshot_id IS NOT NULL
   OR source_query_package_name IS NOT NULL;

CREATE INDEX tasks_client_batch_delivery_idx
  ON tasks(source_client_batch_code, state, id)
  WHERE source_client_batch_code IS NOT NULL;

ALTER TABLE delivery_batches
  DROP CONSTRAINT IF EXISTS delivery_batches_scope_check,
  DROP CONSTRAINT IF EXISTS delivery_batches_check,
  ADD COLUMN client_batch_code varchar(32)
    CHECK (client_batch_code IS NULL OR client_batch_code ~ '^[0-9a-f]{32}$');

-- All existing persisted delivery batches belong to the one historical client
-- batch confirmed for this installation. The migration record is the audit trail
-- for this one-time attribution.
UPDATE delivery_batches
SET client_batch_code = 'b9759aad96a94c109fdce96ab4455294';

ALTER TABLE delivery_batches
  ADD CONSTRAINT delivery_batches_scope_check CHECK (
    scope IN ('ALL_READY', 'QUERY_PACKAGE', 'CLIENT_BATCH', 'SELECTED')
  ),
  ADD CONSTRAINT delivery_batches_scope_metadata_check CHECK (
    (scope = 'QUERY_PACKAGE' AND query_package_name IS NOT NULL)
    OR (scope = 'CLIENT_BATCH' AND query_package_name IS NULL AND client_batch_code IS NOT NULL)
    OR (scope IN ('ALL_READY', 'SELECTED') AND query_package_name IS NULL)
  );

CREATE INDEX delivery_batches_client_batch_idx
  ON delivery_batches(client_batch_code, created_at DESC, id DESC)
  WHERE client_batch_code IS NOT NULL;

-- ADD COLUMN with a temporary default backfills append-only historical rows
-- without issuing an UPDATE that would violate their protection trigger.
ALTER TABLE delivery_batch_items
  ADD COLUMN client_batch_code_snapshot varchar(32)
    DEFAULT 'b9759aad96a94c109fdce96ab4455294'
    CHECK (client_batch_code_snapshot IS NULL
      OR client_batch_code_snapshot ~ '^[0-9a-f]{32}$');
ALTER TABLE delivery_batch_items
  ALTER COLUMN client_batch_code_snapshot DROP DEFAULT;
CREATE INDEX delivery_batch_items_client_batch_idx
  ON delivery_batch_items(client_batch_code_snapshot, delivery_batch_id)
  WHERE client_batch_code_snapshot IS NOT NULL;
