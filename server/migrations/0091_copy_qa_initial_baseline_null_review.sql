-- Historical generation payloads contain "manualReview": null. The original
-- baseline guard treated key presence as a human edit and skipped those drafts.
-- A non-null review payload is still excluded.
CREATE OR REPLACE FUNCTION capture_initial_task_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_origin='GENERATION' AND NEW.execution_id IS NOT NULL
     AND NEW.parent_revision_id IS NULL AND NOT NEW.copy_content_changed_from_machine
     AND coalesce(jsonb_typeof(NEW.content->'manualReview'),'null')='null'
     AND NEW.content_cleared_at IS NULL THEN
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

INSERT INTO task_initial_baselines(task_id,source_revision_id,content,input,asset_ids,source)
SELECT DISTINCT ON(r.task_id) r.task_id,r.id,r.content,t.input,
  ARRAY(SELECT a.id FROM assets a WHERE a.task_id=r.task_id AND a.created_at<=r.created_at),'BACKFILL'
FROM copy_revisions AS r JOIN tasks AS t ON t.id=r.task_id
WHERE t.task_kind='CONTENT' AND r.revision_origin='GENERATION' AND r.execution_id IS NOT NULL
  AND r.parent_revision_id IS NULL AND NOT r.copy_content_changed_from_machine
  AND coalesce(jsonb_typeof(r.content->'manualReview'),'null')='null'
  AND r.content_cleared_at IS NULL
ORDER BY r.task_id,r.revision,r.id
ON CONFLICT(task_id) DO NOTHING;

-- Remove the obsolete blocker only where a baseline is now available. The
-- existing "重试还原 / 清理" action still performs the actual content reset.
UPDATE task_reassignment_cases AS reassignment
SET reset_status='PENDING',reset_error=NULL,version=version+1
WHERE reassignment.status='PENDING' AND reassignment.reset_status='BLOCKED'
  AND reassignment.reset_error='缺少可信机器初稿；请重新生成初始数据后重试'
  AND EXISTS (SELECT 1 FROM task_initial_baselines AS baseline WHERE baseline.task_id=reassignment.task_id);
