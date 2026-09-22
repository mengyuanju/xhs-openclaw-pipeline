-- Additive upgrade: existing tasks keep their state and content. Only an explicit
-- QA escalation starts a reset. Reporting/assignment facts have no cascading FKs.
ALTER TABLE tasks DROP CONSTRAINT tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'COPY_QUEUED','COPY_RUNNING','COPY_REVIEW_PENDING','COPY_FAILED','COPY_QC_PENDING',
  'IMAGE_QUEUED','IMAGE_RUNNING','IMAGE_FAILED','MANUAL_ARCHIVE','IMAGE_QC_PENDING',
  'IMAGE_REWORK_PENDING','REVIEWED','CANCELLED','PENDING_SECOND_ASSIGNMENT'));
ALTER TABLE tasks DROP CONSTRAINT tasks_cancelled_from_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_cancelled_from_state_check CHECK (cancelled_from_state IS NULL OR cancelled_from_state IN (
  'COPY_QUEUED','COPY_RUNNING','COPY_REVIEW_PENDING','COPY_FAILED','COPY_QC_PENDING',
  'IMAGE_QUEUED','IMAGE_RUNNING','IMAGE_FAILED','MANUAL_ARCHIVE','IMAGE_QC_PENDING',
  'IMAGE_REWORK_PENDING','REVIEWED','PENDING_SECOND_ASSIGNMENT'));
ALTER TABLE tasks ADD COLUMN work_generation integer NOT NULL DEFAULT 0;
ALTER TABLE tasks DROP CONSTRAINT tasks_mandatory_copy_qc_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_mandatory_copy_qc_origin_check CHECK (mandatory_copy_qc_origin IS NULL OR
  mandatory_copy_qc_origin IN ('QA_RETURN','FINAL_REWORK','IMAGE_RETRY_REVIEW','DISCARD_RESTORE','SECOND_ASSIGNMENT'));
ALTER TABLE tasks DROP CONSTRAINT tasks_mandatory_image_qc_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_mandatory_image_qc_origin_check CHECK (mandatory_image_qc_origin IS NULL OR
  mandatory_image_qc_origin IN ('QA_RETURN','BATCH_RETURN','DISCARD_RESTORE','SECOND_ASSIGNMENT'));
ALTER TABLE copy_revisions DROP CONSTRAINT copy_revisions_revision_origin_check;
ALTER TABLE copy_revisions ADD CONSTRAINT copy_revisions_revision_origin_check CHECK (revision_origin IS NULL OR
  revision_origin IN ('GENERATION','COPY_EDIT','PLAN_EDIT','QA_RETURN','FINAL_REWORK','DISCARD_RESTORE','SECOND_ASSIGNMENT_RESET'));
ALTER TABLE copy_revisions ADD COLUMN content_cleared_at timestamptz;
ALTER TABLE image_runs ADD COLUMN content_cleared_at timestamptz;
ALTER TABLE task_executions ADD COLUMN content_cleared_at timestamptz;
ALTER TABLE assets ADD COLUMN content_cleared_at timestamptz;

CREATE TABLE task_initial_baselines (
  task_id bigint PRIMARY KEY, source_revision_id bigint NOT NULL, content jsonb NOT NULL,
  input jsonb NOT NULL, asset_ids bigint[] NOT NULL DEFAULT '{}', source text NOT NULL CHECK(source IN ('GENERATION','BACKFILL','REGENERATED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION capture_initial_task_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_origin='GENERATION' AND NEW.parent_revision_id IS NULL
     AND NOT NEW.copy_content_changed_from_machine AND NOT (NEW.content ? 'manualReview') AND NEW.content_cleared_at IS NULL THEN
    INSERT INTO task_initial_baselines(task_id,source_revision_id,content,input,asset_ids,source)
    SELECT NEW.task_id,NEW.id,NEW.content,t.input,
      CASE WHEN EXISTS(SELECT 1 FROM task_reassignment_cases c WHERE c.task_id=NEW.task_id AND c.status='PENDING') THEN '{}'::bigint[]
        ELSE ARRAY(SELECT a.id FROM assets a WHERE a.task_id=NEW.task_id AND a.created_at<=NEW.created_at) END,
      CASE WHEN EXISTS(SELECT 1 FROM task_reassignment_cases c WHERE c.task_id=NEW.task_id AND c.status='PENDING') THEN 'REGENERATED' ELSE 'GENERATION' END FROM tasks t
      WHERE t.id=NEW.task_id AND t.task_kind='CONTENT'
    ON CONFLICT(task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_initial_task_baseline AFTER INSERT ON copy_revisions
  FOR EACH ROW EXECUTE FUNCTION capture_initial_task_baseline();
-- Never infer an original draft from a manual revision, latest state or timestamp.
INSERT INTO task_initial_baselines(task_id,source_revision_id,content,input,asset_ids,source)
SELECT DISTINCT ON(r.task_id) r.task_id,r.id,r.content,t.input,
  ARRAY(SELECT a.id FROM assets a WHERE a.task_id=r.task_id AND a.created_at<=r.created_at),'BACKFILL'
FROM copy_revisions r JOIN tasks t ON t.id=r.task_id
WHERE t.task_kind='CONTENT' AND r.revision_origin='GENERATION' AND r.parent_revision_id IS NULL
  AND NOT r.copy_content_changed_from_machine AND NOT (r.content ? 'manualReview') AND r.content_cleared_at IS NULL
ORDER BY r.task_id,r.revision,r.id ON CONFLICT DO NOTHING;

CREATE TABLE task_assignment_records (
  id bigserial PRIMARY KEY,task_id bigint NOT NULL,assignee_account_id bigint,
  assignee_username_snapshot text NOT NULL,assignee_display_name_snapshot text,
  previous_record_id bigint,source text NOT NULL,reason text,assigned_by_account_id bigint,
  assigned_at timestamptz NOT NULL,ended_at timestamptz,end_reason text,
  source_event_id bigint UNIQUE,baseline boolean NOT NULL DEFAULT false,
  CHECK(ended_at IS NULL OR ended_at>=assigned_at)
);
CREATE INDEX assignment_record_task_idx ON task_assignment_records(task_id,id);
CREATE INDEX assignment_record_account_idx ON task_assignment_records(assignee_account_id,assigned_at);
CREATE UNIQUE INDEX assignment_record_active_idx ON task_assignment_records(task_id) WHERE ended_at IS NULL;
-- Only a current baseline is inferred; old events remain separately auditable.
INSERT INTO task_assignment_records(task_id,assignee_account_id,assignee_username_snapshot,
  assignee_display_name_snapshot,source,assigned_at,baseline)
SELECT t.id,u.id,t.assigned_to_user_id,u.display_name,'MIGRATION_BASELINE',
  COALESCE(t.assigned_at,clock_timestamp()),true
FROM tasks t LEFT JOIN app_users u ON u.username=t.assigned_to_user_id AND u.created_at<=t.assigned_at
WHERE t.assigned_to_user_id IS NOT NULL;
CREATE FUNCTION capture_assignment_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id bigint; moment timestamptz; identity app_users%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.assigned_to_user_id IS NOT DISTINCT FROM OLD.assigned_to_user_id THEN RETURN NEW; END IF;
  moment:=clock_timestamp();
  UPDATE task_assignment_records SET ended_at=greatest(moment,assigned_at),end_reason=NEW.state
    WHERE task_id=NEW.id AND ended_at IS NULL RETURNING id INTO previous_id;
  IF NEW.assigned_to_user_id IS NOT NULL THEN
    SELECT * INTO identity FROM app_users WHERE username=NEW.assigned_to_user_id AND created_at<=COALESCE(NEW.assigned_at,moment);
    INSERT INTO task_assignment_records(task_id,assignee_account_id,assignee_username_snapshot,
      assignee_display_name_snapshot,previous_record_id,source,assigned_at)
    VALUES(NEW.id,identity.id,NEW.assigned_to_user_id,identity.display_name,previous_id,
      COALESCE(NEW.assignment_source,'UNKNOWN'),COALESCE(NEW.assigned_at,moment));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_assignment_record AFTER INSERT OR UPDATE OF assigned_to_user_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION capture_assignment_record();

CREATE TABLE task_reassignment_cases (
  id bigserial PRIMARY KEY,task_id bigint NOT NULL,stage text NOT NULL CHECK(stage IN ('COPY','IMAGE')),
  source_item_id bigint NOT NULL,source_item_public_id uuid NOT NULL,source_freeze_id bigint NOT NULL,
  operator_account_id bigint NOT NULL,assignment_record_id bigint,reviewer_account_id bigint NOT NULL,
  reason_codes text[] NOT NULL DEFAULT '{}',note text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','REASSIGNED','DISCARDED')),
  reset_status text NOT NULL DEFAULT 'PENDING' CHECK(reset_status IN ('PENDING','BLOCKED','READY','REGENERATING')),
  cleanup_status text NOT NULL DEFAULT 'PENDING' CHECK(cleanup_status IN ('PENDING','FAILED','COMPLETE')),
  reset_error text,baseline_revision_id bigint,new_revision_id bigint,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disposed_at timestamptz,disposed_by_account_id bigint,target_account_id bigint,disposition_note text,
  UNIQUE(stage,source_item_id)
);
CREATE UNIQUE INDEX reassignment_one_pending_idx ON task_reassignment_cases(task_id) WHERE status='PENDING';
CREATE INDEX reassignment_pending_idx ON task_reassignment_cases(status,created_at,id);
CREATE TABLE task_reassignment_assessment_records (
  case_id bigint NOT NULL REFERENCES task_reassignment_cases(id),assessment_id bigint NOT NULL,
  task_id bigint NOT NULL,stage text NOT NULL,score_x10 smallint NOT NULL,rating_context text NOT NULL,
  action text NOT NULL,reason_codes text[] NOT NULL,reviewer_username text NOT NULL,created_at timestamptz NOT NULL,
  PRIMARY KEY(case_id,assessment_id)
);
CREATE TABLE task_reassignment_case_members (
  case_id bigint NOT NULL REFERENCES task_reassignment_cases(id),stage text NOT NULL,
  sampling_item_id bigint NOT NULL,freeze_id bigint NOT NULL,
  PRIMARY KEY(case_id,stage,sampling_item_id)
);
CREATE INDEX reassignment_member_idx ON task_reassignment_case_members(stage,sampling_item_id);
CREATE TABLE task_reassignment_cleanup (
  id bigserial PRIMARY KEY,case_id bigint NOT NULL REFERENCES task_reassignment_cases(id),
  task_id bigint NOT NULL,storage_path text NOT NULL,cleaned_at timestamptz,error text,
  UNIQUE(case_id,storage_path)
);
CREATE TABLE task_reassignment_requests (
  actor_account_id bigint NOT NULL,request_id uuid NOT NULL,operation text NOT NULL,
  fingerprint text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_account_id,request_id)
);

ALTER TABLE copy_sampling_items DROP CONSTRAINT copy_sampling_items_status_check;
ALTER TABLE copy_sampling_items ADD CONSTRAINT copy_sampling_items_status_check CHECK(status IN (
  'NOT_SELECTED','PENDING','PASSED','RETURNED','BATCH_AFFECTED','BATCH_RETURNED','RELEASED','SUPERSEDED','DISCARDED','ADMIN_ESCALATED'));
ALTER TABLE image_sampling_items DROP CONSTRAINT image_sampling_items_status_check;
ALTER TABLE image_sampling_items ADD CONSTRAINT image_sampling_items_status_check CHECK(status IN (
  'NOT_SELECTED','PENDING','PASSED','RETURNED','BATCH_AFFECTED','BATCH_RETURNED','RELEASED','SUPERSEDED','DISCARDED','ADMIN_ESCALATED'));
ALTER TABLE copy_sampling_events DROP CONSTRAINT copy_sampling_events_action_check;
ALTER TABLE copy_sampling_events ADD CONSTRAINT copy_sampling_events_action_check CHECK(action IN (
  'FREEZE','PASS','RETURN_SINGLE','RETURN_BATCH','RELEASE','SUPERSEDE','DISCARD','ESCALATE_ADMIN'));
ALTER TABLE image_sampling_events DROP CONSTRAINT image_sampling_events_action_check;
ALTER TABLE image_sampling_events ADD CONSTRAINT image_sampling_events_action_check CHECK(action IN (
  'FREEZE','PASS','RETURN_SINGLE','RETURN_BATCH','RELEASE','SUPERSEDE','DISCARD','ESCALATE_ADMIN'));
ALTER TABLE quality_review_activity_events DROP CONSTRAINT quality_review_activity_events_kind_check;
ALTER TABLE quality_review_activity_events ADD CONSTRAINT quality_review_activity_events_kind_check CHECK(kind IN (
  'QA_REVIEW','QA_BATCH_RETURN','QA_DIRECT_PASS','QA_DISCARD','QA_ESCALATE'));

-- Cleared payloads are intentionally empty metadata shells. Keep foreign-key
-- identities/QA evidence, but never allow an old client to restore their content.
CREATE FUNCTION protect_cleared_copy_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_cleared_at IS NOT NULL AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_cleared_at IS NULL) THEN
    RAISE EXCEPTION 'cleared annotation content cannot be restored';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_cleared_copy_content BEFORE UPDATE ON copy_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_cleared_copy_content();

CREATE VIEW secondary_assignment_migration_report AS
SELECT t.id AS task_id,t.state,t.assigned_to_user_id,b.source_revision_id,
  CASE WHEN b.task_id IS NULL THEN 'BASELINE_MISSING' ELSE 'BASELINE_READY' END AS baseline_status
FROM tasks t LEFT JOIN task_initial_baselines b ON b.task_id=t.id WHERE t.task_kind='CONTENT';

CREATE OR REPLACE FUNCTION copy_quality_image_eligible(
  task_id_arg bigint,
  revision_id_arg bigint,
  mandatory_arg boolean
)
RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE release_lineage(revision_id, depth) AS (
   SELECT revision_id_arg, 0
   UNION ALL
   SELECT inheritance.source_revision_id, release_lineage.depth + 1
   FROM release_lineage
   JOIN copy_qc_revision_inheritances AS inheritance
     ON inheritance.target_revision_id = release_lineage.revision_id
    AND inheritance.task_id = task_id_arg
   WHERE release_lineage.depth < 100
 )
 SELECT NOT mandatory_arg
 AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=task_id_arg AND state='PENDING_SECOND_ASSIGNMENT')
   AND EXISTS (SELECT 1 FROM copy_revisions r WHERE r.task_id = task_id_arg
     AND r.id = revision_id_arg AND r.approved_at IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id = i.freeze_id
     WHERE i.task_id = task_id_arg
 AND NOT EXISTS (SELECT 1 FROM task_reassignment_case_members m WHERE m.stage='COPY' AND m.sampling_item_id=i.id)
 AND f.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED')
   )
   AND NOT EXISTS (
     SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg
       AND i.copy_revision_id = revision_id_arg
       AND i.status IN ('PENDING', 'NOT_SELECTED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'SUPERSEDED')
   )
   AND (
     NOT EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task_id_arg)
     OR EXISTS (
       SELECT 1
       FROM release_lineage
       JOIN copy_sampling_items i ON i.task_id = task_id_arg
         AND i.copy_revision_id = release_lineage.revision_id
       JOIN copy_sampling_freezes f ON f.id = i.freeze_id
       WHERE i.status IN ('PASSED', 'RELEASED')
         AND f.status IN ('RELEASED', 'RELEASED_WITH_EXCEPTIONS')
     )
   )
$$;


CREATE FUNCTION protect_initial_task_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'initial task baseline is immutable'; END $$;
CREATE TRIGGER protect_initial_task_baseline BEFORE UPDATE OR DELETE ON task_initial_baselines
 FOR EACH ROW EXECUTE FUNCTION protect_initial_task_baseline();

-- A detached task cannot be cancelled, requeued or assigned through legacy APIs.
CREATE FUNCTION guard_secondary_assignment_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE regenerating boolean;
BEGIN
 IF current_setting('app.secondary_assignment',true)='on' THEN RETURN NEW; END IF;
 SELECT reset_status='REGENERATING' INTO regenerating FROM task_reassignment_cases WHERE task_id=OLD.id AND status='PENDING';
 IF FOUND AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
   OR NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id OR NEW.current_image_run_id IS DISTINCT FROM OLD.current_image_run_id) THEN
   IF NOT (regenerating AND OLD.state IN ('COPY_QUEUED','COPY_RUNNING') AND NEW.state IN ('COPY_RUNNING','COPY_FAILED')
     AND NEW.assigned_to_user_id IS NULL AND NEW.current_copy_revision_id IS NOT DISTINCT FROM OLD.current_copy_revision_id
     AND NEW.current_image_run_id IS NOT DISTINCT FROM OLD.current_image_run_id) THEN
     RAISE EXCEPTION 'pending secondary assignment must be handled by administrator disposition' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER z_guard_secondary_assignment_state BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_secondary_assignment_state();

CREATE OR REPLACE FUNCTION protect_approved_copy_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('app.secondary_assignment',true)='on' AND OLD.content_cleared_at IS NULL
   AND NEW.content_cleared_at IS NOT NULL AND NEW.content='{}'::jsonb
   AND EXISTS(SELECT 1 FROM task_reassignment_cases WHERE task_id=OLD.task_id AND status='PENDING') THEN RETURN NEW; END IF;
 IF NEW.content IS DISTINCT FROM OLD.content AND (OLD.approved_at IS NOT NULL OR EXISTS (
   SELECT 1 FROM copy_approval_events WHERE copy_revision_id=OLD.id)) THEN
   RAISE EXCEPTION 'approved copy is immutable; append a new revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION mark_secondary_regeneration_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='COPY_FAILED' THEN
  UPDATE task_reassignment_cases SET reset_status='BLOCKED',reset_error='初始数据生成失败，请重新生成',version=version+1
   WHERE task_id=NEW.id AND status='PENDING' AND reset_status='REGENERATING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mark_secondary_regeneration_failure AFTER UPDATE OF state ON tasks
 FOR EACH ROW EXECUTE FUNCTION mark_secondary_regeneration_failure();
CREATE FUNCTION guard_pending_secondary_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM task_reassignment_cases WHERE task_id=OLD.id AND status='PENDING') THEN
  RAISE EXCEPTION 'pending secondary assignment cannot be deleted' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER guard_pending_secondary_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_pending_secondary_delete();
