import assert from 'node:assert/strict';
import test from 'node:test';
import { readPersonalQualityActivity, readPersonalWorkspace } from '../src/personal-workspace.mjs';
import { normalizeRange } from '../../src/web-statistics/summary.mjs';
import { summarizePersonalToday } from '../../src/personal-workspace.mjs';
import { personalQaMetricRows } from '../../src/personal-qa-statistics.mjs';
const actor={userId:11,username:'worker',role:'USER'};

function fake({historyFails=false,deliveryFails=false,qaFails=false,canOpen=false}={}) {
  const calls=[]; let released=false;
  const client={release(){released=true;},async query(sql,values){
    calls.push({sql,values});
    if(historyFails && sql.includes('core_events AS'))throw Error('history unavailable');
    if(sql.startsWith('WITH facts AS') && sql.includes('FROM filtered f'))return{rows:[{ALL:1,actionable:1,review:1,copyInitial:1}]};
    if(sql.startsWith('WITH facts AS'))return{rows:[{id:1}]};
    if(sql.startsWith('SELECT id FROM'))return{rows:[{id:1}]};
    if(sql.startsWith('WITH RECURSIVE core_events'))return{rows:[{event_key:'copy:1',task_id:1,kind:'COMPLETE',stage:'COPY',occurred_at:new Date(),data:{},first_recheck:false,round_known:false}]};
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

function todayFake({extraSubmissions=[],extraDiscards=[]}={}) {
  const calls=[];
  const submissions=[
    {id:'copy-submit:1',task_id:1,stage:'COPY',at:new Date(),first_submission:true,rework:false},
    {id:'copy-submit:2',task_id:1,stage:'COPY',at:new Date(),first_submission:false,rework:true},
    {id:'copy-submit:repeat',task_id:1,stage:'COPY',at:new Date(),first_submission:false,rework:false},
    {id:'image-submit:3',task_id:1,stage:'IMAGE',at:new Date(),first_submission:true,rework:false},
    {id:'image-submit:repeat',task_id:1,stage:'IMAGE',at:new Date(),first_submission:false,rework:false},
    ...extraSubmissions,
  ];
  const discards=[
    {event_key:'copy-review:1',task_id:2,account_id:actor.userId,username:actor.username,
      stage:'COPY',occurred_at:new Date(),rework:false,query:'private annotation discard'},
    {event_key:'copy-return:1',task_id:2,account_id:actor.userId,username:actor.username,
      stage:'COPY',occurred_at:new Date(),rework:true,query:'private rework discard'},
    {event_key:'copy-review:other',task_id:2,account_id:99,username:'other',
      stage:'COPY',occurred_at:new Date(),rework:false,query:'another operator discard'},
    {event_key:'image-review:1',task_id:2,account_id:actor.userId,username:actor.username,
      stage:'IMAGE',occurred_at:new Date(),rework:false,query:'private image discard'},
    ...extraDiscards,
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
  const oracleFacts=values=>{
    const selected=row=>Date.parse(row.at??row.occurred_at)>=Date.parse(values[1])
      && Date.parse(row.at??row.occurred_at)<Date.parse(values[2]);
    return {
      submissions:submissions.filter(selected).map(row=>({...row,taskId:row.task_id,kind:'COMPLETE',firstSubmission:row.first_submission})),
      quality:verdicts.filter(selected).map(row=>({...row.data,id:row.event_key,kind:'ANNOTATION_QUALITY',stage:row.stage,
        accountId:row.account_id,at:row.occurred_at,outcome:row.action,firstPassed:row.action==='PASS' && !row.had_return
          && row.data.sampleKind!=='MANDATORY_RECHECK'})),
      qa:reviews.filter(selected).map(row=>({...row.data,id:row.event_key,taskId:row.task_id,accountId:row.account_id,
        stage:row.stage,kind:row.kind,at:row.occurred_at,sampleKind:row.effective_sample_kind})),
      discarded:discards.filter(row=>selected(row)&&row.account_id===values[0]&&row.stage==='COPY'
        && Date.parse(row.occurred_at)<=Date.parse(values[3])).map(row=>({...row,id:'annotation-discard:'+row.event_key,
        kind:'ANNOTATION_DISCARD',accountId:row.account_id,taskId:row.task_id,at:row.occurred_at,outcome:'DISCARD'})),
    };
  };
  const client={release(){},async query(sql,values){
    calls.push({sql,values});
    if(sql=== 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql==='COMMIT' || sql.startsWith('SET LOCAL'))return{rows:[]};
    if(sql.startsWith('WITH personal_submissions')){
      const facts=oracleFacts(values),range={startMs:Date.parse(values[1]),endMs:Date.parse(values[2])};
      const report=summarizePersonalToday(facts.submissions,facts.quality,facts.qa,range,Date.parse(values[3]),[],facts.discarded);
      return{rows:['COPY','IMAGE'].map(stage=>{
        const a=report.annotation[stage],q=report.qa[stage];return{stage,submissions:a.submissions,first_submissions:a.firstSubmissions,
          rework_submissions:a.reworkSubmissions,annotation_discarded:a.discarded,decided:a.quality.decided,
          annotation_passed:a.quality.passed,first_passed:a.quality.firstPassed,reviews:q.reviews,actual_operations:q.actualOperations,
          processing_coverage:q.processingCoverage,qa_first:q.firstReviews,rechecks:q.rechecks,passed:q.passed,returned:q.returned,
          batch_returned:q.batchReturned,batch_released:q.batchReleased,batch_actions:q.batchActions,discarded:q.discarded,
          escalated:q.escalated,coverage_incomplete:q.coverageIncomplete};
      })};
    }
    if(sql.startsWith('/* personal_receipts:')) {
      const[,metric,sampleSet]=sql.match(/^\/\* personal_receipts:([a-zA-Z]+):([a-zA-Z]*)/u),facts=oracleFacts(values);
      let rows;
      if(metric.startsWith('submit')||metric==='copyFirstReview'||metric==='annotationDiscarded') {
        rows=facts.submissions.filter(row=>(!values[4]||row.stage===values[4]) && (metric==='copyFirstReview'
          ? row.stage==='COPY'&&row.firstSubmission&&!row.rework:metric==='submitFirst'?row.firstSubmission&&!row.rework
          :metric==='submitRework'?row.rework:true)).map(row=>({...row,kind:'SUBMIT',submissionType:row.rework?'REWORK':row.firstSubmission?'FIRST':'REPEAT'}));
        if(metric==='annotationDiscarded')rows=facts.discarded;
        if(metric==='copyFirstReview')rows.push(...facts.discarded);
      } else if(metric==='annotationOverall')rows=facts.quality.filter(row=>(!values[4]||row.stage===values[4])&&
        (sampleSet==='first'?row.firstPassed:sampleSet==='passed'?row.outcome==='PASS':sampleSet==='failed'?row.outcome==='RETURN':true));
      else rows=personalQaMetricRows(facts.qa,[],metric,values[4]);
      rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
      if(sql.includes('SELECT count(*) AS total'))return{rows:[{total:rows.length,coverage_incomplete:false}]};
      return{rows:rows.slice(values[6],values[6]+values[5]).map(row=>({...row,sample_kind:row.sampleKind??null,
        submission_type:row.submissionType??null,first_passed:row.firstPassed===true,coverage_sources:row.coverageSources,manual_kinds:row.manualKinds}))};
    }
    if(sql.startsWith('WITH facts AS') && sql.includes('FROM filtered f'))return{rows:[{ALL:1,actionable:1,review:1,copyInitial:1}]};
    if(sql.startsWith('SELECT e.event_key AS id,e.task_id,e.stage'))return{rows:submissions.filter(row=>
      Date.parse(row.at)>=Date.parse(values[1]) && Date.parse(row.at)<Date.parse(values[2]))};
    if(sql.startsWith('WITH discards AS'))return{rows:discards.filter(row=>
      row.account_id===values[3] && (!values[4] || row.stage===values[4])
      && Date.parse(row.occurred_at)>=Date.parse(values[0]) && Date.parse(row.occurred_at)<Date.parse(values[1])
      && Date.parse(row.occurred_at)<=Date.parse(values[2]))};
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

test('personal statistics honor the selected period and jobs read only their own facts',async()=>{
  const db=todayFake();
  const today=await readPersonalWorkspace(db.pool,actor,{section:'personal',period:'30d'},
    {report:true,blindSql:'false'});
  assert.equal(today.section,'personal');
  const range=normalizeRange({period:'30d'});
  assert.deepEqual(today.range,{from:range.from,to:range.to});
  assert.deepEqual(today.annotation.COPY,{firstReviews:3,discarded:2,firstSubmissions:1,reworkSubmissions:1,submissions:3,
    quality:{firstPassed:0,passed:1,decided:2,firstPassRate:0,rate:0.5}});
  assert.equal(today.annotation.IMAGE.quality.firstPassRate,1);
  assert.equal(today.annotation.IMAGE.submissions,2,'ordinary repeated image submissions also count');
  assert.equal(today.annotation.IMAGE.firstReviews,1);assert.equal(today.annotation.IMAGE.discarded,0);
  assert.deepEqual(today.qa.COPY,{firstReviews:1,rechecks:1,passed:1,returned:1,reviews:2,
    actualOperations:2,processingCoverage:2,batchReturned:0,batchReleased:0,batchActions:0,
    discarded:0,escalated:0,coverageIncomplete:false});
  assert.equal(today.qa.IMAGE.reviews,1,'excluded self review does not count');
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT task.id')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT b.id AS batch_id')),false);
  const aggregateQuery=db.calls.find(call=>call.sql.startsWith('WITH personal_submissions'));
  assert.equal(aggregateQuery.values[0],actor.userId,'all sources use the historical actor account');
  assert.match(aggregateQuery.sql,/discard\.stage='COPY'/u,'only annotation copy discards contribute');
  assert.doesNotMatch(aggregateQuery.sql,/LIMIT 50001/u,'the aggregate remains complete above the old event cap');
  db.calls.length=0;
  const jobs=await readPersonalWorkspace(db.pool,actor,{section:'jobs'}, {report:true,blindSql:'false'});
  assert.equal(jobs.section,'jobs');assert.equal(jobs.counts.copyInitial,1);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH facts AS')),true);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT e.event_key AS id')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH decisions AS')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH discards AS')),false);
});

test('today receipt totals match every event counter and conceal task identity',async()=>{
  const db=todayFake();
  const expected=[
    ['COPY','submitAll',3],['IMAGE','submitAll',2],
    ['COPY','submitFirst',1],['COPY','submitRework',1],['IMAGE','submitFirst',1],
    ['COPY','copyFirstReview',3],['COPY','annotationDiscarded',2],
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
  const discarded=await readPersonalQualityActivity(db.pool,actor,{stage:'COPY',metric:'annotationDiscarded'});
  assert.ok(discarded.items.every(item=>item.kind==='ANNOTATION_DISCARD' && item.outcome==='DISCARD'));
  assert.doesNotMatch(JSON.stringify(discarded),/private|other|worker/u);
  const combined=await readPersonalQualityActivity(db.pool,actor,{metric:'copyFirstReview',pageSize:2,page:2});
  assert.equal(combined.total,3);assert.equal(combined.page,2);assert.equal(combined.items.length,1);
  await assert.rejects(readPersonalQualityActivity(db.pool,actor,{metric:'qaFirst',sampleSet:'first'}),/指标无效/);
  await assert.rejects(readPersonalQualityActivity(db.pool,actor,{metric:'copyFirstReview',stage:'IMAGE'}),/指标无效/);
});

test('seven-day statistics pass the same Shanghai range to submissions and discards',async()=>{
  const range=normalizeRange({period:'7d'});
  const at=new Date(range.startMs).toISOString();
  const db=todayFake({
    extraSubmissions:[{id:'copy-submit:week-start',task_id:5,stage:'COPY',at,first_submission:true,rework:false}],
    extraDiscards:[{event_key:'copy-review:week-start',task_id:5,account_id:actor.userId,
      username:actor.username,stage:'COPY',occurred_at:at,rework:false}],
  });
  const report=await readPersonalWorkspace(db.pool,actor,{section:'personal',period:'7d'},{report:true});
  assert.deepEqual(report.range,{from:range.from,to:range.to});
  assert.equal(report.annotation.COPY.firstSubmissions,2);assert.equal(report.annotation.COPY.discarded,3);
  assert.equal(report.annotation.COPY.firstReviews,5);
  const aggregateQuery=db.calls.find(call=>call.sql.startsWith('WITH personal_submissions'));
  assert.deepEqual(aggregateQuery.values.slice(1,3),[at,new Date(range.endMs).toISOString()]);
  assert.match(aggregateQuery.sql,/assessment\.created_at>=\$2 AND assessment\.created_at<\$3/u);
  const detail=await readPersonalQualityActivity(db.pool,actor,{period:'7d',metric:'copyFirstReview'});
  assert.equal(detail.total,report.annotation.COPY.firstReviews);
});

test('custom personal range includes its first midnight and excludes the next midnight in counts and receipts',async()=>{
  const input={period:'custom',from:'2026-09-15',to:'2026-09-16'};
  const timestamps=['2026-09-14T15:59:59.999Z','2026-09-14T16:00:00.000Z',
    '2026-09-16T15:59:59.999Z','2026-09-16T16:00:00.000Z'];
  const db=todayFake({
    extraSubmissions:timestamps.map((at,index)=>({id:`copy-submit:custom-${index}`,task_id:10+index,
      stage:'COPY',at,first_submission:true,rework:false})),
    extraDiscards:timestamps.map((occurred_at,index)=>({event_key:`copy-return:custom-${index}`,task_id:10+index,
      account_id:actor.userId,username:actor.username,stage:'COPY',occurred_at,rework:true})),
  });
  const report=await readPersonalWorkspace(db.pool,actor,{section:'personal',...input},{report:true});
  assert.deepEqual(report.range,{from:input.from,to:input.to});
  assert.equal(report.annotation.COPY.firstSubmissions,2);assert.equal(report.annotation.COPY.discarded,2);
  assert.equal(report.annotation.COPY.firstReviews,4);
  for(const [metric,field] of [['copyFirstReview','firstReviews'],['annotationDiscarded','discarded'],['submitFirst','firstSubmissions']]) {
    const detail=await readPersonalQualityActivity(db.pool,actor,{...input,stage:'COPY',metric});
    assert.equal(detail.total,report.annotation.COPY[field]);
    assert.ok(detail.items.every(item=>timestamps.slice(1,3).includes(item.at)));
  }
  await assert.rejects(readPersonalWorkspace(db.pool,actor,{section:'personal',period:'custom',
    from:'2026-09-17',to:'2026-09-16'},{report:true}),/日期范围/);
});
