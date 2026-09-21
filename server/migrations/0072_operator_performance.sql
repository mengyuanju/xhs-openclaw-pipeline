-- Append-only, minimal reporting facts. Intentionally no cascading task/user FKs:
-- deleting/reassigning a task must not transfer or erase historical contribution.
CREATE TABLE operator_performance_events (
  sequence_id bigserial UNIQUE,
  event_key text PRIMARY KEY,
  task_id bigint NOT NULL,
  account_id bigint,
  stage text NOT NULL CHECK (stage IN ('COPY','IMAGE')),
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  data jsonb NOT NULL
);
CREATE INDEX operator_performance_account_time_idx ON operator_performance_events(account_id,occurred_at,task_id);
CREATE INDEX operator_performance_time_idx ON operator_performance_events(occurred_at,task_id);
CREATE INDEX operator_performance_task_stage_idx ON operator_performance_events(task_id,stage,occurred_at);
CREATE INDEX operator_copy_decision_idx ON copy_sampling_events(sampling_item_id,created_at,id) WHERE action IN ('PASS','RETURN_SINGLE','RETURN_BATCH');
CREATE INDEX operator_image_decision_idx ON image_sampling_events(sampling_item_id,created_at,id) WHERE action IN ('PASS','RETURN_SINGLE');
CREATE INDEX operator_copy_first_idx ON copy_sampling_items(task_id,id) WHERE selected AND sample_kind='RANDOM';
CREATE INDEX operator_image_first_idx ON image_sampling_items(task_id,id) WHERE selected AND sample_kind='RANDOM';

-- Determine first inspection against the complete task history BEFORE date/person filters.
CREATE VIEW operator_quality_samples AS
WITH items AS (
  SELECT 'COPY'::text AS stage,i.id,i.task_id,i.approval_event_id,i.copy_revision_id,NULL::uuid AS image_run_id,
    i.final_approver_account_id AS account_id,i.final_approver_username AS username,
    i.selected,i.sample_kind,i.parent_item_id,i.status,i.reviewed_at,i.reviewed_by_account_id,i.reason_codes,
    'COPY'::text AS rework_target,i.created_at,f.production_batch_id AS batch_id,f.policy_version,
    (SELECT min(e.created_at) FROM copy_sampling_events e WHERE e.freeze_id=f.id AND e.action='RETURN_BATCH') AS batch_returned_at,
    a.approved_at AS submitted_at,
    d.action,d.created_at AS decision_at,d.actor_account_id AS reviewer_id,d.details,
    EXISTS(SELECT 1 FROM copy_qa_admin_direct_approvals direct WHERE direct.approval_event_id=i.approval_event_id) AS direct,
    false AS simulated,
    NOT EXISTS(SELECT 1 FROM copy_sampling_items p WHERE p.task_id=i.task_id AND p.selected AND p.sample_kind='RANDOM' AND p.id<i.id) AS first_random
  FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id=i.freeze_id
  JOIN copy_approval_events a ON a.id=i.approval_event_id
  LEFT JOIN LATERAL(SELECT action,created_at,actor_account_id,details FROM copy_sampling_events e
    WHERE e.sampling_item_id=i.id AND e.action IN ('PASS','RETURN_SINGLE','RETURN_BATCH') ORDER BY e.created_at,e.id LIMIT 1) d ON true
  UNION ALL
  SELECT 'IMAGE',i.id,i.task_id,i.approval_event_id,i.copy_revision_id,i.image_run_id,
    i.submitter_account_id,i.submitter_username,i.selected,i.sample_kind,i.parent_item_id,i.status,i.reviewed_at,
    i.reviewed_by_account_id,i.reason_codes,i.rework_target,i.created_at,f.production_batch_id,f.policy_version,
    (SELECT min(e.created_at) FROM image_sampling_events e WHERE e.freeze_id=f.id AND e.action='RETURN_BATCH'),
    a.submitted_at,d.action,d.created_at,d.actor_account_id,d.details,false,
    COALESCE(r.result->'simulation'->>'enabled'='true',false),
    NOT EXISTS(SELECT 1 FROM image_sampling_items p WHERE p.task_id=i.task_id AND p.selected AND p.sample_kind='RANDOM' AND p.id<i.id)
  FROM image_sampling_items i JOIN image_sampling_freezes f ON f.id=i.freeze_id
  JOIN image_approval_events a ON a.id=i.approval_event_id JOIN image_runs r ON r.id=i.image_run_id
  LEFT JOIN LATERAL(SELECT action,created_at,actor_account_id,details FROM image_sampling_events e
    WHERE e.sampling_item_id=i.id AND e.action IN ('PASS','RETURN_SINGLE') ORDER BY e.created_at,e.id LIMIT 1) d ON true
)
SELECT items.*,COALESCE(decision_at,reviewed_at) AS decided_at,
  CASE WHEN action='PASS' THEN 'PASS' WHEN action IN ('RETURN_SINGLE','RETURN_BATCH') THEN 'RETURN'
    WHEN status='PASSED' AND reviewed_at IS NOT NULL THEN 'PASS'
    WHEN status='RETURNED' AND reviewed_at IS NOT NULL THEN 'RETURN' END AS outcome,
  CASE WHEN simulated THEN 'SIMULATED'
    WHEN direct OR COALESCE(details->>'directAdminApproval'='true',false) THEN 'ADMIN_DIRECT'
    WHEN COALESCE(reviewer_id,reviewed_by_account_id)=account_id THEN 'SELF_REVIEW'
    WHEN account_id IS NULL THEN 'UNKNOWN_IDENTITY'
    WHEN NOT selected THEN 'NOT_SELECTED'
    WHEN action IS NULL AND status IN ('BATCH_AFFECTED','BATCH_RETURNED') THEN 'BATCH_AFFECTED'
    WHEN action IS NULL AND status IN ('SUPERSEDED','RELEASED') THEN 'NO_VERDICT'
    END AS exclusion
FROM items;

CREATE TABLE operator_stage_events (
  id bigserial PRIMARY KEY,task_id bigint NOT NULL,account_id bigint,username text,
  stage text NOT NULL,phase text NOT NULL,state text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),baseline boolean NOT NULL DEFAULT false
);
CREATE INDEX operator_stage_task_time_idx ON operator_stage_events(task_id,occurred_at,id);

CREATE FUNCTION record_operator_stage(p_task_id bigint,p_baseline boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t tasks%ROWTYPE; previous operator_stage_events%ROWTYPE; owner_id bigint;
  phase_name text; stage_name text; background_running boolean := false; result_ready boolean := false;
BEGIN
  SELECT * INTO t FROM tasks WHERE id=p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT id INTO owner_id FROM app_users WHERE username=t.assigned_to_user_id AND created_at<t.assigned_at;
  stage_name := CASE WHEN t.state LIKE 'COPY_%' THEN 'COPY' ELSE 'IMAGE' END;
  IF t.state='COPY_REVIEW_PENDING' THEN
    SELECT COALESCE(status IN ('QUEUED','RUNNING'),false),COALESCE(status='SUCCEEDED',false)
      INTO background_running,result_ready FROM copy_image_plan_regeneration_jobs
      WHERE task_id=t.id AND copy_revision_id=t.current_copy_revision_id ORDER BY created_at DESC,id DESC LIMIT 1;
  ELSIF t.state IN ('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING') THEN
    SELECT COALESCE(bool_or(status IN ('QUEUED','RUNNING')),false),COALESCE(bool_or(status IN ('PREVIEW_READY','FAILED')),false)
      INTO background_running,result_ready FROM (SELECT DISTINCT ON(target_page) status FROM image_edit_requests
        WHERE task_id=t.id AND copy_revision_id=t.current_copy_revision_id AND status<>'DRAFT'
        ORDER BY target_page,created_at DESC,id DESC) recent;
  END IF;
  phase_name := CASE
    WHEN t.state IN ('REVIEWED','CANCELLED') THEN 'CLOSED'
    WHEN t.state IN ('COPY_QC_PENDING','IMAGE_QC_PENDING') THEN 'QUALITY_WAIT'
    WHEN t.state LIKE '%_RUNNING' THEN 'MACHINE_RUNNING'
    WHEN t.state LIKE '%_QUEUED' THEN 'MACHINE_QUEUE'
    WHEN owner_id IS NULL THEN 'UNASSIGNED'
    WHEN background_running AND NOT COALESCE(result_ready,false) THEN 'BACKGROUND'
    ELSE 'HUMAN' END;
  SELECT * INTO previous FROM operator_stage_events WHERE task_id=t.id ORDER BY occurred_at DESC,id DESC LIMIT 1;
  IF previous.id IS NOT NULL AND NOT p_baseline AND previous.account_id IS NOT DISTINCT FROM owner_id
    AND previous.stage=stage_name AND previous.phase=phase_name AND previous.state=t.state THEN RETURN; END IF;
  INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,baseline)
    VALUES(t.id,owner_id,t.assigned_to_user_id,stage_name,phase_name,t.state,p_baseline);
END $$;

CREATE FUNCTION operator_stage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='tasks' THEN PERFORM record_operator_stage(NEW.id);
  ELSE PERFORM record_operator_stage(NEW.task_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_operator_stage AFTER INSERT OR UPDATE OF state,assigned_to_user_id,current_copy_revision_id,current_image_run_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION operator_stage_trigger();
CREATE TRIGGER zz_operator_plan_stage AFTER INSERT OR UPDATE OF status ON copy_image_plan_regeneration_jobs
  FOR EACH ROW EXECUTE FUNCTION operator_stage_trigger();
CREATE TRIGGER zz_operator_edit_stage AFTER INSERT OR UPDATE OF status ON image_edit_requests
  FOR EACH ROW EXECUTE FUNCTION operator_stage_trigger();

-- Existing rows start a baseline; an unknown historical starting point is never invented.
DO $$ DECLARE t record; BEGIN FOR t IN SELECT id FROM tasks LOOP PERFORM record_operator_stage(t.id,true); END LOOP; END $$;

CREATE VIEW operator_source_facts AS
SELECT 'copy-submit:'||a.id AS event_key,a.task_id,a.approved_by_account_id AS account_id,'COPY'::text AS stage,
  'SUBMIT'::text AS kind,a.approved_at AS occurred_at,
  jsonb_build_object('username',a.approved_by_username,'copyRevisionId',a.copy_revision_id,
    'approvalId',a.id,'exclusion',CASE WHEN a.approval_mode='ADMIN_BYPASS' THEN 'BYPASS' END,
    'rework',r.revision_origin IN ('QA_RETURN','FINAL_REWORK') OR COALESCE(r.copy_rework_satisfied,false),
    'firstSubmission',NOT EXISTS(SELECT 1 FROM copy_approval_events p WHERE p.task_id=a.task_id AND (p.approved_at,p.id)<(a.approved_at,a.id))) AS data
FROM copy_approval_events a JOIN copy_revisions r ON r.id=a.copy_revision_id
UNION ALL
SELECT 'image-submit:'||a.id,a.task_id,a.submitted_by_account_id,'IMAGE','SUBMIT',a.submitted_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',a.copy_revision_id,'imageRunId',a.image_run_id,
    'approvalId',a.id,'exclusion',CASE WHEN r.result->'simulation'->>'enabled'='true' THEN 'SIMULATED' END,
    'rework',a.submission_mode='MANDATORY_RECHECK',
    'firstSubmission',NOT EXISTS(SELECT 1 FROM image_approval_events p WHERE p.task_id=a.task_id AND (p.submitted_at,p.id)<(a.submitted_at,a.id)))
FROM image_approval_events a JOIN image_runs r ON r.id=a.image_run_id
UNION ALL
SELECT lower(q.stage)||'-qa:'||q.id,q.task_id,q.account_id,q.stage,'QUALITY',q.decided_at,
  jsonb_build_object('username',q.username,'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,
    'approvalId',q.approval_event_id,'samplingItemId',q.id,'sampleKind',q.sample_kind,'first',q.first_random AND q.sample_kind='RANDOM',
    'firstRecheck',q.sample_kind='MANDATORY_RECHECK' AND CASE WHEN q.stage='COPY' THEN
      EXISTS(SELECT 1 FROM copy_sampling_items parent WHERE parent.id=q.parent_item_id AND parent.sample_kind='RANDOM') ELSE
      EXISTS(SELECT 1 FROM image_sampling_items parent WHERE parent.id=q.parent_item_id AND parent.sample_kind='RANDOM') END,
    'outcome',q.outcome,'exclusion',q.exclusion,'reasons',q.reason_codes,'target',q.rework_target,
    'reviewerId',COALESCE(q.reviewer_id,q.reviewed_by_account_id),'submittedAt',q.submitted_at,'policyVersion',q.policy_version)
FROM operator_quality_samples q WHERE q.outcome IS NOT NULL AND q.decided_at IS NOT NULL
UNION ALL
SELECT lower(q.stage)||'-sample:'||q.id,q.task_id,q.account_id,q.stage,'SAMPLE',q.created_at,
  jsonb_build_object('username',q.username,'approvalId',q.approval_event_id,'samplingItemId',q.id,
    'sampleKind',q.sample_kind,'first',q.first_random,'selected',q.selected,'policyVersion',q.policy_version)
FROM operator_quality_samples q
UNION ALL
SELECT 'final-return:'||h.id,h.task_id,a.submitted_by_account_id,'IMAGE','RETURN',h.created_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',h.copy_revision_id,'imageRunId',h.image_run_id,
    'reasons',h.reason_codes,'target',h.rework_target,'source','FINAL_REWORK')
FROM human_quality_assessments h LEFT JOIN image_approval_events a ON a.image_run_id=h.image_run_id
WHERE h.rework_target IS NOT NULL
UNION ALL
SELECT lower(q.stage)||'-batch-impact:'||q.id,q.task_id,q.account_id,q.stage,'BATCH_RETURN',COALESCE(q.batch_returned_at,q.reviewed_at,q.created_at),
  jsonb_build_object('username',q.username,'copyRevisionId',q.copy_revision_id,'imageRunId',q.image_run_id,'reasons',q.reason_codes,
    'target',COALESCE(q.rework_target,q.stage),'exclusion',q.exclusion)
FROM operator_quality_samples q WHERE q.status IN ('BATCH_AFFECTED','BATCH_RETURNED') OR q.action='RETURN_BATCH'
UNION ALL
SELECT 'release:'||d.id,d.task_id,a.submitted_by_account_id,'IMAGE','RELEASE',d.approved_at,
  jsonb_build_object('username',a.submitted_by_username,'copyRevisionId',d.copy_revision_id,'imageRunId',d.image_run_id,
    'approvalId',a.id,'exclusion',CASE WHEN a.id IS NULL THEN 'UNKNOWN_IDENTITY' WHEN r.result->'simulation'->>'enabled'='true' THEN 'SIMULATED' END,
    'first',NOT EXISTS(SELECT 1 FROM delivery_entries p WHERE p.task_id=d.task_id AND (p.approved_at,p.id)<(d.approved_at,d.id)),
    'releaseMethod',CASE WHEN EXISTS(SELECT 1 FROM image_sampling_items i WHERE i.approval_event_id=a.id AND i.status='PASSED') THEN 'INSPECTED' ELSE 'POLICY_RELEASE' END)
FROM delivery_entries d LEFT JOIN image_approval_events a ON a.task_id=d.task_id AND a.image_run_id=d.image_run_id
  AND a.copy_revision_id=d.copy_revision_id LEFT JOIN image_runs r ON r.id=d.image_run_id
UNION ALL
SELECT 'delivered:'||b.id||':'||i.id,i.task_id,b.delivered_by_account_id,'IMAGE','DELIVERY',b.delivered_at,
  jsonb_build_object('username',b.delivered_by_username,'copyRevisionId',i.copy_revision_id,'imageRunId',i.image_run_id,
    'deliveryBatchId',b.id,'query',i.query_snapshot)
FROM delivery_batches b JOIN delivery_batch_items i ON i.delivery_batch_id=b.id WHERE b.status='DELIVERED';

CREATE FUNCTION capture_operator_facts(p_task_id bigint DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
  SELECT f.event_key,f.task_id,f.account_id,f.stage,f.kind,f.occurred_at,
    f.data || jsonb_build_object('query',COALESCE(f.data->>'query',t.query),'batchId',t.production_batch_id,'createdAt',t.created_at,
      'displayName',COALESCE(u.display_name,f.data->>'username','历史身份未确认'),'role',u.role)
  FROM operator_source_facts f LEFT JOIN tasks t ON t.id=f.task_id LEFT JOIN app_users u ON u.id=f.account_id
  WHERE (p_task_id IS NULL OR f.task_id=p_task_id)
  ORDER BY f.occurred_at,substring(f.event_key from '[0-9]+$')::bigint,f.event_key
  ON CONFLICT(event_key) DO NOTHING;
$$;
SELECT capture_operator_facts();

CREATE FUNCTION operator_fact_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_key bigint;
BEGIN
  IF TG_TABLE_NAME='delivery_batch_confirmation_events' THEN
    FOR task_key IN SELECT task_id FROM delivery_batch_items WHERE delivery_batch_id=NEW.delivery_batch_id LOOP PERFORM capture_operator_facts(task_key); END LOOP;
  ELSIF TG_TABLE_NAME IN ('copy_sampling_events','image_sampling_events') THEN
    -- Capture the decision only AFTER its event (including direct-pass metadata) exists.
    IF NEW.action IN ('RETURN_BATCH','FREEZE') THEN
      IF TG_TABLE_NAME='copy_sampling_events' THEN
        FOR task_key IN SELECT task_id FROM copy_sampling_items WHERE freeze_id=NEW.freeze_id LOOP PERFORM capture_operator_facts(task_key); END LOOP;
      ELSE
        FOR task_key IN SELECT task_id FROM image_sampling_items WHERE freeze_id=NEW.freeze_id LOOP PERFORM capture_operator_facts(task_key); END LOOP;
      END IF;
    ELSIF NEW.sampling_item_id IS NOT NULL THEN
      IF TG_TABLE_NAME='copy_sampling_events' THEN SELECT task_id INTO task_key FROM copy_sampling_items WHERE id=NEW.sampling_item_id;
      ELSE SELECT task_id INTO task_key FROM image_sampling_items WHERE id=NEW.sampling_item_id; END IF;
      PERFORM capture_operator_facts(task_key);
    END IF;
  ELSE PERFORM capture_operator_facts(NEW.task_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operator_copy_submit AFTER INSERT ON copy_approval_events FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_image_submit AFTER INSERT ON image_approval_events FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_copy_qa AFTER INSERT ON copy_sampling_events FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_image_qa AFTER INSERT ON image_sampling_events FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_final_return AFTER INSERT ON human_quality_assessments FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_release AFTER INSERT ON delivery_entries FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
CREATE TRIGGER operator_delivery AFTER INSERT ON delivery_batch_confirmation_events FOR EACH ROW EXECUTE FUNCTION operator_fact_trigger();
