-- A QA return remains an immutable quality verdict.  This table records the
-- later business decision to stop reworking that returned copy without
-- rewriting the sampling item or its accuracy statistics.
CREATE TABLE copy_return_dispositions (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  returned_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  source_sampling_item_id bigint NOT NULL REFERENCES copy_sampling_items(id) ON DELETE CASCADE,
  action varchar(30) NOT NULL CHECK (action = 'DISCARD_AFTER_QA_RETURN'),
  reason_code varchar(50) NOT NULL CHECK (reason_code IN (
    'QA_RECOMMENDATION', 'UNRECOVERABLE_QUALITY', 'REWORK_COST_TOO_HIGH',
    'MISSING_SOURCE_MATERIAL', 'OTHER'
  )),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  actor_role varchar(20) NOT NULL CHECK (actor_role IN ('ADMIN', 'REVIEWER', 'USER')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, returned_revision_id),
  UNIQUE(actor_account_id, request_id)
);

CREATE INDEX copy_return_dispositions_sampling_item_idx
  ON copy_return_dispositions(source_sampling_item_id, created_at DESC);

COMMENT ON COLUMN copy_return_dispositions.actor_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';

ALTER TABLE copy_sampling_mutation_requests
  DROP CONSTRAINT copy_sampling_mutation_requests_operation_check,
  ADD CONSTRAINT copy_sampling_mutation_requests_operation_check CHECK (
    operation IN (
      'FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE',
      'ADMIN_DIRECT_PASS', 'DISCARD_REWORK'
    )
  );
