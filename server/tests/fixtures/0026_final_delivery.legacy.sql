ALTER TABLE copy_revisions
  ADD COLUMN parent_revision_id bigint REFERENCES copy_revisions(id) ON DELETE SET NULL,
  ADD COLUMN revision_origin varchar(30)
    CHECK (revision_origin IS NULL OR revision_origin IN ('GENERATION', 'COPY_EDIT', 'PLAN_EDIT', 'QA_RETURN', 'FINAL_REWORK')),
  ADD COLUMN copy_content_changed_from_machine boolean NOT NULL DEFAULT false,
  ADD COLUMN copy_rework_satisfied boolean NOT NULL DEFAULT false;

UPDATE copy_revisions
SET revision_origin = CASE
  WHEN execution_id IS NOT NULL THEN 'GENERATION'
  WHEN content ? 'manualReview' THEN 'PLAN_EDIT'
  ELSE revision_origin
END
WHERE revision_origin IS NULL;

UPDATE copy_revisions AS revision
SET parent_revision_id = (revision.content #>> '{manualReview,baseRevisionId}')::bigint
WHERE revision.parent_revision_id IS NULL
  AND (revision.content #>> '{manualReview,baseRevisionId}') ~ '^[1-9][0-9]*$'
  AND EXISTS (
    SELECT 1 FROM copy_revisions AS parent
    WHERE parent.id = (revision.content #>> '{manualReview,baseRevisionId}')::bigint
      AND parent.task_id = revision.task_id
  );

UPDATE copy_revisions AS revision
SET copy_content_changed_from_machine = true,
    revision_origin = CASE WHEN revision.revision_origin = 'PLAN_EDIT' THEN 'COPY_EDIT'
      ELSE revision.revision_origin END
WHERE COALESCE(revision.content->'copy', revision.content#>'{reviewed,copy}', revision.content->'post')
  IS DISTINCT FROM
  (
    SELECT COALESCE(generated.content->'copy', generated.content#>'{reviewed,copy}', generated.content->'post')
    FROM copy_revisions AS generated
    WHERE generated.task_id = revision.task_id AND generated.execution_id IS NOT NULL
    ORDER BY generated.revision, generated.id
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1 FROM copy_revisions AS generated
    WHERE generated.task_id = revision.task_id AND generated.execution_id IS NOT NULL
  );

ALTER TABLE human_quality_assessments
  ADD COLUMN rework_target varchar(10)
    CHECK (rework_target IS NULL OR rework_target IN ('COPY', 'IMAGE', 'BOTH'));

CREATE TABLE delivery_entries (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id),
  image_run_id uuid NOT NULL REFERENCES image_runs(id),
  status varchar(20) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'WITHDRAWN')),
  approved_by_account_id bigint,
  approved_by_username varchar(50) NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX delivery_entries_one_ready_task_idx
  ON delivery_entries(task_id) WHERE status = 'READY';

CREATE TABLE delivery_migration_anomalies (
  task_id bigint PRIMARY KEY,
  reason varchar(100) NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO delivery_entries(
  task_id, copy_revision_id, image_run_id, approved_by_username, approved_at
)
SELECT
  task.id,
  task.current_copy_revision_id,
  task.current_image_run_id,
  COALESCE(task.image_reviewed_by_user_id, 'legacy'),
  COALESCE(task.image_reviewed_at, task.updated_at, now())
FROM tasks AS task
JOIN copy_revisions AS revision
  ON revision.id = task.current_copy_revision_id AND revision.approved_at IS NOT NULL
JOIN image_runs AS image_run
  ON image_run.id = task.current_image_run_id AND image_run.status = 'COMPLETED'
WHERE task.state = 'REVIEWED'
ON CONFLICT DO NOTHING;

INSERT INTO delivery_migration_anomalies(task_id, reason)
SELECT task.id, 'LEGACY_REVIEWED_TASK_MISSING_FROZEN_DELIVERY_SOURCE'
FROM tasks AS task
LEFT JOIN delivery_entries AS delivery
  ON delivery.task_id = task.id AND delivery.status = 'READY'
WHERE task.state = 'REVIEWED' AND delivery.id IS NULL
ON CONFLICT(task_id) DO NOTHING;
