-- Generated glyph references and local patches survive retries and are visible
-- while a text repair is running. They are separate from operator uploads.
ALTER TABLE image_edit_requests
  DROP CONSTRAINT image_edit_requests_operation_check,
  ADD CONSTRAINT image_edit_requests_operation_check
    CHECK(operation IN ('TEXT','SVG_DISCLOSURE','COMPOSITE','AI_FUSION','AI_FULL','AI_LOCAL','AI_TEXT_REPAIR','RESTORE')),
  ADD COLUMN text_repair_state jsonb NOT NULL DEFAULT '{}';
