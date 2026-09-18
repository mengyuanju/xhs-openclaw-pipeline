import assert from 'node:assert/strict';
import test from 'node:test';
import { readPersonalWorkspace } from '../src/personal-workspace.mjs';
const actor={userId:11,username:'worker',role:'USER'};

function fake({historyFails=false,deliveryFails=false,canOpen=false}={}) {
  const calls=[]; let released=false;
  const client={release(){released=true;},async query(sql,values){
    calls.push({sql,values});
    if(sql.startsWith('WITH returns')){
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
test('historical list failures fail explicitly and roll back; they never masquerade as an empty list',async()=>{
  const db=fake({historyFails:true});
  await assert.rejects(readPersonalWorkspace(db.pool,actor,{mode:'COMPLETED'},{blindSql:'false'}),/history unavailable/);
  assert.equal(db.calls.at(-1).sql,'ROLLBACK');assert.equal(db.released,true);
});
test('current list avoids historical aggregation and only hydrates accessible page ids',async()=>{
  const db=fake({canOpen:true});let loaded;
  const page=await readPersonalWorkspace(db.pool,actor,{}, {blindSql:'false',loadTasks:async(client,ids)=>{loaded=ids;return[{id:1,query:'my task'}];}});
  assert.deepEqual(loaded,[1]);assert.equal(page.total,1);assert.equal(page.items[0].canOpen,true);
  assert.equal(db.calls.some(call=>call.sql.startsWith('WITH returns')),false);
  assert.equal(db.calls.some(call=>call.sql.startsWith('SELECT b.id AS batch_id')),false);
});
test('read-only historical rows do not hydrate current detail',async()=>{
  const db=fake();
  const page=await readPersonalWorkspace(db.pool,actor,{mode:'COMPLETED'}, {blindSql:'false',loadTasks:()=>{throw Error('must not hydrate');}});
  assert.equal(page.items[0].canOpen,false);assert.equal(page.items[0].currentCopyRevisionId,null);
  assert.equal(page.items[0].personalWork,null);
  assert.equal(page.items[0].personalHistory[0].kind,'COMPLETE');
});
