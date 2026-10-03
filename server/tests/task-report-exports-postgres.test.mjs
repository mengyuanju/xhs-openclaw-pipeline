import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createTaskReportExport, createTaskReportExportWorker, readyTaskReportExport, taskReportExportStatus, listTaskReportExports } from '../src/task-report-exports.mjs';

test('persistent CSV exports are exact above 10k, permission-scoped, idempotent, bounded and restartable', {
  skip:process.env.RUN_SCALING_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const cluster=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:cluster.connectionString,
    env:{...process.env,PG_POOL_MAX:'1'}});
  const pool=repository.pool,root=await mkdtemp(join(tmpdir(),'xhs-report-export-'));
  let worker;
  try{
    await repository.initialize();
    const admin=await repository.getUserByUsername('admin');
    const actor={role:'ADMIN',userId:admin.id,username:admin.username,credentialVersion:admin.credentialVersion};
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('export-test','Synthetic')");
    await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id)
      SELECT 'csv synthetic '||n,'COPY_QUEUED','export-test','export-test' FROM generate_series(1,10001) n`);
    const input={requestId:randomUUID(),time:{field:'CREATED_AT',mode:'RELATIVE',days:1},sort:'TASK_ID',order:'ASC'};
    const [first,retry]=await Promise.all([createTaskReportExport(pool,actor,input),createTaskReportExport(pool,actor,input)]);
    assert.equal(retry.id,first.id);assert.equal(first.status,'QUEUED');
    await assert.rejects(createTaskReportExport(pool,actor,{...input,sort:'CREATED_AT'}),{code:'REQUEST_REPLAY_MISMATCH'});
    await assert.rejects(taskReportExportStatus(pool,{...actor,userId:actor.userId+1},first.id),/not found/);
    await assert.rejects(taskReportExportStatus(pool,{...actor,credentialVersion:actor.credentialVersion+1},first.id),/not found/);
    await assert.rejects(readyTaskReportExport(pool,actor,first.id,root),{code:'REPORT_EXPORT_NOT_READY'});
    // Persist a stale lease to simulate a process interruption before restart.
    const oldLease=randomUUID(),oldPath=join(root,'report-exports',`${first.id}-${oldLease}.csv`);
    await mkdir(join(root,'report-exports'),{recursive:true});
    await writeFile(oldPath,'interrupted CSV');await writeFile(`${oldPath}.partial`,'interrupted partial');
    await pool.query(`UPDATE task_report_exports SET status='RUNNING',lease_token=$2,lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1`,[first.id,oldLease]);
    await pool.query(`CREATE TABLE test_export_progress_writes(job_id bigint,row_count bigint);
      CREATE FUNCTION test_export_progress_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='RUNNING' AND NEW.status='RUNNING' AND OLD.lease_token=NEW.lease_token THEN
        INSERT INTO test_export_progress_writes VALUES(NEW.id,NEW.row_count); END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_export_progress_audit AFTER UPDATE ON task_report_exports
      FOR EACH ROW EXECUTE FUNCTION test_export_progress_audit()`);
    worker=createTaskReportExportWorker(pool,root,{logger:{error(){}}});
    const started=Date.now();
    await worker.wake();
    let status=await taskReportExportStatus(pool,actor,first.id);
    assert.equal(status.status,'COMPLETE');assert.equal(status.rowCount,10001);
    const writes=(await pool.query('SELECT row_count FROM test_export_progress_writes WHERE job_id=$1',[first.id])).rows;
    assert.ok(writes.length<=Math.ceil((Date.now()-started)/1500)+2,'progress writes must follow time instead of each cursor batch');
    assert.equal(Number(writes.at(-1).row_count),10001,'final progress is forced before completion');
    console.log(JSON.stringify({event:'export_progress_write_measurement',rows:10001,progressWrites:writes.length,
      previousBatchWrites:42,elapsedMs:Date.now()-started,poolMax:1}));
    await assert.rejects(readFile(oldPath),{code:'ENOENT'});await assert.rejects(readFile(`${oldPath}.partial`),{code:'ENOENT'});
    assert.deepEqual((await pool.query('SELECT retired_lease_tokens FROM task_report_exports WHERE id=$1',[first.id])).rows[0].retired_lease_tokens,[]);
    const file=await readyTaskReportExport(pool,actor,first.id,root);
    const csv=await readFile(file.path,'utf8');
    assert.ok(csv.startsWith('\uFEFF'));assert.match(csv, /csv synthetic 10001/);
    assert.equal(csv.split('\r\n').length,10003);
    assert.ok(file.size>10001);
    assert.equal((await listTaskReportExports(pool,actor)).length,1);
    // A failure after rename must remove the finished file as well as its partial.
    const failed=await createTaskReportExport(pool,actor,{...input,requestId:randomUUID()});
    await pool.query(`CREATE FUNCTION test_export_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='COMPLETE' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_export_completion_failure BEFORE UPDATE ON task_report_exports
      FOR EACH ROW EXECUTE FUNCTION test_export_completion_failure()`);
    await worker.wake();
    assert.equal((await taskReportExportStatus(pool,actor,failed.id)).status,'FAILED');
    const failedLease=(await pool.query('SELECT lease_token FROM task_report_exports WHERE id=$1',[failed.id])).rows[0].lease_token;
    const failedPath=join(root,'report-exports',`${failed.id}-${failedLease}.csv`);
    await assert.rejects(readFile(failedPath),{code:'ENOENT'});await assert.rejects(readFile(`${failedPath}.partial`),{code:'ENOENT'});
    await pool.query('DROP TRIGGER test_export_completion_failure ON task_report_exports; DROP FUNCTION test_export_completion_failure()');
    // Expired files cannot be downloaded and are cleaned on the existing sweep.
    // A filesystem failure must remain retryable even after the job is EXPIRED.
    const deletionBlocker=`${file.path}.partial`;
    await mkdir(deletionBlocker);
    await pool.query("UPDATE task_report_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);
    await assert.rejects(readyTaskReportExport(pool,actor,first.id,root),{code:'REPORT_EXPORT_EXPIRED'});
    await worker.wake();
    assert.equal((await taskReportExportStatus(pool,actor,first.id)).status,'EXPIRED');
    await assert.rejects(readFile(file.path),{code:'ENOENT'});
    assert.equal((await pool.query('SELECT cardinality(retired_lease_tokens) AS n FROM task_report_exports WHERE id=$1',[first.id])).rows[0].n,1);
    assert.ok(resolve(deletionBlocker).startsWith(resolve(root)+'\\')||resolve(deletionBlocker).startsWith(resolve(root)+'/'));
    await rm(deletionBlocker,{recursive:true});
    await worker.wake();
    assert.equal((await pool.query('SELECT cardinality(retired_lease_tokens) AS n FROM task_report_exports WHERE id=$1',[first.id])).rows[0].n,0);
    // An idle producer keeps renewing with pool.max=1. A reclaimed token aborts
    // it even though no new row chunks arrive, without changing the new owner.
    await worker.dispose();
    const fenced=await createTaskReportExport(pool,actor,{...input,requestId:randomUUID()});
    let producerStarted;const producerReady=new Promise(resolve=>{producerStarted=resolve;});
    worker=createTaskReportExportWorker(pool,root,{logger:{error(){}},progressIntervalMs:20,heartbeatMs:40,
      csvStream:async function*(_pool,_actor,_query,{signal}) {
        yield {csv:'header\r\n',rows:0};producerStarted();
        await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
      }});
    const fencedWork=worker.wake();await producerReady;
    const fencedLease=(await pool.query('SELECT lease_token FROM task_report_exports WHERE id=$1',[fenced.id])).rows[0].lease_token;
    const newLease=randomUUID();
    await pool.query(`UPDATE task_report_exports SET lease_token=$2,row_count=999,
      retired_lease_tokens=array_append(retired_lease_tokens,lease_token) WHERE id=$1`,[fenced.id,newLease]);
    await fencedWork;
    const newOwner=(await pool.query('SELECT * FROM task_report_exports WHERE id=$1',[fenced.id])).rows[0];
    assert.equal(newOwner.status,'RUNNING');assert.equal(Number(newOwner.row_count),999);assert.equal(newOwner.lease_token,newLease);
    const fencedPath=join(root,'report-exports',`${fenced.id}-${fencedLease}.csv`);
    await assert.rejects(readFile(fencedPath),{code:'ENOENT'});await assert.rejects(readFile(`${fencedPath}.partial`),{code:'ENOENT'});
    await pool.query("UPDATE task_report_exports SET status='FAILED',lease_until=NULL WHERE id=$1",[fenced.id]);
    const queued=await Promise.all(Array.from({length:12},()=>createTaskReportExport(pool,actor,{...input,requestId:randomUUID()}).then(job=>job, error=>error)));
    assert.equal(queued.filter(item=>item.status==='QUEUED').length,10);
    assert.equal(queued.filter(item=>item.code==='REPORT_EXPORT_BUSY').length,2);
    status=await taskReportExportStatus(pool,actor,first.id);assert.equal(status.rowCount,10001);
  }finally{
    await worker?.dispose();await pool.end();await cluster.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
