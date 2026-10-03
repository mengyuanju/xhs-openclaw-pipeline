import assert from 'node:assert/strict';
import test from 'node:test';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readPersonalPeriodSummary, readPersonalReceipts } from '../src/personal-statistics-query.mjs';
import { PERSONAL_QA_EVENTS_SQL, PERSONAL_SUBMISSIONS_SQL } from '../src/personal-workspace.mjs';
import { readAccountQualityFacts } from '../src/account-quality-statistics.mjs';
import { readPersonalQaCoverage } from '../src/personal-qa-coverage.mjs';
import { personalQaMetricRows } from '../../src/personal-qa-statistics.mjs';
import { normalizePersonalFilters, summarizePersonalToday } from '../../src/personal-workspace.mjs';

const now=Date.parse('2026-10-01T12:00:00+08:00');
const actor={userId:11,username:'test-reviewer',role:'REVIEWER'};
const iso=value=>value instanceof Date?value.toISOString():value;

test('personal SQL aggregates and anonymous receipts match legacy QA coverage, duplicates and range; more than 50k events stay complete',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try{
    await repository.initialize();const pool=repository.pool;
    const filters=normalizePersonalFilters({period:'today'},now),range=filters.range;
    const start=new Date(range.startMs+3_600_000).toISOString();
    const qa=[
      ['copy-v2:1',1,'COPY','QA_REVIEW',{samplingItemId:1,qaBatchId:1,outcome:'RETURN',sampleKind:'RANDOM'}],
      ['copy-v2:2',1,'COPY','QA_REVIEW',{samplingItemId:2,qaBatchId:1,outcome:'PASS',sampleKind:'MANDATORY_RECHECK'}],
      ['copy-v2:2-duplicate',1,'COPY','QA_REVIEW',{samplingItemId:2,qaBatchId:1,outcome:'RETURN',sampleKind:'RANDOM'}],
      ['image-review:1',1,'IMAGE','QA_REVIEW',{samplingItemId:1,freezeId:1,outcome:'PASS',sampleKind:'RANDOM'}],
      ['image-discard:1',1,'IMAGE','QA_DISCARD',{samplingItemId:1,freezeId:1,outcome:'DISCARD'}],
      ['image-escalate:2',2,'IMAGE','QA_ESCALATE',{samplingItemId:2,freezeId:1,outcome:'ESCALATE'}],
      ['image-excluded:3',3,'IMAGE','QA_REVIEW',{samplingItemId:3,outcome:'PASS',exclusion:'SELF_REVIEW'}],
      ['image-batch:1',null,'IMAGE','QA_BATCH_RETURN',{freezeId:1,sourceEventId:1,affectedTaskIds:[1,2,2,3],affectedCount:3}],
      ['image-batch:2',null,'IMAGE','QA_BATCH_RETURN',{freezeId:2,sourceEventId:2,affectedCount:4}],
      ['copy-batch:1',null,'COPY','QA_BATCH_RETURN',{qaBatchId:1,sourceEventId:3,affectedCount:4}],
      ['image-batch:0',null,'IMAGE','QA_BATCH_RETURN',{sourceEventId:4,affectedCount:0}],
    ];
    for(let index=0;index<qa.length;index++){
      const[id,task,stage,kind,data]=qa[index];
      await pool.query(`INSERT INTO quality_review_activity_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,task,actor.userId,stage,kind,new Date(Date.parse(start)+index*1000).toISOString(),data]);
    }
    const coverage=[
      ['coverage-copy:1',1,'COPY','COPY:v2:1','BATCH_RETURN','COPY:v2:1:BATCH_RETURN',{sourceEventId:3}],
      ['coverage-copy:excluded',4,'COPY','COPY:v2:4','BATCH_RETURN','COPY:v2:1:BATCH_RETURN',{sourceEventId:3,exclusion:'SELF_REVIEW'}],
      ['coverage-copy:release',5,'COPY','COPY:v2:5','BATCH_RELEASE','COPY:v2:1:BATCH_RELEASE',{}],
      ['coverage-image:release',1,'IMAGE','IMAGE:legacy:1:1','BATCH_RELEASE','IMAGE:release:1',{}],
    ];
    for(let index=0;index<coverage.length;index++){
      const[id,task,stage,key,kind,operation,data]=coverage[index];
      await pool.query(`INSERT INTO quality_review_coverage_events(event_key,task_id,account_id,stage,review_item_key,kind,operation_key,occurred_at,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,task,actor.userId,stage,key,kind,operation,new Date(Date.parse(start)+20_000+index*1000).toISOString(),data]);
    }
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES('submit-first',1,$1,'COPY','SUBMIT',$2,'{}'),('submit-rework',1,$1,'COPY','SUBMIT',$2::timestamptz+interval '1 second','{"rework":true}'),
      ('submit-repeat',1,$1,'COPY','SUBMIT',$2::timestamptz+interval '2 seconds','{}')`,[actor.userId,start]);
    await pool.query(`INSERT INTO account_quality_events(event_key,task_id,account_id,stage,action,occurred_at,data)
      VALUES('verdict-return',1,$1,'COPY','RETURN',$2,'{}'),('verdict-pass',1,$1,'COPY','PASS',$2::timestamptz+interval '1 second','{}'),
      ('image-first-pass',2,$1,'IMAGE','PASS',$2,'{"sampleKind":"RANDOM"}')`,[actor.userId,start]);
    const submissions=(await pool.query(PERSONAL_SUBMISSIONS_SQL,[actor.userId,new Date(range.startMs).toISOString(),new Date(range.endMs).toISOString()])).rows
      .map(row=>({id:row.id,taskId:Number(row.task_id),kind:'COMPLETE',stage:row.stage,at:iso(row.at),firstSubmission:row.first_submission,rework:row.rework}));
    const quality=await readAccountQualityFacts(pool,{start:new Date(range.startMs).toISOString(),end:new Date(range.endMs).toISOString(),accountId:actor.userId});
    const qaFacts=(await pool.query(PERSONAL_QA_EVENTS_SQL,[actor.userId,new Date(range.startMs).toISOString(),new Date(range.endMs).toISOString()])).rows
      .map(row=>({...row.data,id:row.event_key,taskId:row.task_id==null?null:Number(row.task_id),accountId:Number(row.account_id),
        stage:row.stage,kind:row.kind,at:iso(row.occurred_at),sampleKind:row.effective_sample_kind??row.data.sampleKind??null}));
    const coverageFacts=await readPersonalQaCoverage(pool,actor,range);
    assert.deepEqual(await readPersonalPeriodSummary(pool,actor,range,now),summarizePersonalToday(submissions,quality,qaFacts,range,now,coverageFacts));
    for(const stage of ['','COPY','IMAGE'])for(const metric of ['qaActual','qaFirst','qaRecheck','qaPassed','qaReturned','qaCoverage','qaBatchReturned','qaBatchReleased','qaDiscarded','qaEscalated']){
      const expected=personalQaMetricRows(qaFacts,coverageFacts,metric,stage).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
      const result=await readPersonalReceipts(pool,actor,{...filters,stage,pageSize:2,page:2},metric,'',now);
      const page=Math.min(2,Math.max(1,Math.ceil(expected.length/2)));
      assert.equal(result.total,expected.length,`${stage} ${metric} total`);
      assert.deepEqual(result.rows.map(row=>row.id),expected.slice((page-1)*2,page*2).map(row=>row.id),`${stage} ${metric} page`);
      for(const row of result.rows){const match=expected.find(value=>value.id===row.id);assert.equal(row.sample_kind,match.sampleKind??null);
        assert.deepEqual(row.coverage_sources,match.coverageSources);assert.deepEqual(row.manual_kinds??[],match.manualKinds);}
    }
    await pool.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      SELECT 'mass-submit:'||n,100+n,$1,'IMAGE','SUBMIT',$2,'{}' FROM generate_series(1,50010) n`,[actor.userId,start]);
    const complete=await readPersonalReceipts(pool,actor,{...filters,stage:'IMAGE',pageSize:20,page:2501},'submitAll','',now);
    assert.equal(complete.total,50010);assert.equal(complete.rows.length,10);
    const full=await readPersonalPeriodSummary(pool,actor,range,now);assert.equal(full.annotation.IMAGE.submissions,50010);
    const history=await repository.personalWorkspace(actor,{mode:'COMPLETED',stage:'IMAGE',period:'custom',
      from:range.from,to:range.to,pageSize:'20',page:'2501'});
    assert.equal(history.total,50010);assert.equal(history.items.length,10);
    assert.ok(history.items.every(row=>row.state==='HISTORY_ONLY' && row.canOpen===false));
  }finally{await repository.pool.end();await database.stop();}
});
