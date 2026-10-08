CREATE TABLE copy_qa_inspection_records (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  copy_revision_id bigint NOT NULL REFERENCES copy_revisions(id) ON DELETE CASCADE,
  approval_event_id bigint REFERENCES copy_approval_events(id) ON DELETE CASCADE,
  qa_method text NOT NULL CHECK (qa_method IN ('SYSTEM', 'HUMAN')),
  passed boolean NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS', 'RETURN', 'DISCARD')),
  reviewer_account_id bigint,
  reviewer_username varchar(50) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (passed = (verdict = 'PASS')),
  CHECK (qa_method = 'HUMAN' OR (passed AND reviewer_account_id IS NULL))
);

CREATE INDEX copy_qa_inspection_records_current_idx
  ON copy_qa_inspection_records(task_id, copy_revision_id, recorded_at DESC, id DESC);

-- Preserve system passes recorded before the inspection ledger existed.
INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, passed, verdict, reviewer_username, recorded_at)
SELECT 'account-default:' || task.id || ':' || task.copy_qa_auto_passed_revision_id,
  task.id, task.copy_qa_auto_passed_revision_id, approval.id,
  'SYSTEM', true, 'PASS', 'system', COALESCE(approval.approved_at, task.updated_at)
FROM tasks AS task
LEFT JOIN copy_approval_events AS approval
  ON approval.task_id = task.id AND approval.copy_revision_id = task.copy_qa_auto_passed_revision_id
WHERE task.copy_qa_auto_passed_revision_id IS NOT NULL;

INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, passed, verdict, reviewer_account_id,
  reviewer_username, recorded_at)
SELECT 'v2:' || member.id, member.task_id, member.copy_revision_id,
  member.approval_event_id, 'HUMAN', member.status = 'PASSED',
  CASE WHEN member.status = 'PASSED' THEN 'PASS'
    WHEN member.status = 'DISCARDED' THEN 'DISCARD' ELSE 'RETURN' END,
  member.reviewed_by_account_id, COALESCE(reviewer.username, '历史质检员'),
  COALESCE(member.decided_at, member.created_at)
FROM copy_qa_batch_members_v2 AS member
LEFT JOIN app_users AS reviewer ON reviewer.id = member.reviewed_by_account_id
WHERE member.status IN ('PASSED', 'RETURNED', 'DISCARDED')
  AND member.reviewed_by_account_id IS NOT NULL;

INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
  approval_event_id, qa_method, passed, verdict, reviewer_account_id,
  reviewer_username, recorded_at)
SELECT 'legacy:' || item.id, item.task_id, item.copy_revision_id,
  item.approval_event_id, 'HUMAN', item.status = 'PASSED',
  CASE WHEN item.status = 'PASSED' THEN 'PASS' ELSE 'RETURN' END,
  item.reviewed_by_account_id,
  COALESCE(item.reviewed_by_username, reviewer.username, '历史质检员'),
  COALESCE(item.reviewed_at, item.created_at)
FROM copy_sampling_items AS item
LEFT JOIN app_users AS reviewer ON reviewer.id = item.reviewed_by_account_id
WHERE item.status IN ('PASSED', 'RETURNED')
  AND (item.reviewed_by_account_id IS NOT NULL OR item.reviewed_by_username IS NOT NULL);

CREATE FUNCTION record_copy_qa_v2_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PASSED', 'RETURNED', 'DISCARDED')
    OR NEW.reviewed_by_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
    approval_event_id, qa_method, passed, verdict, reviewer_account_id,
    reviewer_username, recorded_at)
  SELECT 'v2:' || NEW.id, NEW.task_id, NEW.copy_revision_id,
    NEW.approval_event_id, 'HUMAN', NEW.status = 'PASSED',
    CASE WHEN NEW.status = 'PASSED' THEN 'PASS'
      WHEN NEW.status = 'DISCARDED' THEN 'DISCARD' ELSE 'RETURN' END,
    NEW.reviewed_by_account_id, COALESCE(reviewer.username, '历史质检员'),
    COALESCE(NEW.decided_at, now())
  FROM (SELECT 1) AS one
  LEFT JOIN app_users AS reviewer ON reviewer.id = NEW.reviewed_by_account_id
  ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER copy_qa_v2_inspection_record
  AFTER INSERT OR UPDATE ON copy_qa_batch_members_v2
  FOR EACH ROW EXECUTE FUNCTION record_copy_qa_v2_inspection();

CREATE FUNCTION record_copy_qa_legacy_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PASSED', 'RETURNED')
    OR (NEW.reviewed_by_account_id IS NULL AND NEW.reviewed_by_username IS NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO copy_qa_inspection_records(source_key, task_id, copy_revision_id,
    approval_event_id, qa_method, passed, verdict, reviewer_account_id,
    reviewer_username, recorded_at)
  SELECT 'legacy:' || NEW.id, NEW.task_id, NEW.copy_revision_id,
    NEW.approval_event_id, 'HUMAN', NEW.status = 'PASSED',
    CASE WHEN NEW.status = 'PASSED' THEN 'PASS' ELSE 'RETURN' END,
    NEW.reviewed_by_account_id,
    COALESCE(NEW.reviewed_by_username, reviewer.username, '历史质检员'),
    COALESCE(NEW.reviewed_at, now())
  FROM (SELECT 1) AS one
  LEFT JOIN app_users AS reviewer ON reviewer.id = NEW.reviewed_by_account_id
  ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER copy_qa_legacy_inspection_record
  AFTER INSERT OR UPDATE ON copy_sampling_items
  FOR EACH ROW EXECUTE FUNCTION record_copy_qa_legacy_inspection();
