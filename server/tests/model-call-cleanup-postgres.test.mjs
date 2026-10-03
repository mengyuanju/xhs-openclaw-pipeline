import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { backfillDeliveryModelCallCleanup, drainDeliveryModelCallCleanup, scheduleDeliveryModelCallCleanup } from '../src/model-call-cleanup.mjs';
import { listModelCalls, saveModelCall } from '../src/model-call-traces.mjs';

test('real PostgreSQL delivery cleanup preserves running/rework executions, rolls back and is bounded/idempotent', {
  skip: process.env.RUN_SCALING_POSTGRES !== '1', timeout: 120_000,
}, async () => {
  const cluster = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: cluster.connectionString });
  const pool = repository.pool;
  try {
    await repository.initialize();
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('cleanup-test','Synthetic executor')");
    const taskId = Number((await pool.query(`INSERT INTO tasks(query,created_by_node_id,copy_executor_node_id)
      VALUES ('synthetic cleanup test','cleanup-test','cleanup-test') RETURNING id`)).rows[0].id);
    const revisionId = Number((await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
      VALUES ($1,1,'{"copy":{"title":"synthetic","body":"test content","tags":[]}}',now()) RETURNING id`, [taskId])).rows[0].id);
    const runId = randomUUID();
    await pool.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,finished_at,image_production_chain_id)
      VALUES ($1,$2,$3,'COMPLETED','{}',clock_timestamp(),$1)`, [runId,taskId,revisionId]);
    async function execution({ finished = false, calls = 1 } = {}) {
      const id = randomUUID();
      await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,stage,snapshot)
        VALUES ($1,$2,'COPY','cleanup-test','TEXT_GENERATION','{}')`, [id,taskId]);
      for (let sequence = 1; sequence <= calls; sequence++) await saveModelCall(pool,id,randomUUID(),{
        sequence,stage:'TEXT_GENERATION',provider:'synthetic',operation:'TEXT',model:'fake-no-quota',status:'SUCCEEDED',
        prompt:'test only',request:'{}',response:'test result',durationMs:1000,startedAt:new Date(Date.now()-1000).toISOString(),finishedAt:new Date().toISOString(),
      });
      if (finished) await pool.query("UPDATE task_executions SET status='SUCCEEDED',finished_at=clock_timestamp() WHERE id=$1",[id]);
      return id;
    }
    const original = await execution({ finished:true,calls:3 });
    const running = await execution();
    const client = await pool.connect();
    let entry;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
      entry = Number((await client.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,approved_by_username)
        VALUES ($1,$2,$3,'admin') RETURNING id`,[taskId,revisionId,runId])).rows[0].id);
      await scheduleDeliveryModelCallCleanup(client,entry,taskId);
      await client.query('COMMIT');
    } finally { client.release(); }
    const subsequent = await execution({finished:true});
    const first = await drainDeliveryModelCallCleanup(pool,{limit:1,batchSize:2});
    assert.equal(first.deleted,2);
    let page = await listModelCalls(pool,taskId);
    assert.equal(page.total,3); assert.equal(page.cleanup.status,'DEFERRED');
    assert.ok(page.items.some(item=>item.executionId===running));
    assert.ok(page.items.some(item=>item.executionId===subsequent));
    assert.equal(Number((await pool.query('SELECT count(*) FROM task_executions WHERE task_id=$1',[taskId])).rows[0].count),3);
    assert.equal(Number((await pool.query('SELECT count(*) FROM copy_revisions WHERE task_id=$1',[taskId])).rows[0].count),1);
    await pool.query("UPDATE task_executions SET status='SUCCEEDED',finished_at=clock_timestamp() WHERE id=$1",[running]);
    await pool.query('UPDATE delivery_model_call_cleanup SET next_attempt_at=clock_timestamp() WHERE delivery_entry_id=$1',[entry]);
    // A failed deletion must roll back both removal and the completed marker.
    await pool.query(`CREATE FUNCTION test_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER test_cleanup_failure BEFORE DELETE ON model_call_traces FOR EACH ROW EXECUTE FUNCTION test_cleanup_failure()`);
    await assert.rejects(drainDeliveryModelCallCleanup(pool,{limit:1}),/injected failure/);
    assert.equal((await listModelCalls(pool,taskId)).total,3);
    // Reproduce a competing cleanup taking the job immediately after rollback.
    // Error-state writing must keep its short lock budget even with one connection.
    const single=new pg.Pool({...pool.options,max:1}),locker=await pool.connect();
    const connect=single.connect.bind(single);let lockAfterRollback=true;
    single.connect=async()=>{
      const connection=await connect(),query=connection.query.bind(connection);
      connection.query=async(sql,...args)=>{
        const result=await query(sql,...args);
        if(sql==='ROLLBACK'&&lockAfterRollback){
          lockAfterRollback=false;await locker.query('BEGIN');
          await locker.query('SELECT delivery_entry_id FROM delivery_model_call_cleanup WHERE delivery_entry_id=$1 FOR UPDATE',[entry]);
        }
        return result;
      };
      return connection;
    };
    try{
      await pool.query('UPDATE delivery_model_call_cleanup SET next_attempt_at=clock_timestamp() WHERE delivery_entry_id=$1',[entry]);
      const started=Date.now();
      await assert.rejects(drainDeliveryModelCallCleanup(single,{limit:1}),/injected failure/);
      assert.ok(Date.now()-started<2000,'error recovery does not wait for the external row lock');
      const reusable=await single.connect();
      try{assert.equal((await reusable.query('SELECT 1 AS value')).rows[0].value,1);}finally{reusable.release();}
    }finally{await locker.query('ROLLBACK');locker.release();await single.end();}
    await pool.query('DROP TRIGGER test_cleanup_failure ON model_call_traces; DROP FUNCTION test_cleanup_failure()');
    await pool.query('UPDATE delivery_model_call_cleanup SET next_attempt_at=clock_timestamp() WHERE delivery_entry_id=$1',[entry]);
    assert.equal((await drainDeliveryModelCallCleanup(pool,{limit:1})).deleted,2);
    page = await listModelCalls(pool,taskId);
    assert.equal(page.total,1);assert.equal(page.items[0].executionId,subsequent);
    assert.equal(page.cleanup.status,'COMPLETE');assert.equal(page.cleanup.deletedCount,4);
    assert.deepEqual(await drainDeliveryModelCallCleanup(pool),{processed:0,deleted:0});
    await assert.rejects(saveModelCall(pool,original,randomUUID(),{
      sequence:9,stage:'TEXT_GENERATION',provider:'synthetic',operation:'TEXT',status:'RUNNING',prompt:'',request:'{}',startedAt:new Date().toISOString(),
    }),/not found/,'late terminal execution writes cannot resurrect removed calls');
    // Backfill does not take executions that completed after the original delivery boundary.
    await pool.query('DELETE FROM delivery_model_call_cleanup WHERE delivery_entry_id=$1',[entry]);
    assert.equal(await backfillDeliveryModelCallCleanup(pool),1);
    assert.deepEqual((await pool.query('SELECT execution_ids FROM delivery_model_call_cleanup WHERE delivery_entry_id=$1',[entry])).rows[0].execution_ids,[original]);
    await drainDeliveryModelCallCleanup(pool);
    assert.equal((await listModelCalls(pool,taskId)).total,1);
    // Scheduling inside a rolled back delivery transaction leaves no cleanup job.
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query("UPDATE delivery_entries SET status='WITHDRAWN',withdrawn_at=now() WHERE id=$1",[entry]);
      const rolled = Number((await rollbackClient.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,approved_by_username)
        VALUES ($1,$2,$3,'admin') RETURNING id`,[taskId,revisionId,runId])).rows[0].id);
      await scheduleDeliveryModelCallCleanup(rollbackClient,rolled,taskId);
      await rollbackClient.query('ROLLBACK');
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM delivery_model_call_cleanup WHERE delivery_entry_id=$1',[rolled])).rows[0].count,0);
    } finally { rollbackClient.release(); }
  } finally { await pool.end(); await cluster.stop(); }
});
