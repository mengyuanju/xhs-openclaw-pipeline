-- A direct copy QA discard ends only the chosen sampled item and its task.
-- It is separate from return decisions and does not count toward batch return thresholds.
ALTER TABLE copy_qa_batch_members_v2 DROP CONSTRAINT copy_qa_batch_members_v2_status_check;
ALTER TABLE copy_qa_batch_members_v2 ADD CONSTRAINT copy_qa_batch_members_v2_status_check
  CHECK (status IN ('PENDING','NOT_SELECTED','PASSED','RETURNED','BATCH_AFFECTED',
    'RELEASED','SUPERSEDED','DISCARDED'));

CREATE TABLE copy_qa_dispositions_v2 (
  id bigserial PRIMARY KEY,
  member_id bigint NOT NULL UNIQUE REFERENCES copy_qa_batch_members_v2(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  reason_code text NOT NULL CHECK (reason_code IN (
    'UNRECOVERABLE_QUALITY','REWORK_COST_TOO_HIGH','MISSING_SOURCE_MATERIAL','OTHER')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  actor_account_id bigint NOT NULL,
  actor_username text NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_account_id,request_id)
);
CREATE INDEX copy_qa_dispositions_v2_task_idx ON copy_qa_dispositions_v2(task_id,created_at DESC);
