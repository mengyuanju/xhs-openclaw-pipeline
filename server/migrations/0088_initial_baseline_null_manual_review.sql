-- Machine generation responses include "manualReview": null. The old key-
-- existence check mistook that JSON null for an actual human review and left
-- genuine initial revisions without a baseline. Keep non-null review data out.
CREATE OR REPLACE FUNCTION capture_initial_task_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_origin='GENERATION' AND NEW.parent_revision_id IS NULL
     AND NOT NEW.copy_content_changed_from_machine
     AND NEW.content->>'manualReview' IS NULL
     AND NEW.content_cleared_at IS NULL
     AND EXISTS (
       SELECT 1 FROM task_executions e
       WHERE e.id=NEW.execution_id AND e.task_id=NEW.task_id AND e.kind='COPY'
     ) THEN
    INSERT INTO task_initial_baselines(task_id,source_revision_id,content,input,asset_ids,source)
    SELECT NEW.task_id,NEW.id,NEW.content,t.input,
      CASE WHEN EXISTS(SELECT 1 FROM task_reassignment_cases c WHERE c.task_id=NEW.task_id AND c.status='PENDING') THEN '{}'::bigint[]
        ELSE ARRAY(SELECT a.id FROM assets a WHERE a.task_id=NEW.task_id AND a.created_at<=NEW.created_at) END,
      CASE WHEN EXISTS(SELECT 1 FROM task_reassignment_cases c WHERE c.task_id=NEW.task_id AND c.status='PENDING') THEN 'REGENERATED' ELSE 'GENERATION' END
    FROM tasks t WHERE t.id=NEW.task_id AND t.task_kind='CONTENT'
    ON CONFLICT(task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

-- Repair only rows with a completed COPY execution for the same task. An
-- origin label or a current human revision alone cannot prove machine output.
INSERT INTO task_initial_baselines(task_id,source_revision_id,content,input,asset_ids,source)
SELECT DISTINCT ON(r.task_id) r.task_id,r.id,r.content,t.input,
  ARRAY(SELECT a.id FROM assets a WHERE a.task_id=r.task_id AND a.created_at<=r.created_at),'BACKFILL'
FROM copy_revisions r
JOIN tasks t ON t.id=r.task_id AND t.task_kind='CONTENT'
JOIN task_executions e ON e.id=r.execution_id AND e.task_id=r.task_id
  AND e.kind='COPY' AND e.status='SUCCEEDED'
WHERE r.revision_origin='GENERATION' AND r.parent_revision_id IS NULL
  AND NOT r.copy_content_changed_from_machine
  AND r.content->>'manualReview' IS NULL
  AND r.content_cleared_at IS NULL
ORDER BY r.task_id,r.revision,r.id ON CONFLICT(task_id) DO NOTHING;
