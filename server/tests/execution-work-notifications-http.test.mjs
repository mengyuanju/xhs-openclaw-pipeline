import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { commitTaskListChange, taskListFactQueryable, taskListFactVersion } from '../src/task-list-facts.mjs';

async function withServer(action) {
  const storageRoot = await mkdtemp(join(tmpdir(),'execution-notify-http-'));
  let queries = 0, claims = 0;
  const pool = {async query(sql) { queries++; return {rows:[],rowCount:1}; }};
  const repository = {
    pool, supportsScopedWorkspaceCounts:true,
    getWorkspaceMutationVersion:() => taskListFactVersion(pool),
    health:async () => ({ok:true,capabilities:{existing:true}}),
    getUserByUsername:async username => ({id:2,username,role:'USER',status:'ACTIVE',credentialVersion:1}),
    claimCopyBatch:async () => {claims++;return {claims:[]};},
  };
  const app = createControlPlaneApp({repository,storageRoot,logger:{},enforceUserAuth:true});
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const wait = (body, options={}) => fetch(`${root}/v1/executions/work-notifications/wait`,{
    method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:JSON.stringify(body),signal:options.signal,
  });
  try { await action({root,wait,pool,dispose:app.context.disposeControlPlaneResources,get queries(){return queries;},get claims(){return claims;}}); }
  finally {
    await app.context.disposeControlPlaneResources();
    await new Promise(resolve => server.close(resolve));
    await rm(storageRoot,{recursive:true,force:true});
  }
}

test('HTTP capability and notification wait preserve claims, return no tasks and use no database connection',async () => {
  await withServer(async fixture => {
    const health = (await (await fetch(`${fixture.root}/health`)).json()).data;
    assert.equal(health.capabilities.executionWorkNotificationsVersion,1);assert.equal(health.capabilities.existing,true);
    const first = (await (await fixture.wait({nodeId:'unregistered-notify-only',epoch:null,revision:0})).json()).data;
    assert.equal(first.changed,false);assert.equal(first.settingsRevision,0);
    const pending = fixture.wait({...first,nodeId:'unregistered-notify-only',timeoutMs:20000});
    await delay(15);
    commitTaskListChange(fixture.pool,[{table:'tasks',fields:['state']}]);
    const response = await pending;
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).data,{...first,revision:1,changed:true});
    assert.equal(fixture.queries,0);assert.equal(fixture.claims,0);
    const legacy = await fetch(`${fixture.root}/v1/executions/claim-copy-batch`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nodeId:'old-node',limit:1}),
    });
    assert.equal(legacy.status,200);assert.deepEqual((await legacy.json()).data,{claims:[]});assert.equal(fixture.claims,1);
  });
});

test('HTTP settings commits refresh the setting revision and timeout remains a bounded fallback',async () => {
  await withServer(async fixture => {
    const first = (await (await fixture.wait({nodeId:'settings-node'})).json()).data;
    const pending = fixture.wait({...first,nodeId:'settings-node'});
    await delay(10);
    await taskListFactQueryable(fixture.pool).query("UPDATE global_settings SET value=$1 WHERE key='production'",[{paused:false}]);
    const next = (await (await pending).json()).data;
    assert.deepEqual(next,{...first,revision:1,settingsRevision:1,changed:true});
    assert.equal(taskListFactVersion(fixture.pool),0);
    const timeout = await fixture.wait({...next,nodeId:'settings-node',timeoutMs:5});
    assert.deepEqual((await timeout.json()).data,{...next,changed:false,timedOut:true});
  });
});

test('HTTP duplicate waits are bounded, disconnect releases its slot, and shutdown settles pending requests',async () => {
  await withServer(async fixture => {
    const first = (await (await fixture.wait({nodeId:'slot-node'})).json()).data;
    const controller = new AbortController();
    const pending = fixture.wait({...first,nodeId:'slot-node'},{signal:controller.signal});
    const cancelled = assert.rejects(pending,{name:'AbortError'});
    await delay(15);
    const duplicate = await fixture.wait({...first,nodeId:'slot-node'});
    assert.equal(duplicate.status,429);assert.equal((await duplicate.json()).error.code,'WORK_NOTIFICATIONS_BUSY');
    controller.abort();await cancelled;
    let retry;
    for(let attempt=0;attempt<10;attempt++) {
      await delay(5);retry=await fixture.wait({...first,nodeId:'slot-node',timeoutMs:5});
      if(retry.status===200)break;
      await retry.json();
    }
    assert.equal(retry.status,200);assert.equal((await retry.json()).data.timedOut,true);
    const stopping = fixture.wait({...first,nodeId:'slot-node'});
    await delay(10);await fixture.dispose();
    const stopped = await stopping;
    assert.equal(stopped.status,503);assert.equal((await stopped.json()).error.code,'WORK_NOTIFICATIONS_STOPPED');
  });
});

test('HTTP notification route uses the existing executor machine permission boundary and validates input',async () => {
  await withServer(async fixture => {
    const denied = await fixture.wait({nodeId:'user-node'},{headers:{
      'X-Actor-Username':'user','X-Actor-User-Id':'2','X-Actor-Role':'USER','X-Actor-Credential-Version':'1',
    }});
    assert.equal(denied.status,403);
    const invalid = await fixture.wait({nodeId:'bad id'});
    assert.equal(invalid.status,400);
    const publicMachine = await fixture.wait({nodeId:'valid-id'});
    assert.equal(publicMachine.status,200);
  });
});
