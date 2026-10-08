import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { normalizePerformanceFilters } from '../../src/operator-performance.mjs';
import { readSqlOperatorSnapshot,readSqlOperatorDetails } from '../src/operator-performance-sql.mjs';
import { readSqlAnnotationJobReport } from '../src/annotation-job-report-query.mjs';
import { refreshReportQueryProjections } from '../src/report-query-projections.mjs';
import { readReportFactVersion,OPERATOR_REPORT_SOURCES } from '../src/report-query-cache.mjs';

test('incremental report projections fence corrections and preserve all original fields, historical cutoffs and lease invalidation',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const evidence={isolatedTemporaryPostgres:true,developmentConnected:false,productionConnected:false,modelCalls:0,checks:[],deepComparisons:0};
  try {
    await repository.initialize();const pool=repository.pool;
    const people=(await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES('projection-a','投影甲','USER','fake-only','ACTIVE','2026-09-01'),('projection-b','投影乙','USER','fake-only','ACTIVE','2026-09-01') RETURNING id,username`)).rows;
    const [a,b]=people;
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES('projection-test','Synthetic executor')");
    const tasks=(await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source)
      VALUES('projection comparison','COPY_REVIEW_PENDING','projection-test','projection-a','projection-a','2026-09-20','MANUAL'),
        ('projection destination','COPY_REVIEW_PENDING','projection-test','projection-b','projection-b','2026-09-20','MANUAL') RETURNING id`)).rows;
    const task=tasks[0].id,other=tasks[1].id;
    await pool.query('DELETE FROM task_assignment_records WHERE task_id=$1',[task]);
    await pool.query('DELETE FROM task_assignment_events WHERE task_id=$1',[task]);
    await pool.query('DELETE FROM operator_stage_events WHERE task_id=$1',[task]);
    await pool.query(`INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,occurred_at)
      VALUES($1,$2,'projection-a','COPY','HUMAN','COPY_REVIEW_PENDING','2026-09-20T00:00:00Z'),
        ($1,$2,'projection-a','COPY','BACKGROUND','COPY_REVIEW_PENDING','2026-09-20T00:04:00Z'),
        ($1,$2,'projection-a','COPY','HUMAN','COPY_REVIEW_PENDING','2026-09-20T00:08:00Z'),
        ($1,$3,'projection-b','COPY','HUMAN','COPY_REVIEW_PENDING','2026-09-20T00:18:00Z')`,[task,a.id,b.id]);
    await pool.query(`INSERT INTO task_assignment_records(task_id,assignee_account_id,assignee_username_snapshot,source,assigned_at,ended_at,baseline)
      VALUES($1,$2,'projection-a','MIGRATION_BASELINE','2026-09-20T00:00:00Z','2026-09-20T00:18:00Z',true),
        ($1,$3,'projection-b','MANUAL','2026-09-20T00:18:00Z',NULL,false)`,[task,a.id,b.id]);
    await pool.query(`INSERT INTO task_assignment_events(task_id,actor_username,previous_assignee_user_id,assignee_user_id,source,created_at)
      VALUES($1,'admin','projection-a','projection-b','MANUAL','2026-09-20T00:18:00Z')`,[task]);
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES('projection:sample',$1,$2,'COPY','SAMPLE','2026-09-20T00:10:00Z','{"sampleKind":"RANDOM","selected":true,"approvalId":123}'),
        ('projection:first',$1,$2,'COPY','SUBMIT','2026-09-20T00:12:00.123456Z','{"username":"projection-a","displayName":"投影甲","approvalId":123,"firstSubmission":true}'),
        ('projection:return',$1,$2,'COPY','QUALITY','2026-09-20T00:15:00Z','{"outcome":"RETURN","sampleKind":"RANDOM","first":true,"target":"COPY"}'),
        ('projection:rework',$1,$3,'COPY','SUBMIT','2026-09-20T00:25:00Z','{"username":"projection-b","displayName":"投影乙","rework":true}')`,[task,a.id,b.id]);
    const input={period:'custom',from:'2026-09-20',to:'2026-09-20'};
    const cutoff='2026-09-20T01:00:00.123456Z';
    async function compare(label,{asOf=cutoff,matrix=false}={}) {
      for(const scope of matrix?[{}, {accountId:String(a.id)}, {query:'投影乙'}, {stage:'COPY'}, {activity:'QA'}, {activity:'PRODUCTION'}]:[{}]) {
        const filters=normalizePerformanceFilters({...input,...scope});
        const actual=await readSqlOperatorSnapshot(pool,filters,asOf,asOf);
        const expected=await readSqlOperatorSnapshot(pool,filters,asOf,asOf,{useProjections:false});
        assert.deepEqual(actual,expected,`${label}: complete operator report`);evidence.deepComparisons++;
        const deployed=await readSqlOperatorSnapshot(pool,filters,asOf,asOf,{useProjections:false,summaryOnly:true});
        assert.deepEqual(deployed,expected,`${label}: complete canonical personnel summary with slim current rows`);
        evidence.deepComparisons++;
        const detailFilters=normalizePerformanceFilters({...input,...scope,metric:'all'});
        for(const accountId of [null,Number(a.id)]) {
          const details=await readSqlOperatorDetails(pool,actual,detailFilters,accountId,{currentPageSize:1});
          const reference=await readSqlOperatorDetails(pool,expected,detailFilters,accountId,{currentPageSize:1,useProjections:false});
          assert.deepEqual(details,reference,`${label}: complete paged detail ${accountId}`);evidence.deepComparisons++;
        }
        const annotationFilters=normalizePerformanceFilters({...input,...scope});
        const annotation=await readSqlAnnotationJobReport(pool,annotationFilters,asOf,undefined,asOf);
        const reference=await readSqlAnnotationJobReport(pool,annotationFilters,asOf,undefined,asOf,{useProjections:false});
        assert.deepEqual(annotation,reference,`${label}: entire annotation report`);evidence.deepComparisons++;
      }
      evidence.checks.push(label);
    }
    async function drain(){while((await refreshReportQueryProjections(pool)).refreshed>0){}}
    await compare('dirty tasks immediately use canonical SQL');await drain();
    await compare('ready projections preserve identity, quality, medians, distinct tasks, stages and scopes',{matrix:true});
    const projected=(await pool.query("SELECT timing FROM report_operator_event_context WHERE event_key='projection:first'")).rows[0].timing;
    assert.equal(projected.humanMs,480123);assert.equal(projected.backgroundMs,240000);
    await pool.query(`INSERT INTO task_assignment_records(task_id,assignee_account_id,assignee_username_snapshot,source,assigned_at,ended_at)
      VALUES($1,$2,'projection-a','MANUAL','2026-09-20T02:00:00Z','2026-09-20T03:00:00Z')`,[task,a.id]);
    await drain();
    assert.ok(Date.parse((await pool.query('SELECT max_occurred_at FROM report_annotation_assignment_history WHERE task_id=$1',[task])).rows[0].max_occurred_at)>Date.parse(cutoff));
    await compare('historical cutoff excludes future assignment using original-SQL fallback');
    await compare('microsecond cutoff keeps future submissions out',{asOf:'2026-09-20T00:12:00.123455Z'});
    await pool.query(`INSERT INTO operator_stage_events(task_id,account_id,username,stage,phase,state,occurred_at)
      VALUES($1,$2,'projection-a','COPY','HUMAN','COPY_REVIEW_PENDING','2026-09-20T00:06:00Z')`,[task,a.id]);
    await compare('late stage event invalidates previously computed timing');await drain();await compare('late stage timing is rebuilt');
    await pool.query("UPDATE operator_performance_events SET occurred_at='2026-09-20T00:20:00Z',data=data||'{\"selected\":false}'::jsonb WHERE event_key='projection:sample'");
    await pool.query("UPDATE operator_performance_events SET task_id=$1,account_id=$2 WHERE event_key='projection:rework'",[other,a.id]);
    await compare('event correction and task movement fence both task projections');
    const oldTaskLock=await pool.connect();
    try {
      await oldTaskLock.query('BEGIN');await oldTaskLock.query('SELECT task_id FROM report_projection_tasks WHERE task_id=$1 FOR UPDATE',[task]);
      assert.equal((await refreshReportQueryProjections(pool,{batchSize:1})).refreshed,1,'target task may rebuild before the locked previous owner');
      await compare('moved event projection rebuilds target independently of the old task');
      await oldTaskLock.query('COMMIT');
    }finally{await oldTaskLock.query('ROLLBACK').catch(()=>{});oldTaskLock.release();}
    await drain();await compare('corrected source contexts are rebuilt');
    await pool.query("DELETE FROM operator_performance_events WHERE event_key='projection:return'");
    await pool.query("DELETE FROM task_assignment_records WHERE task_id=$1 AND assigned_at='2026-09-20T00:18:00Z'",[task]);
    await compare('source deletions cannot reuse old verdict or assignment contexts');await drain();await compare('deleted source facts are removed after rebuilding');
    await pool.query("UPDATE app_users SET created_at='2026-09-21' WHERE id=$1",[a.id]);
    await compare('historical identity correction remains canonical');await drain();await compare('identity correction rebuilt',{matrix:true});
    await pool.query(`INSERT INTO task_assignment_events(task_id,actor_username,previous_assignee_user_id,assignee_user_id,source,created_at)
      VALUES($1,'admin','projection-b','projection-later','MANUAL','2026-09-20T00:30:00Z')`,[task]);
    await drain();
    await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES('projection-later','历史补录身份','USER','fake-only','ACTIVE','2026-09-01')`);
    await compare('late account creation invalidates unresolved assignment identity');await drain();await compare('late account identity rebuilt');
    await pool.query("DELETE FROM app_users WHERE username='projection-later'");
    await compare('account deletion cannot retain a historical username resolution');await drain();await compare('deleted identity rebuilt');
    await pool.query(`CREATE FUNCTION fail_projection_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic projection failure'; END $$`);
    await pool.query("CREATE TRIGGER fail_projection_test_insert BEFORE INSERT ON report_operator_event_context FOR EACH ROW EXECUTE FUNCTION fail_projection_test_insert()");
    await pool.query("UPDATE operator_stage_events SET state=state WHERE task_id=$1",[task]);
    await assert.rejects(refreshReportQueryProjections(pool),/synthetic projection failure/u);
    assert.ok((await pool.query('SELECT revision>projected_revision AS dirty FROM report_projection_tasks WHERE task_id=$1',[task])).rows[0].dirty);
    await compare('failed worker transaction leaves revisions fenced and SQL readable');
    await pool.query('DROP TRIGGER fail_projection_test_insert ON report_operator_event_context');
    await pool.query('DROP FUNCTION fail_projection_test_insert()');
    await drain();await compare('worker recovery rebuilds the same complete facts');
    const revision=(await pool.query('SELECT revision FROM report_projection_tasks WHERE task_id=$1',[task])).rows[0].revision;
    await pool.query("UPDATE operator_stage_events SET state=state WHERE false");
    assert.equal((await pool.query('SELECT revision FROM report_projection_tasks WHERE task_id=$1',[task])).rows[0].revision,revision);
    const lock=await pool.connect();
    try {
      await lock.query('BEGIN');await lock.query('UPDATE report_projection_tasks SET revision=revision+1 WHERE task_id=$1',[task]);
      assert.equal((await refreshReportQueryProjections(pool)).refreshed,0,'locked source revisions are skipped without blocking business traffic');
      await lock.query('COMMIT');
    }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();}
    await drain();evidence.checks.push('zero-row writes and SKIP LOCKED revisions');

    const copy=Number((await pool.query("INSERT INTO copy_revisions(task_id,revision,content,revision_origin) VALUES($1,1,'{}','GENERATION') RETURNING id",[task])).rows[0].id);
    const image=randomUUID();
    await pool.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id) VALUES($1,$2,$3,'COMPLETED',$1)",[image,task,copy]);
    const asset=Number((await pool.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,artifact_key,origin_image_run_id)
      VALUES($1,$2,'image/png',1,$3,'synthetic-test.png',$2,'synthetic',$2) RETURNING id`,[task,image,'f'.repeat(64)])).rows[0].id);
    const edit=randomUUID();
    await pool.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','RUNNING','projection-a')`,[edit,task,randomUUID(),image,asset,copy,'f'.repeat(64)]);
    const version=await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES);
    const dirtyBefore=Number((await pool.query('SELECT count(*) AS n FROM report_projection_tasks WHERE revision<>projected_revision')).rows[0].n);
    const renewalStart=performance.now();
    for(let index=0;index<30;index++)await pool.query('UPDATE image_edit_requests SET lease_expires_at=clock_timestamp()+interval \'2 minutes\',updated_at=clock_timestamp() WHERE id=$1',[edit]);
    evidence.leaseRenewalsMs=Number((performance.now()-renewalStart).toFixed(2));
    assert.equal(await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES),version,'RUNNING lease updates preserve exact aggregate versions');
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM report_projection_tasks WHERE revision<>projected_revision')).rows[0].n),dirtyBefore,'lease writes do not rebuild stage histories');
    await pool.query("UPDATE image_edit_requests SET status='PREVIEW_READY',updated_at=clock_timestamp() WHERE id=$1",[edit]);
    const readyVersion=await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES);assert.notEqual(readyVersion,version);
    await pool.query("UPDATE image_edit_requests SET updated_at=updated_at+interval '1 millisecond' WHERE id=$1",[edit]);
    assert.notEqual(await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES),readyVersion,'PREVIEW_READY timestamp affects waiting time and remains versioned');
    evidence.checks.push('30 real image-edit lease renewals skip invalidation; business readiness remains versioned');
    evidence.status='passed';
  } finally {
    await repository.close();await database.stop();
    await writeFile('reports/performance-round2-report-correctness.json',`${JSON.stringify(evidence,null,2)}\n`);
  }
});
