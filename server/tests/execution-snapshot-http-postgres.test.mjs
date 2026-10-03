import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { BUILTIN_LAYOUT_CATALOG } from '../src/layout-catalog.mjs';
import { drainExecutionSnapshotBackfill } from '../src/execution-snapshot-storage.mjs';
import { requestIdAt } from './fixtures/claim-request-id.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

test('real HTTP and isolated PostgreSQL preserve pinned snapshots across 30 claims, receipt replays, failures and manual/image retries', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18('execution-snapshot-http-');
  const storageRoot = await mkdtemp(join(tmpdir(), 'execution-snapshot-http-assets-'));
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 30 });
  let app, server;
  try {
    await migrateDatabase(pool);
    const repository = new PostgresControlPlaneRepository({ pool, executionSnapshotStorageEnabled: true });
    const nodes = Array.from({ length: 30 }, (_, index) => `snapshot-http-${index}`);
    for (const node of nodes) {
      await pool.query('INSERT INTO codex_concurrency_pools(id,total_concurrency,image_concurrency) VALUES($1,1,1)', [node]);
      await pool.query('INSERT INTO executor_nodes(id,name,codex_pool_id,image_worker_enabled) VALUES($1,$1,$1,true)', [node]);
    }
    await pool.query(`INSERT INTO tasks(query,state,created_by_node_id)
      SELECT 'synthetic HTTP snapshot '||i,'COPY_QUEUED',$1 FROM generate_series(1,30) i`, [nodes[0]]);
    const oldPrompt = await repository.createPromptVersion({ kind: 'COPY', name: 'snapshot test', content: 'pinned original '.repeat(2000) });
    await repository.publishPromptVersion(oldPrompt.id);
    const knowledgeId = Number((await pool.query(`INSERT INTO knowledge_items(kind,name) VALUES('COPY','snapshot test') RETURNING id`)).rows[0].id);
    async function changeConfiguration(generation) {
      const prompt = await repository.createPromptVersion({ kind: 'COPY', name: 'snapshot test', content: `${generation} prompt `.repeat(2000) });
      await repository.publishPromptVersion(prompt.id);
      await pool.query("UPDATE knowledge_versions SET status='ARCHIVED' WHERE item_id=$1 AND status='PUBLISHED'", [knowledgeId]);
      const version = Number((await pool.query('SELECT coalesce(max(version),0)+1 AS version FROM knowledge_versions WHERE item_id=$1', [knowledgeId])).rows[0].version);
      const content = { testGeneration: generation, text: `${generation} knowledge `.repeat(1000) };
      await pool.query(`INSERT INTO knowledge_versions(item_id,version,content,content_sha256,status)
        VALUES($1,$2,$3,$4,'PUBLISHED')`, [knowledgeId, version, content, createHash('sha256').update(JSON.stringify(content)).digest('hex')]);
      await pool.query(`UPDATE global_settings SET value=value||$1::jsonb,version=version+1 WHERE key='production'`, [{ snapshotTestGeneration: generation }]);
    }
    await changeConfiguration('original');
    app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth: false,
      reportProjectionEnabled: false, disposableCleanupEnabled: false, storageOptimizationEnabled: false,
      logger: { info() {}, error() {} } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(accept => server.once('listening', accept));
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function api(path, body, method = body === undefined ? 'GET' : 'POST', expectedStatus = 200) {
      const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result.error ?? {})}`);
      return response.status >= 400 ? result : result.data;
    }
    async function copyClaims() {
      const requestIds = nodes.map(() => requestIdAt());
      const responses = await Promise.all(nodes.map((nodeId, index) => api('/v1/executions/claim-copy-batch', { nodeId, limit: 1, requestId: requestIds[index] })));
      assert.equal(responses.flatMap(response => response.claims).length, 30);
      return { responses, requestIds };
    }
    let initial, snapshotsByTask;
    await t.test('30 simultaneous HTTP claims store compact rows and return complete legacy executor snapshots', async () => {
      initial = await copyClaims();
      const claims = initial.responses.flatMap(response => response.claims);
      snapshotsByTask = new Map(claims.map(claim => [claim.task.id, claim.execution.snapshot]));
      assert.equal(new Set(claims.map(claim => claim.execution.id)).size, 30);
      assert.equal(new Set(claims.map(claim => claim.task.id)).size, 30);
      for (const claim of claims) {
        assert.equal(claim.execution.snapshot.productionSettings.production.value.snapshotTestGeneration, 'original');
        assert.equal(claim.execution.snapshot.knowledge[0].content.testGeneration, 'original');
      }
      const persisted = (await pool.query('SELECT * FROM task_executions')).rows;
      assert.equal(persisted.length, 30);
      assert.equal(new Set(persisted.map(row => row.snapshot_prompts_hash)).size, 1);
      assert.equal(new Set(persisted.map(row => row.snapshot_knowledge_hash)).size, 1);
      assert.equal(new Set(persisted.map(row => row.snapshot_production_settings_hash)).size, 1);
      for (const row of persisted) {
        assert.ok(row.snapshot_prompts_hash && row.snapshot_knowledge_hash && row.snapshot_production_settings_hash);
        assert.equal(Object.hasOwn(row.snapshot, 'prompts'), false);
        assert.equal(Object.hasOwn(row.snapshot, 'knowledge'), false);
        assert.equal(Object.hasOwn(row.snapshot, 'productionSettings'), false);
      }
    });
    await changeConfiguration('updated');
    await t.test('30 idempotency replays and progress replies retain original configuration after administrator changes', async () => {
      const repeated = await Promise.all(nodes.map((nodeId, index) => api('/v1/executions/claim-copy-batch', { nodeId, limit: 1, requestId: initial.requestIds[index] })));
      for (let index = 0; index < repeated.length; index++) {
        assert.equal(repeated[index].requestId, initial.requestIds[index]);
        assert.equal(repeated[index].claims[0].execution.id, initial.responses[index].claims[0].execution.id);
        assert.deepEqual(repeated[index].claims[0].execution.snapshot, initial.responses[index].claims[0].execution.snapshot);
      }
      const progress = await Promise.all(initial.responses.map(response => api(`/v1/executions/${response.claims[0].execution.id}/progress`,
        { stage: 'STARTING_COPY', progressPercent: 10, message: 'synthetic progress only' }, 'PATCH')));
      for (let index = 0; index < progress.length; index++) {
        assert.deepEqual(progress[index].snapshot, initial.responses[index].claims[0].execution.snapshot);
      }
    });
    let resumed;
    await t.test('30 retries of running executions restore captured configuration and abandon only the original execution', async () => {
      await Promise.all([...snapshotsByTask.keys()].map(taskId => api(`/v1/tasks/${taskId}/retry`, { useLatestConfig: false })));
      resumed = await copyClaims();
      for (const claim of resumed.responses.flatMap(response => response.claims)) {
        assert.deepEqual(claim.execution.snapshot, snapshotsByTask.get(claim.task.id));
      }
      assert.equal(Number((await pool.query("SELECT count(*) FROM task_executions WHERE status='ABANDONED'")).rows[0].count), 30);
      const replay = await api('/v1/executions/claim-copy-batch', { nodeId: nodes[0], limit: 1, requestId: initial.requestIds[0] });
      assert.equal(replay.claims[0].execution.status, 'ABANDONED');
      assert.deepEqual(replay.claims[0].execution.snapshot, initial.responses[0].claims[0].execution.snapshot);
    });
    let failedResumed;
    await t.test('30 failed-execution retries read complete historical snapshots and keep their original prompts and knowledge', async () => {
      await Promise.all(resumed.responses.flatMap(response => response.claims).map(claim => api(`/v1/executions/${claim.execution.id}/fail`, { error: 'synthetic failure without provider' })));
      await Promise.all([...snapshotsByTask.keys()].map(taskId => api(`/v1/tasks/${taskId}/retry`, { useLatestConfig: false })));
      failedResumed = await copyClaims();
      for (const claim of failedResumed.responses.flatMap(response => response.claims)) {
        assert.deepEqual(claim.execution.snapshot, snapshotsByTask.get(claim.task.id));
      }
    });
    await t.test('explicit latest-config retry uses updated settings while task details and history hydrate pinned old snapshots', async () => {
      const claim = failedResumed.responses[0].claims[0];
      const nodeId = nodes[0];
      const before = await api(`/v1/tasks/${claim.task.id}`);
      assert.equal(before.executions.length, 3);
      for (const execution of before.executions) assert.deepEqual(execution.snapshot, snapshotsByTask.get(claim.task.id));
      let configurationReads = 0;
      const originalQuery = pool.query;
      pool.query = function(...args) {
        if (String(args[0]).includes('SELECT sha256,payload FROM execution_snapshot_contents')) configurationReads++;
        return originalQuery.apply(this, args);
      };
      let current;
      try { current = await api(`/v1/tasks/${claim.task.id}?historyMode=current`); }
      finally { pool.query = originalQuery; }
      assert.equal(configurationReads, 0, 'current detail never loads shared internal configuration');
      for (const execution of current.executions) assert.equal(Object.hasOwn(execution, 'snapshot'), false);
      const history = await api(`/v1/tasks/${claim.task.id}/history/executions`);
      for (const execution of history.items) assert.equal(Object.hasOwn(execution, 'snapshot'), false);
      const historyItem = await api(`/v1/tasks/${claim.task.id}/history/executions/${history.items[0].id}`);
      assert.deepEqual(historyItem.item.snapshot, snapshotsByTask.get(claim.task.id));
      await api(`/v1/tasks/${claim.task.id}/retry`, { useLatestConfig: true });
      const fresh = await api('/v1/executions/claim-copy-batch', { nodeId, limit: 1, requestId: requestIdAt() });
      assert.equal(fresh.claims[0].task.id, claim.task.id);
      assert.equal(fresh.claims[0].execution.snapshot.productionSettings.production.value.snapshotTestGeneration, 'updated');
      assert.equal(fresh.claims[0].execution.snapshot.knowledge[0].content.testGeneration, 'updated');
      assert.notEqual(fresh.claims[0].execution.snapshot.prompts.COPY.content, claim.execution.snapshot.prompts.COPY.content);
      await api(`/v1/executions/${fresh.claims[0].execution.id}/complete-copy`, { result: { copy: { title: 'synthetic copy', body: 'synthetic fixture', tags: [] } } });
    });
    await t.test('automatic image retry keeps original configuration, production chain, retry budget and catalog capability gates', async () => {
      const nodeId = 'snapshot-image-http';
      await pool.query('INSERT INTO codex_concurrency_pools(id,total_concurrency,image_concurrency) VALUES($1,1,1)', [nodeId]);
      await pool.query('INSERT INTO executor_nodes(id,name,codex_pool_id,image_worker_enabled) VALUES($1,$1,$1,true)', [nodeId]);
      await pool.query(`UPDATE global_settings SET value=value||$1::jsonb,version=version+1 WHERE key='production'`, [{ layoutCatalog: BUILTIN_LAYOUT_CATALOG }]);
      const taskId = Number((await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,assigned_to_user_id,assigned_at,assignment_source)
        VALUES('synthetic image snapshot','IMAGE_QUEUED',$1,'admin',now(),'MANUAL') RETURNING id`, [nodeId])).rows[0].id);
      const copyId = Number((await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at,approved_by_node_id,approval_mode)
        VALUES($1,1,$2,now(),$3,'ADMIN_BYPASS') RETURNING id`, [taskId, { copy: { title: 'synthetic image', body: 'synthetic', tags: [] } }, nodeId])).rows[0].id);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2,copy_qc_released_revision_id=$2 WHERE id=$1', [taskId, copyId]);
      const requestId = requestIdAt();
      const options = { nodeId, limit: 1, requestId, layoutCatalogVersion: 2, imageControlsVersion: 1 };
      const claimed = (await api('/v1/executions/claim-image-batch', options)).claims[0];
      assert.equal(claimed.task.id, taskId);
      await changeConfiguration('newest');
      const unsupported = await api('/v1/executions/claim-image-batch', { ...options, layoutCatalogVersion: 0 }, 'POST', 409);
      assert.equal(unsupported.error.code, 'LAYOUT_CATALOG_UNSUPPORTED');
      await api(`/v1/executions/${claimed.execution.id}/fail`, { error: 'synthetic transient image failure' });
      await pool.query("UPDATE tasks SET last_activity_at=now()-interval '6 seconds' WHERE id=$1", [taskId]);
      const retried = (await api('/v1/executions/claim-image-batch', { ...options, requestId: requestIdAt() })).claims[0];
      assert.equal(retried.task.id, taskId);
      for (const key of ['prompts', 'knowledge', 'productionSettings', 'copyRevision', 'imageProductionChainId']) {
        assert.deepEqual(retried.execution.snapshot[key], claimed.execution.snapshot[key]);
      }
      assert.deepEqual(retried.execution.snapshot.imageRetry, { failedAttempts: 1, nodeId });
      assert.ok(retried.execution.snapshot.imageRecovery.runIds.includes(claimed.execution.id));
      const replay = (await api('/v1/executions/claim-image-batch', options)).claims[0];
      assert.deepEqual(replay.execution.snapshot, claimed.execution.snapshot);
      await api(`/v1/executions/${retried.execution.id}/fail`, { error: 'synthetic image failure 2' });
      await pool.query("UPDATE tasks SET last_activity_at=now()-interval '6 seconds' WHERE id=$1", [taskId]);
      const third = (await api('/v1/executions/claim-image-batch', { ...options, requestId: requestIdAt() })).claims[0];
      assert.equal(third.execution.snapshot.imageRetry.failedAttempts, 2);
      assert.deepEqual(third.execution.snapshot.productionSettings, claimed.execution.snapshot.productionSettings);
      await api(`/v1/executions/${third.execution.id}/fail`, { error: 'synthetic image failure 3' });
      const exhausted = await api(`/v1/tasks/${taskId}?historyMode=current`);
      assert.equal(exhausted.state, 'COPY_REVIEW_PENDING');
      assert.equal(exhausted.currentStage, 'IMAGE_RETRY_EXHAUSTED');
      assert.deepEqual(exhausted.imageRetryFailures.map(failure => failure.attempt), [1, 2, 3]);
      for (const execution of exhausted.executions) assert.equal(Object.hasOwn(execution, 'snapshot'), false);
    });
    await t.test('real multi-task claims with opposite pending configurations coexist with historical compaction', async () => {
      const batchNodes = ['snapshot-opposite-left', 'snapshot-opposite-right'];
      for (const nodeId of batchNodes) {
        await pool.query('INSERT INTO codex_concurrency_pools(id,total_concurrency,image_concurrency) VALUES($1,2,2)', [nodeId]);
        await pool.query('INSERT INTO executor_nodes(id,name,codex_pool_id) VALUES($1,$1,$1)', [nodeId]);
      }
      const marker = randomUUID();
      const values = [];
      const executionIds = [];
      for (const label of ['left', 'right', 'right', 'left']) {
        const taskId = Number((await pool.query(`INSERT INTO tasks(query,state,created_by_node_id)
          VALUES('synthetic opposite configurations','COPY_QUEUED',$1) RETURNING id`, [batchNodes[0]])).rows[0].id);
        const value = { schemaVersion: 1, capturedAt: new Date().toISOString(),
          prompts: { COPY: { content: `${marker} ${label}` } },
          knowledge: [{ content: `${marker} shared knowledge` }],
          productionSettings: { production: { value: { marker } } },
          task: { id: taskId, query: 'synthetic opposite configurations' }, copyRevision: null };
        values.push({ taskId, value });
        await pool.query('UPDATE tasks SET pending_snapshot=$2 WHERE id=$1', [taskId, value]);
        const executionId = randomUUID(); executionIds.push(executionId);
        await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot)
          VALUES($1,$2,'COPY',$3,'SUCCEEDED','COMPLETED',$4)`, [executionId, taskId, batchNodes[0], value]);
      }
      const [compacted, ...claims] = await Promise.all([
        drainExecutionSnapshotBackfill(pool, { batchSize: 4, maxBatches: 1 }),
        ...batchNodes.map(nodeId => api('/v1/executions/claim-copy-batch', { nodeId, limit: 2, requestId: requestIdAt() })),
      ]);
      assert.equal(compacted.processed, 4);
      const allocated = claims.flatMap(response => response.claims);
      assert.equal(allocated.length, 4);
      assert.equal(new Set(allocated.map(claim => claim.task.id)).size, 4);
      const expected = new Map(values.map(({ taskId, value }) => [taskId, value]));
      for (const claim of allocated) assert.deepEqual(claim.execution.snapshot, expected.get(claim.task.id));
      const histories = (await pool.query('SELECT * FROM task_executions WHERE id=ANY($1::uuid[])', [executionIds])).rows;
      for (const row of histories) assert.ok(row.snapshot_prompts_hash && row.snapshot_knowledge_hash && row.snapshot_production_settings_hash);
    });
    assert.equal(Number((await pool.query('SELECT count(*) FROM model_call_traces')).rows[0].count), 0, 'no test invokes a model provider');
  } finally {
    if (server) await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    await app?.context.disposeControlPlaneResources?.();
    await pool.end();
    await database.stop();
    assert.ok(resolve(storageRoot).startsWith(resolve(join(tmpdir(), 'execution-snapshot-http-assets-'))));
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
