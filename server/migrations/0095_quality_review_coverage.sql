-- Member-level workflow coverage is separate from actual reviewer verdicts.
-- No content/user foreign keys: deletion or reassignment must not erase work.
CREATE TABLE quality_review_coverage_events (
  event_key text PRIMARY KEY,
  account_id bigint,
  task_id bigint NOT NULL,
  stage text NOT NULL CHECK(stage IN ('COPY','IMAGE')),
  review_item_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('BATCH_RETURN','BATCH_RELEASE')),
  occurred_at timestamptz NOT NULL,
  operation_key text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX quality_coverage_account_time_idx
  ON quality_review_coverage_events(account_id,occurred_at,stage);
CREATE INDEX quality_coverage_operation_idx
  ON quality_review_coverage_events(operation_key);
CREATE INDEX account_quality_affected_reviewer_time_idx
  ON account_quality_events((data->>'reviewerId'),occurred_at)
  WHERE data->>'source'='BATCH_AFFECTED' AND action='RETURN';
