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
