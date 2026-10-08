-- JSON predicates otherwise use a 0.005 null selectivity even when every fact
-- has no exclusion, producing catastrophic estimates for complete history CTEs.
CREATE STATISTICS operator_performance_reporting_json_stats
  ON (data->>'exclusion'),(data->>'batchId'),kind,stage,account_id
  FROM operator_performance_events;
CREATE STATISTICS quality_review_reporting_json_stats
  ON (data->>'exclusion'),(data->>'batchId'),kind,stage,account_id
  FROM quality_review_activity_events;
CREATE STATISTICS account_quality_reporting_json_stats
  ON (data->>'exclusion'),(data->>'batchId'),action,stage,account_id
  FROM account_quality_events;
ANALYZE operator_performance_events;
ANALYZE quality_review_activity_events;
ANALYZE account_quality_events;
