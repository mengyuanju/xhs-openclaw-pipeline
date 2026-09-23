ALTER TABLE app_users
  ADD COLUMN auto_copy_batch_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_copy_batch_size integer NOT NULL DEFAULT 10 CHECK (auto_copy_batch_size BETWEEN 1 AND 5000),
  ADD COLUMN copy_full_inspection boolean NOT NULL DEFAULT false;

ALTER TABLE workflow_quality_settings
  ADD COLUMN copy_batch_return_threshold_bps integer NOT NULL DEFAULT 5000
    CHECK (copy_batch_return_threshold_bps BETWEEN 1 AND 10000);

ALTER TABLE tasks ADD COLUMN copy_qa_cycle integer NOT NULL DEFAULT 0 CHECK (copy_qa_cycle >= 0);
ALTER TABLE tasks ADD COLUMN copy_qa_rework_pending boolean NOT NULL DEFAULT false;
UPDATE tasks SET copy_qa_rework_pending=true,mandatory_copy_qc=false,mandatory_copy_qc_origin=NULL
WHERE state='COPY_REVIEW_PENDING' AND mandatory_copy_qc_origin='QA_RETURN';
UPDATE tasks AS task SET copy_qa_cycle = (
  SELECT count(*)::integer FROM task_reassignment_cases AS reassignment
  WHERE reassignment.task_id = task.id AND reassignment.status = 'REASSIGNED'
);

CREATE TABLE copy_qa_batches_v2 (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('PERSONAL_AUTO','PERSONAL_MANUAL','MIXED_MANUAL','SYSTEM_MIGRATION')),
  account_id bigint,
  legacy_freeze_id bigint UNIQUE,
  full_inspection boolean NOT NULL DEFAULT false,
  blind_review_enabled boolean NOT NULL DEFAULT false,
  sampling_rate_bps integer CHECK (sampling_rate_bps BETWEEN 0 AND 10000),
  return_threshold_bps integer NOT NULL CHECK (return_threshold_bps BETWEEN 1 AND 10000),
  return_trigger_count integer NOT NULL CHECK (return_trigger_count >= 0),
  member_count integer NOT NULL CHECK (member_count > 0),
  sample_count integer NOT NULL CHECK (sample_count >= 0 AND sample_count <= member_count),
  status text NOT NULL DEFAULT 'INSPECTING' CHECK (status IN ('INSPECTING','COMPLETED','AUTO_RETURNED')),
  created_by_account_id bigint,
  request_id uuid,
  request_fingerprint char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  CHECK ((mode IN ('PERSONAL_AUTO','PERSONAL_MANUAL')) = (account_id IS NOT NULL))
);
CREATE UNIQUE INDEX copy_qa_batches_v2_request_idx ON copy_qa_batches_v2(created_by_account_id,request_id)
  WHERE created_by_account_id IS NOT NULL AND request_id IS NOT NULL;

CREATE TABLE copy_qa_decision_requests_v2 (
  reviewer_account_id bigint NOT NULL,
  request_id uuid NOT NULL,
  fingerprint char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(reviewer_account_id,request_id)
);

CREATE TABLE copy_qa_batch_members_v2 (
  id bigserial PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  batch_id bigint NOT NULL REFERENCES copy_qa_batches_v2(id),
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  approval_event_id bigint NOT NULL REFERENCES copy_approval_events(id) ON DELETE CASCADE,
  approver_account_id bigint NOT NULL,
  quality_cycle integer NOT NULL,
  content_sha256 char(64) NOT NULL,
  selected boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','NOT_SELECTED','PASSED','RETURNED','BATCH_AFFECTED','RELEASED','SUPERSEDED')),
  reviewed_by_account_id bigint,
  reason_codes text[] NOT NULL DEFAULT '{}',
  reason_snapshots jsonb NOT NULL DEFAULT '[]',
  note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,copy_revision_id),
  UNIQUE(batch_id,task_id)
);
CREATE INDEX copy_qa_batch_members_v2_pending_idx ON copy_qa_batch_members_v2(batch_id,id)
  WHERE status IN ('PENDING','NOT_SELECTED');

CREATE TABLE copy_qa_return_events_v2 (
  id bigserial PRIMARY KEY,
  task_id bigint NOT NULL,
  quality_cycle integer NOT NULL,
  member_id bigint UNIQUE REFERENCES copy_qa_batch_members_v2(id),
  legacy_item_id bigint UNIQUE,
  kind text NOT NULL CHECK (kind IN ('DIRECT','BATCH_AFFECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((member_id IS NULL) <> (legacy_item_id IS NULL))
);
CREATE INDEX copy_qa_return_events_v2_cycle_idx ON copy_qa_return_events_v2(task_id,quality_cycle,id);

ALTER TABLE task_reassignment_cases
  ALTER COLUMN source_item_id DROP NOT NULL,
  ALTER COLUMN source_freeze_id DROP NOT NULL,
  ADD COLUMN source_copy_qa_member_v2_id bigint UNIQUE REFERENCES copy_qa_batch_members_v2(id) ON DELETE SET NULL;

INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,legacy_item_id,kind,created_at)
SELECT item.task_id,
  (SELECT count(*)::integer FROM task_reassignment_cases AS reassignment
   WHERE reassignment.task_id = item.task_id AND reassignment.status = 'REASSIGNED'
     AND reassignment.disposed_at <= COALESCE(item.reviewed_at,item.updated_at)),
  item.id, CASE WHEN item.status = 'RETURNED' THEN 'DIRECT' ELSE 'BATCH_AFFECTED' END,
  COALESCE(item.reviewed_at,item.updated_at)
FROM copy_sampling_items AS item
WHERE item.status IN ('RETURNED','BATCH_AFFECTED','BATCH_RETURNED');

UPDATE tasks AS task SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
  copy_qc_released_revision_id = task.current_copy_revision_id,
  mandatory_copy_qc = false, mandatory_copy_qc_origin = NULL,
  progress_message = '历史文案质检已通过，等待生图', updated_at = now()
WHERE task.state = 'COPY_QC_PENDING'
  AND EXISTS (SELECT 1 FROM copy_sampling_items AS item WHERE item.task_id = task.id
    AND item.copy_revision_id = task.current_copy_revision_id AND item.status = 'PASSED');

INSERT INTO copy_qa_batches_v2(mode,account_id,legacy_freeze_id,full_inspection,blind_review_enabled,sampling_rate_bps,
  return_threshold_bps,return_trigger_count,member_count,sample_count)
SELECT 'SYSTEM_MIGRATION',NULL,legacy_freeze.id,false,legacy_freeze.blind_review_enabled,legacy_freeze.rate_bps,
  settings.copy_batch_return_threshold_bps,
  GREATEST(1,ceil(count(*) FILTER (WHERE item.status = 'PENDING')
    * settings.copy_batch_return_threshold_bps / 10000.0)::integer),
  count(*)::integer,
  count(*) FILTER (WHERE item.status = 'PENDING')::integer
FROM copy_sampling_freezes AS legacy_freeze
JOIN copy_sampling_items AS item ON item.freeze_id = legacy_freeze.id
JOIN tasks AS task ON task.id = item.task_id AND task.state = 'COPY_QC_PENDING'
  AND task.current_copy_revision_id = item.copy_revision_id
CROSS JOIN workflow_quality_settings AS settings
WHERE item.status IN ('PENDING','NOT_SELECTED')
GROUP BY legacy_freeze.id,legacy_freeze.rate_bps,legacy_freeze.blind_review_enabled,settings.copy_batch_return_threshold_bps;

INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,copy_revision_id,approval_event_id,
  approver_account_id,quality_cycle,content_sha256,selected,status)
SELECT batch.id,item.task_id,item.copy_revision_id,item.approval_event_id,
  COALESCE(approval.approved_by_account_id,item.final_approver_account_id),
  task.copy_qa_cycle,item.content_sha256,item.selected,item.status
FROM copy_qa_batches_v2 AS batch
JOIN copy_sampling_items AS item ON item.freeze_id = batch.legacy_freeze_id
JOIN copy_approval_events AS approval ON approval.id=item.approval_event_id
JOIN tasks AS task ON task.id = item.task_id AND task.state = 'COPY_QC_PENDING'
  AND task.current_copy_revision_id = item.copy_revision_id
WHERE item.status IN ('PENDING','NOT_SELECTED');

CREATE VIEW copy_qa_v2_migration_report AS
SELECT (SELECT count(*) FROM copy_qa_batches_v2 WHERE mode='SYSTEM_MIGRATION') AS system_batches,
  (SELECT count(*) FROM copy_qa_batch_members_v2) AS imported_members,
  (SELECT count(*) FROM copy_qa_return_events_v2 WHERE legacy_item_id IS NOT NULL) AS legacy_returns;

-- A migrated freeze with no sampled pending items can release immediately.
UPDATE tasks AS task SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
  copy_qc_released_revision_id=task.current_copy_revision_id,
  mandatory_copy_qc=false,mandatory_copy_qc_origin=NULL,
  progress_message='历史批次无需抽检，等待生图',updated_at=now()
FROM copy_qa_batch_members_v2 AS member
JOIN copy_qa_batches_v2 AS batch ON batch.id=member.batch_id
WHERE member.task_id=task.id AND member.status='NOT_SELECTED' AND batch.sample_count=0;
UPDATE copy_qa_batch_members_v2 AS member SET status='RELEASED'
FROM copy_qa_batches_v2 AS batch WHERE member.batch_id=batch.id AND batch.sample_count=0;
UPDATE copy_qa_batches_v2 SET status='COMPLETED',completed_at=now()
WHERE sample_count=0;

CREATE OR REPLACE FUNCTION copy_quality_image_eligible(task_id_arg bigint,revision_id_arg bigint,mandatory_arg boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage(revision_id,depth) AS (
    SELECT revision_id_arg,0
    UNION ALL
    SELECT inheritance.source_revision_id,lineage.depth+1 FROM lineage
      JOIN copy_qc_revision_inheritances AS inheritance
        ON inheritance.target_revision_id=lineage.revision_id
       AND inheritance.task_id=task_id_arg WHERE lineage.depth<100
  )
  SELECT NOT mandatory_arg
    AND EXISTS (SELECT 1 FROM copy_revisions AS revision
      WHERE revision.id=revision_id_arg AND revision.task_id=task_id_arg
        AND revision.approved_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=task_id_arg AND state='PENDING_SECOND_ASSIGNMENT')
    AND NOT EXISTS (SELECT 1 FROM copy_qa_batch_members_v2 AS member
      WHERE member.task_id=task_id_arg AND member.copy_revision_id=revision_id_arg
        AND member.status NOT IN ('PASSED','RELEASED'))
    AND (NOT EXISTS (SELECT 1 FROM copy_qa_batch_members_v2 AS member WHERE member.task_id=task_id_arg)
      OR EXISTS (SELECT 1 FROM lineage JOIN copy_qa_batch_members_v2 AS member
        ON member.copy_revision_id=lineage.revision_id AND member.task_id=task_id_arg
        WHERE member.status IN ('PASSED','RELEASED'))
      OR EXISTS (SELECT 1 FROM tasks WHERE id=task_id_arg
        AND copy_qc_released_revision_id=revision_id_arg));
$$;

CREATE OR REPLACE FUNCTION invalidate_copy_quality_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inherits_copy_release boolean := false;
BEGIN
  IF NEW.current_copy_revision_id IS DISTINCT FROM OLD.current_copy_revision_id THEN
    SELECT EXISTS (
      SELECT 1 FROM copy_qc_revision_inheritances AS inheritance
      WHERE inheritance.task_id = NEW.id
        AND inheritance.target_revision_id = NEW.current_copy_revision_id
        AND inheritance.source_revision_id = OLD.current_copy_revision_id
    ) INTO inherits_copy_release;

    IF NOT inherits_copy_release
      AND NEW.state = 'IMAGE_QUEUED'
      AND NOT NEW.mandatory_copy_qc
      AND OLD.state IN ('MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED')
      AND OLD.copy_qc_released_revision_id = OLD.current_copy_revision_id
      AND copy_quality_image_eligible(OLD.id, OLD.current_copy_revision_id, false) THEN
      INSERT INTO copy_qc_revision_inheritances(
        target_revision_id, task_id, source_revision_id,
        inherited_by_username, reason
      )
      SELECT target.id, OLD.id, source.id,
        left(COALESCE(NULLIF(target.content #>> '{imageRevision,actorUsername}', ''), 'system'), 50),
        'IMAGE_PLAN_RETRY'
      FROM copy_revisions AS target
      JOIN copy_revisions AS source ON source.id = OLD.current_copy_revision_id
        AND source.task_id = OLD.id
      WHERE target.id = NEW.current_copy_revision_id
        AND target.task_id = OLD.id
        AND target.parent_revision_id = source.id
        AND target.revision_origin = 'PLAN_EDIT'
        AND target.approved_at IS NOT NULL
        AND target.content #>> '{imageRevision,operation}' IN ('REGENERATE', 'REPROCESS')
        AND target.content #>> '{imageRevision,baseRevisionId}' = source.id::text
        AND copy_revision_copy_payload(target.content) = copy_revision_copy_payload(source.content)
      ON CONFLICT (target_revision_id) DO NOTHING;

      SELECT EXISTS (
        SELECT 1 FROM copy_qc_revision_inheritances AS inheritance
        WHERE inheritance.task_id = NEW.id
          AND inheritance.target_revision_id = NEW.current_copy_revision_id
          AND inheritance.source_revision_id = OLD.current_copy_revision_id
      ) INTO inherits_copy_release;
    END IF;

    IF inherits_copy_release AND NOT NEW.mandatory_copy_qc AND NEW.state = 'IMAGE_QUEUED' THEN
      NEW.copy_qc_released_revision_id := NEW.current_copy_revision_id;
    ELSIF NEW.state = 'IMAGE_QUEUED' AND NOT NEW.mandatory_copy_qc
      AND NEW.copy_qc_released_revision_id = NEW.current_copy_revision_id THEN
      NULL;
    ELSE
      NEW.copy_qc_released_revision_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
