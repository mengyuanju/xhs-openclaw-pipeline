import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPerformanceSnapshot,durationDistribution,normalizePerformanceFilters,overallQualityRate,performanceCsv,performanceMetricRows,performancePeoplePage,qualityRate,submissionTiming } from '../src/operator-performance.mjs';

const now=Date.parse('2026-09-18T08:00:00Z');
const at=offset=>new Date(now+offset).toISOString();
const event=(id,extra={})=>({id:String(id),taskId:id,accountId:11,username:'worker-a',displayName:'标注甲',stage:'COPY',kind:'SUBMIT',at:at(-1000),exclusion:null,...extra});
const qa=(id,outcome,extra={})=>event(id,{kind:'QUALITY',first:true,sampleKind:'RANDOM',outcome,...extra});

test('first pass rate counts actual first random verdicts, not submissions or later rechecks',()=>{
  const rows=[...Array.from({length:10},(_,i)=>event(i)),qa(1,'PASS'),qa(2,'PASS'),qa(3,'PASS'),qa(4,'RETURN'),
    qa(4,'PASS',{sampleKind:'MANDATORY_RECHECK',first:false}),qa(5,'PASS',{exclusion:'ADMIN_DIRECT'}),qa(6,'PASS',{exclusion:'SELF_REVIEW'}),
    qa(7,'PASS',{first:false}),qa(8,'PASS',{exclusion:'SIMULATED'}),event(9,{kind:'PENDING'})];
  assert.deepEqual(qualityRate(rows),{passed:3,failed:1,decided:4,rate:.75});
  assert.deepEqual(overallQualityRate(rows),{passed:4,failed:0,decided:4,rate:1});
  assert.deepEqual(qualityRate(rows,false),{passed:1,failed:0,decided:1,rate:1});
  assert.equal(performanceMetricRows(rows,'firstPass','','failed').length,1);
  assert.equal(qualityRate([]).rate,null);
});
test('team counts deduplicate cross-stage contribution and weight sample counts',()=>{
  const filters=normalizePerformanceFilters({},now);
  const rows=[event(1),event(1,{stage:'IMAGE',accountId:22,username:'b'}),qa(1,'RETURN'),
    ...Array.from({length:9},(_,i)=>qa(20+i,'PASS',{accountId:22,username:'b'}))];
  const report=buildPerformanceSnapshot(rows,[],[],filters,at(0));
  assert.equal(report.summary.submitted,1);
  assert.equal(report.people.reduce((n,p)=>n+p.submitted,0),2);
  assert.equal(report.summary.COPY.firstPass.rate,.9);
  assert.equal(report.people.find(p=>p.accountId===11).COPY.firstPass.rate,0);
  assert.equal(report.people.find(p=>p.accountId===22).COPY.firstPass.rate,1);
});
test('first-sample final pass credits a later valid recheck to the original sample once',()=>{
  const rows=[qa(1,'RETURN',{accountId:11}),qa(1,'RETURN',{accountId:22,first:false,sampleKind:'MANDATORY_RECHECK',at:at(-900)}),
    qa(1,'PASS',{accountId:22,first:false,sampleKind:'MANDATORY_RECHECK',at:at(-800)})];
  const report=buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters({},now),at(0));
  assert.deepEqual(report.summary.COPY.overallPass,{passed:1,failed:0,decided:1,rate:1});
  assert.deepEqual(report.people.find(person=>person.accountId===11).COPY.overallPass,{passed:1,failed:0,decided:1,rate:1});
  assert.equal(report.people.find(person=>person.accountId===22).COPY.overallPass.decided,0);
});
test('account and name filters retain another worker recheck for first-sample final pass history',()=>{
  const rows=[qa(1,'RETURN',{displayName:'目标账号',username:'target'}),
    qa(1,'PASS',{accountId:22,displayName:'返修账号',username:'repair',first:false,sampleKind:'MANDATORY_RECHECK',at:at(-900)})];
  for(const input of [{accountId:'11'},{query:'目标账号'}]) {
    const filters=normalizePerformanceFilters(input,now);
    const report=buildPerformanceSnapshot(rows,[],[],filters,at(0));
    assert.equal(report.people.length,1);
    assert.equal(report.summary.COPY.overallPass.rate,1);
    assert.equal(report.rows.length,1,'other account events stay out of visible report rows');
  }
  const scoped=buildPerformanceSnapshot(rows.slice(0,1),[],[],normalizePerformanceFilters({accountId:'11'},now),at(0),rows);
  assert.equal(scoped.summary.COPY.overallPass.rate,1,'server can supply bounded supporting history');
});
test('timeline separates reassignment, machine wait and background work without inventing active labor',()=>{
  const timeline=[{id:1,taskId:1,accountId:11,stage:'COPY',phase:'HUMAN',at:at(-600_000),baseline:false},
    {id:2,taskId:1,accountId:22,stage:'COPY',phase:'HUMAN',at:at(-480_000),baseline:false},
    {id:3,taskId:1,accountId:22,stage:'COPY',phase:'BACKGROUND',at:at(-360_000),baseline:false},
    {id:4,taskId:1,accountId:22,stage:'COPY',phase:'HUMAN',at:at(-120_000),baseline:false}];
  const timing=submissionTiming(event(1,{accountId:22,at:at(0)}),timeline);
  assert.equal(timing.humanMs,240_000);assert.equal(timing.backgroundMs,240_000);
  assert.equal(submissionTiming(event(1),[{...timeline[0],baseline:true}]).humanMs,null);
  assert.equal(submissionTiming(event(1,{accountId:44}),timeline).humanMs,null);
  assert.deepEqual(durationDistribution([10,20,30,40]),{samples:4,missing:0,meanMs:25,medianMs:25,p90Ms:40});
});
test('date bounds use Beijing days; first eligibility is not recalculated after date filtering',()=>{
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-18',to:'2026-09-18'},now);
  assert.equal(new Date(filters.range.startMs).toISOString(),'2026-09-17T16:00:00.000Z');
  assert.equal(new Date(filters.range.endMs).toISOString(),'2026-09-18T16:00:00.000Z');
  const report=buildPerformanceSnapshot([qa(1,'RETURN',{at:'2026-09-17T15:59:59Z'}),qa(1,'PASS',{first:false})],[],[],filters,at(0));
  assert.equal(report.summary.COPY.firstPass.decided,0);
});
test('batch impact, unknown identities and missing timings remain distinct',()=>{
  const rows=[qa(1,'RETURN'),...Array.from({length:10},(_,i)=>event(100+i,{kind:'BATCH_RETURN'})),event(22,{accountId:null}),event(30,{rework:true})];
  const report=buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters({},now),at(0));
  assert.equal(report.summary.returned,1);assert.equal(report.summary.batchAffected,10);
  assert.equal(report.summary.COPY.duration.samples,0);assert.equal(report.summary.COPY.duration.missing,1);
  assert.equal(report.summary.reworkDuration.missing,1);assert.equal(report.dataQuality.unknownIdentity,1);
});
test('pagination sorts unknown rates last and exports literal user text safely',()=>{
  const report=buildPerformanceSnapshot([event(1,{displayName:'=HYPERLINK("evil")'}),event(2,{kind:'ACCOUNT_QUALITY',bucket:'FIRST_PASS',accountId:22,username:'b'})],[],[],normalizePerformanceFilters({},now),at(0));
  const page=performancePeoplePage(report,{sort:'copyRate',order:'asc',pageSize:1,page:1});
  assert.equal(page.items[0].accountId,22);assert.equal(page.total,2);
  const csv=performanceCsv(report);assert.match(csv,/'=HYPERLINK\(""evil""\)/u);
  assert.match(csv,/报表时点/u);assert.match(csv,/Asia\/Shanghai/u);
});
test('overall pass sort and CSV use reviewer decisions, including rechecks, across stages',()=>{
  const review=(id,accountId,outcome,stage='COPY',sampleKind='RANDOM')=>event(id,{accountId,username:`reviewer-${accountId}`,
    kind:'QA_REVIEW',samplingItemId:id,sampleKind,outcome,stage});
  const rows=[review(101,11,'PASS'),
    ...Array.from({length:9},(_,i)=>review(110+i,11,'RETURN','IMAGE')),
    review(201,22,'PASS'),review(202,22,'RETURN','IMAGE','MANDATORY_RECHECK'),
    event(301,{accountId:33,username:'c'})];
  const report=buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters({},now),at(0));
  assert.deepEqual(performancePeoplePage(report,normalizePerformanceFilters({sort:'overallPassRate',order:'asc'},now))
    .items.map(person=>person.accountId),[11,22,33]);
  assert.deepEqual(performancePeoplePage(report,normalizePerformanceFilters({sort:'overallPassRate',order:'desc'},now))
    .items.map(person=>person.accountId),[22,11,33]);
  const [header,...lines]=performanceCsv(report).replace(/^\uFEFF/u,'').split('\r\n');
  const index=header.split(',').indexOf('"账号整体通过率"');
  const passedIndex=header.split(',').indexOf('"账号质检整体通过"');
  const decidedIndex=header.split(',').indexOf('"账号质检已判定"');
  assert.ok(index>0);
  assert.equal(lines.find(line=>line.startsWith('"11",'))?.split(',')[passedIndex],'"1"');
  assert.equal(lines.find(line=>line.startsWith('"11",'))?.split(',')[decidedIndex],'"10"');
  assert.equal(lines.find(line=>line.startsWith('"11",'))?.split(',')[index],'"0.1"');
  assert.equal(lines.find(line=>line.startsWith('"33",'))?.split(',')[index],'""');
});
test('account outcome columns sort by combined stage counts and rates in both directions',()=>{
  const fact=(id,accountId,bucket,stage='COPY')=>event(id,{accountId,username:`worker-${accountId}`,kind:'ACCOUNT_QUALITY',bucket,stage});
  const rows=[fact(101,11,'FIRST_PASS'),fact(102,11,'FIRST_PASS'),fact(103,11,'RETURNED'),
    fact(201,22,'FIRST_PASS'),fact(202,22,'FIRST_PASS','IMAGE'),fact(203,22,'RETURNED'),fact(204,22,'DISCARDED'),
    fact(301,33,'DISCARDED'),fact(302,33,'DISCARDED'),event(401,{accountId:44,username:'worker-44'})];
  const report=buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters({},now),at(0));
  assert.equal(report.people.find(person=>person.accountId===22).qualityOutcomes.judged,4);
  assert.equal(report.people.find(person=>person.accountId===44).qualityOutcomes.firstPassRate,null);
  for(const [sort,asc,desc] of [
    ['judged',[44,33,11,22],[22,11,33,44]],
    ['firstPassRate',[33,22,11,44],[11,22,33,44]],
    ['returnRate',[33,22,11,44],[11,22,33,44]],
    ['discardedRate',[11,22,33,44],[33,22,11,44]],
  ]) {
    for(const [order,expected] of [['asc',asc],['desc',desc]]) {
      const filters=normalizePerformanceFilters({sort,order},now);
      assert.deepEqual(performancePeoplePage(report,filters).items.map(person=>person.accountId),expected,`${sort} ${order}`);
    }
  }
});
test('invalid and oversized filters are rejected instead of silently broadening the report',()=>{
  for(const input of [{accountId:'-1'},{pageSize:'1000'},{stage:'SQL'},{sort:'random()'},{period:'forever'},{query:['a','b']},{unknown:'1'},
    {period:'custom',from:'2026-01-01',to:'2027-02-01'}]) assert.throws(()=>normalizePerformanceFilters(input,now));
});
test('searching a renamed worker keeps all their historical contributions',()=>{
  const rows=[event(1,{displayName:'旧名字'}),event(2,{displayName:'新名字'})];
  const snapshot=buildPerformanceSnapshot(rows,[],[],normalizePerformanceFilters({query:'新名字'},now),at(0));
  assert.equal(snapshot.summary.submitted,2);
});
