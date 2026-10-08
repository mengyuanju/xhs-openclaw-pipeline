ALTER TABLE copy_qa_inspection_records
  ADD COLUMN decision_mode text;

UPDATE copy_qa_inspection_records
SET decision_mode = CASE WHEN qa_method = 'SYSTEM' THEN 'ACCOUNT_DEFAULT' ELSE 'HUMAN_REVIEW' END;

ALTER TABLE copy_qa_inspection_records
  ALTER COLUMN decision_mode SET NOT NULL,
  ADD CONSTRAINT copy_qa_inspection_decision_mode_check
    CHECK (decision_mode IN ('ACCOUNT_DEFAULT', 'HUMAN_REVIEW', 'BATCH_RELEASE', 'ADMIN_DIRECT')),
  ADD CONSTRAINT copy_qa_inspection_method_mode_check
    CHECK ((qa_method = 'HUMAN') = (decision_mode IN ('HUMAN_REVIEW', 'ADMIN_DIRECT')));

-- A batch release is a recorded system outcome, distinct from an actual inspection.
INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, decision_mode, passed, verdict,
  reviewer_username, recorded_at)
SELECT 'v2:' || member.id, member.task_id, member.copy_revision_id,
  member.approval_event_id, 'SYSTEM', 'BATCH_RELEASE', true, 'PASS',
  'system', COALESCE(batch.completed_at, member.decided_at, member.created_at)
FROM copy_qa_batch_members_v2 AS member
JOIN copy_qa_batches_v2 AS batch ON batch.id = member.batch_id
WHERE member.status = 'RELEASED'
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, decision_mode, passed, verdict,
  reviewer_username, recorded_at)
SELECT 'legacy:' || item.id, item.task_id, item.copy_revision_id,
  item.approval_event_id, 'SYSTEM', 'BATCH_RELEASE', true, 'PASS',
  'system', COALESCE(f.resolved_at, item.updated_at, item.created_at)
FROM copy_sampling_items AS item
JOIN copy_sampling_freezes AS f ON f.id = item.freeze_id
WHERE item.status = 'RELEASED'
ON CONFLICT (source_key) DO NOTHING;

-- Older verdicts can lack a reviewer account; preserve their actual outcome too.
INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, decision_mode, passed, verdict,
  reviewer_account_id, reviewer_username, recorded_at)
SELECT 'v2:' || member.id, member.task_id, member.copy_revision_id,
  member.approval_event_id, 'HUMAN', 'HUMAN_REVIEW', member.status = 'PASSED',
  CASE WHEN member.status = 'PASSED' THEN 'PASS'
    WHEN member.status = 'DISCARDED' THEN 'DISCARD' ELSE 'RETURN' END,
  member.reviewed_by_account_id, COALESCE(reviewer.username, '历史质检员'),
  COALESCE(member.decided_at, member.created_at)
FROM copy_qa_batch_members_v2 AS member
LEFT JOIN app_users AS reviewer ON reviewer.id = member.reviewed_by_account_id
WHERE member.status IN ('PASSED', 'RETURNED', 'DISCARDED')
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, decision_mode, passed, verdict,
  reviewer_account_id, reviewer_username, recorded_at)
SELECT 'legacy:' || item.id, item.task_id, item.copy_revision_id,
  item.approval_event_id, 'HUMAN', 'HUMAN_REVIEW', item.status = 'PASSED',
  CASE WHEN item.status = 'PASSED' THEN 'PASS' ELSE 'RETURN' END,
  item.reviewed_by_account_id,
  COALESCE(item.reviewed_by_username, reviewer.username, '历史质检员'),
  COALESCE(item.reviewed_at, item.created_at)
FROM copy_sampling_items AS item
LEFT JOIN app_users AS reviewer ON reviewer.id = item.reviewed_by_account_id
WHERE item.status IN ('PASSED', 'RETURNED')
ON CONFLICT (source_key) DO NOTHING;

UPDATE copy_qa_inspection_records AS record
SET decision_mode = 'ADMIN_DIRECT'
FROM copy_sampling_items AS item
JOIN copy_qa_admin_direct_approvals AS direct
  ON direct.approval_event_id = item.approval_event_id
WHERE record.source_key = 'legacy:' || item.id
  AND record.qa_method = 'HUMAN' AND record.passed = true;

CREATE OR REPLACE FUNCTION record_copy_qa_v2_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PASSED', 'RETURNED', 'DISCARDED', 'RELEASED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
    approval_event_id, qa_method, decision_mode, passed, verdict,
    reviewer_account_id, reviewer_username, recorded_at)
  SELECT 'v2:' || NEW.id, NEW.task_id, NEW.copy_revision_id,
    NEW.approval_event_id,
    CASE WHEN NEW.status = 'RELEASED' THEN 'SYSTEM' ELSE 'HUMAN' END,
    CASE WHEN NEW.status = 'RELEASED' THEN 'BATCH_RELEASE' ELSE 'HUMAN_REVIEW' END,
    NEW.status IN ('PASSED', 'RELEASED'),
    CASE WHEN NEW.status IN ('PASSED', 'RELEASED') THEN 'PASS'
      WHEN NEW.status = 'DISCARDED' THEN 'DISCARD' ELSE 'RETURN' END,
    CASE WHEN NEW.status = 'RELEASED' THEN NULL ELSE NEW.reviewed_by_account_id END,
    CASE WHEN NEW.status = 'RELEASED' THEN 'system'
      ELSE COALESCE(reviewer.username, '历史质检员') END,
    CASE WHEN NEW.status = 'RELEASED' THEN now() ELSE COALESCE(NEW.decided_at, now()) END
  FROM (SELECT 1) AS one
  LEFT JOIN app_users AS reviewer ON reviewer.id = NEW.reviewed_by_account_id
  ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION record_copy_qa_legacy_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PASSED', 'RETURNED', 'RELEASED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
    approval_event_id, qa_method, decision_mode, passed, verdict,
    reviewer_account_id, reviewer_username, recorded_at)
  SELECT 'legacy:' || NEW.id, NEW.task_id, NEW.copy_revision_id,
    NEW.approval_event_id,
    CASE WHEN NEW.status = 'RELEASED' THEN 'SYSTEM' ELSE 'HUMAN' END,
    CASE WHEN NEW.status = 'RELEASED' THEN 'BATCH_RELEASE' ELSE 'HUMAN_REVIEW' END,
    NEW.status IN ('PASSED', 'RELEASED'),
    CASE WHEN NEW.status IN ('PASSED', 'RELEASED') THEN 'PASS' ELSE 'RETURN' END,
    CASE WHEN NEW.status = 'RELEASED' THEN NULL ELSE NEW.reviewed_by_account_id END,
    CASE WHEN NEW.status = 'RELEASED' THEN 'system'
      ELSE COALESCE(NEW.reviewed_by_username, reviewer.username, '历史质检员') END,
    CASE WHEN NEW.status = 'RELEASED' THEN now() ELSE COALESCE(NEW.reviewed_at, now()) END
  FROM (SELECT 1) AS one
  LEFT JOIN app_users AS reviewer ON reviewer.id = NEW.reviewed_by_account_id
  ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mark_copy_qa_admin_direct_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE copy_qa_inspection_records AS record
  SET decision_mode = 'ADMIN_DIRECT'
  FROM copy_sampling_items AS item
  WHERE item.approval_event_id = NEW.approval_event_id
    AND item.status = 'PASSED'
    AND record.source_key = 'legacy:' || item.id
    AND record.qa_method = 'HUMAN' AND record.passed = true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER copy_qa_admin_direct_inspection_record
  AFTER INSERT ON copy_qa_admin_direct_approvals
  FOR EACH ROW EXECUTE FUNCTION mark_copy_qa_admin_direct_inspection();
