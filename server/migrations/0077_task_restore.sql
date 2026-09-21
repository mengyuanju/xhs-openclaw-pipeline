ALTER TABLE tasks DROP CONSTRAINT tasks_mandatory_copy_qc_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_mandatory_copy_qc_origin_check CHECK (
  mandatory_copy_qc_origin IS NULL OR mandatory_copy_qc_origin IN ('QA_RETURN', 'FINAL_REWORK', 'IMAGE_RETRY_REVIEW', 'DISCARD_RESTORE')
);
ALTER TABLE tasks DROP CONSTRAINT tasks_mandatory_image_qc_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_mandatory_image_qc_origin_check CHECK (
  mandatory_image_qc_origin IS NULL OR mandatory_image_qc_origin IN ('QA_RETURN', 'BATCH_RETURN', 'DISCARD_RESTORE')
);
ALTER TABLE copy_revisions DROP CONSTRAINT copy_revisions_revision_origin_check;
ALTER TABLE copy_revisions ADD CONSTRAINT copy_revisions_revision_origin_check CHECK (
  revision_origin IS NULL OR revision_origin IN ('GENERATION', 'COPY_EDIT', 'PLAN_EDIT', 'QA_RETURN', 'FINAL_REWORK', 'DISCARD_RESTORE')
);

CREATE TABLE task_restore_events (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  cancelled_from_state varchar(40),
  restored_state varchar(40) NOT NULL,
  source_copy_revision_id bigint,
  restored_copy_revision_id bigint,
  source_image_run_id uuid,
  actor_account_id bigint NOT NULL,
  actor_username varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_restore_events_task_idx ON task_restore_events(task_id, id DESC);

ALTER TABLE saved_task_views DROP CONSTRAINT saved_task_views_view_key_check;
ALTER TABLE saved_task_views ADD CONSTRAINT saved_task_views_view_key_check CHECK (view_key IN (
  'PERSONAL', 'UNASSIGNED', 'ALL_COPY', 'COPY_REVIEW', 'IMAGE_WORK',
  'MANUAL_ARCHIVE', 'COMPLETED', 'ALL_JOBS', 'DISCARDED'
));
