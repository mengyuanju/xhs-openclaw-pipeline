import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAccountQuality } from '../src/account-quality-statistics.mjs';
import { buildPerformanceSnapshot, normalizePerformanceFilters } from '../src/operator-performance.mjs';
const fact=(taskId,bucket,extra={})=>({id:String(taskId),kind:'ACCOUNT_QUALITY',taskId,accountId:1,stage:'COPY',bucket,at:'2026-09-22T00:00:00Z',...extra});
test('three quality buckets partition each subject, including assignments, with exact display rounding',()=>{
  const result=summarizeAccountQuality([fact(1,'DISCARDED'),fact(2,'FIRST_PASS'),fact(3,'RETURNED',{reassigned:true}),fact(3,'RETURNED',{reassigned:true})]);
  assert.equal(result.judged,3);assert.equal(result.reassigned,1);
  assert.deepEqual([result.discardedRate,result.firstPassRate,result.returnRate],[.3334,.3333,.3333]);
  assert.equal(summarizeAccountQuality([]).firstPassRate,null);
  const handoff=summarizeAccountQuality([fact(1,'RETURNED',{reassigned:true}),fact(1,'FIRST_PASS',{accountId:2})]);
  assert.equal(handoff.judged,2);assert.equal(handoff.tasks,1);
});
test('later final disposition changes original QA day; receipt date never moves into current-day samples',()=>{
  const row=fact(1,'DISCARDED',{at:'2026-09-21T15:59:59Z',outcomeChangedAt:'2026-09-22T06:00:00Z'});
  const report=buildPerformanceSnapshot([row],[],[],normalizePerformanceFilters({period:'custom',from:'2026-09-21',to:'2026-09-21'}),new Date().toISOString());
  assert.equal(report.summary.COPY.qualityOutcomes.discarded,1);
  const today=buildPerformanceSnapshot([row],[],[],normalizePerformanceFilters({period:'custom',from:'2026-09-22',to:'2026-09-22'}),new Date().toISOString());
  assert.equal(today.summary.COPY.qualityOutcomes.judged,0);
});
