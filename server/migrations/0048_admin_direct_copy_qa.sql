-- An administrator may explicitly approve one already-reviewed copy without
-- waiting for its production batch to reach the sampling boundary. Keep the
-- decision revision-bound so later copy changes cannot inherit the bypass.
CREATE TABLE copy_qa_admin_direct_approvals (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  approval_event_id bigint NOT NULL REFERENCES copy_approval_events(id) ON DELETE CASCADE,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, copy_revision_id),
  UNIQUE(actor_account_id, request_id)
);

COMMENT ON COLUMN copy_qa_admin_direct_approvals.actor_account_id IS
  'Immutable historical app_users.id; deliberately retained without a foreign key after account deletion.';

ALTER TABLE copy_sampling_mutation_requests
  DROP CONSTRAINT copy_sampling_mutation_requests_operation_check,
  ADD CONSTRAINT copy_sampling_mutation_requests_operation_check CHECK (
    operation IN ('FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE', 'ADMIN_DIRECT_PASS')
  );
