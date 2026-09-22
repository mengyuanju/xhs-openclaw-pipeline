-- Durable, content-free facts. Subsequent dispositions change the bucket, not
-- its operator, denominator or first QA date. No FK to deletable content/users.
CREATE TABLE account_quality_events (
  sequence_id bigserial UNIQUE,event_key text PRIMARY KEY,task_id bigint NOT NULL,
  stage text NOT NULL CHECK(stage IN ('COPY','IMAGE')),account_id bigint NOT NULL,
  action text NOT NULL CHECK(action IN ('PASS','RETURN','DISCARD','RESTORE','REASSIGNED')),
  establishes_sample boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX account_quality_event_subject_idx ON account_quality_events(task_id,stage,account_id,occurred_at,sequence_id);
CREATE TABLE account_quality_records (
  id bigserial PRIMARY KEY,task_id bigint NOT NULL,stage text NOT NULL,operator_account_id bigint NOT NULL,
  first_qa_at timestamptz NOT NULL,first_event_key text NOT NULL,current_bucket text NOT NULL
    CHECK(current_bucket IN ('FIRST_PASS','RETURNED','DISCARDED')),
  outcome_changed_at timestamptz NOT NULL,outcome_version bigint NOT NULL DEFAULT 1,
  reassigned boolean NOT NULL DEFAULT false,data jsonb NOT NULL,
  UNIQUE(task_id,stage,operator_account_id)
);
CREATE INDEX account_quality_period_idx ON account_quality_records(first_qa_at,stage,operator_account_id);
CREATE INDEX account_quality_operator_idx ON account_quality_records(operator_account_id,first_qa_at);

CREATE FUNCTION rebuild_account_quality_record(p_task bigint,p_stage text,p_account bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_fact account_quality_events%ROWTYPE; disposition text; has_return boolean; was_reassigned boolean;
  last_at timestamptz; bucket text;
BEGIN
  SELECT * INTO first_fact FROM account_quality_events WHERE task_id=p_task AND stage=p_stage AND account_id=p_account
    AND establishes_sample ORDER BY occurred_at,sequence_id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT action INTO disposition FROM account_quality_events WHERE task_id=p_task AND stage=p_stage AND account_id=p_account
    AND action IN ('DISCARD','RESTORE') ORDER BY occurred_at DESC,sequence_id DESC LIMIT 1;
  SELECT bool_or(action='RETURN'),bool_or(action='REASSIGNED'),max(occurred_at)
    INTO has_return,was_reassigned,last_at FROM account_quality_events
    WHERE task_id=p_task AND stage=p_stage AND account_id=p_account;
  bucket:=CASE WHEN disposition='DISCARD' THEN 'DISCARDED'
    WHEN has_return OR first_fact.action<>'PASS' THEN 'RETURNED' ELSE 'FIRST_PASS' END;
  INSERT INTO account_quality_records(task_id,stage,operator_account_id,first_qa_at,first_event_key,
    current_bucket,outcome_changed_at,reassigned,data)
  VALUES(p_task,p_stage,p_account,first_fact.occurred_at,first_fact.event_key,bucket,last_at,was_reassigned,first_fact.data)
  ON CONFLICT(task_id,stage,operator_account_id) DO UPDATE SET
    first_qa_at=EXCLUDED.first_qa_at,first_event_key=EXCLUDED.first_event_key,data=EXCLUDED.data,
    current_bucket=EXCLUDED.current_bucket,outcome_changed_at=EXCLUDED.outcome_changed_at,
    reassigned=EXCLUDED.reassigned,outcome_version=account_quality_records.outcome_version+1;
END $$;
CREATE FUNCTION project_account_quality_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rebuild_account_quality_record(NEW.task_id,NEW.stage,NEW.account_id);
  RETURN NEW;
END $$;
CREATE TRIGGER project_account_quality_event AFTER INSERT ON account_quality_events
  FOR EACH ROW EXECUTE FUNCTION project_account_quality_event();

-- Prefer the actual approval identity when legacy recheck items inherited a parent's owner.
CREATE VIEW account_quality_fact_sources AS
SELECT e.event_key,e.task_id,e.stage,COALESCE(a.approved_by_account_id,e.account_id) AS account_id,
 e.data->>'outcome' AS action,true AS establishes_sample,e.occurred_at,
 e.data||jsonb_build_object('batchId',COALESCE(t.production_batch_id,(e.data->>'batchId')::bigint))||CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('username',a.approved_by_username,'exclusion',NULL) ELSE '{}'::jsonb END AS data
FROM operator_performance_events e
LEFT JOIN tasks t ON t.id=e.task_id
LEFT JOIN copy_sampling_items i ON e.stage='COPY' AND i.id=(e.data->>'samplingItemId')::bigint
LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
WHERE e.kind='QUALITY' AND COALESCE(a.approved_by_account_id,e.account_id) IS NOT NULL
 AND e.data->>'outcome' IN ('PASS','RETURN') AND e.data->>'reviewerId' IS NOT NULL
 AND (e.data->>'reviewerId')::bigint<>COALESCE(a.approved_by_account_id,e.account_id)
 AND (e.data->>'exclusion' IS NULL OR (e.data->>'exclusion'='SELF_REVIEW' AND a.id IS NOT NULL));
CREATE FUNCTION capture_account_quality_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='QUALITY' THEN
  INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
  SELECT * FROM account_quality_fact_sources WHERE event_key=NEW.event_key ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_account_quality_fact AFTER INSERT ON operator_performance_events
 FOR EACH ROW EXECUTE FUNCTION capture_account_quality_fact();
INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
SELECT * FROM account_quality_fact_sources ORDER BY occurred_at,event_key ON CONFLICT DO NOTHING;

CREATE VIEW account_quality_disposition_sources AS
SELECT 'copy-disposition:'||d.id AS event_key,d.task_id,'COPY'::text AS stage,COALESCE(a.approved_by_account_id,i.final_approver_account_id) AS account_id,
  'DISCARD'::text AS action,false AS establishes_sample,d.created_at AS occurred_at,
  jsonb_build_object('username',COALESCE(a.approved_by_username,i.final_approver_username),'samplingItemId',i.id,'actorId',d.actor_account_id,
    'reason',d.reason_code,'note',d.note,'source','COPY_DISPOSITION') AS data
FROM copy_return_dispositions d JOIN copy_sampling_items i ON i.id=d.source_sampling_item_id
LEFT JOIN copy_approval_events a ON a.id=i.approval_event_id
UNION ALL
SELECT 'image-disposition:'||d.id,d.task_id,'IMAGE',a.submitted_by_account_id,'DISCARD',
  (d.from_state='IMAGE_QC_PENDING' AND COALESCE(i.selected,false)
    AND d.actor_account_id<>a.submitted_by_account_id AND NOT COALESCE(r.result->'simulation'->>'enabled'='true',false)),d.created_at,
  jsonb_build_object('username',a.submitted_by_username,'samplingItemId',i.id,'actorId',d.actor_account_id,
    'reviewerId',d.actor_account_id,'note',d.note,'source','IMAGE_DISPOSITION',
    'query',t.query,'batchId',t.production_batch_id,'copyRevisionId',d.copy_revision_id,'imageRunId',d.image_run_id)
FROM image_task_dispositions d JOIN image_approval_events a ON a.task_id=d.task_id AND a.image_run_id=d.image_run_id
LEFT JOIN image_sampling_items i ON i.id=d.sampling_item_id JOIN image_runs r ON r.id=d.image_run_id
JOIN tasks t ON t.id=d.task_id
WHERE NOT COALESCE(r.result->'simulation'->>'enabled'='true',false);
CREATE FUNCTION capture_account_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
  SELECT event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data
    FROM account_quality_disposition_sources WHERE event_key=(CASE WHEN TG_TABLE_NAME='copy_return_dispositions'
      THEN 'copy-disposition:' ELSE 'image-disposition:' END)||NEW.id ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_copy_account_disposition AFTER INSERT ON copy_return_dispositions FOR EACH ROW EXECUTE FUNCTION capture_account_disposition();
CREATE TRIGGER capture_image_account_disposition AFTER INSERT ON image_task_dispositions FOR EACH ROW EXECUTE FUNCTION capture_account_disposition();
INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
SELECT * FROM account_quality_disposition_sources ORDER BY occurred_at,event_key ON CONFLICT DO NOTHING;

CREATE FUNCTION capture_account_restore() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,occurred_at,data)
  SELECT 'restore:'||NEW.id||':'||r.id,r.task_id,r.stage,r.operator_account_id,'RESTORE',NEW.created_at,
    jsonb_build_object('actorId',NEW.actor_account_id,'source','TASK_RESTORE')
  FROM account_quality_records r WHERE r.task_id=NEW.task_id AND r.current_bucket='DISCARDED'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_account_restore AFTER INSERT ON task_restore_events FOR EACH ROW EXECUTE FUNCTION capture_account_restore();
-- Historical restore evidence, rather than current task state, reverses discards.
INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,occurred_at,data)
SELECT 'restore:'||restore.id||':'||r.id,r.task_id,r.stage,r.operator_account_id,'RESTORE',restore.created_at,
  jsonb_build_object('actorId',restore.actor_account_id,'source','TASK_RESTORE')
FROM task_restore_events restore JOIN account_quality_records r ON r.task_id=restore.task_id
WHERE EXISTS(SELECT 1 FROM account_quality_events e WHERE e.task_id=r.task_id AND e.stage=r.stage
  AND e.account_id=r.operator_account_id AND e.action='DISCARD' AND e.occurred_at<=restore.created_at)
ORDER BY restore.created_at,restore.id ON CONFLICT DO NOTHING;
