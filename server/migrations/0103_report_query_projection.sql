-- One current row per task avoids DISTINCT ON over the entire stage history on
-- every personnel report. History remains the source for elapsed-time facts.
CREATE TABLE operator_stage_current (LIKE operator_stage_events INCLUDING DEFAULTS);
ALTER TABLE operator_stage_current ALTER COLUMN id DROP DEFAULT;
ALTER TABLE operator_stage_current ADD PRIMARY KEY (task_id);
CREATE INDEX operator_stage_current_active_idx
  ON operator_stage_current(account_id,stage,task_id) WHERE phase<>'CLOSED';

INSERT INTO operator_stage_current
  SELECT DISTINCT ON(task_id) * FROM operator_stage_events
  ORDER BY task_id,occurred_at DESC,id DESC;

CREATE FUNCTION project_operator_stage_current() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_key bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO operator_stage_current SELECT NEW.*
    ON CONFLICT(task_id) DO UPDATE SET
      id=EXCLUDED.id,account_id=EXCLUDED.account_id,username=EXCLUDED.username,
      stage=EXCLUDED.stage,phase=EXCLUDED.phase,state=EXCLUDED.state,
      occurred_at=EXCLUDED.occurred_at,baseline=EXCLUDED.baseline
    WHERE (EXCLUDED.occurred_at,EXCLUDED.id)>(operator_stage_current.occurred_at,operator_stage_current.id);
    RETURN NEW;
  END IF;
  -- Corrections/deletions are uncommon, but must also preserve latest ordering.
  FOR task_key IN SELECT DISTINCT unnest(CASE WHEN TG_OP='DELETE'
    THEN ARRAY[OLD.task_id] ELSE ARRAY[OLD.task_id,NEW.task_id] END) LOOP
    DELETE FROM operator_stage_current WHERE task_id=task_key;
    INSERT INTO operator_stage_current
      SELECT * FROM operator_stage_events WHERE task_id=task_key
      ORDER BY occurred_at DESC,id DESC LIMIT 1
    ON CONFLICT(task_id) DO UPDATE SET
      id=EXCLUDED.id,account_id=EXCLUDED.account_id,username=EXCLUDED.username,
      stage=EXCLUDED.stage,phase=EXCLUDED.phase,state=EXCLUDED.state,
      occurred_at=EXCLUDED.occurred_at,baseline=EXCLUDED.baseline;
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER project_operator_stage_current
  AFTER INSERT OR UPDATE OR DELETE ON operator_stage_events
  FOR EACH ROW EXECUTE FUNCTION project_operator_stage_current();

CREATE INDEX operator_performance_submit_previous_idx
  ON operator_performance_events(task_id,stage,occurred_at DESC,sequence_id DESC)
  WHERE kind='SUBMIT' AND data->>'exclusion' IS NULL;
CREATE INDEX operator_performance_quality_latest_idx
  ON operator_performance_events(task_id,stage,occurred_at DESC,sequence_id DESC)
  WHERE kind='QUALITY';
CREATE INDEX operator_performance_random_approval_idx
  ON operator_performance_events(task_id,stage,(data->>'approvalId'))
  WHERE kind='SAMPLE' AND data->>'sampleKind'='RANDOM';
CREATE INDEX operator_performance_return_time_idx
  ON operator_performance_events(task_id,occurred_at)
  WHERE kind IN ('RETURN','BATCH_RETURN') OR kind='QUALITY' AND data->>'outcome'='RETURN';

-- Reporting facts may contain legacy/untrusted JSON. Invalid values remain
-- unknown, matching the JavaScript oracle rather than aborting a whole report.
CREATE FUNCTION report_safe_integer(value text) RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE parsed numeric;
BEGIN
  IF value !~ '^[+-]?[0-9]+([.]0+)?$' THEN RETURN NULL; END IF;
  parsed:=value::numeric;
  IF abs(parsed)>9007199254740991 THEN RETURN NULL; END IF;
  RETURN parsed::bigint;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $$;
CREATE FUNCTION report_safe_timestamp(value text) RETURNS timestamptz LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;


-- Statement-level, database-local versions invalidate only reporting sources.
-- Per-backend shards avoid a single counter lock across concurrent writers.
CREATE TABLE report_fact_versions (
  source text NOT NULL, shard smallint NOT NULL CHECK(shard BETWEEN 0 AND 63),
  revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(source,shard)
);
CREATE FUNCTION advance_report_fact_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO report_fact_versions(source,shard) VALUES(TG_TABLE_NAME,pg_backend_pid()%64)
  ON CONFLICT(source,shard) DO UPDATE SET revision=report_fact_versions.revision+1;
  RETURN NULL;
END $$;
DO $$
DECLARE source_name text; columns_sql text;
BEGIN
  FOREACH source_name IN ARRAY ARRAY[
    'operator_performance_events','operator_stage_events','operator_quality_samples',
    'account_quality_records','account_quality_events','quality_review_activity_events','quality_review_coverage_events',
    'app_users','copy_sampling_items','copy_sampling_freezes','copy_qa_batch_members_v2','copy_qa_batches_v2',
    'image_sampling_items','image_sampling_freezes','image_edit_requests','copy_image_plan_regeneration_jobs',
    'task_assignment_events','task_assignment_records','task_reassignment_cases','task_reassignment_assessment_records',
    'human_quality_assessments','copy_approval_events','copy_revisions','image_approval_events','copy_qa_return_events_v2',
    'copy_sampling_events','image_sampling_events','copy_qa_admin_direct_approvals','delivery_entries','delivery_batch_items',
    'delivery_batches','delivery_item_owners','delivery_item_confirmations','delivery_item_download_events',
    'delivery_archive_items','delivery_archive_jobs','copy_return_dispositions','image_task_dispositions'
  ] LOOP
    EXECUTE format('CREATE TRIGGER report_fact_version AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION advance_report_fact_version()',source_name);
  END LOOP;
  -- Ordinary progress writes update updated_at on every heartbeat. They cannot
  -- affect report membership or any metric and must not invalidate the cache.
  SELECT string_agg(quote_ident(column_name),',') INTO columns_sql
  FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks'
    AND column_name NOT IN ('progress_percent','progress_message','updated_at','last_heartbeat_at','last_progress_at',
      'current_stage','last_activity_at');
  EXECUTE format('CREATE TRIGGER report_fact_version_insert_delete AFTER INSERT OR DELETE ON tasks FOR EACH STATEMENT EXECUTE FUNCTION advance_report_fact_version()');
  EXECUTE format('CREATE TRIGGER report_fact_version_update AFTER UPDATE OF %s ON tasks FOR EACH STATEMENT EXECUTE FUNCTION advance_report_fact_version()',columns_sql);
END $$;

CREATE FUNCTION report_valid_task_ids(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value)='array' THEN NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(value) item WHERE jsonb_typeof(item)<>'number'
      OR coalesce(report_safe_integer(item#>>'{}'),0)<=0) ELSE false END
$$;

-- Exact handoff canonicalization, scoped to the task histories selected by a
-- report. It mirrors annotateAssignmentCycles, including migration baselines,
-- duplicate record/event owners and clock-late ends of replaced assignments.
CREATE FUNCTION report_annotation_canonical(rows_input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; previous jsonb; canonical jsonb:='[]'; positions jsonb:='{}'; same_owner boolean;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(rows_input)
    ORDER BY (value->>'atMs')::bigint,coalesce((value->>'priority')::integer,0),coalesce((value->>'order')::bigint,0) LOOP
    previous:=canonical->(jsonb_array_length(canonical)-1);
    same_owner:=CASE WHEN previous->>'accountId' IS NOT NULL AND item->>'accountId' IS NOT NULL
      THEN previous->>'accountId'=item->>'accountId'
      ELSE coalesce(previous->>'username','')<>'' AND previous->>'username'=item->>'username' END;
    IF previous IS NULL OR NOT(coalesce(same_owner,false) OR
      previous->>'accountId' IS NULL AND coalesce(previous->>'username','')=''
      AND item->>'accountId' IS NULL AND coalesce(item->>'username','')='') THEN
      canonical:=canonical||jsonb_build_array(item);
    END IF;
    positions:=positions||jsonb_build_object(item->>'id',jsonb_array_length(canonical)-1);
    IF item->>'sourceRecordId' IS NOT NULL THEN
      positions:=positions||jsonb_build_object(item->>'sourceRecordId',jsonb_array_length(canonical)-1);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('rows',canonical,'positions',positions);
END $$;

CREATE FUNCTION report_annotation_transitions(assignments jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; first_event jsonb; baseline_record jsonb; transitions jsonb:='[]'; starts jsonb;
  start_position integer; end_position integer;
BEGIN
  SELECT value INTO first_event FROM jsonb_array_elements(assignments)
    WHERE value->>'kind'='EVENT' ORDER BY (value->>'atMs')::bigint,(value->>'order')::bigint LIMIT 1;
  IF first_event->>'previousAccountId' IS NOT NULL OR coalesce(first_event->>'previousUsername','')<>'' THEN
    transitions:=jsonb_build_array(jsonb_build_object('id','initial','atMs',-9007199254740991::bigint,
      'accountId',first_event->'previousAccountId','username',first_event->'previousUsername','order',0));
  ELSIF first_event IS NULL THEN
    SELECT value INTO baseline_record FROM jsonb_array_elements(assignments)
      WHERE value->>'kind'='RECORD' AND value->>'baseline'='true' LIMIT 1;
    IF baseline_record IS NOT NULL THEN
      transitions:=jsonb_build_array(baseline_record||jsonb_build_object('id','initial',
        'sourceRecordId',baseline_record->>'id','atMs',-9007199254740991::bigint,'order',0));
    END IF;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(assignments) LOOP
    IF item->>'kind'='EVENT' THEN transitions:=transitions||jsonb_build_array(item||'{"priority":1}'::jsonb);
    ELSIF item->>'baseline' IS DISTINCT FROM 'true' AND item->>'atMs' IS NOT NULL THEN
      transitions:=transitions||jsonb_build_array(item||'{"priority":2}'::jsonb);
    END IF;
  END LOOP;
  starts:=report_annotation_canonical(transitions);
  FOR item IN SELECT value FROM jsonb_array_elements(assignments)
    WHERE value->>'kind'='RECORD' AND value->>'endMs' IS NOT NULL LOOP
    start_position:=(starts->'positions'->>(item->>'id'))::integer;
    IF start_position IS NULL THEN
      SELECT coalesce(max(ordinality-1),-1) INTO start_position
        FROM jsonb_array_elements(starts->'rows') WITH ORDINALITY
        WHERE (value->>'atMs')::bigint<=(item->>'atMs')::bigint;
    END IF;
    SELECT coalesce(max(ordinality-1),-1) INTO end_position
      FROM jsonb_array_elements(starts->'rows') WITH ORDINALITY
      WHERE (value->>'atMs')::bigint<=(item->>'endMs')::bigint;
    IF end_position<=start_position THEN
      transitions:=transitions||jsonb_build_array(jsonb_build_object('id',item->>'id'||':end',
        'atMs',item->'endMs','accountId',NULL,'username',NULL,'order',item->'order','priority',0));
    END IF;
  END LOOP;
  RETURN report_annotation_canonical(transitions)->'rows';
END $$;
