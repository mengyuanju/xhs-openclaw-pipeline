import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { taskListFactClient, taskListFactQueryable, taskListFactVersion } from '../src/task-list-facts.mjs';
import { createClaimRequestId } from '../../src/control-plane/claim-request.mjs';

const admin={userId:1,username:'admin',role:'ADMIN',credentialVersion:1};

test('facts advance after commit only, ignore zero rows and discard rolled-back changes',async()=>{
  const pool={},client=taskListFactClient({async query(sql){
    return {rows:[],rowCount:sql.includes('zero')?0:1};
  }},pool);
  await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');
  assert.equal(taskListFactVersion(pool),0);
  await client.query('ROLLBACK');assert.equal(taskListFactVersion(pool),0);
  await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1 /* zero */');
  await client.query('COMMIT');assert.equal(taskListFactVersion(pool),0);
  await client.query('BEGIN');await client.query('UPDATE tasks SET last_activity_at=now()');
  await client.query('UPDATE tasks SET current_stage=$1');
  assert.equal(taskListFactVersion(pool),0);
  await client.query('COMMIT');assert.equal(taskListFactVersion(pool),1);
  await client.query('UPDATE executor_nodes SET last_seen_at=now()');
  await client.query('INSERT INTO execution_claim_requests(node_id) VALUES($1)');
  await client.query("WITH active AS (UPDATE task_executions SET heartbeat_at=now() RETURNING id),renewed AS (UPDATE image_edit_requests edit SET lease_expires_at=now()+interval '15 minutes' FROM active WHERE edit.execution_id=active.id RETURNING edit.id) SELECT id FROM active");
  await client.query('UPDATE image_edit_requests SET lease_token=$1,lease_expires_at=now(),updated_at=now() WHERE status=$2');
  assert.equal(taskListFactVersion(pool),1);
  await client.query('UPDATE image_edit_requests SET status=$1,lease_token=NULL,updated_at=now() WHERE id=$2');
  assert.equal(taskListFactVersion(pool),2);
  await client.query('UPDATE image_edit_requests SET updated_at=now() WHERE status=$1');
  assert.equal(taskListFactVersion(pool),3,'preview ready timestamps affect personal waiting facts');
});

test('nested savepoint rollback retains earlier changes and adapters share pool identity',async()=>{
  const pool={async query(){return{rows:[],rowCount:1};},async connect(){return this;}};
  const adapter=taskListFactQueryable(pool),client=await adapter.connect();
  assert.equal(taskListFactQueryable(adapter),adapter);
  assert.equal(taskListFactClient(client,adapter),client,'a domain transaction cannot double-track a client');
  await client.query('BEGIN');await client.query('SAVEPOINT first');
  await client.query('UPDATE tasks SET state=$1');await client.query('ROLLBACK TO SAVEPOINT first');
  await client.query('COMMIT');assert.equal(taskListFactVersion(pool),0);
  await client.query('BEGIN');await client.query('UPDATE tasks SET assigned_to_user_id=$1');
  await client.query('SAVEPOINT second');await client.query('UPDATE tasks SET state=$1');
  await client.query('ROLLBACK TO SAVEPOINT second');await client.query('COMMIT');
  assert.equal(taskListFactVersion(pool),1);
  assert.equal(taskListFactVersion(adapter),1);
  assert.equal(taskListFactQueryable({}).query,undefined);
  assert.equal(taskListFactQueryable({}).connect,undefined);
});

test('COMMIT on an aborted PostgreSQL transaction cannot advance the business revision',async()=>{
  const pool={};let aborted=false;
  const client=taskListFactClient({async query(sql){
    if(sql==='BEGIN'){aborted=false;return{command:'BEGIN',rows:[],rowCount:null};}
    if(sql==='SELECT broken'){aborted=true;throw new Error('transaction query failed');}
    if(sql==='COMMIT')return{command:aborted?'ROLLBACK':'COMMIT',rows:[],rowCount:null};
    return{command:'UPDATE',rows:[],rowCount:1};
  }},pool);
  await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');
  await assert.rejects(client.query('SELECT broken'),/transaction query failed/u);
  await client.query('COMMIT');
  assert.equal(taskListFactVersion(pool),0,'an accepted COMMIT can actually roll back');
  await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');await client.query('COMMIT');
  assert.equal(taskListFactVersion(pool),1,'the next successful transaction still advances');
});

function queueFixture({staleRows=0}={}) {
  let counts=0;
  const pool={async query(sql){if(sql.includes('COUNT(*) AS total')){counts++;return{rows:[{total:0}],rowCount:1};}
    return{rows:[],rowCount:0};},async connect(){return{release(){},async query(sql){
      if(sql.includes('FROM executor_nodes n'))return{rows:[{id:'empty-node',codex_pool_id:1,codex_total_concurrency:1,
        codex_image_concurrency:1,copy_image_plan_regeneration_version:staleRows?1:0}],rowCount:1};
      if(sql.includes('FROM app_users'))return{rows:[{id:1,username:'admin',role:'ADMIN',status:'ACTIVE',credential_version:1}],rowCount:1};
      if(sql.includes('COUNT(*) AS total_count'))return{rows:[{total_count:0,image_count:0}],rowCount:1};
      if(sql.includes('UPDATE copy_image_plan_regeneration_jobs regeneration'))return{rows:[],rowCount:staleRows};
      return{rows:[],rowCount:0};
    }};}};
  return{repository:new PostgresControlPlaneRepository({pool,totalCacheTtlMs:5000,now:()=>1}),pool,get counts(){return counts;}};
}

test('read-only priority audit and an empty executor claim preserve a warmed task total',async()=>{
  const fixture=queueFixture(),options={includeTotal:true,countCacheIdentity:admin};
  await fixture.repository.listTasks(options);await fixture.repository.getTaskPriorityAudit(1,{actor:admin});
  const result=await fixture.repository.claimCopyBatch({nodeId:'empty-node',limit:1,requestId:createClaimRequestId()});
  assert.deepEqual(result.claims,[]);await fixture.repository.listTasks(options);
  assert.equal(fixture.counts,1);assert.equal(fixture.repository.getWorkspaceMutationVersion(),0);
});

test('an empty claim that actually clears stale planning work advances the business revision',async()=>{
  const fixture=queueFixture({staleRows:1}),options={includeTotal:true,countCacheIdentity:admin};
  await fixture.repository.listTasks(options);
  const result=await fixture.repository.claimCopyBatch({nodeId:'empty-node',limit:1,requestId:createClaimRequestId()});
  assert.deepEqual(result.claims,[]);await fixture.repository.listTasks(options);
  assert.equal(fixture.counts,2);assert.equal(fixture.repository.getWorkspaceMutationVersion(),1);
});
