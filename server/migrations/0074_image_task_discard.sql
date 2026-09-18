ALTER TABLE image_sampling_items DROP CONSTRAINT image_sampling_items_status_check;
ALTER TABLE image_sampling_items ADD CONSTRAINT image_sampling_items_status_check CHECK (status IN (
  'NOT_SELECTED', 'PENDING', 'PASSED', 'RETURNED', 'BATCH_AFFECTED',
  'BATCH_RETURNED', 'RELEASED', 'SUPERSEDED', 'DISCARDED'
));
ALTER TABLE image_sampling_events DROP CONSTRAINT image_sampling_events_action_check;
ALTER TABLE image_sampling_events ADD CONSTRAINT image_sampling_events_action_check CHECK (action IN (
  'FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE', 'SUPERSEDE', 'DISCARD'
));
ALTER TABLE image_sampling_mutation_requests DROP CONSTRAINT image_sampling_mutation_requests_operation_check;
ALTER TABLE image_sampling_mutation_requests ADD CONSTRAINT image_sampling_mutation_requests_operation_check CHECK (operation IN (
  'SELF_REVIEW', 'FREEZE', 'PASS', 'RETURN_SINGLE', 'RETURN_BATCH', 'RELEASE', 'DISCARD_OWNER', 'DISCARD_QA'
));

CREATE TABLE image_task_dispositions (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  image_run_id uuid NOT NULL REFERENCES image_runs(id) ON DELETE CASCADE,
  sampling_item_id bigint REFERENCES image_sampling_items(id) ON DELETE SET NULL,
  from_state text NOT NULL CHECK (from_state IN ('MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'IMAGE_QC_PENDING')),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  actor_role varchar(20) NOT NULL CHECK (actor_role IN ('ADMIN', 'USER', 'REVIEWER')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_account_id, request_id)
);
CREATE INDEX image_task_dispositions_task_idx ON image_task_dispositions(task_id, id DESC);
