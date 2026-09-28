import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateAssignmentCycles, firstCopyAssignmentCohort } from '../src/annotation-assignment-cycles.mjs';

const at=day=>`2026-09-${String(day).padStart(2,'0')}T02:00:00Z`;
const work=(id,day,accountId,extra={})=>({id,at:at(day),accountId,taskId:1,stage:'COPY',kind:'SUBMIT',
  username:`worker-${accountId}`,approvalId:Number(id.replace(/\D/gu,''))||1,copyRevisionId:day,...extra});
const assignment=(id,day,accountId,extra={})=>({id:`event:${id}`,order:id,at:at(day),taskId:1,
  kind:'EVENT',accountId,username:accountId==null?null:`worker-${accountId}`,...extra});

test('ordinary handoff starts personal first copy and image work despite workflow rework flags',()=>{
  const rows=[work('submit-1',10,11),work('submit-2',12,22,{rework:true}),
    work('submit-3',13,22,{rework:true}),work('image-4',14,22,{stage:'IMAGE',rework:true}),
    work('image-5',15,22,{stage:'IMAGE',rework:true})];
  const result=annotateAssignmentCycles(rows,[assignment(1,9,11),assignment(2,11,22,{previousAccountId:11})]);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,true,false,true,false]);
  assert.equal(result[1].rework,true,'workflow facts remain untouched');
  assert.notEqual(result[1].annotationCycleKey,result[3].annotationCycleKey);
  assert.equal(rows[0].annotationCycleKey,undefined,'input facts remain unchanged');
});

test('the same person receives a new cycle after handing the task away and receiving it back',()=>{
  const result=annotateAssignmentCycles([work('submit-1',10,11),work('submit-2',12,22),
    work('submit-3',14,11),work('submit-4',15,11)],
  [assignment(1,9,11),assignment(2,11,22,{previousAccountId:11}),assignment(3,13,11,{previousAccountId:22})]);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,true,true,false]);
  assert.notEqual(result[0].annotationCycleKey,result[2].annotationCycleKey);
});

test('work before the selected dates establishes the first operation before filtering',()=>{
  const result=annotateAssignmentCycles([work('submit-1',10,11),work('submit-2',24,11,{rework:true})],
    [assignment(1,9,11)]);
  assert.equal(result[1].annotationFirst,false);
  assert.deepEqual(firstCopyAssignmentCohort(result,[result[1]]),[]);
});

test('a migration baseline does not create a second first operation',()=>{
  const rows=[work('submit-1',10,11),work('submit-2',24,11)];
  const baseline={id:'record:50',order:50,taskId:1,kind:'RECORD',accountId:11,username:'worker-11',
    at:at(20),baseline:true};
  const withoutEvents=annotateAssignmentCycles(rows,[baseline]);
  assert.deepEqual(withoutEvents.map(row=>row.annotationFirst),[true,false]);
  const withEvents=annotateAssignmentCycles(rows,[assignment(1,9,11),baseline]);
  assert.deepEqual(withEvents.map(row=>row.annotationFirst),[true,false]);
});

test('records and their duplicate assignment events establish one handoff',()=>{
  const assignments=[assignment(1,9,11),assignment(2,20,22,{previousAccountId:11}),
    {id:'record:1',order:1,taskId:1,kind:'RECORD',accountId:11,username:'worker-11',at:at(9),endedAt:at(20)},
    {id:'record:2',order:2,taskId:1,kind:'RECORD',accountId:22,username:'worker-22',at:at(20)}];
  const result=annotateAssignmentCycles([work('submit-1',10,11),work('submit-2',21,22),work('submit-3',22,22)],assignments);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,true,false]);
  assert.equal(result[1].annotationCycleKey,result[2].annotationCycleKey);
});

test('the old record clock-time ending cannot unassign a handoff recorded a few milliseconds earlier',()=>{
  const start='2026-09-20T10:00:00.000Z',handoff='2026-09-20T11:00:00.000Z';
  const assignments=[
    assignment(1,20,11,{at:start}),
    assignment(2,20,22,{at:handoff,previousAccountId:11,previousUsername:'worker-11'}),
    {id:'record:1',order:1,taskId:1,kind:'RECORD',accountId:11,username:'worker-11',
      at:start,endedAt:'2026-09-20T11:00:00.005Z'},
    {id:'record:2',order:2,taskId:1,kind:'RECORD',accountId:22,username:'worker-22',at:handoff},
  ];
  const result=annotateAssignmentCycles([
    work('submit-1',20,22,{at:'2026-09-20T11:01:00.000Z'}),
    work('submit-2',20,22,{at:'2026-09-20T11:02:00.000Z'}),
  ],assignments);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,false]);
  assert.equal(result[0].annotationCycleKey,'1:event:2:22:COPY');
  assert.equal(result[1].annotationCycleKey,result[0].annotationCycleKey);
  assert.doesNotMatch(result[0].annotationCycleKey,/:end:/u);
});

test('an explicit unassignment and later reassignment to the same person starts a new cycle',()=>{
  const result=annotateAssignmentCycles([work('submit-1',10,11),work('submit-2',23,11)],
    [assignment(1,9,11),assignment(2,20,null,{previousAccountId:11}),assignment(3,22,11)]);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,true]);
  assert.notEqual(result[0].annotationCycleKey,result[1].annotationCycleKey);
});

test('excluded submissions do not consume the first personal operation',()=>{
  const result=annotateAssignmentCycles([work('excluded-1',10,11,{exclusion:'BYPASS'}),work('submit-2',12,11)],[]);
  assert.equal(result[0].annotationFirst,undefined);
  assert.equal(result[1].annotationFirst,true);
});

test('direct discard and restoration share a cycle whose first submission is tracked through report time',()=>{
  const result=annotateAssignmentCycles([work('discard-1',10,11,{kind:'ANNOTATION_DISCARD',approvalId:undefined}),
    work('submit-2',24,11,{approvalId:202}),work('submit-3',25,11,{approvalId:203})],[]);
  assert.deepEqual(result.map(row=>row.annotationFirst),[true,false,false]);
  const cohort=firstCopyAssignmentCohort(result,[result[0]]);
  assert.equal(cohort.length,1);
  assert.equal(cohort[0].submitted,true);
  assert.equal(cohort[0].approvalId,202);
  assert.equal(cohort[0].submittedAt,at(24));
});

test('a direct-discard-only cycle is retained without inventing a first QA submission',()=>{
  const result=annotateAssignmentCycles([work('discard-1',10,11,{kind:'ANNOTATION_DISCARD'})],[]);
  const cohort=firstCopyAssignmentCohort(result,result);
  assert.equal(cohort[0].submitted,false);
  assert.equal(cohort[0].approvalId,null);
});

test('first approval tracking stays separate for an account that returns in a later cycle',()=>{
  const result=annotateAssignmentCycles([work('submit-1',10,11,{approvalId:101}),work('submit-2',12,22,{approvalId:202}),
    work('submit-3',14,11,{approvalId:303})],
  [assignment(1,9,11),assignment(2,11,22),assignment(3,13,11)]);
  const cohort=firstCopyAssignmentCohort(result,[result[0],result[2]]);
  assert.deepEqual(cohort.map(row=>row.approvalId),[101,303]);
  assert.notEqual(cohort[0].cycleKey,cohort[1].cycleKey);
});
