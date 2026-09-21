-- Reviewer work is separate from the producer's QUALITY outcome. No cascading
-- FKs: reassignment, superseding a version and deleting an account preserve work.
CREATE TABLE quality_review_activity_events (
  event_key text PRIMARY KEY,
  account_id bigint,
  task_id bigint,
  stage text NOT NULL CHECK (stage IN ('COPY','IMAGE')),
  kind text NOT NULL CHECK (kind IN ('QA_REVIEW','QA_BATCH_RETURN','QA_DIRECT_PASS','QA_DISCARD')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  data jsonb NOT NULL
);
CREATE INDEX quality_activity_account_time_idx ON quality_review_activity_events(account_id,occurred_at);
CREATE INDEX quality_activity_time_idx ON quality_review_activity_events(occurred_at,stage);
CREATE INDEX quality_activity_batch_idx ON quality_review_activity_events(((data->>'batchId')::bigint),occurred_at);

CREATE VIEW quality_review_activity_sources AS
WITH source AS NOT MATERIALIZED (
  SELECT 'COPY'::text AS stage,e.id,e.action,e.actor_account_id,e.actor_username,e.created_at,e.details,e.reason_codes,
    i.id AS item_id,i.public_id AS item_public_id,i.task_id,i.copy_revision_id,NULL::uuid AS image_run_id,
    i.sample_kind,i.selected,i.final_approver_account_id AS submitter_id,f.id AS freeze_id,f.public_id AS freeze_public_id,
    f.production_batch_id AS batch_id,false AS simulated,
    EXISTS(SELECT 1 FROM copy_sampling_events p WHERE p.sampling_item_id=i.id
      AND p.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH') AND (p.created_at,p.id)<(e.created_at,e.id)) AS prior_decision
  FROM copy_sampling_events e JOIN copy_sampling_freezes f ON f.id=e.freeze_id
  LEFT JOIN copy_sampling_items i ON i.id=e.sampling_item_id
  WHERE e.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH')
  UNION ALL
  SELECT 'IMAGE',e.id,e.action,e.actor_account_id,e.actor_username,e.created_at,e.details,e.reason_codes,
    i.id,i.public_id,i.task_id,i.copy_revision_id,i.image_run_id,i.sample_kind,i.selected,i.submitter_account_id,
    f.id,f.public_id,f.production_batch_id,COALESCE(r.result->'simulation'->>'enabled'='true',false),
    EXISTS(SELECT 1 FROM image_sampling_events p WHERE p.sampling_item_id=i.id
      AND p.action IN ('PASS','RETURN_SINGLE') AND (p.created_at,p.id)<(e.created_at,e.id))
  FROM image_sampling_events e JOIN image_sampling_freezes f ON f.id=e.freeze_id
  LEFT JOIN image_sampling_items i ON i.id=e.sampling_item_id
  LEFT JOIN image_runs r ON r.id=i.image_run_id
  WHERE e.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH','DISCARD')
), activities AS (
  SELECT lower(stage)||'-review:'||item_id AS event_key,source.*,
    CASE WHEN details->>'directAdminApproval'='true' THEN 'QA_DIRECT_PASS' ELSE 'QA_REVIEW' END AS kind,
    CASE WHEN action='PASS' THEN 'PASS' ELSE 'RETURN' END AS outcome
  FROM source WHERE item_id IS NOT NULL AND NOT prior_decision
    AND (action IN ('PASS','RETURN_SINGLE') OR stage='COPY' AND action='RETURN_BATCH')
  UNION ALL
  SELECT lower(stage)||'-batch-action:'||id,source.*,'QA_BATCH_RETURN',NULL
  FROM source WHERE action='RETURN_BATCH'
  UNION ALL
  SELECT 'image-discard:'||item_id,source.*,'QA_DISCARD',NULL
  FROM source WHERE action='DISCARD' AND item_id IS NOT NULL AND details->>'fromState'='IMAGE_QC_PENDING'
)
SELECT a.event_key,a.id AS source_event_id,a.actor_account_id AS account_id,
  CASE WHEN a.kind='QA_BATCH_RETURN' THEN NULL ELSE a.task_id END AS task_id,
  a.stage,a.kind,a.created_at AS occurred_at,
  jsonb_build_object('username',a.actor_username,'displayName',COALESCE(u.display_name,a.actor_username),
    'sourceEventId',a.id,'batchId',a.batch_id,'freezeId',a.freeze_id,'freezePublicId',a.freeze_public_id,
    'samplingItemId',a.item_id,'samplingItemPublicId',a.item_public_id,'sampleKind',a.sample_kind,
    'copyRevisionId',a.copy_revision_id,'imageRunId',a.image_run_id,'query',CASE WHEN a.kind<>'QA_BATCH_RETURN' THEN t.query END,
    'outcome',a.outcome,'reasons',a.reason_codes,
    'affectedCount',CASE WHEN a.kind='QA_BATCH_RETURN' THEN a.details->'affectedCount' END,
    'affectedTaskIds',CASE WHEN a.kind='QA_BATCH_RETURN' THEN a.details->'affectedTaskIds' END,
    'exclusion',CASE WHEN a.actor_account_id IS NULL THEN 'UNKNOWN_IDENTITY'
      WHEN a.simulated THEN 'SIMULATED'
      WHEN a.kind='QA_REVIEW' AND a.actor_account_id=a.submitter_id THEN 'SELF_REVIEW'
      WHEN a.kind='QA_REVIEW' AND NOT a.selected THEN 'NOT_SELECTED' END) AS data
FROM activities a LEFT JOIN app_users u ON u.id=a.actor_account_id LEFT JOIN tasks t ON t.id=a.task_id;

CREATE FUNCTION capture_quality_review_activity(p_stage text DEFAULT NULL,p_source_id bigint DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO quality_review_activity_events(event_key,account_id,task_id,stage,kind,occurred_at,data)
  SELECT event_key,account_id,task_id,stage,kind,occurred_at,data FROM quality_review_activity_sources
  WHERE (p_stage IS NULL OR stage=p_stage) AND (p_source_id IS NULL OR source_event_id=p_source_id)
  ORDER BY occurred_at,event_key ON CONFLICT(event_key) DO NOTHING;
$$;
CREATE FUNCTION capture_quality_review_activity_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH','DISCARD') THEN
    PERFORM capture_quality_review_activity(CASE WHEN TG_TABLE_NAME='copy_sampling_events' THEN 'COPY' ELSE 'IMAGE' END,NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quality_activity_copy AFTER INSERT ON copy_sampling_events FOR EACH ROW EXECUTE FUNCTION capture_quality_review_activity_trigger();
CREATE TRIGGER quality_activity_image AFTER INSERT ON image_sampling_events FOR EACH ROW EXECUTE FUNCTION capture_quality_review_activity_trigger();

-- Install triggers before the backfill so concurrent writes cannot fall into a gap.
SELECT capture_quality_review_activity();

-- Recover trustworthy preserved single-item decisions after source deletion.
-- The same item key prevents double counting with the primary event backfill.
INSERT INTO quality_review_activity_events(event_key,account_id,task_id,stage,kind,occurred_at,data)
SELECT lower(e.stage)||'-review:'||(e.data->>'samplingItemId'),(e.data->>'reviewerId')::bigint,e.task_id,e.stage,
  'QA_REVIEW',e.occurred_at,jsonb_build_object('samplingItemId',e.data->'samplingItemId',
    'sampleKind',e.data->'sampleKind','outcome',e.data->'outcome','batchId',e.data->'batchId',
    'copyRevisionId',e.data->'copyRevisionId','imageRunId',e.data->'imageRunId',
    'username',u.username,'displayName',COALESCE(u.display_name,'历史质检账号 #'||(e.data->>'reviewerId')),
    'query',e.data->'query','source','PRESERVED_QUALITY','reasons',e.data->'reasons')
FROM operator_performance_events e LEFT JOIN app_users u ON u.id=(e.data->>'reviewerId')::bigint
WHERE e.kind='QUALITY' AND e.data->>'exclusion' IS NULL AND e.data->>'reviewerId' IS NOT NULL
  AND e.data->>'samplingItemId' IS NOT NULL AND e.data->>'outcome' IN ('PASS','RETURN')
ON CONFLICT(event_key) DO NOTHING;
