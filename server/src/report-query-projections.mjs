import pg from 'pg';
import { OPERATOR_EVENTS_SOURCE_SQL } from './operator-performance-event-sources.mjs';

// The original SQL remains the reference and the immediate read-after-write
// path. A dirty task cannot reuse a projection from an earlier fact revision.
const validProjection = `SELECT 1 FROM report_operator_event_context projected
  JOIN report_projection_tasks revision ON revision.task_id=projected.task_id
    AND revision.revision=revision.projected_revision AND revision.revision=projected.source_revision
  WHERE projected.event_key=e.event_key AND projected.task_id=e.task_id`;

export function projectedOperatorEventsSourceSql() {
  const original = OPERATOR_EVENTS_SOURCE_SQL.replace(/\s+ORDER BY e\.occurred_at,e\.event_key$/u,'')
    .replace('WHERE e.occurred_at >= $1',`WHERE NOT EXISTS (${validProjection}) AND e.occurred_at >= $1`);
  return `SELECT e.*,EXISTS(SELECT 1 FROM tasks t WHERE t.id=e.task_id) AS task_exists,
    projected.sample_selected,projected.previous_submitted_at,projected.returned_at,NULL::bigint AS return_round
    FROM operator_performance_events e
    JOIN report_projection_tasks revision ON revision.task_id=e.task_id AND revision.revision=revision.projected_revision
    JOIN report_operator_event_context projected ON projected.event_key=e.event_key AND projected.task_id=e.task_id
      AND projected.source_revision=revision.revision
    WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND e.occurred_at <= $3
      AND ($4::bigint IS NULL OR e.account_id=$4) AND ($5::text='' OR e.stage=$5)
      AND ($6::bigint IS NULL OR (e.data->>'batchId')::bigint=$6)
    UNION ALL ${original}`;
}

export async function refreshReportQueryProjections(pool,{batchSize=100}={}) {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>500)throw new RangeError('report projection batch must be 1–500 tasks');
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='500ms'");
    const ids=(await client.query(`SELECT task_id FROM report_projection_tasks WHERE revision<>projected_revision
      ORDER BY task_id LIMIT $1 FOR UPDATE SKIP LOCKED`,[batchSize])).rows.map(row=>row.task_id);
    if(ids.length)await client.query('SELECT refresh_report_query_projections($1::bigint[])',[ids]);
    await client.query('COMMIT');
    return {refreshed:ids.length};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}

export function createReportProjectionWorker(pool,{logger=console,batchSize=100,maximumBatches=5}={}) {
  if(!Number.isSafeInteger(maximumBatches)||maximumBatches<1||maximumBatches>10)throw new RangeError('report projection maximum batches must be 1–10');
  const projectionPool=new pg.Pool({...pool.options,max:1,application_name:'xhs-report-projections',
    statement_timeout:30_000,idle_in_transaction_session_timeout:30_000});
  let flight=null,stopping=false;
  const wake=()=>{
    if(stopping||flight)return flight;
    flight=(async()=>{
      let refreshed=0;const started=Date.now();
      for(let batch=0;batch<maximumBatches&&!stopping&&Date.now()-started<30_000;batch++) {
        const result=await refreshReportQueryProjections(projectionPool,{batchSize});refreshed+=result.refreshed;
        if(result.refreshed<batchSize)break;
      }
      return {refreshed};
    })().catch(error=>{
      // A concurrent source write can change a locked revision in RR. It stays
      // dirty and is retried by the next bounded sweep; reads use canonical SQL.
      logger.error?.('report projection refresh deferred',{code:error.code??'REPORT_PROJECTION_ERROR'});
      return {refreshed:0,deferred:true};
    }).finally(()=>{flight=null;});
    return flight;
  };
  return {wake,async dispose(){stopping=true;await flight;await projectionPool.end();}};
}
