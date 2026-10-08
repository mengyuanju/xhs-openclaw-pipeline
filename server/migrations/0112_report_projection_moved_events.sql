-- A corrected event can move between tasks. A target task may be processed
-- before the previous task (which may be SKIP LOCKED in another transaction).
-- Retire the old derived key first, then run the unchanged projection builder.
ALTER FUNCTION refresh_report_query_projections(bigint[]) RENAME TO refresh_report_query_projections_base;
CREATE FUNCTION refresh_report_query_projections(p_task_ids bigint[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM report_operator_event_context WHERE task_id<>ALL(p_task_ids)
    AND event_key IN(SELECT event_key FROM operator_performance_events WHERE task_id=ANY(p_task_ids));
  PERFORM refresh_report_query_projections_base(p_task_ids);
END $$;
