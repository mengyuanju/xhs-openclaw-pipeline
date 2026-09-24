-- Accept the new copy QA discard labels while preserving historical reason codes.
ALTER TABLE copy_qa_dispositions_v2
  DROP CONSTRAINT copy_qa_dispositions_v2_reason_code_check;

ALTER TABLE copy_qa_dispositions_v2
  ADD CONSTRAINT copy_qa_dispositions_v2_reason_code_check
  CHECK (reason_code IN (
    'UNRECOVERABLE_QUALITY','REWORK_COST_TOO_HIGH','MISSING_SOURCE_MATERIAL','OTHER',
    'SHALLOW_CONTENT','DISORGANIZED_LOGIC','OFF_TOPIC'));
