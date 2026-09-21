-- Ordinary operators create the same immutable delivery manifests as
-- administrators.  The batch origin and explicit delivery confirmation make
-- those actions visible to administrators without treating a download as
-- proof that the archive was actually handed off.
ALTER TABLE delivery_batches
  ADD COLUMN batch_kind varchar(30) NOT NULL DEFAULT 'ADMIN_DELIVERY',
  ADD COLUMN created_by_role varchar(20) NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN delivered_by_account_id bigint,
  ADD COLUMN delivered_by_username varchar(50);

ALTER TABLE delivery_batches
  DROP CONSTRAINT IF EXISTS delivery_batches_status_check,
  ADD CONSTRAINT delivery_batches_status_check
    CHECK (status IN ('GENERATED', 'DOWNLOADED', 'DELIVERED')),
  ADD CONSTRAINT delivery_batches_kind_check
    CHECK (batch_kind IN ('ADMIN_DELIVERY', 'OPERATOR_DELIVERY')),
  ADD CONSTRAINT delivery_batches_creator_role_check
    CHECK (created_by_role IN ('ADMIN', 'USER')),
  ADD CONSTRAINT delivery_batches_kind_role_check CHECK (
    (batch_kind = 'ADMIN_DELIVERY' AND created_by_role = 'ADMIN')
    OR (batch_kind = 'OPERATOR_DELIVERY' AND created_by_role = 'USER')
  ),
  ADD CONSTRAINT delivery_batches_confirmation_check CHECK (
    (status = 'DELIVERED'
      AND delivered_at IS NOT NULL
      AND delivered_by_account_id IS NOT NULL
      AND delivered_by_username IS NOT NULL)
    OR (status <> 'DELIVERED'
      AND delivered_at IS NULL
      AND delivered_by_account_id IS NULL
      AND delivered_by_username IS NULL)
  );

CREATE INDEX delivery_batches_creator_idx
  ON delivery_batches(created_by_account_id, created_at DESC, id DESC);
CREATE INDEX delivery_batches_kind_status_idx
  ON delivery_batches(batch_kind, status, created_at DESC, id DESC);

CREATE TABLE delivery_batch_confirmation_events (
  id bigserial PRIMARY KEY,
  delivery_batch_id bigint NOT NULL REFERENCES delivery_batches(id) ON DELETE RESTRICT,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_batch_confirmation_events_batch_idx
  ON delivery_batch_confirmation_events(delivery_batch_id, confirmed_at DESC, id DESC);

CREATE TRIGGER delivery_batch_confirmation_events_append_only
BEFORE UPDATE OR DELETE ON delivery_batch_confirmation_events
FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_history();
