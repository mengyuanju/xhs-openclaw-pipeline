-- Preserve failed execution/image-run history and approved copy; only requeue tasks.
UPDATE public.tasks AS t SET
  state = 'IMAGE_QUEUED',
  current_stage = 'IMAGE_QUEUED',
  current_execution_id = NULL,
  current_image_run_id = NULL,
  progress_percent = 0,
  progress_message = '生图失败，已重新排队，等待执行机领取',
  pending_snapshot = COALESCE(t.pending_snapshot, (
    SELECT e.snapshot FROM public.task_executions e
    WHERE e.task_id = t.id AND e.kind = 'IMAGE'
    ORDER BY e.started_at DESC, e.id DESC LIMIT 1
  )),
  execution_started_at = NULL,
  finished_at = NULL,
  last_activity_at = now(),
  updated_at = now()
WHERE t.state = 'IMAGE_FAILED';
