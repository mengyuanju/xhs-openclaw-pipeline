-- Keep model-generated disclosure edits and add a deterministic SVG + Sharp option.
ALTER TABLE image_edit_requests
  DROP CONSTRAINT image_edit_requests_operation_check,
  ADD CONSTRAINT image_edit_requests_operation_check
    CHECK(operation IN ('TEXT','SVG_DISCLOSURE','COMPOSITE','AI_FUSION','AI_FULL','AI_LOCAL','RESTORE'));
