import assert from 'node:assert/strict';
import test from 'node:test';
import { readPersonalQualityActivity, readPersonalWorkspace } from '../src/personal-workspace.mjs';
const actor={userId:11,username:'worker',role:'USER'};

function fake({historyFails=false,deliveryFails=false,qaFails=false,canOpen=false}={}) {
  const calls=[]; let released=false;
  const client={release(){released=true;},async query(sql,values){
    calls.push({sql,values});
    if(qaFails&&sql.includes('FROM quality_review_activity_events'))throw Error('quality activity unavailable');
    if(sql.startsWith('WITH personal_events')){
      if(historyFails)throw Error('history unavailable');
      return {rows:[{id:'copy:1',task_id:1,kind:'COMPLETE',stage:'COPY',at:new Date(),rework:false,reasons:[]}]};
    }
    if(sql.startsWith('SELECT task.id'))return {rows:[{id:1,query:'my task',state:'COPY_REVIEW_PENDING',created_at:new Date(),queue_entered_at:new Date(),priority_sort_at:new Date(),is_assigned:true,is_created:true,has_access:canOpen}]};
    if(sql.startsWith('SELECT b.id AS batch_id')){if(deliveryFails)throw Error('delivery unavailable');return{rows:[]};}
    return{rows:[]};
  }};
  return{pool:{async connect(){return client;}},calls,get released(){return released;}};
}
test('personal statistics isolate unavailable history and delivery instead of silently reporting zero',async()=>{
  const db=fake({historyFails:true,deliveryFails:true});
  const report=await readPersonalWorkspace(db.pool,actor,{}, {report:true,blindSql:'false'});
  assert.equal(report.counts.copyInitial,1);assert.equal(report.period,null);assert.equal(report.pendingDeliveryBatches,null);
  assert.equal(report.notices.length,2);assert.equal(db.released,true);
  assert.ok(db.calls.some(call=>call.sql==='ROLLBACK TO SAVEPOINT personal_history'));
  assert.equal(db.calls.at(-1).sql,'COMMIT');
});

test('unavailable QA history is null, leaves production available and releases its savepoint',async()=>{
  const db=fake({qaFails:true});
  const report=await readPersonalWorkspace(db.pool,actor,{}, {report:true,blindSql:'false'});
  assert.equal(report.qa,null);assert.equal(report.contribution,null);assert.equal(report.qaTrend,null);
  assert.equal(report.period.completed,1);assert.equal(report.counts.copyInitial,1);
  assert.match(report.notices.join(' '),/质检贡献暂不可用/);
  assert.ok(db.calls.some(call=>call.sql==='ROLLBACK TO SAVEPOINT personal_qa'));
  assert.equal(db.calls.at(-1).sql,'COMMIT');
});
test('historical list failures fail explicitly and roll back; they never masquerade as an empty list',async()=>{
  const db=fake({historyFails:true});
  await assert.rejects(readPersonalWorkspace(db.pool,actor,{mode:'COMPLETED'},{blindSql:'false'}),/history unavailable/);
  assert.equal(db.calls.at(-1).sql,'ROLLBACK');assert.equal(db.released,true);
});
test('current list avoids historical aggregation and only hydrates accessible page ids',async()=>{
  const db=fake({canOpen:true});let loaded;
  const page=await readPersonalWorkspace(db.pool,actor,{}, {blindSql:'false',loadTasks:async(client,ids)=>{loaded=ids;return[{id:1,query:'my task'}];}});
  assert.deepEqual(loaded,[1]);assert.equal(page.total,1);assert.equal(page.items[0].canOpen,true);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH personal_events')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT b.id AS batch_id')),false);
});
test('read-only historical rows do not hydrate current detail',async()=>{
  const db=fake();
  const page=await readPersonalWorkspace(db.pool,actor,{mode:'COMPLETED'}, {blindSql:'false',loadTasks:()=>{throw Error('must not hydrate');}});
  assert.equal(page.items[0].canOpen,false);assert.equal(page.items[0].currentCopyRevisionId,null);
  assert.equal(page.items[0].personalWork,null);
  assert.equal(page.items[0].personalHistory[0].kind,'COMPLETE');
});

function todayFake() {
  const calls=[];
  const submissions=[
    {id:'copy-submit:1',task_id:1,stage:'COPY',at:new Date(),first_submission:true,rework:false},
    {id:'copy-submit:2',task_id:1,stage:'COPY',at:new Date(),first_submission:false,rework:true},
    {id:'copy-submit:repeat',task_id:1,stage:'COPY',at:new Date(),first_submission:false,rework:false},
    {id:'image-submit:3',task_id:1,stage:'IMAGE',at:new Date(),first_submission:true,rework:false},
    {id:'image-submit:repeat',task_id:1,stage:'IMAGE',at:new Date(),first_submission:false,rework:false},
  ];
  const verdicts=[
    {event_key:'quality:1',task_id:1,stage:'COPY',account_id:actor.userId,
      occurred_at:new Date(),action:'RETURN',data:{},had_return:false,from_batch:false},
    {event_key:'quality:2',task_id:1,stage:'COPY',account_id:actor.userId,
      occurred_at:new Date(),action:'PASS',data:{},had_return:true,from_batch:false},
    {event_key:'quality:3',task_id:1,stage:'IMAGE',account_id:actor.userId,
      occurred_at:new Date(),action:'PASS',data:{sampleKind:'RANDOM'},had_return:false,from_batch:false},
  ];
  const reviews=[
    {event_key:'copy-v2:1',task_id:1,stage:'COPY',account_id:actor.userId,
      kind:'QA_REVIEW',occurred_at:new Date(),data:{outcome:'RETURN',samplingItemId:1},effective_sample_kind:'RANDOM'},
    {event_key:'copy-v2:2',task_id:1,stage:'COPY',account_id:actor.userId,
      kind:'QA_REVIEW',occurred_at:new Date(),data:{outcome:'PASS',samplingItemId:2},effective_sample_kind:'MANDATORY_RECHECK'},
    {event_key:'image-review:3',task_id:1,stage:'IMAGE',account_id:actor.userId,
      kind:'QA_REVIEW',occurred_at:new Date(),data:{outcome:'PASS',samplingItemId:3,sampleKind:'RANDOM'},effective_sample_kind:'RANDOM'},
    {event_key:'image-review:4',task_id:1,stage:'IMAGE',account_id:actor.userId,
      kind:'QA_REVIEW',occurred_at:new Date(),data:{outcome:'PASS',samplingItemId:4,sampleKind:'RANDOM',exclusion:'SELF_REVIEW'},effective_sample_kind:'RANDOM'},
  ];
  const client={release(){},async query(sql,values){
    calls.push({sql,values});
    if(sql=== 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql==='COMMIT' || sql.startsWith('SET LOCAL'))return{rows:[]};
    if(sql.startsWith('SELECT e.event_key AS id,e.task_id,e.stage'))return{rows:submissions};
    if(sql.startsWith('SELECT r.*,EXISTS'))return{rows:[]};
    if(sql.startsWith('WITH decisions AS'))return{rows:verdicts.filter(row=>!values[3]||row.stage===values[3])};
    if(sql.startsWith('SELECT e.*,'))return{rows:reviews};
    if(sql.startsWith('SELECT e.* FROM quality_review_coverage_events')
      || sql.startsWith('SELECT e.* FROM account_quality_events')
      || sql.startsWith('SELECT DISTINCT missing.stage'))return{rows:[]};
    if(sql.startsWith('SELECT task.id'))return{rows:[{id:1,query:'my task',state:'COPY_REVIEW_PENDING',
      created_at:new Date(),queue_entered_at:new Date(),priority_sort_at:new Date(),is_assigned:true,is_created:true,has_access:true}]};
    throw Error(`unexpected query: ${sql.slice(0,80)}`);
  }};
  return{pool:{async connect(){return client;}},calls};
}

test('today and jobs sections read only the facts each tab needs',async()=>{
  const db=todayFake();
  const today=await readPersonalWorkspace(db.pool,actor,{section:'personal',period:'30d'},
    {report:true,blindSql:'false'});
  assert.equal(today.section,'personal');
  assert.equal(today.range.from,today.range.to,'the personal section forces today');
  assert.deepEqual(today.annotation.COPY,{firstSubmissions:1,reworkSubmissions:1,submissions:3,
    quality:{firstPassed:0,passed:1,decided:2,firstPassRate:0,rate:0.5}});
  assert.equal(today.annotation.IMAGE.quality.firstPassRate,1);
  assert.equal(today.annotation.IMAGE.submissions,2,'ordinary repeated image submissions also count');
  assert.deepEqual(today.qa.COPY,{firstReviews:1,rechecks:1,passed:1,returned:1,reviews:2,
    actualOperations:2,processingCoverage:2,batchReturned:0,batchReleased:0,batchActions:0,
    discarded:0,escalated:0,coverageIncomplete:false});
  assert.equal(today.qa.IMAGE.reviews,1,'excluded self review does not count');
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT task.id')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT b.id AS batch_id')),false);
  db.calls.length=0;
  const jobs=await readPersonalWorkspace(db.pool,actor,{section:'jobs'}, {report:true,blindSql:'false'});
  assert.equal(jobs.section,'jobs');assert.equal(jobs.counts.copyInitial,1);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT task.id')),true);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT e.event_key AS id')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH decisions AS')),false);
});

test('today receipt totals match every event counter and conceal task identity',async()=>{
  const db=todayFake();
  const expected=[
    ['COPY','submitAll',3],['IMAGE','submitAll',2],
    ['COPY','submitFirst',1],['COPY','submitRework',1],['IMAGE','submitFirst',1],
    ['COPY','annotationOverall',2],['COPY','qaFirst',1],['COPY','qaRecheck',1],
    ['COPY','qaPassed',1],['COPY','qaReturned',1],['IMAGE','qaPassed',1],
  ];
  for(const [stage,metric,count] of expected) {
    const result=await readPersonalQualityActivity(db.pool,actor,{period:'today',stage,metric});
    assert.equal(result.total,count,`${stage} ${metric}`);
    for(const item of result.items) {
      assert.match(item.code,/^ACT-[A-F0-9]{12}$/u);
      assert.equal(item.taskId,undefined);assert.equal(item.query,undefined);
      assert.equal(item.accountId,undefined);
    }
  }
  assert.equal((await readPersonalQualityActivity(db.pool,actor,
    {period:'today',stage:'IMAGE',metric:'annotationOverall',sampleSet:'first'})).total,1);
  const allSubmissions=await readPersonalQualityActivity(db.pool,actor,
    {period:'today',stage:'COPY',metric:'submitAll'});
  assert.deepEqual(allSubmissions.items.map(item=>item.submissionType).sort(),['FIRST','REPEAT','REWORK']);
  await assert.rejects(readPersonalQualityActivity(db.pool,actor,{metric:'qaFirst',sampleSet:'first'}),/指标无效/);
});
