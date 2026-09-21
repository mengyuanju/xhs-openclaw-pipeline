import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPersonalTask, normalizePersonalFilters, personalListHref, selectPersonalTasks, summarizePersonalWorkspace } from '../src/personal-workspace.mjs';

const now=Date.parse('2026-09-17T10:00:00+08:00');
const task=(id,extra={})=>({id,query:`Query ${id}`,state:'COPY_REVIEW_PENDING',isAssigned:true,isCreated:true,
  createdAt:'2026-09-14T09:00:00+08:00',queueEnteredAt:'2026-09-16T08:00:00+08:00',prioritySortAt:'2026-09-14T09:00:00+08:00',
  priorityMode:'SYSTEM',canOpen:true,...extra});
const event=(id,extra={})=>({id:String(id),taskId:id,kind:'COMPLETE',stage:'COPY',at:'2026-09-17T09:00:00+08:00',...extra});
const filters=(input={})=>normalizePersonalFilters(input,now);

test('rework classes are mutually exclusive and exclude voluntary editing / execution exhaustion',()=>{
  const facts=[task(1,{copyReworkOrigin:'QA_RETURN'}),task(2,{state:'IMAGE_REWORK_PENDING'}),
    task(3,{copyReworkOrigin:'FINAL_REWORK',reworkTarget:'BOTH'}),task(4,{currentStage:'IMAGE_RETRY_EXHAUSTED'}),task(5)];
  const summary=summarizePersonalWorkspace(facts,[],[],filters(),now);
  assert.equal(summary.counts.rework,3);
  assert.equal(summary.rework.copy+summary.rework.image+summary.rework.both,3);
  assert.equal(summary.counts.copyInitial,1); assert.equal(summary.counts.anomaly,1);
  assert.equal(summary.counts.actionable,5,'each task counted once despite overlapping flags');
  const recheck=classifyPersonalTask(task(1,{state:'COPY_QC_PENDING',copyReworkOrigin:'QA_RETURN',mandatoryCopyQc:true}),now);
  assert.ok(recheck.categories.includes('recheck')); assert.ok(!recheck.categories.includes('rework'));
});
test('background processing becomes pending result and resets current waiting clock without heartbeat dependence',()=>{
  const facts=[task(1,{copyReworkOrigin:'QA_RETURN',planStatus:'RUNNING'}),
    task(2,{copyReworkOrigin:'QA_RETURN',planStatus:'SUCCEEDED',planReadyAt:'2026-09-17T09:30:00+08:00'}),
    task(3,{state:'IMAGE_REWORK_PENDING',imageEdits:{queued:0,running:0,ready:1,failed:0},previewReadyAt:'2026-09-17T09:00:00+08:00'})];
  const summary=summarizePersonalWorkspace(facts,[],[],filters(),now);
  assert.equal(summary.counts.actionable,2); assert.equal(summary.rework.processing,1); assert.equal(summary.rework.confirm,2);
  assert.equal(summary.rework.longWaiting,0); assert.equal(summary.background.previews,2);
  assert.equal(classifyPersonalTask({...facts[1],lastActivityAt:new Date(now).toISOString()},now).waitingHours,0.5);
});
test('pending cards drill down through the same classification including long / repeated rework',()=>{
  const facts=[task(1,{copyReworkOrigin:'QA_RETURN',reworkCount:2}),task(2,{state:'IMAGE_REWORK_PENDING'}),
    task(3,{state:'IMAGE_QC_PENDING'}),task(4,{isAssigned:false}),task(5,{state:'REVIEWED',deliveryReady:true})];
  const summary=summarizePersonalWorkspace(facts,[],[],filters(),now);
  for (const [category,count] of Object.entries(summary.counts)) {
    assert.equal(selectPersonalTasks(facts,[],filters({category}),now).total,count,category);
  }
  assert.equal(selectPersonalTasks(facts,[],filters({category:'rework',longWaiting:'1',repeated:'1'}),now).total,1);
  assert.equal(selectPersonalTasks(facts,[],filters({personalScope:'CREATED'}),now).total,5);
});
test('history belongs to original actor independently of current scope and task permissions',()=>{
  const facts=[task(1,{isAssigned:false,isCreated:false,canOpen:false}),task(2)];
  const events=[event(1),event(1,{id:'image',stage:'IMAGE'}),event(2,{at:'2026-09-16T09:00:00+08:00'})];
  const summary=summarizePersonalWorkspace(facts,events,[],filters(),now);
  assert.equal(summary.counts.ALL,1); assert.equal(summary.period.completed,1); assert.equal(summary.period.copy,1); assert.equal(summary.period.image,1);
  const history=selectPersonalTasks(facts,events,filters({mode:'COMPLETED'}),now);
  assert.equal(history.total,1); assert.equal(history.items[0].canOpen,false); assert.equal(history.items[0].history.length,2);
});
test('quality denominator excludes repeat / unobserved work and no sample stays unknown',()=>{
  const events=[event(1,{kind:'QUALITY',first:true,passed:true}),event(2,{kind:'QUALITY',first:true,passed:false}),
    event(3,{kind:'QUALITY',first:false,passed:true})];
  const summary=summarizePersonalWorkspace([],events,[],filters(),now);
  assert.deepEqual(summary.quality.COPY,{samples:2,passed:1,rate:0.5});
  assert.deepEqual(summary.quality.IMAGE,{samples:0,passed:0,rate:null});
  assert.equal(selectPersonalTasks([task(1),task(2),task(3)],events,filters({mode:'QUALITY',stage:'COPY',qualityFirst:'1'}),now).total,2);
});
test('delivery measures batches and unique tasks; rework median and repeated history use historical events',()=>{
  const events=[event(1,{rework:true,returnedAt:'2026-09-17T07:00:00+08:00'}),event(2,{rework:true,returnedAt:'2026-09-17T05:00:00+08:00'}),
    event(3,{kind:'RETURN',round:2,reasons:['TEXT','TEXT']})];
  const batches=[{status:'DOWNLOADED'},...[[1,2],[2,3]].map(taskIds=>({status:'DELIVERED',taskIds,deliveredAt:events[0].at}))];
  const summary=summarizePersonalWorkspace([],events,batches,filters(),now);
  assert.equal(summary.pendingDeliveryBatches,1); assert.equal(summary.period.deliveredBatches,2); assert.equal(summary.period.deliveredTasks,3);
  assert.equal(summary.reworkDuration.medianMs,3*3_600_000); assert.equal(summary.repeatReworkTasks,1); assert.equal(summary.reasons[0].count,1);
  assert.equal(selectPersonalTasks([task(3,{reworkCount:0})],events,filters({mode:'RETURNS',repeated:'1'}),now).total,1);
});
test('date boundaries are Shanghai calendar dates, pagination/dedup/query are applied before totals',()=>{
  const facts=[task(1,{query:'same'}),task(2,{query:'same'}),task(3)];
  const events=[event(1,{at:'2026-09-16T16:00:00Z'}),event(2,{at:'2026-09-17T16:00:00Z'})];
  assert.equal(summarizePersonalWorkspace(facts,events,[],filters(),now).period.completed,1);
  assert.equal(selectPersonalTasks(facts,[],filters({deduplicateQuery:'1'}),now).total,2);
  assert.equal(selectPersonalTasks(facts,[],filters({query:'#3'}),now).items[0].id,3);
  const page=selectPersonalTasks(facts,[],filters({pageSize:'2',page:'99'}),now);
  assert.equal(page.offset,2); assert.equal(page.items.length,1); assert.equal(page.total,3);
  assert.equal(selectPersonalTasks([task(4,{createdAt:null})],[],filters({createdFrom:'2026-09-17'}),now).total,0);
});
test('URLs round trip filters safely; malformed ranges fail instead of displaying fake zero',()=>{
  const href=personalListHref({mode:'REWORK',stage:'COPY',period:'custom',from:'2026-09-16',to:'2026-09-17',query:'a&b'});
  const decoded=filters(Object.fromEntries(new URL(href,'http://localhost').searchParams));
  assert.equal(decoded.query,'a&b'); assert.equal(decoded.mode,'REWORK'); assert.equal(decoded.range.from,'2026-09-16');
  assert.throws(()=>filters({period:'custom',from:'2026-09-18',to:'2026-09-17'}));
});
