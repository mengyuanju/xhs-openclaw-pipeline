import assert from 'node:assert/strict';
import test from 'node:test';
import { readAnnotationAssignmentReport, ANNOTATION_SUBMISSIONS_SQL, ANNOTATION_ASSIGNMENTS_SQL,
  ANNOTATION_FIRST_COPY_SQL } from '../src/annotation-assignment-report.mjs';

const at=day=>`2026-09-${String(day).padStart(2,'0')}T02:00:00Z`;
const submission=(id,day,accountId,extra={})=>({event_key:`copy-submit:${id}`,task_id:1,account_id:accountId,
  stage:'COPY',occurred_at:at(day),sequence_id:id,data:{username:`worker-${accountId}`,approvalId:id,
    copyRevisionId:id,rework:true,...extra}});
const periodWork=row=>({...row.data,id:row.event_key,taskId:row.task_id,accountId:row.account_id,
  stage:row.stage,kind:'SUBMIT',at:row.occurred_at});
const assignment=(id,day,accountId,extra={})=>({id:`event:${id}`,ordering:id,kind:'EVENT',task_id:1,
  account_id:accountId,username:`worker-${accountId}`,occurred_at:at(day),...extra});
const report=rows=>({rows,asOf:at(28),range:{from:'2026-09-13',to:'2026-09-24'}});
function fakeClient({submissions=[],assignments=[],discards=[],quality=()=>[]}={}) {
  const calls=[];
  return {calls,async query(sql,params){
    calls.push({sql,params});
    if(sql===ANNOTATION_SUBMISSIONS_SQL)return {rows:submissions};
    if(sql===ANNOTATION_ASSIGNMENTS_SQL)return {rows:assignments};
    if(sql===ANNOTATION_FIRST_COPY_SQL)return {rows:quality(JSON.parse(params[0]))};
    if(sql.includes('WITH discards AS'))return {rows:discards};
    throw new Error('Unexpected query');
  }};
}

 test('handoff classification uses full task history and pins the new owner first QA to their approval',async()=>{
  const older=submission(101,10,11),first=submission(202,20,22),later=submission(203,21,22);
  const selected=report([periodWork(first),periodWork(later)]);
  const db=fakeClient({submissions:[older,first,later],assignments:[assignment(1,9,11),assignment(2,19,22,
    {previous_account_id:11,previous_username:'worker-11'})],quality:cohort=>{
    assert.equal(cohort.length,1);assert.equal(cohort[0].approval_id,202);assert.equal(cohort[0].account_id,22);
    return cohort.map(row=>({...row,outcome:'RETURN',reason:null}));
  }});
  const result=await readAnnotationAssignmentReport(db,selected);
  assert.deepEqual(result.report.rows.map(row=>row.annotationFirst),[true,false]);
  assert.equal(result.report.rows[0].rework,true,'original workflow classification is preserved');
  assert.equal(selected.rows[0].annotationFirst,undefined,'the general snapshot stays unchanged');
  assert.equal(result.firstCopyVerdicts[0].outcome,'RETURN');
  assert.equal(result.firstCopyVerdicts[0].submitted,true);
  for(const call of db.calls.filter(call=>call.sql!==ANNOTATION_FIRST_COPY_SQL)) {
    assert.deepEqual(call.sql.includes('WITH discards AS')?call.params[6]:call.params[0],[1]);
  }
  assert.equal(db.calls.find(call=>call.sql===ANNOTATION_FIRST_COPY_SQL).params[1],selected.asOf,
    'first QA follows the report time, including decisions after the selected last day');
});

 test('a previous first operation prevents an in-range submission from becoming a new first',async()=>{
  const older=submission(101,10,11),current=submission(102,20,11);
  const db=fakeClient({submissions:[older,current],assignments:[assignment(1,9,11)]});
  const result=await readAnnotationAssignmentReport(db,report([periodWork(current)]));
  assert.equal(result.report.rows[0].annotationFirst,false);
  assert.deepEqual(result.firstCopyVerdicts,[]);
  assert.equal(db.calls.some(call=>call.sql===ANNOTATION_FIRST_COPY_SQL),false);
});

 test('the same account returning to a task has independent first approvals and QA results',async()=>{
  const first=submission(101,14,11),other=submission(202,18,22),returned=submission(303,23,11);
  const db=fakeClient({submissions:[first,other,returned],assignments:[assignment(1,13,11),
    assignment(2,17,22),assignment(3,22,11)],quality:cohort=>{
    assert.deepEqual(cohort.map(row=>row.approval_id),[101,303]);
    return cohort.map((row,index)=>({...row,outcome:index?'DISCARD':'PASS',reason:null}));
  }});
  const result=await readAnnotationAssignmentReport(db,report([periodWork(first),periodWork(returned)]));
  assert.deepEqual(result.report.rows.map(row=>row.annotationFirst),[true,true]);
  assert.notEqual(result.firstCopyVerdicts[0].cycleKey,result.firstCopyVerdicts[1].cycleKey);
  assert.deepEqual(result.firstCopyVerdicts.map(row=>row.outcome),['PASS','DISCARD']);
});

 test('direct discard followed by restoration uses the first later approval in that same cycle',async()=>{
  const submit=submission(202,25,11);
  const discard={event_key:'copy-review:7',task_id:1,account_id:11,username:'worker-11',stage:'COPY',
    occurred_at:at(20),rework:false};
  const periodDiscard={id:'annotation-discard:copy-review:7',taskId:1,accountId:11,stage:'COPY',
    kind:'ANNOTATION_DISCARD',at:at(20),rework:false};
  const db=fakeClient({submissions:[submit],discards:[discard],quality:cohort=>{
    assert.equal(cohort[0].approval_id,202);return cohort.map(row=>({...row,outcome:null,reason:'PENDING'}));
  }});
  const result=await readAnnotationAssignmentReport(db,report([periodDiscard]));
  assert.equal(result.firstCopyVerdicts[0].submitted,true);
  assert.equal(result.firstCopyVerdicts[0].reason,'PENDING');
  assert.equal(result.report.rows[0].annotationFirst,true);
});

 test('direct-discard-only first cycles stay in the cohort without becoming QA failures',async()=>{
  const discard={event_key:'copy-review:7',task_id:1,account_id:11,username:'worker-11',stage:'COPY',
    occurred_at:at(20),rework:false};
  const periodDiscard={id:'annotation-discard:copy-review:7',taskId:1,accountId:11,stage:'COPY',
    kind:'ANNOTATION_DISCARD',at:at(20),rework:false};
  const db=fakeClient({discards:[discard]});
  const result=await readAnnotationAssignmentReport(db,report([periodDiscard]));
  assert.equal(result.firstCopyVerdicts[0].submitted,false);
  assert.equal(result.firstCopyVerdicts[0].outcome,null);
  assert.equal(result.firstCopyVerdicts[0].reason,undefined);
  assert.equal(db.calls.some(call=>call.sql===ANNOTATION_FIRST_COPY_SQL),false);
});

 test('pending, administrative direct release, unsampled but unreleased, and absent records have distinct explanations',async()=>{
  const submissions=[1,2,3,4].map(taskId=>({...submission(100+taskId,20,11),task_id:taskId}));
  const reasons=['PENDING','ADMIN_DIRECT','NOT_SELECTED','NO_RECORD'];
  const db=fakeClient({submissions,quality:cohort=>cohort.map((row,index)=>({...row,outcome:null,reason:reasons[index]}))});
  const result=await readAnnotationAssignmentReport(db,report(submissions.map(periodWork)));
  assert.deepEqual(result.firstCopyVerdicts.map(row=>row.reason),reasons);
  assert.ok(result.firstCopyVerdicts.every(row=>row.submitted&&row.outcome===null));
});

 test('first-copy verdicts carry batch-release passes while retaining unreleased and failed outcomes',async()=>{
  // The PostgreSQL regression verifies how these verdicts are produced. This checks
  // that the unchanged report contract carries every result to its exact first cycle.
  const cases=[
    {label:'人工质检通过',outcome:'PASS',reason:null},
    {label:'未抽中且RELEASED',outcome:'PASS',reason:null},
    {label:'有批次放行事实',outcome:'PASS',reason:null},
    {label:'未抽中尚未放行',outcome:null,reason:'NOT_SELECTED'},
    {label:'抽中待检',outcome:null,reason:'PENDING'},
    {label:'批次整体驳回BATCH_AFFECTED',outcome:'RETURN',reason:null},
    {label:'管理员直接放行',outcome:null,reason:'ADMIN_DIRECT'},
  ];
  const submissions=cases.map((row,index)=>({...submission(401+index,20,11),task_id:index+1}));
  const db=fakeClient({submissions,quality:cohort=>{
    assert.deepEqual(cohort.map(row=>row.approval_id),submissions.map(row=>row.data.approvalId));
    assert.ok(cohort.every(row=>row.account_id===11&&row.submitted_at===at(20)));
    return cohort.map((row,index)=>({...row,outcome:cases[index].outcome,reason:cases[index].reason}));
  }});
  const result=await readAnnotationAssignmentReport(db,report(submissions.map(periodWork)));
  assert.equal(result.firstCopyVerdicts.length,cases.length);
  for(let index=0;index<cases.length;index++) {
    const verdict=result.firstCopyVerdicts[index],expected=cases[index];
    assert.equal(verdict.taskId,index+1,expected.label);
    assert.equal(verdict.accountId,11,expected.label);
    assert.equal(verdict.submitted,true,expected.label);
    assert.equal(verdict.outcome,expected.outcome,expected.label);
    assert.equal(verdict.reason,expected.reason??undefined,expected.label);
  }
  assert.equal(new Set(result.firstCopyVerdicts.map(row=>row.cycleKey)).size,cases.length);
  assert.equal(db.calls.find(call=>call.sql===ANNOTATION_FIRST_COPY_SQL).params[1],at(28),
    'release and QA verdicts are bounded by the same report asOf');
});

 test('copy first QA SQL binds exact approval identities and excludes dispositions and self/direct review',()=>{
  assert.match(ANNOTATION_FIRST_COPY_SQL,/approved\.approved_by_account_id=cohort\.account_id/u);
  assert.match(ANNOTATION_FIRST_COPY_SQL,/member\.approval_event_id=COALESCE\(approval\.id,cohort\.approval_id\)/u);
  assert.match(ANNOTATION_FIRST_COPY_SQL,/item\.approval_event_id=COALESCE\(approval\.id,cohort\.approval_id\)/u);
  assert.match(ANNOTATION_FIRST_COPY_SQL,/verdict\.establishes_sample/u);
  assert.match(ANNOTATION_FIRST_COPY_SQL,/verdict\.data->>'reviewerId'<>cohort\.account_id::text/u);
  assert.match(ANNOTATION_FIRST_COPY_SQL,/AND NOT direct\.present/u);
  assert.doesNotMatch(ANNOTATION_FIRST_COPY_SQL,/account_quality_records|first_event_key|sample_kind='RANDOM'/u);
});

 test('oversized history fails explicitly instead of classifying truncated first operations',async()=>{
  const current=submission(1,20,11);
  const db=fakeClient({submissions:Array.from({length:50_001},()=>current)});
  await assert.rejects(readAnnotationAssignmentReport(db,report([periodWork(current)])),/50,000/u);
});

 test('a quality-only report does not query unrelated task history',async()=>{
  const selected=report([{taskId:1,accountId:11,kind:'ANNOTATION_QUALITY',stage:'COPY',at:at(20)}]);
  const db=fakeClient();
  const result=await readAnnotationAssignmentReport(db,selected);
  assert.equal(result.report,selected);
  assert.deepEqual(result.firstCopyVerdicts,[]);
  assert.deepEqual(db.calls,[]);
});