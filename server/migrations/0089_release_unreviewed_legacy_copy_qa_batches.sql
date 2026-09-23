-- An old frozen item was imported into a one-item system batch by 0088.
-- Only untouched system batches can be returned to the new candidate pool.
-- Reviewed batches retain their history and status.
CREATE TEMP TABLE copy_qa_legacy_batches_to_release ON COMMIT DROP AS
SELECT batch.id
FROM copy_qa_batches_v2 AS batch
WHERE batch.mode = 'SYSTEM_MIGRATION'
  AND batch.status = 'INSPECTING'
  AND EXISTS (
    SELECT 1 FROM copy_qa_batch_members_v2 AS member
    WHERE member.batch_id = batch.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM copy_qa_batch_members_v2 AS member
    WHERE member.batch_id = batch.id
      AND member.status NOT IN ('PENDING', 'NOT_SELECTED')
  );

DELETE FROM copy_qa_batch_members_v2 AS member
USING copy_qa_legacy_batches_to_release AS candidate
WHERE member.batch_id = candidate.id;

DELETE FROM copy_qa_batches_v2 AS batch
USING copy_qa_legacy_batches_to_release AS candidate
WHERE batch.id = candidate.id;
