import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { BUILTIN_LAYOUT_CATALOG } from '../src/layout-catalog.mjs';
import { createMockPost } from '../../src/pipeline.mjs';
import { createMockVisualPlan } from '../../src/visual-plan.mjs';
import { catalogDirectPlan } from '../../src/catalog-planning.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { imageTextHash } from '../../src/locked-image-plan.mjs';

const id = 'aaaaaaaa-1111-4111-8111-111111111111';
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;

test('center validates and saves full planning before images and accepts idempotent JSONB retries', async () => {
  const post = createMockPost(3);
  const plan = catalogDirectPlan(createMockVisualPlan(post), post, BUILTIN_LAYOUT_CATALOG);
  let stored = null; let writes = 0; let active = true;
  const client = { release() {}, async query(sql, values = []) {
    if (sql.includes('SELECT t.id') && sql.includes('SELECT e.task_id')) return { rows: [{ id: 1 }] };
    if (sql.includes('SELECT e.*')) return { rows: [{ id, kind: 'IMAGE', status: 'RUNNING', current_execution_id: active ? id : null, snapshot: { copyRevision: { content: { copy: { title: post.title, body: post.body, tags: post.tags }, imagePlan: post.imagePlan } }, productionSettings: { production: { value: { layoutCatalog: BUILTIN_LAYOUT_CATALOG } } } } }] };
    if (sql.startsWith('SELECT result FROM image_runs')) return { rows: [{ result: reorder(stored) }] };
    if (sql.startsWith('UPDATE image_runs SET result')) { writes++; stored = structuredClone(values[1]); }
    return { rows: [] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.saveVisualPlan(id, { value: plan, model: 'fake' });
  assert.equal(stored.visualPlan.value.pages.length, 3);
  assert.equal(stored.visualPlan.value.pages[0].catalogTemplate.subjectRegion, '中央');
  await repository.saveVisualPlan(id, { value: plan, model: 'fake' });
  assert.equal(writes, 1);
  const changed = structuredClone(plan); changed.pages[0].visualSubject = '另一套设计';
  await assert.rejects(repository.saveVisualPlan(id, { value: changed }), /不同的规划/);
  const forged = structuredClone(plan); forged.pages[0].layoutTemplate = 'HERO_UNKNOWN';
  await assert.rejects(repository.saveVisualPlan(id, { value: forged }), /layoutTemplate/);
  active = false;
  await assert.rejects(repository.saveVisualPlan(id, { value: plan }), /no longer current/);
  assert.equal(writes, 1);
});

test('catalog completion requires validated planning and retry snapshots retain it', async () => {
  const post = createMockPost(3);
  const value = catalogDirectPlan(createMockVisualPlan(post), post, BUILTIN_LAYOUT_CATALOG);
  const snapshot = { copyRevision: { content: post }, productionSettings: { production: { value: { layoutCatalog: BUILTIN_LAYOUT_CATALOG } } } };
  const execution = { id, task_id: 1, node_id: 'node-a', kind: 'IMAGE', status: 'RUNNING', current_execution_id: id, snapshot };
  let stored = null; const writes = [];
  const client = { release() {}, async query(sql, values = []) {
    if (sql.includes('SELECT t.id') && sql.includes('SELECT e.task_id')) return { rows: [{ id: 1 }] };
    if (sql.includes('SELECT e.*')) return { rows: [execution] };
    if (sql.startsWith('SELECT result FROM image_runs')) return { rows: [{ result: stored }] };
    if (sql.startsWith('SELECT * FROM tasks')) return { rows: [{ id: 1, state: 'IMAGE_FAILED', current_execution_id: null }] };
    if (sql.includes('SELECT id, node_id, snapshot FROM task_executions')) return { rows: [execution] };
    if (sql.includes('UPDATE')) writes.push({ sql, values });
    return { rows: [] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.completeImage(id, { images: [], visualPlan: { value } }), { code: 'VISUAL_PLAN_REQUIRED' });
  assert.equal(writes.length, 0);
  snapshot.visualPlanCheckpoint = { value: { ...value, textContractSha256: imageTextHash(post) } };
  const changed = structuredClone(value); changed.pages[0].selectionReason = '另一份有效但未冻结的规划';
  await assert.rejects(repository.saveVisualPlan(id, { value: changed }), { code: 'VISUAL_PLAN_CONFLICT' });
  assert.equal(writes.length, 0);
  delete snapshot.visualPlanCheckpoint;
  stored = { visualPlan: { value, model: 'fake' } };
  await repository.failExecution(id, 'temporary failure');
  assert.deepEqual(writes.find(item => item.sql.includes('UPDATE tasks')).values[5].visualPlanCheckpoint, stored.visualPlan);
  writes.length = 0;
  await repository.retryTask(1);
  assert.deepEqual(writes.find(item => item.sql.includes('UPDATE tasks')).values[2].visualPlanCheckpoint, stored.visualPlan);
  writes.length = 0;
  await repository.completeImage(id, { images: [], visualPlan: { value: 'forged' } });
  assert.ok(writes.some(item => item.sql.includes("result->'visualPlan'")));
});

test('claim receipt replay rejects executors without catalog support', async () => {
  const client = { release() {}, async query(sql) {
    if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ id: 'node-a' }] };
    if (sql.includes('SELECT * FROM execution_claim_requests')) return { rows: [{ requested_limit: 1, execution_ids: [id] }] };
    if (sql.includes('SELECT e.*')) return { rows: [{ snapshot: { productionSettings: { production: { value: { layoutCatalog: BUILTIN_LAYOUT_CATALOG } } } } }] };
    return { rows: [] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.claimImageBatch({ nodeId: 'node-a', limit: 1, requestId: id }), { code: 'LAYOUT_CATALOG_UNSUPPORTED' });
});

test('catalog HTTP endpoints reject non-administrators and preserve version conflicts', async () => {
  const app = createControlPlaneApp({ storageRoot: 'test-storage', repository: {
    getUserByUsername: async username => ({ id: 1, username, role: username === 'admin' ? 'ADMIN' : 'USER', credentialVersion: 1, status: 'ACTIVE' }),
    getLayoutCatalog: async () => ({ catalog: BUILTIN_LAYOUT_CATALOG, revision: 'a'.repeat(64) }),
    updateLayoutCatalog: async () => { const error = new TypeError('目录已变化'); error.code = 'CATALOG_CONFLICT'; throw error; },
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    for (const username of ['admin', 'user']) {
      const headers = { 'X-Actor-User-Id': '1', 'X-Actor-Username': username, 'X-Actor-Role': username === 'admin' ? 'ADMIN' : 'USER', 'X-Actor-Credential-Version': '1', 'Content-Type': 'application/json' };
      const response = await fetch(`${root}/v1/layout-catalog`, { headers });
      assert.equal(response.status, username === 'admin' ? 200 : 403);
      const mutation = await fetch(`${root}/v1/layout-catalog`, { method: 'POST', headers, body: '{}' });
      assert.equal(mutation.status, username === 'admin' ? 409 : 403);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
