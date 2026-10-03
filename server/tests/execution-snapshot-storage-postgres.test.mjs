import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/database-migrations.mjs';
import {
  drainExecutionSnapshotBackfill,
  hydrateExecutionSnapshots,
  storeExecutionSnapshot,
  storeExecutionSnapshotBatch,
} from '../src/execution-snapshot-storage.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

function snapshot(index = 0) {
  return {
    schemaVersion: 1,
    capturedAt: `2026-10-02T01:00:${String(index).padStart(2, '0')}.000Z`,
    prompts: { COPY: { version: 7, name: 'pinned original prompt', content: 'prompt '.repeat(4000) } },
    knowledge: [{ itemId: 5, versionId: 17, kind: 'COPY', content: 'pinned knowledge '.repeat(1200) }],
    productionSettings: { production: { version: 4, value: { model: 'test-no-provider', temperature: 0.2 } } },
    task: { id: index + 1, query: `synthetic snapshot ${index}`, input: { test: true } },
    copyRevision: { id: index + 101, content: { copy: `per-execution copy ${index}` } },
    imageRetry: { failedAttempts: index % 3, nodeId: 'snapshot-test' },
    imageRecovery: { nodeId: 'snapshot-test', runIds: [randomUUID()] },
    imageProductionChainId: randomUUID(),
    imageEditRequestId: randomUUID(),
  };
}

function rowFor(stored, id = randomUUID()) {
  return {
    id,
    snapshot: stored.snapshot,
    snapshot_prompts_hash: stored.promptsHash,
    snapshot_knowledge_hash: stored.knowledgeHash,
    snapshot_production_settings_hash: stored.productionSettingsHash,
  };
}

test('isolated PostgreSQL execution snapshot contents preserve configurations with 30 concurrent writers and bounded maintenance', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18('execution-snapshot-storage-');
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 30 });
  try {
    await migrateDatabase(pool);
    assert.deepEqual(await migrateDatabase(pool), []);
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES('snapshot-test','snapshot test')");
    const taskIds = [];
    async function addExecution(value, { compact = false, status = 'SUCCEEDED', cleared = false, executionId = randomUUID() } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const taskId = Number((await client.query(`INSERT INTO tasks(query,state,created_by_node_id)
          VALUES('synthetic snapshot fixture','COPY_REVIEW_PENDING','snapshot-test') RETURNING id`)).rows[0].id);
        const id = executionId;
        const stored = compact ? await storeExecutionSnapshot(client, value)
          : { snapshot: value, promptsHash: null, knowledgeHash: null, productionSettingsHash: null };
        await client.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot,
          snapshot_prompts_hash,snapshot_knowledge_hash,snapshot_production_settings_hash,content_cleared_at)
          VALUES($1,$2,'COPY','snapshot-test',$3,'DONE',$4,$5,$6,$7,CASE WHEN $8 THEN now() END)`,
        [id, taskId, status, stored.snapshot, stored.promptsHash, stored.knowledgeHash, stored.productionSettingsHash, cleared]);
        await client.query('COMMIT');
        taskIds.push(taskId);
        return { ...rowFor(stored, id), task_id: taskId };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    let concurrent;
    await t.test('30 concurrent writes share each configuration section and keep all execution differences', async () => {
      const full = Array.from({ length: 30 }, (_, index) => snapshot(index));
      concurrent = await Promise.all(full.map(value => addExecution(value, { compact: true })));
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count), 3);
      assert.equal(new Set(concurrent.map(row => row.snapshot_prompts_hash)).size, 1);
      assert.equal(new Set(concurrent.map(row => row.snapshot_knowledge_hash)).size, 1);
      assert.equal(new Set(concurrent.map(row => row.snapshot_production_settings_hash)).size, 1);
      let contentQueries = 0;
      const restored = await hydrateExecutionSnapshots({ query: async (...args) => {
        contentQueries++; return pool.query(...args);
      } }, concurrent);
      assert.equal(contentQueries, 1, 'all configurations are hydrated in one batch query');
      for (let index = 0; index < 30; index++) {
        assert.deepEqual(restored[index].snapshot, full[index]);
        for (const field of ['prompts', 'knowledge', 'productionSettings']) assert.equal(Object.hasOwn(concurrent[index].snapshot, field), false);
        assert.deepEqual(concurrent[index].snapshot.imageRetry, full[index].imageRetry);
        assert.equal(concurrent[index].snapshot.imageEditRequestId, full[index].imageEditRequestId);
      }
      restored[0].snapshot.prompts.COPY.content = 'executor local mutation';
      assert.equal(restored[1].snapshot.prompts.COPY.content, full[1].prompts.COPY.content);
      assert.equal((await hydrateExecutionSnapshots(pool, [concurrent[0]]))[0].snapshot.prompts.COPY.content, full[0].prompts.COPY.content);
    });
    await t.test('property order and settings changes do not duplicate pinned prompt or knowledge content', async () => {
      const original = snapshot(30);
      const first = await storeExecutionSnapshot(pool, original);
      const reordered = {
        ...original,
        prompts: { COPY: { content: original.prompts.COPY.content, name: original.prompts.COPY.name, version: 7 } },
        productionSettings: { production: { value: { temperature: 0.9, model: 'test-new-config' }, version: 5 } },
      };
      const second = await storeExecutionSnapshot(pool, reordered);
      assert.equal(second.promptsHash, first.promptsHash);
      assert.equal(second.knowledgeHash, first.knowledgeHash);
      assert.notEqual(second.productionSettingsHash, first.productionSettingsHash);
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count), 4);
      const restored = await hydrateExecutionSnapshots(pool, [rowFor(first), rowFor(second)]);
      assert.deepEqual(restored.map(row => row.snapshot), [original, reordered]);
    });
    await t.test('legacy, absent, explicit null and unknown snapshot fields preserve their existing meaning', async () => {
      const legacy = { id: randomUUID(), snapshot: { prompts: null, productionSettings: null, customFutureField: { enabled: true } } };
      const rows = [legacy];
      let reads = 0;
      assert.equal(await hydrateExecutionSnapshots({ query: async () => { reads++; throw new Error('unexpected content read'); } }, rows), rows);
      assert.equal(reads, 0);
      const stored = await storeExecutionSnapshot(pool, legacy.snapshot);
      assert.deepEqual(stored, { snapshot: legacy.snapshot, promptsHash: null, knowledgeHash: null, productionSettingsHash: null });
      assert.equal(Object.hasOwn(stored.snapshot, 'knowledge'), false);
      assert.deepEqual((await hydrateExecutionSnapshots(pool, [rowFor(stored)]))[0].snapshot, legacy.snapshot);
      assert.deepEqual(await storeExecutionSnapshot(pool, {}), { snapshot: {}, promptsHash: null, knowledgeHash: null, productionSettingsHash: null });
    });
    await t.test('a failed execution transaction rolls back new shared configuration content', async () => {
      const countBefore = Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = snapshot(31);
        value.prompts.COPY.content = randomUUID();
        value.knowledge[0].content = randomUUID();
        value.productionSettings.production.value.model = randomUUID();
        await storeExecutionSnapshot(client, value);
        await client.query('ROLLBACK');
      } finally { client.release(); }
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count), countBefore);
    });
    await t.test('references protect frozen content and missing or inconsistent data never silently uses new configuration', async () => {
      const row = concurrent[0];
      await assert.rejects(pool.query('UPDATE execution_snapshot_contents SET payload=$2 WHERE sha256=$1', [row.snapshot_prompts_hash, { changed: true }]), /immutable/u);
      await assert.rejects(pool.query('DELETE FROM execution_snapshot_contents WHERE sha256=$1', [row.snapshot_prompts_hash]), { code: '23503' });
      await assert.rejects(hydrateExecutionSnapshots({ query: async () => ({ rows: [] }) }, [row]), /Missing execution snapshot/u);
      await assert.rejects(hydrateExecutionSnapshots(pool, [{ ...row, snapshot: { ...row.snapshot, prompts: { changed: true } } }]), /inline configuration conflicts/u);
      const input = { prompts: { content: `synthetic corrupt hash ${randomUUID()}` } };
      const client = await pool.connect();
      let stored;
      try {
        await client.query('BEGIN'); stored = await storeExecutionSnapshot(client, input); await client.query('ROLLBACK');
      } finally { client.release(); }
      await pool.query('INSERT INTO execution_snapshot_contents(sha256,payload) VALUES($1,$2)', [stored.promptsHash, { unrelated: true }]);
      await assert.rejects(storeExecutionSnapshot(pool, input), /hash collision/u);
      await assert.rejects(hydrateExecutionSnapshots(pool, [rowFor(stored)]), /Corrupt execution snapshot/u);
      await pool.query('DELETE FROM execution_snapshot_contents WHERE sha256=$1', [stored.promptsHash]);
    });
    await t.test('historical backfill is bounded, skips running and cleared executions, and tolerates 30 concurrent sweepers', async () => {
      const values = Array.from({ length: 7 }, (_, index) => snapshot(index));
      const legacy = [];
      for (const value of values) legacy.push(await addExecution(value));
      const running = await addExecution(snapshot(8), { status: 'RUNNING' });
      const cleared = await addExecution(snapshot(9), { cleared: true });
      const nullOnly = await addExecution({ prompts: null, knowledge: null, productionSettings: null });
      const first = await drainExecutionSnapshotBackfill(pool, { batchSize: 2, maxBatches: 1 });
      assert.equal(first.processed, 2);
      assert.ok(first.logicalBytesSaved > 80_000, 'already shared contents are not charged again for logical savings');
      const swept = await Promise.all(Array.from({ length: 30 }, () => drainExecutionSnapshotBackfill(pool, { batchSize: 1, maxBatches: 1 })));
      assert.equal(swept.reduce((total, sweep) => total + sweep.processed, 0), 5);
      for (const { id } of [running, cleared, nullOnly]) {
        const persisted = (await pool.query('SELECT * FROM task_executions WHERE id=$1', [id])).rows[0];
        assert.equal(persisted.snapshot_prompts_hash, null);
        assert.equal(persisted.snapshot_knowledge_hash, null);
        assert.equal(persisted.snapshot_production_settings_hash, null);
      }
      const persisted = (await pool.query('SELECT * FROM task_executions WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)', [legacy.map(row => row.id)])).rows;
      assert.deepEqual((await hydrateExecutionSnapshots(pool, persisted)).map(row => row.snapshot), values);
      assert.deepEqual(await drainExecutionSnapshotBackfill(pool), { processed: 0, logicalBytesSaved: 0 });
    });
    await t.test('locked executions are skipped and a failed compaction transaction remains fully retryable', async () => {
      const legacy = await addExecution(snapshot(11));
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN'); await locker.query('SELECT id FROM task_executions WHERE id=$1 FOR UPDATE', [legacy.id]);
        assert.deepEqual(await drainExecutionSnapshotBackfill(pool), { processed: 0, logicalBytesSaved: 0 });
        assert.deepEqual((await pool.query('SELECT snapshot FROM task_executions WHERE id=$1', [legacy.id])).rows[0].snapshot, legacy.snapshot);
        await locker.query('ROLLBACK');
      } finally { locker.release(); }
      await pool.query(`CREATE FUNCTION reject_snapshot_compaction() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic snapshot compaction failure'; END $$;
        CREATE TRIGGER reject_snapshot_compaction BEFORE UPDATE ON task_executions
        FOR EACH ROW EXECUTE FUNCTION reject_snapshot_compaction()`);
      await assert.rejects(drainExecutionSnapshotBackfill(pool), /synthetic snapshot compaction failure/u);
      assert.deepEqual((await pool.query('SELECT snapshot FROM task_executions WHERE id=$1', [legacy.id])).rows[0].snapshot, legacy.snapshot);
      await pool.query('DROP TRIGGER reject_snapshot_compaction ON task_executions; DROP FUNCTION reject_snapshot_compaction()');
      assert.equal((await drainExecutionSnapshotBackfill(pool)).processed, 1);
      const row = (await pool.query('SELECT * FROM task_executions WHERE id=$1', [legacy.id])).rows[0];
      assert.deepEqual((await hydrateExecutionSnapshots(pool, [row]))[0].snapshot, legacy.snapshot);
    });
    await t.test('empty backlog lookup uses the partial index rather than scanning large execution history', async () => {
      await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot)
        SELECT gen_random_uuid(),$1,'COPY','snapshot-test','SUCCEEDED','DONE','{}'::jsonb
        FROM generate_series(1,10000)`, [taskIds[0]]);
      await pool.query('ANALYZE task_executions');
      let lookupPlan;
      const instrumented = { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, args) => {
          if (String(sql).startsWith('SELECT * FROM task_executions')) {
            lookupPlan = (await client.query('EXPLAIN (FORMAT JSON) ' + sql, args)).rows[0]['QUERY PLAN'][0].Plan;
          }
          return client.query(sql, args);
        } };
      } };
      assert.deepEqual(await drainExecutionSnapshotBackfill(instrumented), { processed: 0, logicalBytesSaved: 0 });
      assert.ok(JSON.stringify(lookupPlan).includes('task_executions_snapshot_backfill_idx'));
    });
    await t.test('opposite configuration orders in concurrent claim-sized batches and backfill batches use one globally sorted insert', async () => {
      const marker = randomUUID();
      const left = { ...snapshot(40), prompts: { COPY: { content: `${marker} left` } },
        knowledge: [{ content: `${marker} shared knowledge` }], productionSettings: { production: { value: { marker } } } };
      const right = { ...snapshot(41), prompts: { COPY: { content: `${marker} right` } },
        knowledge: left.knowledge, productionSettings: left.productionSettings };
      const legacy = [];
      for (const [index, value] of [left, right, right, left].entries()) {
        legacy.push(await addExecution(value, { executionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
      }
      let picked = 0, release;
      const bothPicked = new Promise(accept => { release = accept; });
      const sortedInserts = [];
      function inspectInsert(sql, args) {
        if (String(sql).startsWith('INSERT INTO execution_snapshot_contents')) {
          const hashes = JSON.parse(args[0]).map(entry => entry.sha256);
          assert.deepEqual(hashes, [...hashes].sort());
          assert.equal(new Set(hashes).size, hashes.length);
          sortedInserts.push(hashes);
        }
      }
      const maintenancePool = { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, args) => {
          inspectInsert(sql, args);
          const result = await client.query(sql, args);
          if (String(sql).startsWith('SELECT * FROM task_executions') && result.rows.length) {
            assert.equal(result.rows.length, 2);
            picked++;
            if (picked === 2) release();
            await bothPicked;
          }
          return result;
        } };
      } };
      async function writeBatch(index) {
        const client = await pool.connect();
        let inserts = 0;
        const counted = { query: (sql, args) => {
          inspectInsert(sql, args);
          if (String(sql).startsWith('INSERT INTO execution_snapshot_contents')) inserts++;
          return client.query(sql, args);
        } };
        try {
          await client.query('BEGIN');
          const values = index % 2 ? [left, right] : [right, left];
          const stored = await storeExecutionSnapshotBatch(counted, values);
          assert.equal(inserts, 1, 'distinct configurations are inserted as one whole-transaction batch');
          assert.deepEqual((await hydrateExecutionSnapshots(client, stored.map(value => rowFor(value)))).map(row => row.snapshot), values);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      }
      const results = await Promise.all([
        drainExecutionSnapshotBackfill(maintenancePool, { batchSize: 2, maxBatches: 1 }),
        drainExecutionSnapshotBackfill(maintenancePool, { batchSize: 2, maxBatches: 1 }),
        ...Array.from({ length: 20 }, (_, index) => writeBatch(index)),
      ]);
      assert.deepEqual(results.slice(0, 2).map(result => result.processed), [2, 2]);
      assert.equal(sortedInserts.length, 22);
      for (const hashes of sortedInserts) assert.equal(hashes.length, 4);
      const persisted = (await pool.query('SELECT * FROM task_executions WHERE id=ANY($1::uuid[]) ORDER BY id', [legacy.map(row => row.id)])).rows;
      assert.deepEqual((await hydrateExecutionSnapshots(pool, persisted)).map(row => row.snapshot), [left, right, right, left]);
      const countBefore = Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await storeExecutionSnapshotBatch(client, [{ prompts: { isolated: randomUUID() } }, { knowledge: [{ isolated: randomUUID() }] }]);
        await client.query('ROLLBACK');
      } finally { client.release(); }
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_snapshot_contents')).rows[0].count), countBefore);
    });
  } finally { await pool.end(); await database.stop(); }
});
