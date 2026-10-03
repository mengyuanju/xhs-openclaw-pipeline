-- Configuration content is immutable and shared independently across executions.
-- Operational/retry fields remain in task_executions.snapshot for existing SQL.
SET LOCAL lock_timeout = '1s';

CREATE TABLE public.execution_snapshot_contents (
  sha256 varchar(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.guard_execution_snapshot_content_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'execution snapshot configuration content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_snapshot_contents_immutable
BEFORE UPDATE ON public.execution_snapshot_contents
FOR EACH ROW EXECUTE FUNCTION public.guard_execution_snapshot_content_update();

ALTER TABLE public.task_executions
  ADD COLUMN snapshot_prompts_hash varchar(64) REFERENCES public.execution_snapshot_contents(sha256),
  ADD COLUMN snapshot_knowledge_hash varchar(64) REFERENCES public.execution_snapshot_contents(sha256),
  ADD COLUMN snapshot_production_settings_hash varchar(64) REFERENCES public.execution_snapshot_contents(sha256);

-- After the historical backlog is drained this index is effectively empty.
-- Maintenance must not scan all execution history on every background sweep.
CREATE INDEX task_executions_snapshot_backfill_idx ON public.task_executions(id)
WHERE status <> 'RUNNING' AND content_cleared_at IS NULL AND (
  (snapshot_prompts_hash IS NULL AND snapshot->'prompts' IS NOT NULL AND snapshot->'prompts' <> 'null'::jsonb)
  OR (snapshot_knowledge_hash IS NULL AND snapshot->'knowledge' IS NOT NULL AND snapshot->'knowledge' <> 'null'::jsonb)
  OR (snapshot_production_settings_hash IS NULL AND snapshot->'productionSettings' IS NOT NULL
    AND snapshot->'productionSettings' <> 'null'::jsonb)
);
