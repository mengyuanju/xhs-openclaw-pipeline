import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAdminTaskPage } from '../src/control-plane/admin-task-page.mjs';

test('admin task pages preserve server pagination beyond 200 and combine role, state and search', async () => {
  const calls = [];
  const page = { items: [{ id: 357, state: 'IMAGE_FAILED', createdByRole: 'USER', sourceQueryPackageName: '九月选题' }], total: 251, limit: 20, offset: 240 };
  const result = await loadAdminTaskPage(async (path) => {
    calls.push(path);
    return path.endsWith('/health') ? { capabilities: { adminTaskFilters: true } } : page;
  }, { createdByRole: 'USER', state: 'IMAGE_FAILED', taskId: 357, query: '城市 & 徒步', queryPackageName: '九月 选题',
    attention: 'FAILED', sortBy: 'createdAt', sortOrder: 'asc', limit: 20, offset: 240 });
  assert.equal(result, page);
  const search = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(search.get('createdByRole'), 'USER');
  assert.equal(search.get('state'), 'IMAGE_FAILED');
  assert.equal(search.get('query'), '城市 & 徒步');
  assert.equal(search.get('queryPackageName'), '九月 选题');
  assert.equal(result.items[0].sourceQueryPackageName, '九月选题');
  assert.equal(search.get('taskId'), '357');
  assert.equal(search.get('attention'), 'FAILED');
  assert.equal(search.get('sortBy'), 'createdAt');
  assert.equal(search.get('sortOrder'), 'asc');
  assert.equal(search.get('offset'), '240');
  assert.equal(search.get('includeTotal'), 'true');
  assert.equal(search.has('mine') || search.has('nodeId') || search.has('createdByUserId'), false);
});

test('all roles and states do not add ownership or lifecycle restrictions', async () => {
  let requested;
  await loadAdminTaskPage(async (path) => {
    if (path.endsWith('/health')) return { capabilities: { adminTaskFilters: true } };
    requested = new URL(path, 'http://localhost');
    return { items: [], total: 0, limit: 20, offset: 0 };
  });
  assert.deepEqual([...requested.searchParams.keys()].sort(), ['includeTotal', 'limit', 'offset']);
});

test('selected operator is sent as an exact account alongside role, state and Query filters', async () => {
  let requested;
  await loadAdminTaskPage(async (path) => {
    if (path.endsWith('/health')) return { capabilities: { adminTaskFilters: true, creatorAccountFilters: true } };
    requested = new URL(path, 'http://localhost');
    return { items: [], total: 0, limit: 20, offset: 20 };
  }, { createdByUserId: 'operator.02', createdByAccountId: 202, createdByRole: 'USER', state: 'IMAGE_FAILED', query: '周末 & 徒步', offset: 20 });
  assert.equal(requested.searchParams.get('createdByUserId'), 'operator.02');
  assert.equal(requested.searchParams.get('createdByAccountId'), '202');
  assert.equal(requested.searchParams.get('createdByRole'), 'USER');
  assert.equal(requested.searchParams.get('state'), 'IMAGE_FAILED');
  assert.equal(requested.searchParams.get('query'), '周末 & 徒步');
  assert.equal(requested.searchParams.get('offset'), '20');
});

test('exact creator pages reject incomplete identities and centers without account filtering', async () => {
  await assert.rejects(loadAdminTaskPage(async () => ({}), { createdByUserId: 'operator.02' }), /稳定账号身份/u);
  await assert.rejects(loadAdminTaskPage(async (path) => path.endsWith('/health')
    ? { capabilities: { adminTaskFilters: true } }
    : { items: [], total: 0, limit: 20, offset: 0 }, {
    createdByUserId: 'operator.02', createdByAccountId: 202,
  }), /精确账号筛选/u);
});

test('old centers and malformed pages cannot be presented as complete results', async () => {
  let taskReads = 0;
  await assert.rejects(loadAdminTaskPage(async () => { taskReads += 1; return { capabilities: {} }; }), /更新.*中心/u);
  assert.equal(taskReads, 2);
  for (const response of [[], { items: [], total: 250 }, { items: [], total: -1, limit: 20, offset: 0 }]) {
    await assert.rejects(loadAdminTaskPage(async (path) => path.endsWith('/health')
      ? { capabilities: { adminTaskFilters: true } } : response), /分页/u);
  }
});

test('health and task page requests start together without a network waterfall', async () => {
  const calls = [];
  let releaseHealth;
  const health = new Promise((resolve) => { releaseHealth = resolve; });
  const pending = loadAdminTaskPage((path) => {
    calls.push(path);
    return path.endsWith('/health') ? health : Promise.resolve({ items: [], total: 0, limit: 20, offset: 0 });
  });
  try {
    assert.equal(calls.length, 2, 'task query must start before health completes');
  } finally { releaseHealth({ capabilities: { adminTaskFilters: true } }); }
  await pending;
});

test('task read failures remain errors instead of becoming an empty page', async () => {
  await assert.rejects(loadAdminTaskPage(async (path) => {
    if (path.endsWith('/health')) return { capabilities: { adminTaskFilters: true } };
    throw new Error('test service unavailable');
  }), /test service unavailable/u);
});

test('unsupported centers fail promptly even if the concurrent task read stalls or rejects', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const pending = loadAdminTaskPage((path) => path.endsWith('/health')
    ? Promise.resolve({ capabilities: {} }) : promise);
  const outcome = await Promise.race([
    pending.then(() => 'unexpected success', (error) => error.message),
    new Promise((done) => setImmediate(() => done('still waiting for tasks'))),
  ]);
  resolve({ items: [], total: 0, limit: 20, offset: 0 });
  assert.match(outcome, /更新.*中心/u);
  await assert.rejects(loadAdminTaskPage((path) => path.endsWith('/health')
    ? Promise.resolve({ capabilities: {} }) : Promise.reject(new Error('legacy task endpoint failed'))), /更新.*中心/u);
});
