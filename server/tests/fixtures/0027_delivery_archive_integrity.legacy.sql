UPDATE delivery_entries AS delivery
SET status = 'WITHDRAWN', withdrawn_at = now()
FROM tasks AS task
JOIN copy_revisions AS revision ON revision.id = task.current_copy_revision_id
JOIN image_runs AS image_run ON image_run.id = task.current_image_run_id
WHERE delivery.task_id = task.id
  AND delivery.status = 'READY'
  AND (
    revision.approved_at IS NULL
    OR image_run.status <> 'COMPLETED'
    OR image_run.copy_revision_id <> task.current_copy_revision_id
    OR jsonb_typeof(COALESCE(
      revision.content->'copy',
      revision.content#>'{reviewed,copy}',
      revision.content->'post',
      revision.content
    )) IS DISTINCT FROM 'object'
    OR jsonb_typeof(image_run.result->'images') IS DISTINCT FROM 'array'
    OR jsonb_array_length(CASE
      WHEN jsonb_typeof(image_run.result->'images') = 'array'
        THEN image_run.result->'images'
      ELSE '[]'::jsonb
    END) = 0
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(image_run.result->'images') = 'array'
          THEN image_run.result->'images'
        ELSE '[]'::jsonb
      END) AS selected(image)
      LEFT JOIN assets AS asset
        ON asset.id = CASE
          WHEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId', '')
            ~ '^[1-9][0-9]*$'
            THEN COALESCE(selected.image->>'deliveryAssetId', selected.image->>'assetId')::bigint
          ELSE NULL
        END
        AND asset.task_id = task.id
        AND asset.image_run_id = image_run.id
        AND asset.media_type LIKE 'image/%'
      WHERE asset.id IS NULL
    )
  );

INSERT INTO delivery_migration_anomalies(task_id, reason, detected_at)
SELECT task.id, 'READY_DELIVERY_SOURCE_NOT_ARCHIVABLE', now()
FROM tasks AS task
WHERE task.state = 'REVIEWED'
  AND NOT EXISTS (
    SELECT 1
    FROM delivery_entries AS delivery
    WHERE delivery.task_id = task.id AND delivery.status = 'READY'
  )
ON CONFLICT(task_id) DO UPDATE
SET reason = EXCLUDED.reason, detected_at = EXCLUDED.detected_at;
