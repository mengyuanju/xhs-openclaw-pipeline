ALTER TABLE public.tasks
  ALTER COLUMN copy_executor_node_id DROP NOT NULL;

UPDATE public.tasks
SET
  copy_executor_node_id = NULL,
  current_stage = 'COPY_QUEUED',
  progress_message = '等待文案执行机领取'
WHERE state = 'COPY_QUEUED';

DROP INDEX IF EXISTS public.tasks_copy_queue_idx;
CREATE INDEX tasks_copy_queue_idx
  ON public.tasks(id) WHERE state = 'COPY_QUEUED';

