import assert from 'node:assert/strict';
import test from 'node:test';
import { qaMetricRows,summarizeQa } from '../src/quality-review-statistics.mjs';
import { buildPerformanceSnapshot,normalizePerformanceFilters,performanceCsv,performanceMetricRows } from '../src/operator-performance.mjs';

const now=Date.parse('2026-09-18T04:00:00Z'),at=new Date(now-1000).toISOString();
const review=(id,stage='COPY',extra={})=>({id:`qa:${stage}:${id}`,samplingItemId:id,taskId:id,accountId:22,username:'reviewer',displayName:'质检同学',kind:'QA_REVIEW',stage,sampleKind:'RANDOM',at,outcome:'PASS',...extra});
const snapshot=(rows,filters={})=>buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters(filters,now),new Date(now).toISOString());

test('review-only worker appears with 5 copy and 3 image decisions; producer quality stays separate',()=>{
  const rows=[...Array.from({length:5},(_,i)=>review(i+1)),...Array.from({length:3},(_,i)=>review(i+6,'IMAGE')),
    {...review(1),kind:'QUALITY',accountId:11,username:'producer',displayName:'制作同学',first:true}];
  const report=snapshot(rows),person=report.people.find(p=>p.accountId===22);
  assert.equal(person.submitted,0);assert.equal(person.qa.reviews,8);assert.equal(person.contributed,8);
  assert.equal(person.qa.COPY.reviews,5);assert.equal(person.qa.IMAGE.reviews,3);assert.equal(person.COPY.firstPass.rate,null);
  assert.equal(report.people.find(p=>p.accountId===11).COPY.firstPass.rate,1);
  assert.equal(snapshot(rows,{activity:'QA'}).people.length,1);
  assert.equal(snapshot(rows,{activity:'PRODUCTION'}).people[0].accountId,11);
  assert.equal(snapshot(rows,{query:'质检同学'}).summary.qa.reviews,8);
  assert.match(performanceCsv(report),/文案质检次数/);assert.match(performanceCsv(report),/质检同学/);
});

test('task union and decision counts differ across stages and rechecks; retries are idempotent',()=>{
  const first=review(1),rows=[first,{...first},review(2,'IMAGE',{taskId:1}),review(3,'IMAGE',{taskId:1,sampleKind:'MANDATORY_RECHECK',outcome:'RETURN'}),
    {...review(4),kind:'SUBMIT',taskId:1}];
  const qa=summarizeQa(rows),report=snapshot(rows);
  assert.equal(qa.tasks,1);assert.equal(qa.reviews,3);assert.equal(qa.passed,2);assert.equal(qa.returned,1);assert.equal(qa.rechecks,1);
  assert.equal(report.summary.contributed,1);assert.equal(performanceMetricRows(rows,'qaRecheck').length,1);
  assert.equal(qaMetricRows(rows,'qa','IMAGE','RETURN').length,1);
});

test('batch actions, unknown historical scopes, direct pass, self-review and simulated decisions do not inflate review work',()=>{
  const rows=[review(1),review(2,'COPY',{exclusion:'SELF_REVIEW'}),review(3,'IMAGE',{exclusion:'SIMULATED'}),
    review(4,'COPY',{kind:'QA_DIRECT_PASS'}),review(5,'IMAGE',{kind:'QA_DISCARD'}),
    review(6,'IMAGE',{kind:'QA_BATCH_RETURN',taskId:null,affectedCount:50}),
    review(7,'COPY',{kind:'QA_BATCH_RETURN',taskId:null,affectedTaskIds:[10,11],affectedCount:2}),
    review(8,'COPY',{kind:'QA_BATCH_RETURN',taskId:null,affectedTaskIds:[11,12],affectedCount:2})];
  const qa=summarizeQa(rows);
  assert.equal(qa.reviews,1);assert.equal(qa.batchActions,3);assert.equal(qa.affectedTasks,3);
  assert.equal(qa.legacyAffectedCount,50);assert.equal(qa.unknownBatchScopes,1);assert.equal(qa.specialActions,2);
  assert.equal(snapshot(rows).summary.contributed,1);
});

test('pending-only people survive historical date filters and blocked items have exact drilldowns',()=>{
  const rows=[review(1,'COPY',{kind:'QA_PENDING',at:'2026-08-01T00:00:00Z',blocked:false}),
    review(2,'IMAGE',{kind:'QA_PENDING',at:null,blocked:true}),review(3,'IMAGE',{kind:'QA_PENDING',blocked:false,sampleKind:'MANDATORY_RECHECK'})];
  const report=snapshot(rows,{period:'today',activity:'QA'});
  assert.equal(report.people.length,1);assert.equal(report.summary.qa.pending,2);assert.equal(report.summary.qa.blocked,1);
  assert.equal(qaMetricRows(report.rows,'qaPending').length,2);assert.equal(qaMetricRows(report.rows,'qaBlocked').length,1);
  assert.equal(report.summary.qa.IMAGE.pendingRechecks,1);assert.equal(report.summary.qa.participants,0);
});

test('Beijing date boundaries use decision time and include no synthetic missing-identity work',()=>{
  const report=snapshot([review(1,'COPY',{at:'2026-09-17T15:59:59Z'}),review(2,'COPY',{at:'2026-09-17T16:00:00Z'}),
    review(3,'COPY',{at:'2026-09-18T16:00:00Z'}),review(4,'IMAGE',{accountId:null})],{period:'today'});
  assert.equal(report.summary.qa.reviews,1);assert.equal(report.trend[0].qa,1);
  assert.throws(()=>normalizePerformanceFilters({activity:'REVIEWER'},now));
});
