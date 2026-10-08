import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionWorkNotifications } from '../src/execution-work-notifications.mjs';
import { commitTaskListChange, subscribeExecutionWorkChanges, taskListFactClient, taskListFactQueryable, taskListFactVersion } from '../src/task-list-facts.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { workspaceMutationCommitted } from '../src/http-workspace-invalidation.mjs';

const queued = { table: 'tasks', fields: ['state','updated_at'] };
const progress = { table: 'tasks', fields: ['current_stage','progress_percent','progress_message','last_activity_at','updated_at'] };
const begin = notifications => notifications.wait({ nodeId: 'node-a', epoch: null, revision: 0 });

test('first cursor, stale epoch/revision and pre-wait commits cannot lose a work notification', async () => {
  const pool = {}, notifications = createExecutionWorkNotifications({ pool, epoch: 'center-test' });
  try {
    const first = await begin(notifications);
    assert.deepEqual(first, { epoch:'center-test',revision:0,settingsRevision:0,changed:false,timedOut:false });
    commitTaskListChange(pool,[queued]);
    assert.equal((await notifications.wait({ ...first,nodeId:'node-a' })).changed,true);
    assert.equal((await notifications.wait({ ...first,nodeId:'node-a',epoch:'old-center' })).changed,true);
    assert.equal((await notifications.wait({ ...first,nodeId:'node-a',revision:99 })).changed,true);
    assert.equal(notifications.pendingCount,0);
    assert.throws(() => notifications.wait({nodeId:'node-a',epoch:'center-test',revision:-1}),/cursor/u);
    assert.throws(() => notifications.wait({nodeId:'bad node'}),/nodeId/u);
  } finally { notifications.dispose(); }
});

test('a long read-only notification response does not replay another request\'s maintenance or cache invalidation', () => {
  const ctx = {method:'POST',path:'/v1/executions/work-notifications/wait',status:200};
  assert.equal(workspaceMutationCommitted({getWorkspaceMutationVersion:() => 2},ctx,1),false);
  assert.equal(workspaceMutationCommitted({},ctx,null),false);
});

test('meaningful committed writes wake waits but progress and empty/rollback/receipt/heartbeat writes do not', async () => {
  const pool = {}, notifications = createExecutionWorkNotifications({ pool });
  const client = taskListFactClient({async query(sql) {
    return { rows:[],rowCount:sql.includes('zero')?0:1,command:sql==='COMMIT'?'COMMIT':/^WITH/u.test(sql)?'SELECT':undefined };
  }},pool);
  try {
    const first = await begin(notifications), pending = notifications.wait({...first,nodeId:'node-a',timeoutMs:20000});
    commitTaskListChange(pool,[progress]);
    await client.query('UPDATE executor_nodes SET last_seen_at=now()');
    await client.query('INSERT INTO execution_claim_requests(node_id) VALUES($1)');
    await client.query('UPDATE tasks SET state=$1 /* zero */');
    await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');await client.query('ROLLBACK');
    await client.query('BEGIN');await client.query('SAVEPOINT discarded');
    await client.query('UPDATE tasks SET state=$1');await client.query("UPDATE global_settings SET value=$1 WHERE key='production'");
    await client.query('ROLLBACK TO SAVEPOINT discarded');await client.query('COMMIT');
    assert.equal(notifications.pendingCount,1);
    await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');
    assert.equal(notifications.pendingCount,1,'uncommitted work cannot wake');
    await client.query('COMMIT');
    assert.deepEqual(await pending,{...first,revision:1,changed:true});
    const next = await begin(notifications), waiting = notifications.wait({...next,nodeId:'node-a'});
    await client.query("UPDATE global_settings SET value=$1 WHERE key='production'");
    assert.deepEqual(await waiting,{...next,revision:2,settingsRevision:1,changed:true});
    assert.equal(taskListFactVersion(pool),2,'settings changes do not invalidate task totals');
  } finally { notifications.dispose(); }
});

test('settings adapter and real repository setting writes notify once, separate from fact versions', async () => {
  const pool = {async query(sql,values) {return {rows:sql.includes('RETURNING')?[{key:values[0],value:values[1],version:1}]:[],rowCount:1};}};
  const repository = new PostgresControlPlaneRepository({pool}), events = [];
  const unsubscribe = subscribeExecutionWorkChanges(taskListFactQueryable(pool),event => events.push(event));
  try {
    await repository.upsertSetting('production',{paused:true});await repository.seedSetting('feature',{enabled:true});
    assert.deepEqual(events,[[{table:'global_settings'}],[{table:'global_settings'}]]);
    assert.equal(taskListFactVersion(pool),0);
  } finally { unsubscribe(); }
});

test('combined task/settings transaction emits one signal and aborted COMMIT emits none', async () => {
  const pool = {}, events = [];
  const unsubscribe = subscribeExecutionWorkChanges(pool,event => events.push(event));
  let aborted = false;
  const client = taskListFactClient({async query(sql){
    if(sql==='BEGIN')aborted=false;
    if(sql==='SELECT broken'){aborted=true;throw new Error('failed');}
    return {rows:[],rowCount:1,command:sql==='COMMIT'?(aborted?'ROLLBACK':'COMMIT'):undefined};
  }},pool);
  try {
    await client.query('BEGIN');await client.query('UPDATE tasks SET state=$1');
    await client.query('UPDATE global_settings SET value=$1');await client.query('UPDATE global_settings SET version=version+1');
    await client.query('COMMIT');assert.equal(events.length,1);assert.equal(events[0].length,2);
    await client.query('BEGIN');await client.query('UPDATE global_settings SET value=$1');
    await assert.rejects(client.query('SELECT broken'));await client.query('COMMIT');assert.equal(events.length,1);
  } finally { unsubscribe(); }
});

test('bounded waits release per-node/global slots on timeout, cancellation and server disposal', async () => {
  const pool = {}, notifications = createExecutionWorkNotifications({pool,maxWaiters:2});
  const first = await begin(notifications), a = new AbortController(), b = new AbortController();
  const pendingA = notifications.wait({...first,nodeId:'node-a',timeoutMs:999999},{signal:a.signal});
  const pendingB = notifications.wait({...first,nodeId:'node-b'},{signal:b.signal});
  await assert.rejects(notifications.wait({...first,nodeId:'node-a'}),{status:429,code:'WORK_NOTIFICATIONS_BUSY'});
  await assert.rejects(notifications.wait({...first,nodeId:'node-c'}),{status:429});
  assert.equal(notifications.pendingCount,2);
  a.abort();await assert.rejects(pendingA,{name:'AbortError'});
  const timed = notifications.wait({...first,nodeId:'node-a',timeoutMs:5});
  const [timeout] = await Promise.all([timed,delay(10)]);
  assert.equal(timeout.timedOut,true);assert.equal(notifications.pendingCount,1);
  notifications.dispose();await assert.rejects(pendingB,{status:503,code:'WORK_NOTIFICATIONS_STOPPED'});
  assert.equal(notifications.pendingCount,0);
  await assert.rejects(begin(notifications),{status:503});
  assert.throws(() => createExecutionWorkNotifications({pool,maxWaiters:257}),/options/u);
});
