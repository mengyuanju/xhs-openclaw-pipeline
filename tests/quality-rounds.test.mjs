import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateInspectionRounds,inspectionContexts,needsReassignment } from '../src/quality-rounds.mjs';
import { summarizeOperator,buildPerformanceSnapshot,normalizePerformanceFilters } from '../src/operator-performance.mjs';
const link=(id,extra={})=>({stage:'COPY',itemId:id,taskId:10,approvalId:id,parentItemId:id===1?null:id-1,
  sampleKind:id===1?'RANDOM':'MANDATORY_RECHECK',submitterId:11,outcome:'RETURN',exclusion:null,...extra});

test('rounds follow complete stage ancestry across reporting dates and stop after reassignment',()=>{
  const contexts=inspectionContexts([link(1),link(2),link(3,{submitterId:22}),link(4,{submitterId:22,outcome:'PASS'}),
    link(1,{stage:'IMAGE',outcome:'PASS'})]);
  assert.deepEqual(contexts.get('COPY',2),{reviewRound:2,returnRound:2,consecutiveReturns:2,roundKnown:true,firstRecheck:true,rootItemId:1});
  assert.equal(contexts.get('COPY',3).consecutiveReturns,1);
  assert.equal(contexts.get('COPY',4).consecutiveReturns,0);
  assert.equal(contexts.get('COPY',4).returnRound,3);
  assert.equal(contexts.get('IMAGE',1).returnRound,0);
});

test('missing ancestry, cross-task links and cycles do not fabricate rounds',()=>{
  for(const rows of [[link(2)],[link(1,{taskId:99}),link(2)],
    [link(1,{sampleKind:'MANDATORY_RECHECK',parentItemId:2}),link(2)]]) {
    const result=inspectionContexts(rows).get('COPY',2);
    assert.equal(result.roundKnown,false);assert.equal(result.reviewRound,null);assert.equal(result.consecutiveReturns,0);
  }
});

test('batch impact, self-review and direct release cannot count as failed first inspection',()=>{
  for(const extra of [{outcome:null},{exclusion:'SELF_REVIEW'},{exclusion:'ADMIN_DIRECT'},{submitterId:null}]) {
    const result=inspectionContexts([link(1,extra),link(2)]).get('COPY',2);
    assert.equal(result.firstRecheck,false);assert.equal(result.consecutiveReturns,1);assert.equal(result.returnRound,1);
  }
});

test('current reassignment suggestions exclude passed, closed and newly assigned work',()=>{
  const decision={stage:'COPY',accountId:11,outcome:'RETURN',roundKnown:true,consecutiveReturns:2,submittedAt:'2026-09-18T08:00:00Z'};
  const current={stage:'COPY',accountId:11,phase:'HUMAN',assignedAt:'2026-09-17T08:00:00Z'};
  assert.equal(needsReassignment(current,decision),true);
  for(const changed of [{accountId:22},{stage:'IMAGE'},{phase:'CLOSED'},{assignedAt:'2026-09-19T08:00:00Z'}])
    assert.equal(needsReassignment({...current,...changed},decision),false);
  assert.equal(needsReassignment(current,{...decision,outcome:'PASS'}),false);
});

test('initial and reworked production overlap without inflating content counts; first recheck excludes later rounds',()=>{
  const base={taskId:10,accountId:11,stage:'COPY',at:'2026-09-18T08:00:00Z'};
  const rows=annotateInspectionRounds([
    {...base,id:'s1',kind:'SUBMIT',approvalId:1,firstSubmission:true},
    {...base,id:'s2',kind:'SUBMIT',approvalId:2,rework:true},
    {...base,id:'q2',kind:'QUALITY',samplingItemId:2,sampleKind:'MANDATORY_RECHECK',outcome:'RETURN'},
    {...base,id:'q3',kind:'QUALITY',samplingItemId:3,sampleKind:'MANDATORY_RECHECK',outcome:'PASS'},
  ],[link(1),link(2),link(3,{outcome:'PASS'})]);
  const summary=summarizeOperator(rows);
  assert.equal(summary.COPY.submitted,1);assert.equal(summary.COPY.submissions,2);
  assert.equal(summary.COPY.firstSubmitted,1);assert.equal(summary.COPY.reworked,1);
  assert.deepEqual(summary.COPY.firstRecheck,{passed:0,failed:1,decided:1,rate:0});
  assert.equal(summary.COPY.recheck.rate,.5);
});

test('current suggestions remain visible outside historical date range and retain detail parity',()=>{
  const now=Date.parse('2026-09-18T08:00:00Z');
  const report=buildPerformanceSnapshot([{id:'reassign:1',taskId:10,accountId:11,stage:'COPY',kind:'REASSIGN',at:'2026-08-01T08:00:00Z'}],[],[],normalizePerformanceFilters({period:'today'},now),new Date(now).toISOString());
  assert.equal(report.summary.reassignSuggested,1);assert.equal(report.summary.returned,0);assert.equal(report.rows.length,1);
});
