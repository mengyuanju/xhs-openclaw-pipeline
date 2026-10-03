import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { connectDatabase, safeError } from '../server/scripts/database-common.mjs';

// This probe performs only SELECT and GET operations against the configured development service.
const { dev, prod } = developmentConfigurations();
const client = connectDatabase(dev);
const origin = 'http://127.0.0.1:4311';
const report = { startedAt: new Date().toISOString(), target: dev.display, readOnly: true, modelCalls: 0, checks: [], timings: [] };
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name,'xhs_control');
  const accounts = (await client.query(`SELECT id,username,role,credential_version FROM app_users
    WHERE status='ACTIVE' AND must_change_password=false ORDER BY (role='ADMIN') DESC,id LIMIT 30`)).rows;
  const admin = accounts.find(account=>account.role==='ADMIN');
  assert.ok(admin,'An active development administrator is required');
  const sample = (await client.query("SELECT id,query FROM tasks WHERE task_kind='CONTENT' ORDER BY id DESC LIMIT 1")).rows[0];
  report.migrations = (await client.query("SELECT id FROM control_plane_migrations WHERE id LIKE '010%' ORDER BY id")).rows.map(row=>row.id);
  assert.ok(report.migrations.length>=5);
  const invalidIndexes = (await client.query(`SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE NOT i.indisvalid`)).rows;
  assert.deepEqual(invalidIndexes,[]);
  report.checks.push('Development database identity, applied migrations and valid indexes');
  await client.query('COMMIT');
  async function get(path, actor = admin) {
    const started = performance.now();
    const response = await fetch(origin+path,{headers:{'X-Actor-User-Id':String(actor.id),'X-Actor-Username':actor.username,
      'X-Actor-Role':actor.role,'X-Actor-Credential-Version':String(actor.credential_version)},signal:AbortSignal.timeout(60_000)});
    const body = await response.json();
    assert.ok(response.ok,`${path}: ${response.status} ${body.error?.message??'request failed'}`);
    report.timings.push({path,durationMs:Number((performance.now()-started).toFixed(2))});
    return body.data;
  }
  for(let attempt=0;attempt<120;attempt++) {
    const ready=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)}).then(response=>response.ok,()=>false);
    if(ready)break;
    if(attempt===119)throw Error('Development center did not become ready');
    await new Promise(done=>setTimeout(done,250));
  }
  const health = await get('/health');
  assert.ok(health);
  report.checks.push('Live center health and executor protocol response');
  if(sample) {
    const current=await get(`/v1/tasks/${sample.id}?historyMode=current`);
    assert.equal(current.id,Number(sample.id));assert.equal(current.query,sample.query);
    const history=await get(`/v1/tasks/${sample.id}/history/copyRevisions?limit=20`);
    assert.ok(Array.isArray(history.items));
    const traces=await get(`/v1/tasks/${sample.id}/model-calls?limit=20`);
    assert.equal(typeof traces.total,'number');
    report.checks.push('Live current task, paged history and trace metadata');
  }
  await get('/v1/tasks?limit=20&includeTotal=true&refreshTotal=true');
  await get('/v1/delivery-pool?limit=20&includeTotal=true');
  await get('/v1/admin/annotation-job-report?period=7d');
  const operators=await get('/v1/admin/operator-performance?period=7d');
  await get(`/v1/admin/operator-performance/tasks?snapshotToken=${encodeURIComponent(operators.snapshotToken)}&pageSize=15&currentPageSize=20`);
  if(sample) await get(`/v1/admin/task-data-report/tasks/${sample.id}`);
  report.checks.push('Live task/delivery lists, full personnel and annotation-job reports, task-data report');
  const before = performance.now();
  await Promise.all(Array.from({length:30},(_,index)=>get('/v1/personal-workspace/tasks?personalScope=ASSIGNED&pageSize=20',accounts[index%accounts.length])));
  report.concurrentRead = {requests:30,distinctAccounts:Math.min(30,accounts.length),durationMs:Number((performance.now()-before).toFixed(2))};
  report.checks.push('30 simultaneous read requests against actual development data');
  const web=await fetch('http://127.0.0.1:3002/login',{signal:AbortSignal.timeout(60_000)});
  assert.equal(web.status,200);
  report.checks.push('Live development Web login page');
  report.passed=true;
} catch(error) {
  report.passed=false;report.error=safeError(safeError(error,prod),dev);
  process.exitCode=1;
} finally {
  await client.query('ROLLBACK').catch(()=>{});await client.end();
  report.completedAt=new Date().toISOString();
  await mkdir(resolve('reports'),{recursive:true});
  await writeFile(resolve('reports/scaling-live-development.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
