-- Idempotency receipts must follow the immutable account identity, not a
-- reusable username.  Do not add an app_users foreign key: deleting an account
-- must leave its historical numeric identity on the receipt.
ALTER TABLE query_package_mutation_requests
  ADD COLUMN actor_account_id bigint;

ALTER TABLE copy_sampling_mutation_requests
  ADD COLUMN actor_account_id bigint;

-- Preserve retry continuity only when the currently stored account already
-- existed when the legacy receipt was written. A same-name replacement created
-- afterwards must never inherit the former account's receipt.
UPDATE query_package_mutation_requests AS receipt
SET actor_account_id = actor.id
FROM app_users AS actor
WHERE receipt.actor_account_id IS NULL
  AND actor.username = receipt.actor_username
  AND actor.created_at <= receipt.created_at;

UPDATE copy_sampling_mutation_requests AS receipt
SET actor_account_id = actor.id
FROM app_users AS actor
WHERE receipt.actor_account_id IS NULL
  AND actor.username = receipt.actor_username
  AND actor.created_at <= receipt.created_at;

-- A deleted legacy account has no surviving numeric ID to recover. Give each
-- unmatched historical username one shared negative, receipt-only identity.
-- Runtime actors always have positive app_users IDs, so these rows remain
-- auditable across both receipt tables but can never be replayed by a later
-- same-name account.
CREATE TEMP TABLE mutation_receipt_legacy_actor_ids (
  actor_username varchar(50) PRIMARY KEY,
  actor_account_id bigint NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO mutation_receipt_legacy_actor_ids(actor_username, actor_account_id)
SELECT actor_username,
  -9223372036854775807::bigint + row_number() OVER (ORDER BY actor_username)
FROM (
  SELECT actor_username
  FROM query_package_mutation_requests
  WHERE actor_account_id IS NULL
  UNION
  SELECT actor_username
  FROM copy_sampling_mutation_requests
  WHERE actor_account_id IS NULL
) AS usernames;

UPDATE query_package_mutation_requests AS receipt
SET actor_account_id = legacy.actor_account_id
FROM mutation_receipt_legacy_actor_ids AS legacy
WHERE receipt.actor_account_id IS NULL
  AND legacy.actor_username = receipt.actor_username;

UPDATE copy_sampling_mutation_requests AS receipt
SET actor_account_id = legacy.actor_account_id
FROM mutation_receipt_legacy_actor_ids AS legacy
WHERE receipt.actor_account_id IS NULL
  AND legacy.actor_username = receipt.actor_username;

ALTER TABLE query_package_mutation_requests
  DROP CONSTRAINT query_package_mutation_requests_pkey,
  ALTER COLUMN actor_account_id SET NOT NULL,
  ADD CONSTRAINT query_package_mutation_requests_pkey
    PRIMARY KEY(actor_account_id, request_id);

ALTER TABLE copy_sampling_mutation_requests
  DROP CONSTRAINT copy_sampling_mutation_requests_pkey,
  ALTER COLUMN actor_account_id SET NOT NULL,
  ADD CONSTRAINT copy_sampling_mutation_requests_pkey
    PRIMARY KEY(actor_account_id, request_id);

-- The durable business artifacts and audit rows use the same request IDs as
-- their receipts.  Leaving these uniqueness checks keyed by username would
-- still reject a legitimate request from a later, same-name account even
-- though its receipt is correctly isolated above.
ALTER TABLE production_batches
  DROP CONSTRAINT production_batches_created_by_username_request_id_key,
  ADD CONSTRAINT production_batches_actor_request_key
    UNIQUE(created_by_account_id, request_id);

ALTER TABLE copy_sampling_freezes
  DROP CONSTRAINT copy_sampling_freezes_frozen_by_username_request_id_key,
  ADD CONSTRAINT copy_sampling_freezes_actor_request_key
    UNIQUE(frozen_by_account_id, request_id);

ALTER TABLE query_package_deletion_audits
  DROP CONSTRAINT query_package_deletion_audits_actor_username_request_id_key,
  ADD CONSTRAINT query_package_deletion_audits_actor_request_key
    UNIQUE(actor_account_id, request_id);

ALTER TABLE query_package_lifecycle_audits
  DROP CONSTRAINT query_package_lifecycle_audits_actor_username_request_id_key,
  ADD CONSTRAINT query_package_lifecycle_audits_actor_request_key
    UNIQUE(actor_account_id, request_id);

COMMENT ON COLUMN query_package_mutation_requests.actor_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';

COMMENT ON COLUMN copy_sampling_mutation_requests.actor_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';
