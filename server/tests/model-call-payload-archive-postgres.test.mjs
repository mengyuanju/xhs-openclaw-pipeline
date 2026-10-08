import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { getModelCall, listModelCalls, normalizeModelCall, saveModelCall } from '../src/model-call-traces.mjs';
import { drainTerminalModelCallPayloadArchive, readTerminalModelCallPayloadArchiveStats,
  terminalModelCallArchivePageSql, encodeModelCallPayload } from '../src/model-call-payload-archive.mjs';
import { scheduleDeliveryModelCallCleanup, drainDeliveryModelCallCleanup } from '../src/model-call-cleanup.mjs';

test('real PostgreSQL terminal trace archive preserves exact details and delivery deletion under concurrency', {
  skip: process.env.RUN_SCALING_POSTGRES !== '1', timeout: 180_000,
}, async t => {
  const cluster = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: cluster.connectionString, max: 16 });
  const evidence = { isolatedTemporaryPostgres: true, developmentConnected: false, productionConnected: false,
    modelCalls: 0, checks: [], candidatePlan: null };
  const old = new Date(Date.now() - 14 * 86400_000).toISOString();
  const recent = new Date(Date.now() - 86400_000).toISOString();
  try {
    await migrateDatabase(pool);
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('payload-archive-test','Synthetic payload archive executor')");
    async function fixture({ calls = 1, executionStatus = 'SUCCEEDED', callStatus = 'SUCCEEDED',
      finishedAt = old, executionFinishedAt = finishedAt, size = 3000 } = {}) {
      const taskId = Number((await pool.query(`INSERT INTO tasks(query,created_by_node_id,copy_executor_node_id)
        VALUES ($1,'payload-archive-test','payload-archive-test') RETURNING id`, [`Synthetic archive ${randomUUID()}`])).rows[0].id);
      const executionId = randomUUID();
      await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,stage,snapshot)
        VALUES ($1,$2,'COPY','payload-archive-test','TEXT_GENERATION','{}')`, [executionId, taskId]);
      const records = [];
      for (let sequence = 1; sequence <= calls; sequence += 1) {
        const callId = randomUUID();
        const input = { sequence, stage: 'TEXT_GENERATION', provider: 'synthetic', operation: 'TEXT', model: 'fake-no-quota',
          status: callStatus, prompt: 'Synthetic 中文提示 🧪 '.repeat(size), request: JSON.stringify({ sequence, query: 'synthetic input' }),
          response: sequence % 2 ? 'Synthetic response '.repeat(size) : '', error: callStatus === 'FAILED' ? 'Synthetic failure' : null,
          durationMs: 1000, startedAt: old, finishedAt };
        await saveModelCall(pool, executionId, callId, input);
        records.push({ callId, input, normalized: normalizeModelCall(input) });
      }
      await pool.query('UPDATE task_executions SET status=$2,finished_at=$3 WHERE id=$1',
        [executionId, executionStatus, executionStatus === 'RUNNING' ? null : executionFinishedAt]);
      return { taskId, executionId, records };
    }
    async function capture(fixture) {
      return Promise.all(fixture.records.map(record => getModelCall(pool, fixture.taskId, record.callId)));
    }
    async function archiveAll() {
      for (let index = 0; index < 100; index += 1) {
        const result = await drainTerminalModelCallPayloadArchive(pool, { limit: 100, batchSize: 50, timeBudgetMs: 30_000 });
        if (!result.archived) break;
      }
    }
    async function delivery(fixture) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [fixture.taskId]);
        const revisionId = Number((await client.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
          VALUES ($1,1,'{"copy":{"title":"Synthetic","body":"Synthetic body","tags":[]}}',now()) RETURNING id`, [fixture.taskId])).rows[0].id);
        const runId = randomUUID();
        await client.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,finished_at,image_production_chain_id)
          VALUES ($1,$2,$3,'COMPLETED','{}',now(),$1)`, [runId, fixture.taskId, revisionId]);
        const entryId = Number((await client.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,approved_by_username)
          VALUES ($1,$2,$3,'synthetic') RETURNING id`, [fixture.taskId, revisionId, runId])).rows[0].id);
        await scheduleDeliveryModelCallCleanup(client, entryId, fixture.taskId);
        await client.query('COMMIT');
        return entryId;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }

    await t.test('old final calls move atomically, metadata/page counts and detailed strings are unchanged', async () => {
      const item = await fixture({ calls: 3, callStatus: 'FAILED' });
      const before = await capture(item), pageBefore = await listModelCalls(pool, item.taskId);
      const first = await drainTerminalModelCallPayloadArchive(pool, { limit: 1, batchSize: 2 });
      assert.equal(first.archived, 2); assert.equal(first.processed, 1);
      assert.ok(first.compressedBytes < first.rawBytes / 10);
      assert.deepEqual(await capture(item), before);
      assert.deepEqual(await listModelCalls(pool, item.taskId), pageBefore);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM model_call_traces WHERE payload_archived AND task_id=$1', [item.taskId])).rows[0].count, 2);
      assert.equal((await drainTerminalModelCallPayloadArchive(pool, { limit: 1, batchSize: 2 })).archived, 1);
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 0);
      const stats = await readTerminalModelCallPayloadArchiveStats(pool);
      assert.equal(stats.archivedCalls, 3); assert.equal(stats.eligibleCalls, 0);
      for (const record of item.records) {
        await saveModelCall(pool, item.executionId, record.callId, { ...record.input, status: 'RUNNING' });
      }
      assert.deepEqual(await capture(item), before, 'late replays preserve the original final body');
      await assert.rejects(saveModelCall(pool, item.executionId, randomUUID(), item.records[0].input), /not found/);
      evidence.checks.push('exact body/metadata/page recovery; batch bounds; idempotence; terminal late writes');
    });

    await t.test('RUNNING executions/calls, recent terminal calls and missing finish timestamps stay hot', async () => {
      const protectedItems = [await fixture({ executionStatus: 'RUNNING' }),
        await fixture({ callStatus: 'RUNNING' }), await fixture({ finishedAt: recent }),
        await fixture({ executionFinishedAt: recent }), await fixture({ executionFinishedAt: null })];
      const before = await Promise.all(protectedItems.map(capture));
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 0);
      assert.deepEqual(await Promise.all(protectedItems.map(capture)), before);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM model_call_traces WHERE payload_archived AND task_id=ANY($1::bigint[])', [protectedItems.map(item => item.taskId)])).rows[0].count, 0);
      evidence.checks.push('RUNNING/recent/missing finish protection');
    });

    await t.test('an injected update failure rolls back the archive row and hot body together', async () => {
      const item = await fixture(), before = await capture(item);
      await pool.query(`CREATE FUNCTION test_payload_archive_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.payload_archived THEN RAISE EXCEPTION 'injected archive failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_payload_archive_failure BEFORE UPDATE ON model_call_traces
        FOR EACH ROW EXECUTE FUNCTION test_payload_archive_failure()`);
      await assert.rejects(drainTerminalModelCallPayloadArchive(pool), /injected archive failure/);
      assert.deepEqual(await capture(item), before);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM model_call_payload_archives WHERE call_id=$1', [item.records[0].callId])).rows[0].count, 0);
      await pool.query('DROP TRIGGER test_payload_archive_failure ON model_call_traces; DROP FUNCTION test_payload_archive_failure()');
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 1);
      assert.deepEqual(await capture(item), before);
      evidence.checks.push('transaction rollback leaves full original body and no orphan archive');
    });

    await t.test('large Unicode payloads obey the 8 MiB batch memory bound and still restore exactly', async () => {
      const item = await fixture({ calls: 0, executionStatus: 'RUNNING' });
      const large = { sequence: 1, stage: 'TEXT_GENERATION', provider: 'synthetic', operation: 'TEXT',
        model: 'fake-no-quota', status: 'FAILED', prompt: '中'.repeat(200000), request: '文'.repeat(200000),
        response: '值'.repeat(200000), error: '错'.repeat(200000), durationMs: 1000, startedAt: old, finishedAt: old };
      const ids = [];
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        const id = randomUUID(); ids.push(id);
        await saveModelCall(pool, item.executionId, id, { ...large, sequence });
      }
      await pool.query("UPDATE task_executions SET status='FAILED',finished_at=$2 WHERE id=$1", [item.executionId, old]);
      const before = await getModelCall(pool, item.taskId, ids[0]);
      const result = await drainTerminalModelCallPayloadArchive(pool, { limit: 1, batchSize: 50 });
      assert.equal(result.archived, 3);
      assert.ok(result.rawBytes <= 8388608);
      await archiveAll();
      assert.deepEqual(await getModelCall(pool, item.taskId, ids[0]), before);
      assert.equal((await listModelCalls(pool, item.taskId)).total, 5);
      evidence.checks.push('8 MiB batch bound with maximum-length four-field Unicode payloads');
    });

    await t.test('maximum legal control-character texts survive their larger JSON archive envelope', async () => {
      const item = await fixture({ calls: 0, executionStatus: 'RUNNING' }), callId = randomUUID();
      const input = { sequence: 1, stage: 'TEXT_GENERATION', provider: 'synthetic', operation: 'TEXT',
        model: 'fake-no-quota', status: 'FAILED', prompt: '\u0001'.repeat(200000), request: '\u0002'.repeat(200000),
        response: '\u0003'.repeat(200000), error: '\u0004'.repeat(200000),
        durationMs: 1000, startedAt: old, finishedAt: old };
      await saveModelCall(pool, item.executionId, callId, input);
      await pool.query("UPDATE task_executions SET status='FAILED',finished_at=$2 WHERE id=$1", [item.executionId, old]);
      const before = await getModelCall(pool, item.taskId, callId);
      await archiveAll();
      const archive = (await pool.query('SELECT raw_bytes FROM model_call_payload_archives WHERE call_id=$1', [callId])).rows[0];
      assert.ok(archive.raw_bytes > 4194304 && archive.raw_bytes < 8388608);
      assert.deepEqual(await getModelCall(pool, item.taskId, callId), before);
      evidence.checks.push('maximum legal control-character bodies: 4.8MB JSON archive and exact detail restoration');
    });

    await t.test('task/execution/call locks skip safely and 30 readers plus valid active writes preserve data', async () => {
      const item = await fixture({ calls: 4 }), before = await capture(item);
      for (const [table, key, value] of [['tasks', 'id', item.taskId], ['task_executions', 'id', item.executionId],
        ['model_call_traces', 'execution_id', item.executionId]]) {
        const locker = await pool.connect();
        try {
          await locker.query('BEGIN');
          await locker.query(`SELECT id FROM ${table} WHERE ${key}=$1 FOR UPDATE`, [value]);
          assert.equal((await drainTerminalModelCallPayloadArchive(pool, { limit: 1 })).archived, 0);
          assert.deepEqual(await capture(item), before);
        } finally { await locker.query('ROLLBACK'); locker.release(); }
      }
      const active = await fixture({ executionStatus: 'RUNNING' });
      await Promise.all([drainTerminalModelCallPayloadArchive(pool, { limit: 10 }),
        ...Array.from({ length: 30 }, async (_, index) => {
          assert.deepEqual(await capture(item), before);
          await saveModelCall(pool, active.executionId, randomUUID(), { ...active.records[0].input, sequence: index + 10 });
          assert.deepEqual(await capture(item), before);
        })]);
      assert.deepEqual(await capture(item), before);
      assert.equal((await listModelCalls(pool, active.taskId, { limit: 100 })).total, 31);
      evidence.checks.push('task/execution/call SKIP LOCKED; 30 concurrent detail reads and active writes');
    });

    await t.test('captured delivery calls are deleted rather than archived; archived bodies cascade on delivery', async () => {
      const archived = await fixture({ calls: 2 });
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 2);
      await delivery(archived);
      assert.equal((await drainDeliveryModelCallCleanup(pool)).deleted, 2);
      assert.equal((await listModelCalls(pool, archived.taskId)).total, 0);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM model_call_payload_archives WHERE call_id=ANY($1::uuid[])', [archived.records.map(record => record.callId)])).rows[0].count, 0);
      const pending = await fixture({ calls: 2 });
      await delivery(pending);
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 0);
      assert.equal((await drainDeliveryModelCallCleanup(pool)).deleted, 2);
      await assert.rejects(getModelCall(pool, pending.taskId, pending.records[0].callId), /not found/);
      evidence.checks.push('delivery DELETE priority and archive foreign-key cascade');
    });

    await t.test('100,000 excluded calls cannot expand a pass beyond 1000 IDs or starve later eligible calls', async () => {
      await archiveAll();
      const running = await fixture({ calls: 0, executionStatus: 'RUNNING' });
      const captured = await fixture({ calls: 0 });
      const locked = await fixture({ calls: 0 });
      await delivery(captured);
      await pool.query(`INSERT INTO model_call_traces(id,task_id,execution_id,sequence,stage,provider,operation,
          status,prompt,request,started_at,finished_at)
        SELECT gen_random_uuid(),CASE g%3 WHEN 0 THEN $1::bigint WHEN 1 THEN $2::bigint ELSE $3::bigint END,
          CASE g%3 WHEN 0 THEN $4::uuid WHEN 1 THEN $5::uuid ELSE $6::uuid END,g,'COMPLETE','synthetic','TEXT',
          'SUCCEEDED','','',$7::timestamptz,$7::timestamptz+g*interval '1 microsecond'
        FROM generate_series(1,100000) g`, [running.taskId, captured.taskId, locked.taskId,
        running.executionId, captured.executionId, locked.executionId, old]);
      const later = await fixture({ finishedAt: new Date(Date.parse(old) + 200).toISOString() });
      const boundedPool = new pg.Pool({ connectionString: cluster.connectionString, max: 4 });
      const locker = await pool.connect();
      const passes = [];
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [locked.taskId]);
        for (let index = 0; index < 110; index += 1) {
          const started = Date.now();
          const result = await drainTerminalModelCallPayloadArchive(boundedPool, { limit: 10, timeBudgetMs: 1000 });
          passes.push({ ...result, durationMs: Date.now() - started });
          assert.ok(result.scanned <= 1000, 'joins and SKIP LOCKED never widen the raw indexed page');
          if (index === 0) { assert.equal(result.scanned, 1000); assert.equal(result.archived, 0); }
          if (result.archived) { assert.equal(result.archived, 1); break; }
        }
        assert.ok(passes.at(-1).archived === 1, 'the persistent cursor reaches work after 100,000 excluded IDs');
        assert.ok(passes.reduce((total, pass) => total + pass.scanned, 0) >= 100001);
        assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM model_call_traces
          WHERE task_id=ANY($1::bigint[]) AND payload_archived`, [[running.taskId, captured.taskId, locked.taskId]])).rows[0].count, 0);
        assert.equal((await pool.query('SELECT payload_archived FROM model_call_traces WHERE id=$1', [later.records[0].callId])).rows[0].payload_archived, true);
        evidence.excludedCandidateProof = { excludedCalls: 100000, maxIdsPerPass: Math.max(...passes.map(pass => pass.scanned)),
          passes: passes.length, totalIdsScanned: passes.reduce((total, pass) => total + pass.scanned, 0),
          maximumPassMs: Math.max(...passes.map(pass => pass.durationMs)), firstPass: passes[0], lastPass: passes.at(-1),
          runningCapturedAndLockedBodiesUnchanged: true, laterEligibleCallArchived: true };
      } finally {
        await locker.query('ROLLBACK'); locker.release(); await boundedPool.end();
        await pool.query('DELETE FROM tasks WHERE id=ANY($1::bigint[])', [[running.taskId, captured.taskId, locked.taskId, later.taskId]]);
        await pool.query('VACUUM (ANALYZE) model_call_traces');
      }
      evidence.checks.push('100,000 RUNNING/captured/task-locked calls; indexed tuple cursor <=1000/pass and later work fairness');
    });

    await t.test('candidate lookup uses terminal/pending indexes on an isolated representative history', async () => {
      await archiveAll();
      // 12,000 old finalized executions with no pending trace should not force
      // a table scan of their snapshots to find one remaining payload.
      const taskId = Number((await pool.query(`INSERT INTO tasks(query,created_by_node_id,copy_executor_node_id)
        VALUES ('Synthetic indexed archive history','payload-archive-test','payload-archive-test') RETURNING id`)).rows[0].id);
      await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot,finished_at)
        SELECT gen_random_uuid(),$1,'COPY','payload-archive-test','SUCCEEDED','COMPLETE','{}',
          now()-interval '30 days'+g*interval '1 second' FROM generate_series(1,12000) g`, [taskId]);
      const empty = await encodeModelCallPayload({ prompt: '', request: '', response: null, error: null });
      await pool.query(`WITH inserted AS (
        INSERT INTO model_call_traces(id,task_id,execution_id,sequence,stage,provider,operation,model,status,
          prompt,request,started_at,finished_at,payload_archived)
        SELECT gen_random_uuid(),task_id,id,1,'COMPLETE','synthetic','TEXT','fake-no-quota','SUCCEEDED',
          '','',finished_at-interval '1 second',finished_at,true FROM task_executions WHERE task_id=$1
        RETURNING id
      ) INSERT INTO model_call_payload_archives(call_id,payload,raw_bytes,sha256)
        SELECT id,$2,$3,$4 FROM inserted`, [taskId, empty.payload, empty.rawBytes, empty.sha256]);
      const pending = await fixture();
      await pool.query('ANALYZE tasks; ANALYZE task_executions; ANALYZE model_call_traces; ANALYZE delivery_model_call_cleanup');
      const cutoff = new Date(Date.now() - 7 * 86400_000);
      const pageParams = [cutoff, '-infinity', '00000000-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-000000000000', 100];
      async function explainPage() {
        const client = await pool.connect();
        try {
          await client.query('BEGIN'); await client.query('SET LOCAL enable_seqscan=off');
          return (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${terminalModelCallArchivePageSql}`, pageParams)).rows[0]['QUERY PLAN'][0];
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      const plan = await explainPage();
      evidence.pagePlannerSetting = 'SET LOCAL enable_seqscan=off; maintenance index page transaction only';
      evidence.candidatePlan = plan;
      const planText = JSON.stringify(plan);
      assert.match(planText, /model_call_traces_payload_archive_pending_idx/);
      assert.ok(plan['Execution Time'] < 200, 'the real archive candidate statement remains bounded');
      assert.ok(plan.Plan['Shared Hit Blocks'] < 500, 'sparse payload work must not read 12,000 historical execution rows');
      assert.equal((await drainTerminalModelCallPayloadArchive(pool)).archived, 1);
      assert.equal((await pool.query('SELECT payload_archived FROM model_call_traces WHERE id=$1', [pending.records[0].callId])).rows[0].payload_archived, true);
      // At initial rollout the same population can consist almost entirely of
      // pending payloads. The same call finish-time index gives LIMIT a fast path.
      await pool.query(`DELETE FROM model_call_payload_archives archive USING model_call_traces call
        WHERE archive.call_id=call.id AND call.task_id=$1`, [taskId]);
      await pool.query('UPDATE model_call_traces SET payload_archived=false WHERE task_id=$1', [taskId]);
      await pool.query('ANALYZE model_call_traces');
      const initialPlan = await explainPage();
      evidence.initialArchivePlan = initialPlan;
      assert.match(JSON.stringify(initialPlan), /model_call_traces_payload_archive_pending_idx/);
      assert.ok(initialPlan['Execution Time'] < 200, 'initial-rollout candidate lookup stays bounded');
      assert.ok(initialPlan.Plan['Shared Hit Blocks'] < 500, 'initial-rollout LIMIT must not aggregate all pending histories');
      evidence.checks.push('real EXPLAIN ANALYZE: 12,000 history executions and pending payload index');
    });
    if (process.env.RUN_SCALING_POSTGRES === '1') {
      await mkdir(new URL('../../reports/', import.meta.url), { recursive: true });
      await writeFile(new URL('../../reports/terminal-model-call-archive-postgres-proof.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  } finally { await pool.end(); await cluster.stop(); }
});
