-- Derived facts, not summed percentages/distinct counts/medians. Source changes
-- only fence the affected task. Exact SQL is retained while a task is dirty.
CREATE TABLE report_projection_tasks (
  task_id bigint PRIMARY KEY,revision bigint NOT NULL DEFAULT 1,
  projected_revision bigint NOT NULL DEFAULT 0,
  CHECK(revision>0 AND projected_revision>=0 AND projected_revision<=revision)
);
CREATE INDEX report_projection_dirty_idx ON report_projection_tasks(task_id) WHERE revision<>projected_revision;
CREATE TABLE report_operator_event_context (
  event_key text PRIMARY KEY,task_id bigint NOT NULL,source_revision bigint NOT NULL,
  sample_selected boolean,previous_submitted_at timestamptz,returned_at timestamptz,
  timing jsonb
);
CREATE INDEX report_operator_context_task_idx ON report_operator_event_context(task_id);
CREATE TABLE report_annotation_assignment_history (
  task_id bigint PRIMARY KEY,source_revision bigint NOT NULL,
  max_occurred_at timestamptz,history jsonb NOT NULL
);

CREATE FUNCTION invalidate_report_query_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO report_projection_tasks(task_id) SELECT DISTINCT task_id FROM new_projection_rows
    ON CONFLICT(task_id) DO UPDATE SET revision=report_projection_tasks.revision+1;
  ELSIF TG_OP='DELETE' THEN
    INSERT INTO report_projection_tasks(task_id) SELECT DISTINCT task_id FROM old_projection_rows
    ON CONFLICT(task_id) DO UPDATE SET revision=report_projection_tasks.revision+1;
  ELSE
    INSERT INTO report_projection_tasks(task_id) SELECT task_id FROM new_projection_rows UNION SELECT task_id FROM old_projection_rows
    ON CONFLICT(task_id) DO UPDATE SET revision=report_projection_tasks.revision+1;
  END IF;
  RETURN NULL;
END $$;
DO $$
DECLARE source_name text;
BEGIN
  FOREACH source_name IN ARRAY ARRAY['operator_performance_events','operator_stage_events','task_assignment_events','task_assignment_records'] LOOP
    EXECUTE format('CREATE TRIGGER report_projection_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate_report_query_projection()',source_name);
    EXECUTE format('CREATE TRIGGER report_projection_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate_report_query_projection()',source_name);
    EXECUTE format('CREATE TRIGGER report_projection_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION invalidate_report_query_projection()',source_name);
  END LOOP;
END $$;

-- Assignment events resolve historical usernames against account creation.
-- Display-name/status/password changes do not change those canonical cycles.
CREATE FUNCTION invalidate_report_projection_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO report_projection_tasks(task_id)
    SELECT DISTINCT task_id FROM task_assignment_events WHERE assignee_user_id IN(NEW.username,OLD.username)
      OR previous_assignee_user_id IN(NEW.username,OLD.username)
  ON CONFLICT(task_id) DO UPDATE SET revision=report_projection_tasks.revision+1;
  RETURN NULL;
END $$;
CREATE TRIGGER report_projection_identity AFTER UPDATE OF username,created_at,id ON app_users
  FOR EACH ROW WHEN(NEW.username IS DISTINCT FROM OLD.username OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.id IS DISTINCT FROM OLD.id)
  EXECUTE FUNCTION invalidate_report_projection_identity();
CREATE TRIGGER report_projection_identity_membership AFTER INSERT OR DELETE ON app_users
  FOR EACH ROW EXECUTE FUNCTION invalidate_report_projection_identity();

CREATE FUNCTION refresh_report_query_projections(p_task_ids bigint[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM report_operator_event_context WHERE task_id=ANY(p_task_ids);
  INSERT INTO report_operator_event_context(event_key,task_id,source_revision,sample_selected,previous_submitted_at,returned_at,timing)
  SELECT e.event_key,e.task_id,revision.revision,
    (SELECT bool_or(s.data->>'selected'='true') FROM operator_performance_events s WHERE s.task_id=e.task_id AND s.stage=e.stage
      AND s.kind='SAMPLE' AND s.data->>'sampleKind'='RANDOM' AND s.data->>'approvalId'=e.data->>'approvalId'),
    previous.occurred_at,
    (SELECT max(r.occurred_at) FROM operator_performance_events r WHERE r.task_id=e.task_id
      AND r.occurred_at<e.occurred_at AND (previous.occurred_at IS NULL OR r.occurred_at>=previous.occurred_at)
      AND (r.kind IN('RETURN','BATCH_RETURN') OR r.kind='QUALITY' AND r.data->>'outcome'='RETURN')
      AND coalesce(r.data->>'target',r.stage) IN(e.stage,'BOTH')),
    CASE WHEN e.kind='SUBMIT' AND coalesce(e.data->>'exclusion','')='' AND e.account_id IS NOT NULL THEN
      jsonb_build_object('humanMs',timing.human_ms,'backgroundMs',timing.background_ms,'qualityWaitMs',timing.quality_wait_ms,'reason',timing.reason) END
  FROM operator_performance_events e JOIN report_projection_tasks revision ON revision.task_id=e.task_id
  LEFT JOIN LATERAL(SELECT occurred_at FROM operator_performance_events p WHERE p.task_id=e.task_id AND p.stage=e.stage
    AND p.kind='SUBMIT' AND p.data->>'exclusion' IS NULL AND (p.occurred_at,p.sequence_id)<(e.occurred_at,e.sequence_id)
    ORDER BY p.occurred_at DESC,p.sequence_id DESC LIMIT 1) previous ON e.kind='SUBMIT'
  LEFT JOIN LATERAL (
    SELECT CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
        covering.occurred_at>coalesce(previous.occurred_at,'-infinity'::timestamptz)
      THEN NULL ELSE sum(elapsed.ms) FILTER(WHERE segment.stage=e.stage AND segment.account_id=e.account_id AND segment.phase='HUMAN' AND elapsed.ms>0) END AS human_ms,
      CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
        covering.occurred_at>coalesce(previous.occurred_at,'-infinity'::timestamptz)
      THEN NULL ELSE coalesce(sum(elapsed.ms) FILTER(WHERE segment.stage=e.stage AND segment.phase IN('BACKGROUND','MACHINE_QUEUE','MACHINE_RUNNING')),0) END AS background_ms,
      CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL OR covering.baseline AND
        covering.occurred_at>coalesce(previous.occurred_at,'-infinity'::timestamptz)
      THEN NULL ELSE coalesce(sum(elapsed.ms) FILTER(WHERE segment.stage=e.stage AND segment.phase='QUALITY_WAIT'),0) END AS quality_wait_ms,
      CASE WHEN bounds.starts_at IS NULL OR covering.id IS NULL THEN 'UNKNOWN_START'
        WHEN covering.baseline AND covering.occurred_at>coalesce(previous.occurred_at,'-infinity'::timestamptz) THEN 'UNKNOWN_START'
        WHEN count(*) FILTER(WHERE segment.stage=e.stage AND segment.account_id=e.account_id AND segment.phase='HUMAN' AND elapsed.ms>0)=0 THEN 'NO_OWN_INTERVAL' END AS reason
    FROM LATERAL(SELECT coalesce(previous.occurred_at,(SELECT occurred_at FROM operator_stage_events first
      WHERE first.task_id=e.task_id AND first.stage=e.stage AND first.occurred_at<=e.occurred_at ORDER BY occurred_at,id LIMIT 1)) AS starts_at) bounds
    LEFT JOIN LATERAL(SELECT * FROM operator_stage_events cover WHERE cover.task_id=e.task_id AND cover.occurred_at<=bounds.starts_at
      ORDER BY cover.occurred_at DESC,cover.id DESC LIMIT 1) covering ON true
    LEFT JOIN LATERAL(SELECT event.*,lead(event.occurred_at,1,e.occurred_at) OVER(ORDER BY event.occurred_at,event.id) AS ends_at
      FROM operator_stage_events event WHERE event.task_id=e.task_id AND event.occurred_at<=e.occurred_at) segment ON true
    LEFT JOIN LATERAL(SELECT greatest(0,extract(epoch FROM least(date_trunc('milliseconds',segment.ends_at),date_trunc('milliseconds',e.occurred_at))
      -greatest(date_trunc('milliseconds',segment.occurred_at),date_trunc('milliseconds',bounds.starts_at)))*1000) AS ms) elapsed ON true
    GROUP BY bounds.starts_at,covering.id,covering.baseline,covering.occurred_at
  ) timing ON e.kind='SUBMIT' AND e.account_id IS NOT NULL AND coalesce(e.data->>'exclusion','')=''
  WHERE e.task_id=ANY(p_task_ids);

  DELETE FROM report_annotation_assignment_history WHERE task_id=ANY(p_task_ids);
  INSERT INTO report_annotation_assignment_history(task_id,source_revision,max_occurred_at,history)
  SELECT assignment.task_id,max(revision.revision),max(assignment.occurred_at),
    report_annotation_transitions(jsonb_agg(jsonb_build_object('id',assignment.id,'order',assignment.ordering,'kind',assignment.kind,
      'accountId',assignment.account_id,'username',assignment.username,'previousAccountId',assignment.previous_account_id,
      'previousUsername',assignment.previous_username,'atMs',(extract(epoch FROM date_trunc('milliseconds',assignment.occurred_at))*1000)::bigint,
      'endMs',(extract(epoch FROM date_trunc('milliseconds',assignment.ended_at))*1000)::bigint,'baseline',assignment.baseline)
      ORDER BY assignment.occurred_at,assignment.ordering))
  FROM (
    SELECT 'event:'||event.id AS id,event.id AS ordering,event.task_id,'EVENT'::text AS kind,
      current_actor.id AS account_id,event.assignee_user_id AS username,event.created_at AS occurred_at,
      previous_actor.id AS previous_account_id,event.previous_assignee_user_id AS previous_username,
      NULL::timestamptz AS ended_at,false AS baseline
    FROM task_assignment_events event
    LEFT JOIN app_users current_actor ON current_actor.username=event.assignee_user_id AND current_actor.created_at<=event.created_at
    LEFT JOIN app_users previous_actor ON previous_actor.username=event.previous_assignee_user_id AND previous_actor.created_at<=event.created_at
    WHERE event.task_id=ANY(p_task_ids)
    UNION ALL SELECT 'record:'||record.id,record.id,record.task_id,'RECORD',record.assignee_account_id,
      record.assignee_username_snapshot,record.assigned_at,NULL::bigint,NULL::text,record.ended_at,(record.baseline OR record.source='MIGRATION_BASELINE')
    FROM task_assignment_records record WHERE record.task_id=ANY(p_task_ids)
  ) assignment JOIN report_projection_tasks revision ON revision.task_id=assignment.task_id
  GROUP BY assignment.task_id;
  UPDATE report_projection_tasks SET projected_revision=revision WHERE task_id=ANY(p_task_ids);
END $$;

INSERT INTO report_projection_tasks(task_id)
  SELECT task_id FROM operator_performance_events
  UNION SELECT task_id FROM task_assignment_events UNION SELECT task_id FROM task_assignment_records;
-- Bounded set-based batches also keep the initial backfill parameter size small.
SELECT refresh_report_query_projections(ids) FROM (
  SELECT array_agg(task_id ORDER BY task_id) AS ids FROM report_projection_tasks GROUP BY task_id/1000
) batches;
