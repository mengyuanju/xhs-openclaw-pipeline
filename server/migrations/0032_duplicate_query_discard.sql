-- Duplicate-Query cleanup is a recoverable cancellation. Receipts make client
-- retries idempotent, while audit rows preserve the exact discarded -> keeper
-- decision without retaining a second copy of Query or task input content.
CREATE TABLE task_duplicate_query_discard_requests (
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  representative_task_ids bigint[] NOT NULL,
  preview_fingerprint char(64) NOT NULL,
  confirmed_discard_count integer NOT NULL CHECK (confirmed_discard_count >= 0),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id, request_id),
  CHECK (cardinality(representative_task_ids) BETWEEN 1 AND 100)
);

COMMENT ON COLUMN task_duplicate_query_discard_requests.actor_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';

CREATE TABLE task_duplicate_query_discard_audits (
  id bigserial PRIMARY KEY,
  discarded_task_id bigint NOT NULL,
  keeper_task_id bigint NOT NULL,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  preview_fingerprint char(64) NOT NULL,
  business_context_fingerprint char(64) NOT NULL,
  reason varchar(40) NOT NULL CHECK (reason = 'DUPLICATE_QUERY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_account_id, request_id, discarded_task_id),
  CHECK (discarded_task_id <> keeper_task_id)
);

CREATE INDEX task_duplicate_query_discard_audits_discarded_idx
  ON task_duplicate_query_discard_audits(discarded_task_id, created_at DESC);

-- This is the same identity used by task-list DISTINCT ON and cleanup lookup.
CREATE INDEX tasks_query_identity_id_idx
  ON tasks((lower(regexp_replace(btrim(query), '\s+', ' ', 'g'))), id);
