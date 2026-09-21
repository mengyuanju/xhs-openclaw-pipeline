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

WITH safe_parent_references AS MATERIALIZED (
  SELECT candidate.revision_id,
    CASE
      WHEN candidate.parent_revision_text ~ '^[1-9][0-9]{0,18}$'
        AND (
          char_length(candidate.parent_revision_text) < 19
          OR candidate.parent_revision_text <= '9223372036854775807'
        )
      THEN candidate.parent_revision_text::bigint
      ELSE NULL
    END AS parent_revision_id
  FROM (
    SELECT source.id AS revision_id,
      source.content #>> '{manualReview,baseRevisionId}' AS parent_revision_text
    FROM copy_revisions AS source
  ) AS candidate
)
UPDATE copy_revisions AS revision
SET parent_revision_id = safe.parent_revision_id
FROM safe_parent_references AS safe
WHERE revision.parent_revision_id IS NULL
  AND safe.revision_id = revision.id
  AND safe.parent_revision_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM copy_revisions AS parent
    WHERE parent.id = safe.parent_revision_id
      AND parent.task_id = revision.task_id
  );

WITH RECURSIVE revision_lineage AS (
  SELECT human.id AS revision_id,
    human.task_id,
    parent.id AS ancestor_id,
    parent.parent_revision_id,
    parent.execution_id,
    1 AS depth,
    ARRAY[human.id, parent.id]::bigint[] AS visited_ids
  FROM copy_revisions AS human
  JOIN copy_revisions AS parent
    ON parent.id = human.parent_revision_id
    AND parent.task_id = human.task_id
  WHERE human.execution_id IS NULL

  UNION ALL

  SELECT lineage.revision_id,
    lineage.task_id,
    parent.id AS ancestor_id,
    parent.parent_revision_id,
    parent.execution_id,
    lineage.depth + 1,
    lineage.visited_ids || parent.id
  FROM revision_lineage AS lineage
  JOIN copy_revisions AS parent
    ON parent.id = lineage.parent_revision_id
    AND parent.task_id = lineage.task_id
  WHERE lineage.execution_id IS NULL
    AND NOT parent.id = ANY(lineage.visited_ids)
), closest_lineage_machine AS (
  SELECT DISTINCT ON (revision_id)
    revision_id,
    ancestor_id AS machine_revision_id
  FROM revision_lineage
  WHERE execution_id IS NOT NULL
  ORDER BY revision_id, depth
), machine_baselines AS (
  SELECT human.id AS revision_id,
    COALESCE(lineage.machine_revision_id, preceding.machine_revision_id) AS machine_revision_id
  FROM copy_revisions AS human
  LEFT JOIN closest_lineage_machine AS lineage
    ON lineage.revision_id = human.id
  LEFT JOIN LATERAL (
    SELECT generated.id AS machine_revision_id
    FROM copy_revisions AS generated
    WHERE generated.task_id = human.task_id
      AND generated.execution_id IS NOT NULL
      AND (
        generated.revision < human.revision
        OR (generated.revision = human.revision AND generated.id < human.id)
      )
    ORDER BY generated.revision DESC, generated.id DESC
    LIMIT 1
  ) AS preceding ON lineage.machine_revision_id IS NULL
  WHERE human.execution_id IS NULL
)
UPDATE copy_revisions AS revision
SET copy_content_changed_from_machine = true,
    revision_origin = CASE WHEN revision.revision_origin = 'PLAN_EDIT' THEN 'COPY_EDIT'
      ELSE revision.revision_origin END
FROM machine_baselines AS baseline
JOIN copy_revisions AS machine
  ON machine.id = baseline.machine_revision_id
WHERE revision.id = baseline.revision_id
  AND revision.execution_id IS NULL
  AND COALESCE(revision.content->'copy', revision.content#>'{reviewed,copy}', revision.content->'post')
    IS DISTINCT FROM
    COALESCE(machine.content->'copy', machine.content#>'{reviewed,copy}', machine.content->'post');

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
