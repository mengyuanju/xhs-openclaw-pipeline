-- Complete the exact early 0082 draft without changing its recorded checksum.
-- Reinstall the canonical check for both draft and finalized databases; existing
-- rows are validated in the same transaction and are never rewritten.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS standalone_image_workspace_state;
ALTER TABLE tasks ADD CONSTRAINT standalone_image_workspace_state CHECK (
  task_kind <> 'STANDALONE_IMAGE_EDIT' OR (
    state='MANUAL_ARCHIVE' AND current_execution_id IS NULL AND production_batch_id IS NULL
    AND mandatory_copy_qc=false AND mandatory_image_qc=false
  )
);
