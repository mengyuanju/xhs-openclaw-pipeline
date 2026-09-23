-- Keep the individual subjects affected by a batch return. The operator event
-- is append-only, so later removal of a sampling item does not erase the fact.
CREATE VIEW account_quality_batch_sources AS
SELECT e.event_key,e.task_id,e.stage,
  CASE WHEN e.stage='COPY' THEN COALESCE(ca.approved_by_account_id,ci.final_approver_account_id,e.account_id)
    ELSE COALESCE(ia.submitted_by_account_id,ii.submitter_account_id,e.account_id) END AS account_id,
  'RETURN'::text AS action,true AS establishes_sample,e.occurred_at,
  e.data||jsonb_build_object(
    'username',CASE WHEN e.stage='COPY' THEN COALESCE(ca.approved_by_username,ci.final_approver_username,e.data->>'username')
      ELSE COALESCE(ia.submitted_by_username,ii.submitter_username,e.data->>'username') END,
    'batchId',COALESCE((e.data->>'batchId')::bigint,t.production_batch_id),
    'freezeId',CASE WHEN e.stage='COPY' THEN ci.freeze_id ELSE ii.freeze_id END,
    'samplingItemId',CASE WHEN e.stage='COPY' THEN ci.id ELSE ii.id END,
    'sampleKind',CASE WHEN e.stage='COPY' THEN ci.sample_kind ELSE ii.sample_kind END,
    'batchTrigger',CASE WHEN e.stage='COPY' AND ci.id IS NULL THEN NULL
      WHEN e.stage='COPY' THEN EXISTS(SELECT 1 FROM copy_sampling_events action
        WHERE action.sampling_item_id=ci.id AND action.action='RETURN_BATCH') ELSE false END,
    'source','BATCH_RETURN','exclusion',NULL) AS data
FROM operator_performance_events e
LEFT JOIN tasks t ON t.id=e.task_id
LEFT JOIN copy_sampling_items ci ON e.stage='COPY' AND ci.id=substring(e.event_key from '[0-9]+$')::bigint
LEFT JOIN copy_approval_events ca ON ca.id=ci.approval_event_id
LEFT JOIN image_sampling_items ii ON e.stage='IMAGE' AND ii.id=substring(e.event_key from '[0-9]+$')::bigint
LEFT JOIN image_approval_events ia ON ia.id=ii.approval_event_id
WHERE e.kind='BATCH_RETURN' AND e.stage IN ('COPY','IMAGE')
  AND e.data->>'exclusion' IS DISTINCT FROM 'SIMULATED'
  AND e.data->>'exclusion' IS DISTINCT FROM 'UNKNOWN_IDENTITY'
  AND (CASE WHEN e.stage='COPY' THEN COALESCE(ca.approved_by_account_id,ci.final_approver_account_id,e.account_id)
    ELSE COALESCE(ia.submitted_by_account_id,ii.submitter_account_id,e.account_id) END) IS NOT NULL;

CREATE FUNCTION capture_account_quality_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
  SELECT * FROM account_quality_batch_sources WHERE event_key=NEW.event_key ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_account_quality_batch AFTER INSERT ON operator_performance_events
  FOR EACH ROW WHEN (NEW.kind='BATCH_RETURN') EXECUTE FUNCTION capture_account_quality_batch();
INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
SELECT * FROM account_quality_batch_sources ORDER BY occurred_at,event_key ON CONFLICT DO NOTHING;

-- Legacy operator backfills only saw items that were still BATCH_AFFECTED or
-- BATCH_RETURNED. A later recheck can supersede that status. Recover members
-- from the original batch action and its retained freeze membership instead.
INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
SELECT 'copy-batch-impact:'||i.id,i.task_id,'COPY',COALESCE(a.approved_by_account_id,i.final_approver_account_id),
  'RETURN',true,b.created_at,
  jsonb_build_object('username',COALESCE(a.approved_by_username,i.final_approver_username),
    'batchId',f.production_batch_id,'freezeId',f.id,'samplingItemId',i.id,
    'sampleKind',i.sample_kind,'source','BATCH_RETURN','batchTrigger',false,'exclusion',NULL)
FROM copy_sampling_events b JOIN copy_sampling_freezes f ON f.id=b.freeze_id
JOIN copy_sampling_items i ON i.freeze_id=f.id AND i.created_at<=b.created_at
LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
WHERE b.action='RETURN_BATCH' AND (
  (jsonb_typeof(b.details->'affectedItemIds')='array' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.details->'affectedItemIds')='array'
      THEN b.details->'affectedItemIds' ELSE '[]'::jsonb END) member(id)
    WHERE member.id=i.public_id::text))
  OR (jsonb_typeof(b.details->'affectedItemIds') IS DISTINCT FROM 'array'
    AND jsonb_typeof(b.details->'affectedTaskIds')='array' AND EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.details->'affectedTaskIds')='array'
        THEN b.details->'affectedTaskIds' ELSE '[]'::jsonb END) member(id)
      WHERE member.id=i.task_id::text))
  OR (jsonb_typeof(b.details->'affectedItemIds') IS DISTINCT FROM 'array'
    AND jsonb_typeof(b.details->'affectedTaskIds') IS DISTINCT FROM 'array'
    AND i.status='BATCH_AFFECTED'))
ORDER BY b.created_at,b.id,i.id ON CONFLICT DO NOTHING;

INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
SELECT 'image-batch-impact:'||i.id,i.task_id,'IMAGE',COALESCE(a.submitted_by_account_id,i.submitter_account_id),
  'RETURN',true,b.created_at,
  jsonb_build_object('username',COALESCE(a.submitted_by_username,i.submitter_username),
    'batchId',f.production_batch_id,'freezeId',f.id,'samplingItemId',i.id,
    'sampleKind',i.sample_kind,'source','BATCH_RETURN','batchTrigger',false,'exclusion',NULL)
FROM image_sampling_events b JOIN image_sampling_freezes f ON f.id=b.freeze_id
JOIN image_sampling_items i ON i.freeze_id=f.id AND i.sample_kind='RANDOM' AND i.created_at<=b.created_at
LEFT JOIN image_approval_events a ON a.id=i.approval_event_id
WHERE b.action='RETURN_BATCH' AND (
  jsonb_typeof(b.details->'affectedTaskIds') IS DISTINCT FROM 'array' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.details->'affectedTaskIds')='array'
      THEN b.details->'affectedTaskIds' ELSE '[]'::jsonb END) member(id)
    WHERE member.id=i.task_id::text))
ORDER BY b.created_at,b.id,i.id ON CONFLICT DO NOTHING;
CREATE INDEX account_quality_batch_freeze_idx ON account_quality_events(stage,(data->>'freezeId'))
  WHERE data->>'source'='BATCH_RETURN';
