import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readOperatorPerformance, readOperatorPerformanceOracle } from '../src/operator-performance.mjs';
import { readReportFactVersion, OPERATOR_REPORT_SOURCES } from '../src/report-query-cache.mjs';
import { streamTaskDataReportCsv, exportTaskDataReportCsv } from '../src/task-data-report.mjs';
import { annotateAssignmentCycles } from '../../src/annotation-assignment-cycles.mjs';

test('report facts stay cached and details stay readable during real executor progress, with scoped refresh and cancellable CSV', {
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString,env:{...process.env,PG_POOL_MAX:'2'}});
  try {
    await repository.initialize();
    const pool=repository.pool,adminRow=await repository.getUserByUsername('admin');
    const admin={role:'ADMIN',userId:adminRow.id,username:adminRow.username};
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('report-progress','Synthetic executor')");
    const task=Number((await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source)
      VALUES('synthetic live progress','COPY_RUNNING','report-progress','admin','admin',now(),'MANUAL') RETURNING id`)).rows[0].id);
    const execution=randomUUID();
    await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,stage,snapshot)
      VALUES($1,$2,'COPY','report-progress','COPY_GENERATE','{}')`,[execution,task]);
    await pool.query('UPDATE tasks SET current_execution_id=$2 WHERE id=$1',[task,execution]);
    const otherAdmins=(await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status)
      SELECT 'report-admin-'||n,'Synthetic administrator '||n,'ADMIN','fake-only','ACTIVE' FROM generate_series(1,29) n
      RETURNING id,username,role`)).rows.map(row=>({role:row.role,userId:Number(row.id),username:row.username}));
    const defaultWorkMem=(await pool.query('SHOW work_mem')).rows[0].work_mem;
    async function assertLocalMemoryReset() {
      const clients=await Promise.all([pool.connect(),pool.connect()]);
      try {
        for(const client of clients)assert.equal((await client.query('SHOW work_mem')).rows[0].work_mem,defaultWorkMem,
          'heavy report memory applies only inside its transaction, including after rollback');
      }finally{for(const client of clients)client.release();}
    }
    const version=await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES);
    await pool.query("UPDATE operator_performance_events SET data=data WHERE false");
    await pool.query("DELETE FROM quality_review_activity_events WHERE false");
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'empty-report-write',$1,$2,'COPY','SUBMIT',now(),'{}'::jsonb WHERE false`,[task,admin.userId]);
    assert.equal(await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES),version,
      'zero-row background sweeps neither invalidate aggregates nor expire detail facts');
    let aggregateReads=0,connectionLeases=0;
    const wrapped=new WeakSet(),originalConnect=pool.connect.bind(pool);
    const reportPool={connect:async()=>{
      const client=await originalConnect();
      connectionLeases++;
      if(!wrapped.has(client)) {
        const originalQuery=client.query.bind(client);
        client.query=(sql,...args)=>{
          if(typeof sql==='string'&&sql.includes('repaired_facts AS'))aggregateReads++;
          return originalQuery(sql,...args);
        };
        wrapped.add(client);
      }
      return client;
    }};
    const report=await readOperatorPerformance(reportPool,admin,{});
    await assertLocalMemoryReset();
    connectionLeases=0;
    const [sharedReports,ordinaryList]=await Promise.all([
      Promise.all(otherAdmins.map(actor=>readOperatorPerformance(reportPool,actor,{}))),
      repository.listTasks({limit:10}),
    ]);
    assert.equal(connectionLeases,1,'thirty overlapping administrators acquire only the leader report connection');
    assert.ok(ordinaryList.some(item=>item.id===task),'normal lists remain readable with a two-connection pool');
    assert.ok(sharedReports.every(row=>row.summary.pending===report.summary.pending));
    assert.equal(aggregateReads,1,'same administrator scope shares one complete aggregate across thirty accounts');
    await assert.rejects(readOperatorPerformance(reportPool,otherAdmins[0],{snapshotToken:report.snapshotToken},{kind:'detail'}),
      {code:'PERFORMANCE_SNAPSHOT_EXPIRED'},'sharing aggregates never shares snapshot ownership');
    const writer=(async()=>{
      for(let i=0;i<40;i++)await repository.updateProgress(execution,{stage:`COPY_GENERATE_${i%3}`,progressPercent:i,
        message:'Synthetic progress',details:{iteration:i}});
    })();
    const readers=Promise.all(Array.from({length:12},(_,index)=>readOperatorPerformance(reportPool,admin,
      {snapshotToken:report.snapshotToken,metric:'all',page:index+1},{kind:'detail',accountId:admin.userId})));
    const [details]=await Promise.all([readers,writer]);
    assert.equal(await readReportFactVersion(pool,OPERATOR_REPORT_SOURCES),version,
      'actual updateProgress writes current_stage/last_activity_at, without advancing report metric versions');
    assert.ok(details.every(detail=>detail.refreshed===false));
    assert.equal(aggregateReads,1,'background progress cannot cause full-range aggregate recomputation');
    await pool.query("UPDATE tasks SET state='COPY_FAILED' WHERE id=$1",[task]);
    const refreshed=await readOperatorPerformance(reportPool,admin,{snapshotToken:report.snapshotToken},{kind:'detail',accountId:admin.userId});
    assert.equal(refreshed.refreshed,true);
    assert.equal(refreshed.current[0].state,'COPY_FAILED');
    assert.equal(refreshed.person.pending,refreshed.currentTotal);
    assert.equal(refreshed.reportAsOf,report.asOf);
    assert.equal((await readOperatorPerformance(reportPool,admin,{snapshotToken:report.snapshotToken},{kind:'export'})).asOf,report.asOf);
    const exportInput={time:{field:'CREATED_AT',mode:'RELATIVE',days:1},sort:'TASK_ID',order:'ASC'};
    const synchronous=await exportTaskDataReportCsv(pool,admin,exportInput);
    let csv='',rows=0;
    for await(const chunk of streamTaskDataReportCsv(pool,admin,exportInput)){csv+=chunk.csv;rows+=chunk.rows;}
    assert.equal(csv,synchronous);assert.equal(rows,1);
    const generator=streamTaskDataReportCsv(pool,admin,exportInput);
    await generator.next();await generator.next();await generator.return();
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database()
      AND state='idle in transaction'`)).rows[0].n),0,'cancelled export rolls back its cursor transaction');
    const discardTask=Number((await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,assigned_to_user_id,assigned_at,assignment_source)
      VALUES('synthetic discard handoff','COPY_REVIEW_PENDING','report-progress','admin',now(),'MANUAL') RETURNING id`)).rows[0].id);
    const revision=Number((await pool.query("INSERT INTO copy_revisions(task_id,revision,content,revision_origin) VALUES($1,1,'{}','GENERATION') RETURNING id",[discardTask])).rows[0].id);
    const session=randomUUID();
    await pool.query(`INSERT INTO human_quality_review_submissions(review_session_id,task_id,stage,reviewer_username,request_fingerprint)
      VALUES($1,$2,'COPY','admin',$3)`,[session,discardTask,'a'.repeat(64)]);
    await pool.query(`INSERT INTO human_quality_assessments(task_id,stage,copy_revision_id,score_x10,rating_context,action,reviewer_username,review_session_id,request_fingerprint)
      VALUES($1,'COPY',$2,10,'ORIGINAL','DISCARD','admin',$3,$4)`,[discardTask,revision,session,'a'.repeat(64)]);
    async function assertAnnotationOracle() {
      const input={activity:'PRODUCTION',stage:''};
      const actual=await readOperatorPerformance(reportPool,admin,input,{kind:'annotationJobReport'});
      const expected=await readOperatorPerformanceOracle({connect:()=>pool.connect()},admin,input,{kind:'annotationJobReport'});
      assert.deepEqual({...actual,asOf:''},{...expected,asOf:''});return actual;
    }
    const direct=await assertAnnotationOracle();
    assert.equal(direct.people[0].copyFirstDirectDiscarded,1);
    const work=async(accountId,username)=>pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES($1,$2,$3,'COPY','SUBMIT',clock_timestamp(),$4)`,[randomUUID(),discardTask,accountId,{username,displayName:username,exclusion:null}]);
    await work(admin.userId,admin.username);
    const repairedDiscard=await assertAnnotationOracle();
    assert.equal(repairedDiscard.people[0].copyRework,1);
    assert.equal(repairedDiscard.people[0].copyFirstDirectDiscarded,0,'a later first submission in the same cycle follows the original discard cohort');
    const nextUser=Number((await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES('report-handoff','接手人','USER','fake-only','ACTIVE',now()-interval '1 day') RETURNING id`)).rows[0].id);
    await pool.query("UPDATE tasks SET assigned_to_user_id='report-handoff',assigned_at=clock_timestamp(),assignment_source='MANUAL' WHERE id=$1",[discardTask]);
    await work(nextUser,'report-handoff');
    const handoff=await assertAnnotationOracle();
    assert.equal(handoff.people.find(person=>person.accountId===nextUser).copyReview,1);
    await pool.query("UPDATE tasks SET assigned_to_user_id='admin',assigned_at=clock_timestamp(),assignment_source='MANUAL' WHERE id=$1",[discardTask]);
    await work(admin.userId,admin.username);
    const returnedOwner=await assertAnnotationOracle();
    assert.equal(returnedOwner.people.find(person=>person.accountId===admin.userId).copyReview,2,
      'returning to a previous owner starts a new contribution cycle without rewriting earlier work');
    const cutoff='2026-10-02T00:00:00.123456Z';
    const boundaryAccount=otherAdmins.at(-1);
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'clock-boundary:'||offset_name,$1,$2,'COPY','SUBMIT',event_time,$3::jsonb FROM (VALUES
        ('before',$4::timestamptz-interval '1 microsecond'),('at',$4::timestamptz),
        ('next-ms','2026-10-02T00:00:00.124000Z'::timestamptz),
        ('next-ms-micro','2026-10-02T00:00:00.124001Z'::timestamptz)) boundaries(offset_name,event_time)`,
      [discardTask,boundaryAccount.userId,{username:boundaryAccount.username,displayName:'Synthetic boundary account'},cutoff]);
    const preciseClockPool={connect:async()=>{
      const client=await pool.connect();
      return {query:(sql,parameters)=>typeof sql==='string'&&sql.includes('report_clock')
        ? Promise.resolve({rows:[{at:new Date(cutoff),data_cutoff:cutoff}]}) :client.query(sql,parameters),
      release:()=>client.release()};
    }};
    const boundaryInput={period:'custom',from:'2026-10-02',to:'2026-10-02',activity:'PRODUCTION',accountId:String(boundaryAccount.userId)};
    const boundary=await readOperatorPerformance(preciseClockPool,admin,boundaryInput);
    const boundaryOracle=await readOperatorPerformanceOracle(preciseClockPool,admin,boundaryInput);
    assert.equal(boundary.summary.submissions,2,'exact next millisecond and its microsecond future facts stay outside the snapshot');
    assert.equal(boundary.asOf,'2026-10-02T00:00:00.123Z');
    assert.deepEqual(boundary.summary,boundaryOracle.summary,'precise cutoff keeps every original summary metric');
    assert.deepEqual(boundary.trend,boundaryOracle.trend);
    assert.deepEqual(boundary.people,boundaryOracle.people);
    const boundaryAnnotation=await readOperatorPerformance(preciseClockPool,admin,boundaryInput,{kind:'annotationJobReport'});
    const boundaryAnnotationOracle=await readOperatorPerformanceOracle(preciseClockPool,admin,boundaryInput,{kind:'annotationJobReport'});
    assert.deepEqual({...boundaryAnnotation,asOf:''},{...boundaryAnnotationOracle,asOf:''});
    await assertLocalMemoryReset();
    const failingPool={connect:async()=>{
      const client=await pool.connect();
      return {query:(sql,...args)=>typeof sql==='string'&&sql.includes('repaired_facts AS')
        ? Promise.reject(new Error('Synthetic aggregate failure after local memory budget')):client.query(sql,...args),
      release:()=>client.release()};
    }};
    await assert.rejects(readOperatorPerformance(failingPool,admin,{}, {forceRefresh:true}),
      /Synthetic aggregate failure after local memory budget/u);
    await assertLocalMemoryReset();
  } finally {await repository.close();await database.stop();}
});

test('database assignment-cycle canonicalization preserves baselines, repeated owners and clock-late record ends',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try {
    await repository.initialize();
    const at=offset=>new Date(Date.UTC(2026,8,10)+offset).toISOString();
    const cases=[
      [{id:'record:1',kind:'RECORD',taskId:1,accountId:1,username:'a',at:at(100),order:1,baseline:true}],
      [{id:'event:1',kind:'EVENT',taskId:1,accountId:2,username:'b',previousAccountId:1,previousUsername:'a',at:at(100),order:1},
        {id:'record:1',kind:'RECORD',taskId:1,accountId:1,username:'a',at:at(0),endedAt:at(102),order:1},
        {id:'record:2',kind:'RECORD',taskId:1,accountId:2,username:'b',at:at(100),order:2},
        {id:'event:2',kind:'EVENT',taskId:1,accountId:1,username:'a',previousAccountId:2,previousUsername:'b',at:at(200),order:2}],
      [{id:'event:1',kind:'EVENT',taskId:1,accountId:null,username:'a',at:at(0),order:1},
        {id:'record:1',kind:'RECORD',taskId:1,accountId:1,username:'a',at:at(0),order:1,endedAt:at(150)},
        {id:'event:2',kind:'EVENT',taskId:1,accountId:2,username:'b',at:at(100),order:2},
        {id:'record:2',kind:'RECORD',taskId:1,accountId:2,username:'b',at:at(100),order:2,endedAt:at(200)}],
    ];
    for(const assignments of cases) {
      const rows=assignments.map(row=>({...row,atMs:Date.parse(row.at),endMs:row.endedAt?Date.parse(row.endedAt):null}));
      const history=(await repository.pool.query('SELECT report_annotation_transitions($1::jsonb) AS history',[JSON.stringify(rows)])).rows[0].history;
      const work=Array.from({length:12},(_,index)=>({id:`work:${index}`,taskId:1,accountId:index%2+1,stage:index%3?'COPY':'IMAGE',kind:'SUBMIT',
        at:at(index*25),sequence:index,exclusion:null}));
      const expected=annotateAssignmentCycles(work,assignments),seen=new Set();
      const actual=work.map(row=>{
        const epoch=history.findLast(item=>item.atMs<=Date.parse(row.at))?.id??'initial';
        const key=`${row.taskId}:${epoch}:${row.accountId}:${row.stage}`,first=!seen.has(key);seen.add(key);
        return {...row,annotationCycleKey:key,annotationFirst:first};
      });
      assert.deepEqual(actual,expected);
    }
  }finally{await repository.close();await database.stop();}
});
