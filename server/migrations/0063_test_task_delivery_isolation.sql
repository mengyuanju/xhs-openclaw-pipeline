-- Test runs exercise the real workflow but must never become customer delivery
-- inventory. Withdraw any legacy READY rows and revoke published previews.
WITH excluded AS (
  UPDATE delivery_entries AS delivery
  SET status = 'WITHDRAWN',
      withdrawn_at = COALESCE(delivery.withdrawn_at, now()),
      preview_status = CASE
        WHEN delivery.preview_status IN ('PUBLISHED', 'REVOKE_FAILED') THEN 'REVOKING'
        ELSE delivery.preview_status
      END
  FROM tasks AS task
  WHERE task.id = delivery.task_id
    AND task.input @> '{"testRun":true}'::jsonb
    AND delivery.status = 'READY'
  RETURNING delivery.id, delivery.task_id, delivery.preview_id, delivery.preview_status
)
INSERT INTO delivery_preview_revocation_jobs(
  preview_id, delivery_entry_id, task_id, reason, status, next_attempt_at
)
SELECT preview_id, id, task_id, 'TEST_TASK_EXCLUDED', 'PENDING', now()
FROM excluded
WHERE preview_id IS NOT NULL AND preview_status = 'REVOKING'
ON CONFLICT(preview_id) DO UPDATE SET
  reason = EXCLUDED.reason,
  status = CASE
    WHEN delivery_preview_revocation_jobs.status = 'COMPLETED' THEN 'COMPLETED'
    ELSE 'PENDING'
  END,
  next_attempt_at = now(),
  lease_expires_at = NULL,
  updated_at = now();
