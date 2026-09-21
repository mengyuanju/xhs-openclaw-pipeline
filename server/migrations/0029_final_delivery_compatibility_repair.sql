-- Reconcile databases that applied the pre-release 0026/0027 data backfills.
-- Their DDL is compatible with the canonical migrations, but their historical
-- copy lineage and READY-delivery validation were less strict. This migration
-- is deliberately idempotent so it is also safe after the canonical versions.

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

-- Machine revisions can never represent a human copy edit. Restrict origin
-- repair to rows that existed when 0026 ran so later runtime semantics remain
-- untouched.
WITH migration_boundary AS (
  SELECT applied_at
  FROM control_plane_migrations
  WHERE id = '0026_final_delivery'
)
UPDATE copy_revisions AS revision
SET copy_content_changed_from_machine = false,
    revision_origin = CASE
      WHEN revision.created_at <= boundary.applied_at THEN 'GENERATION'
      ELSE revision.revision_origin
    END
FROM migration_boundary AS boundary
WHERE revision.execution_id IS NOT NULL
  AND (
    revision.copy_content_changed_from_machine IS DISTINCT FROM false
    OR (
      revision.created_at <= boundary.applied_at
      AND revision.revision_origin IS DISTINCT FROM 'GENERATION'
    )
  );

WITH RECURSIVE migration_boundary AS (
  SELECT applied_at
  FROM control_plane_migrations
  WHERE id = '0026_final_delivery'
), revision_lineage AS (
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
), evaluated_revisions AS (
  SELECT human.id AS revision_id,
    human.created_at <= boundary.applied_at AS existed_when_0026_ran,
    human.content ? 'manualReview' AS has_legacy_manual_review,
    COALESCE(human.content->'copy', human.content#>'{reviewed,copy}', human.content->'post')
      IS DISTINCT FROM
      COALESCE(machine.content->'copy', machine.content#>'{reviewed,copy}', machine.content->'post')
      AS changed_from_machine
  FROM machine_baselines AS baseline
  JOIN copy_revisions AS human
    ON human.id = baseline.revision_id
  JOIN copy_revisions AS machine
    ON machine.id = baseline.machine_revision_id
  CROSS JOIN migration_boundary AS boundary
  WHERE human.execution_id IS NULL
)
UPDATE copy_revisions AS revision
SET copy_content_changed_from_machine = evaluated.changed_from_machine,
    revision_origin = CASE
      WHEN evaluated.existed_when_0026_ran AND evaluated.has_legacy_manual_review
        THEN CASE WHEN evaluated.changed_from_machine THEN 'COPY_EDIT' ELSE 'PLAN_EDIT' END
      ELSE revision.revision_origin
    END
FROM evaluated_revisions AS evaluated
WHERE revision.id = evaluated.revision_id
  AND (
    revision.copy_content_changed_from_machine IS DISTINCT FROM evaluated.changed_from_machine
    OR (
      evaluated.existed_when_0026_ran
      AND evaluated.has_legacy_manual_review
      AND revision.revision_origin IS DISTINCT FROM
        CASE WHEN evaluated.changed_from_machine THEN 'COPY_EDIT' ELSE 'PLAN_EDIT' END
    )
  );

WITH ready_delivery_sources AS (
  SELECT
    delivery.id AS delivery_id,
    delivery.task_id,
    delivery.copy_revision_id,
    delivery.image_run_id,
    task.state AS task_state,
    task.current_copy_revision_id,
    task.current_image_run_id,
    revision.task_id AS revision_task_id,
    revision.approved_at AS revision_approved_at,
    revision.content AS revision_content,
    image_run.task_id AS image_run_task_id,
    image_run.copy_revision_id AS image_run_copy_revision_id,
    image_run.status AS image_run_status,
    image_run.result AS image_run_result
  FROM delivery_entries AS delivery
  JOIN tasks AS task ON task.id = delivery.task_id
  LEFT JOIN copy_revisions AS revision ON revision.id = delivery.copy_revision_id
  LEFT JOIN image_runs AS image_run ON image_run.id = delivery.image_run_id
  WHERE delivery.status = 'READY'
), invalid_ready_deliveries AS (
  SELECT source.delivery_id
  FROM ready_delivery_sources AS source
  WHERE source.task_state IS DISTINCT FROM 'REVIEWED'
    OR source.copy_revision_id IS DISTINCT FROM source.current_copy_revision_id
    OR source.image_run_id IS DISTINCT FROM source.current_image_run_id
    OR source.revision_task_id IS DISTINCT FROM source.task_id
    OR source.image_run_task_id IS DISTINCT FROM source.task_id
    OR source.revision_approved_at IS NULL
    OR source.image_run_status IS DISTINCT FROM 'COMPLETED'
    OR source.image_run_copy_revision_id IS DISTINCT FROM source.copy_revision_id
    OR jsonb_typeof(COALESCE(
      source.revision_content->'copy',
      source.revision_content#>'{reviewed,copy}',
      source.revision_content->'post',
      source.revision_content
    )) IS DISTINCT FROM 'object'
    OR jsonb_typeof(source.image_run_result->'images') IS DISTINCT FROM 'array'
    OR jsonb_array_length(CASE
      WHEN jsonb_typeof(source.image_run_result->'images') = 'array'
        THEN source.image_run_result->'images'
      ELSE '[]'::jsonb
    END) = 0
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(source.image_run_result->'images') = 'array'
          THEN source.image_run_result->'images'
        ELSE '[]'::jsonb
      END) AS selected(image)
      LEFT JOIN assets AS asset
        ON asset.id = CASE
          WHEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')
              ~ '^[1-9][0-9]{0,18}$'
            AND (
              char_length(COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')) < 19
              OR COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')
                <= '9223372036854775807'
            )
            THEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId')::bigint
          ELSE NULL
        END
        AND asset.task_id = source.task_id
        AND asset.image_run_id = source.image_run_id
        AND asset.media_type LIKE 'image/%'
      WHERE asset.id IS NULL
    )
)
UPDATE delivery_entries AS delivery
SET status = 'WITHDRAWN', withdrawn_at = now()
FROM invalid_ready_deliveries AS invalid
WHERE delivery.id = invalid.delivery_id
  AND delivery.status = 'READY';

WITH archivable_ready_deliveries AS (
  SELECT delivery.task_id
  FROM delivery_entries AS delivery
  JOIN tasks AS source_task ON source_task.id = delivery.task_id
  JOIN copy_revisions AS revision
    ON revision.id = delivery.copy_revision_id
    AND revision.task_id = delivery.task_id
  JOIN image_runs AS image_run
    ON image_run.id = delivery.image_run_id
    AND image_run.task_id = delivery.task_id
    AND image_run.copy_revision_id = delivery.copy_revision_id
  WHERE delivery.status = 'READY'
    AND source_task.state = 'REVIEWED'
    AND delivery.copy_revision_id = source_task.current_copy_revision_id
    AND delivery.image_run_id = source_task.current_image_run_id
    AND revision.approved_at IS NOT NULL
    AND image_run.status = 'COMPLETED'
    AND jsonb_typeof(COALESCE(
      revision.content->'copy',
      revision.content#>'{reviewed,copy}',
      revision.content->'post',
      revision.content
    )) = 'object'
    AND jsonb_typeof(image_run.result->'images') = 'array'
    AND jsonb_array_length(CASE
      WHEN jsonb_typeof(image_run.result->'images') = 'array'
        THEN image_run.result->'images'
      ELSE '[]'::jsonb
    END) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(image_run.result->'images') = 'array'
          THEN image_run.result->'images'
        ELSE '[]'::jsonb
      END) AS selected(image)
      LEFT JOIN assets AS asset
        ON asset.id = CASE
          WHEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')
              ~ '^[1-9][0-9]{0,18}$'
            AND (
              char_length(COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')) < 19
              OR COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')
                <= '9223372036854775807'
            )
            THEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId')::bigint
          ELSE NULL
        END
        AND asset.task_id = delivery.task_id
        AND asset.image_run_id = delivery.image_run_id
        AND asset.media_type LIKE 'image/%'
      WHERE asset.id IS NULL
    )
)
INSERT INTO delivery_migration_anomalies(task_id, reason, detected_at)
SELECT task.id, 'READY_DELIVERY_SOURCE_NOT_ARCHIVABLE', now()
FROM tasks AS task
WHERE task.state = 'REVIEWED'
  AND NOT EXISTS (
    SELECT 1
    FROM archivable_ready_deliveries AS delivery
    WHERE delivery.task_id = task.id
  )
ON CONFLICT(task_id) DO UPDATE
SET reason = EXCLUDED.reason, detected_at = EXCLUDED.detected_at;
