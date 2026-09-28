-- Returned images may be submitted for another mandatory review without changing
-- the image run. Each approval keeps its own note, frozen snapshot and QA history.
ALTER TABLE image_approval_events
  DROP CONSTRAINT image_approval_events_task_id_image_run_id_key;

CREATE INDEX image_approval_events_version_history_idx
  ON image_approval_events(task_id, image_run_id, submitted_at DESC, id DESC);

-- Keep the existing UNIQUE(submitted_by_username, review_session_id) constraint:
-- retries of one submission session must still resolve to exactly one approval.
