import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import pg from 'pg';
import { startTemporaryPostgres18 } from '../tests/helpers/personal-postgres.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { normalizePerformanceFilters } from '../../src/operator-performance.mjs';
import { readSqlOperatorSnapshot,operatorReportAggregateSql } from '../src/operator-performance-sql.mjs';
import { readSqlAnnotationJobReport } from '../src/annotation-job-report-query.mjs';
import { readOperatorPerformance } from '../src/operator-performance.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

// Accepts no business database URL. The only connection comes from a newly
// owned, disposable loopback PostgreSQL 18 cluster.
const TASKS=1_000_000,FACTS=60_001;
// Captured from the frozen round-two baseline generator; independent of the
// retained reports snapshot directory so this benchmark remains reproducible.
const ORIGINAL_SQL_SHA256='655577264ac583b10e11ce0d4c9f24cdaf8a66c6dd5fcd03372cee683d0b8345';
const evidence={startedAt:new Date().toISOString(),status:'running',isolatedTemporaryPostgres:true,
  developmentConnected:false,productionConnected:false,modelCalls:0,tasks:TASKS,reportFacts:FACTS,
  scope:'single local synthetic fixture; database/OS buffers may be warm; uncached SQL, not a production SLA',measurements:{}};
const save=()=>writeFile('reports/performance-round2-report-benchmark.json',`${JSON.stringify(evidence,null,2)}\n`);
const execFile=promisify(execFileCallback);
async function readBackendMemory(pid) {
  assert.ok(Number.isSafeInteger(pid)&&pid>0);
  if(process.platform==='win32') {
    const {stdout}=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `Get-Process -Id ${pid} -ErrorAction Stop | Select-Object WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],
      {windowsHide:true,shell:false,timeout:10_000});
    const memory=JSON.parse(stdout);
    return {residentBytes:memory.WorkingSet64,lifetimePeakResidentBytes:memory.PeakWorkingSet64,privateBytes:memory.PrivateMemorySize64};
  }
  if(process.platform==='linux') {
    const status=await readFile(`/proc/${pid}/status`,'utf8');
    const bytes=label=>Number(status.match(new RegExp(`^${label}:\\s+(\\d+)`,'mu'))?.[1]??0)*1024;
    return {residentBytes:bytes('VmRSS'),lifetimePeakResidentBytes:bytes('VmHWM')};
  }
  return {unavailable:true};
}
async function measured(name,action){const start=performance.now();const value=await action();evidence.measurements[name]={durationMs:Number((performance.now()-start).toFixed(2))};await save();console.log(`${name}: ${evidence.measurements[name].durationMs} ms`);return value;}
async function localMemory(pool,action){
  const client=await pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL work_mem='32MB'");const value=await action(client);await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
let database,pool;
try {
  await save();database=await startTemporaryPostgres18();
  pool=new pg.Pool({connectionString:database.connectionString,max:6,statement_timeout:120_000,application_name:'xhs-round2-report-fixture'});
  assert.equal(new URL(database.connectionString).hostname,'127.0.0.1');
  await measured('emptySchemaMigration',()=>migrateDatabase(pool));
  await pool.query("INSERT INTO executor_nodes(id,name) VALUES('report-benchmark','Synthetic executor')");
  await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
    SELECT 'report-bench-'||g,'Synthetic report person '||g,'USER','fake-only','ACTIVE','2025-01-01' FROM generate_series(1,30) g`);
  await measured('loadMillionCurrentTasks',async()=>{
    // Defer only nonunique performance indexes in this newly owned cluster.
    // Foreign keys, unique indexes and CHECK constraints remain active.
    const indexes=(await pool.query(`SELECT indexname,indexdef FROM pg_indexes named JOIN pg_class indexed ON indexed.relname=named.indexname
      JOIN pg_namespace space ON space.oid=indexed.relnamespace AND space.nspname=named.schemaname
      JOIN pg_index definition ON definition.indexrelid=indexed.oid
      WHERE named.schemaname='public' AND named.tablename=ANY($1::text[]) AND NOT definition.indisunique`,
      [['tasks','operator_stage_events','operator_stage_current','operator_performance_events','task_assignment_records']])).rows;
    for(const index of indexes){assert.match(index.indexname,/^[a-z_][a-z_0-9]*$/u);await pool.query(`DROP INDEX public."${index.indexname}"`);}
    await pool.query('SET statement_timeout=0');
    for(const table of ['tasks','operator_stage_events','operator_performance_events','task_assignment_records'])await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    for(let from=1;from<=TASKS;from+=20_000)await pool.query(`INSERT INTO tasks(id,query,input,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at,updated_at,personal_stage_entered_at)
      SELECT g,'Synthetic report task '||g,'{}',CASE g%5 WHEN 0 THEN 'COPY_QUEUED' WHEN 1 THEN 'COPY_REVIEW_PENDING' WHEN 2 THEN 'IMAGE_QUEUED' ELSE 'MANUAL_ARCHIVE' END,
        'report-benchmark','admin','report-bench-'||((g-1)%30+1),'MANUAL','2026-09-01Z'::timestamptz+g*interval '1 second',
        '2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second','2026-09-01Z'::timestamptz+g*interval '1 second'
      FROM generate_series($1::integer,$2::integer) g`,[from,Math.min(TASKS,from+19_999)]);
    await pool.query(`INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,occurred_at,baseline)
      SELECT t.id,u.id,u.username,CASE WHEN t.state LIKE 'COPY_%' THEN 'COPY' ELSE 'IMAGE' END,
        CASE WHEN t.state LIKE '%_QUEUED' THEN 'MACHINE_QUEUE' ELSE 'HUMAN' END,t.state,t.created_at,true
      FROM tasks t JOIN app_users u ON u.username=t.assigned_to_user_id`);
    await pool.query('INSERT INTO operator_stage_current SELECT * FROM operator_stage_events');
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'round2-submit:'||t.id,t.id,u.id,'COPY','SUBMIT','2026-09-20Z'::timestamptz+t.id*interval '1 microsecond',
        jsonb_build_object('username',u.username,'displayName',u.display_name,'copyRevisionId',t.id)
      FROM tasks t JOIN app_users u ON u.username=t.assigned_to_user_id WHERE t.id<=$1`,[FACTS]);
    await pool.query(`INSERT INTO task_assignment_records(task_id,assignee_account_id,assignee_username_snapshot,source,assigned_at,baseline)
      SELECT t.id,u.id,u.username,'MIGRATION_BASELINE',t.assigned_at,true FROM tasks t JOIN app_users u ON u.username=t.assigned_to_user_id WHERE t.id<=$1`,[FACTS]);
    for(const table of ['tasks','operator_stage_events','operator_performance_events','task_assignment_records'])await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    for(const index of indexes)await pool.query(index.indexdef);
    await pool.query('VACUUM (ANALYZE)');
    await pool.query('SET statement_timeout=120000');
  });
  const cutoff='2026-10-02T00:00:00.123456Z',filters=normalizePerformanceFilters({period:'custom',from:'2026-09-20',to:'2026-09-20',activity:'PRODUCTION'});
  const normalizeSql=sql=>sql.replace(/\s+/gu,' ').trim();
  evidence.originalSqlReferenceSha256=createHash('sha256').update(normalizeSql(operatorReportAggregateSql({useProjections:false}))).digest('hex');
  evidence.originalSqlMatchesFrozenBaseline=evidence.originalSqlReferenceSha256===ORIGINAL_SQL_SHA256;
  assert.equal(evidence.originalSqlMatchesFrozenBaseline,true);
  const original=await measured('operatorOriginalSql',()=>readSqlOperatorSnapshot(pool,filters,cutoff,cutoff,{useProjections:false}));
  const originalAnnotation=await measured('annotationOriginalSql',()=>readSqlAnnotationJobReport(pool,filters,cutoff,undefined,cutoff,{useProjections:false}));
  const backfillClient=new pg.Client({connectionString:database.connectionString,statement_timeout:120_000,
    application_name:'xhs-report-backfill-memory-fixture'});
  await backfillClient.connect();
  try {
    const pid=Number((await backfillClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    evidence.initialBackfillMemory={scope:'one fresh PostgreSQL backend, OS resident lifetime peak; includes mapped shared pages',
      before:await readBackendMemory(pid)};
    await measured('projectionInitialBackfill',async()=>{
      await backfillClient.query(`INSERT INTO report_projection_tasks(task_id) SELECT task_id FROM operator_performance_events
        UNION SELECT task_id FROM task_assignment_records ON CONFLICT DO NOTHING`);
      await backfillClient.query(`SELECT refresh_report_query_projections(ids) FROM(SELECT array_agg(task_id ORDER BY task_id) AS ids
        FROM report_projection_tasks GROUP BY task_id/1000) batches`);
      await backfillClient.query('VACUUM (ANALYZE) report_projection_tasks,report_operator_event_context,report_annotation_assignment_history');
    });
    evidence.initialBackfillMemory.after=await readBackendMemory(pid);await save();
  }finally{await backfillClient.end();}
  const personnel=await measured('operatorCanonicalLocal32WithoutCover',()=>localMemory(pool,
    client=>readSqlOperatorSnapshot(client,filters,cutoff,cutoff,{useProjections:false,summaryOnly:true})));
  const projected=await measured('operatorProjectedLocal32WithoutCover',()=>localMemory(pool,
    client=>readSqlOperatorSnapshot(client,filters,cutoff,cutoff)));
  const annotation=await measured('annotationOptimizedLocal32WithoutCover',()=>localMemory(pool,
    client=>readSqlAnnotationJobReport(client,filters,cutoff,undefined,cutoff)));
  assert.deepEqual(personnel,original,'the deployed personnel policy preserves every complete response field');
  assert.deepEqual(projected,original,'the optional personnel projection remains exact');
  assert.deepEqual(annotation,originalAnnotation,'the deployed annotation projection preserves every complete response field');
  assert.equal(personnel.summary.submissions,FACTS);assert.equal(annotation.summary.totalJobs,FACTS);
  evidence.completeResponseDeepEquality=true;
  evidence.shippedPolicy={operator:'canonical source with slim current summary',annotation:'revision-fenced projections',
    workMem:'32MB per PostgreSQL execution node, SET LOCAL only',maximumHeavyCalculations:2,newCoveringIndex:false};
  await save();
  const warmConnections=await Promise.all(Array.from({length:6},()=>pool.connect()));for(const connection of warmConnections)connection.release();
  // Public latency uses exactly the deployed schema and transaction-local 32MB.
  await pool.query("UPDATE app_users SET role='ADMIN',must_change_password=false WHERE username LIKE 'report-bench-%'");
  const actors=(await pool.query("SELECT id,username,role,credential_version FROM app_users WHERE username LIKE 'report-bench-%' ORDER BY id")).rows.map(row=>({userId:Number(row.id),username:row.username,role:row.role,credentialVersion:row.credential_version}));
  const publicInput={period:'custom',from:'2026-09-20',to:'2026-09-20',activity:'PRODUCTION'};
  const repository=new PostgresControlPlaneRepository({pool});
  const ordinary=[];let reportDone=false;
  const ordinaryFlight=(async()=>{while(!reportDone&&ordinary.length<30){const started=performance.now();await repository.listTasks({limit:20,actor:actors[0]});ordinary.push(performance.now()-started);await new Promise(resolve=>setTimeout(resolve,20));}})();
  try {
    const shared=await measured('thirtySameScopePublicReports',()=>Promise.all(actors.map(actor=>readOperatorPerformance(pool,actor,publicInput))));
    assert.ok(shared.every(report=>report.summary.submissions===FACTS));
    assert.equal(new Set(shared.map(report=>report.asOf)).size,1,'all followers share the same exact facts snapshot');
    await measured('cachedPublicReport',()=>readOperatorPerformance(pool,actors[0],publicInput));
  }finally{reportDone=true;await ordinaryFlight;}
  ordinary.sort((a,b)=>a-b);evidence.ordinaryDuringSharedReport={requests:ordinary.length,p95Ms:Number(ordinary[Math.ceil(ordinary.length*.95)-1].toFixed(2)),maximumMs:Number(ordinary.at(-1).toFixed(2))};
  for(const mode of ['withoutProjectionInvalidation','withProjectionInvalidation']) {
    if(mode==='withoutProjectionInvalidation')await pool.query('ALTER TABLE operator_performance_events DISABLE TRIGGER report_projection_update');
    try {
      const times=[];
      await measured(`thirtyParallelSourceWrites_${mode}`,()=>Promise.all(Array.from({length:30},async(_,index)=>{
        const started=performance.now();await pool.query("UPDATE operator_performance_events SET occurred_at=occurred_at+interval '1 microsecond' WHERE event_key=$1",[`round2-submit:${index+1}`]);times.push(performance.now()-started);
      })));
      times.sort((a,b)=>a-b);evidence.measurements[`thirtyParallelSourceWrites_${mode}`].p95Ms=Number(times[Math.ceil(times.length*.95)-1].toFixed(2));
    }finally{if(mode==='withoutProjectionInvalidation')await pool.query('ALTER TABLE operator_performance_events ENABLE TRIGGER report_projection_update');}
  }
  const bytes=(await pool.query(`SELECT pg_total_relation_size('report_projection_tasks')+pg_total_relation_size('report_operator_event_context')+
    pg_total_relation_size('report_annotation_assignment_history') AS bytes`)).rows[0].bytes;
  evidence.projectionBytes=Number(bytes);
  evidence.operatorImprovementPercent=Number((100*(1-evidence.measurements.operatorCanonicalLocal32WithoutCover.durationMs/evidence.measurements.operatorOriginalSql.durationMs)).toFixed(2));
  evidence.annotationImprovementPercent=Number((100*(1-evidence.measurements.annotationOptimizedLocal32WithoutCover.durationMs/evidence.measurements.annotationOriginalSql.durationMs)).toFixed(2));
  evidence.status='passed';
}catch(error){evidence.status='failed';evidence.error=error.message;console.error(error);process.exitCode=1;}
finally{await pool?.end();await database?.stop();evidence.finishedAt=new Date().toISOString();await save();}
