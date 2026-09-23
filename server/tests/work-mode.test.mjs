import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkModePage } from '../src/work-mode.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { workModeKinds } from '../../src/admin/workflow-access.mjs';
import { userCanAccessControlPlaneRoute } from '../../src/control-plane/proxy-access.mjs';

const user = { id: 8, username: 'worker', role: 'USER', status: 'ACTIVE', credentialVersion: 2,
  copyReviewEnabled: true, copyQcEnabled: false, imageQcEnabled: false };
const actor = { ...user, userId: user.id };
const task = (id, state, extra = {}) => ({ id, state, query: `Query ${id}`, assignedToUserId: user.username,
  assignedToAccountId: user.id, currentCopyRevisionId: id + 100, currentImageRunId: 'run-'+id, ...extra });

test('work mode exposes actions by capability, image review stays with operators', () => {
  assert.deepEqual(workModeKinds({ roles: ['USER'], copyReviewEnabled: true }), ['COPY', 'IMAGE']);
  assert.deepEqual(workModeKinds({ roles: ['USER'] }), ['IMAGE']);
  assert.deepEqual(workModeKinds({ roles: ['REVIEWER'], copyQcEnabled: true, imageQcEnabled: true }), ['COPY_QA', 'IMAGE_QA']);
  assert.deepEqual(workModeKinds({ roles: ['ADMIN'] }), ['COPY', 'IMAGE', 'COPY_QA', 'IMAGE_QA']);
  assert.deepEqual(workModeKinds(null), []);
  assert.equal(userCanAccessControlPlaneRoute('/v1/work-mode/items', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/work-mode/items', 'POST'), false);
});

test('copy work is removed after submission, returns on rework, and scope precedes pagination', async () => {
  const tasks = [task(1, 'COPY_RUNNING'), task(2, 'COPY_REVIEW_PENDING'), task(3, 'COPY_QC_PENDING'),
    task(4, 'COPY_REVIEW_PENDING', { assignedToAccountId: 99 }), task(5, 'COPY_REVIEW_PENDING', { priorityPaused: true })];
  let filters;
  const repository = { getUserByUsername: async () => user, listTasks: async options => {
    filters = options;
    const rows = tasks.filter(t => options.states.split(',').includes(t.state) && t.assignedToUserId === options.assignedToUserId
      && t.assignedToAccountId === options.assignedToAccountId && !t.priorityPaused && (options.taskId === undefined || t.id === options.taskId));
    return { items: rows.slice(options.offset, options.offset + options.limit), total: rows.length };
  } };
  let page = await loadWorkModePage(repository, { kind: 'COPY', limit: 1 }, actor);
  assert.deepEqual(page.items.map(t => t.taskId), [2]);
  assert.equal(filters.workModeKind, 'COPY'); assert.equal(filters.assignedToAccountId, 8); assert.equal(page.total, 1);
  assert.deepEqual((await loadWorkModePage(repository, { kind: 'COPY', itemId: '2' }, actor)).items.map(row => row.taskId), [2]);
  assert.equal(filters.taskId, 2);
  for (const itemId of ['1', '4', '5', '999']) {
    assert.equal((await loadWorkModePage(repository, { kind: 'COPY', itemId }, actor)).items.length, 0);
  }
  tasks[1].state = 'COPY_QC_PENDING';
  assert.equal((await loadWorkModePage(repository, { kind: 'COPY' }, actor)).total, 0);
  tasks[1].state = 'COPY_REVIEW_PENDING'; tasks[1].mandatoryCopyQc = true; tasks[1].currentCopyRevisionId++;
  page = await loadWorkModePage(repository, { kind: 'COPY' }, actor);
  assert.equal(page.items[0].rework, true); assert.equal(page.items[0].version, 103);
});

test('work mode rechecks live account permission and stable identity', async () => {
  let currentUser = { ...user };
  const repository = { getUserByUsername: async () => currentUser, listTasks: () => { throw new Error('must not query tasks'); } };
  currentUser.copyReviewEnabled = false;
  await assert.rejects(loadWorkModePage(repository, { kind: 'COPY' }, actor), /作业权限/u);
  await assert.rejects(loadWorkModePage(repository, { kind: 'IMAGE_QA' }, actor), /作业权限/u);
  currentUser = { ...user, id: 99 };
  await assert.rejects(loadWorkModePage(repository, { kind: 'COPY' }, actor), { name: 'ControlPlaneAuthenticationError' });
  for (const options of [{ kind: 'OTHER' }, { limit: 0 }, { limit: '1;DROP' }, { offset: -1 }, { limit: 101 }, { kind: 'COPY', itemId: 'bad' }]) {
    currentUser = { ...user };
    await assert.rejects(loadWorkModePage(repository, options, actor), TypeError);
  }
});

test('quality work delegates redaction and shared-queue filtering to existing QA stores and preserves pagination', async () => {
  const reviewer = { ...user, role: 'REVIEWER', copyQcEnabled: true, imageQcEnabled: true };
  const qa = Array.from({ length: 3 }, (_, i) => ({ id: `opaque-${i}`, anonymousCode: `QA-${i}`, blindReview: true,
    status: 'PENDING', sampleKind: 'MANDATORY_RECHECK', capabilities: { canPass: true, canReturnSingle: true },
    approvedRevision: { revisionToken: 'opaque-token' }, productionBatch: { anonymousCode: 'batch' } }));
  const calls = [];
  const repository = { getUserByUsername: async () => reviewer,
    listCopyQaItems: async (options, context) => { calls.push({ options, context }); return qa.slice(options.offset, options.offset + options.limit); },
    listImageQaItems: async (options, context) => { calls.push({ options, context }); return { items: qa.slice(options.offset, options.offset + options.limit) }; } };
  for (const kind of ['COPY_QA', 'IMAGE_QA']) {
    const page = await loadWorkModePage(repository, { kind, limit: 2 }, { ...actor, role: 'REVIEWER' });
    assert.equal(page.items.length, 2); assert.equal(page.hasMore, true); assert.equal(page.total, null);
    assert.equal(page.items[0].source, null); assert.equal(page.items[0].taskId, undefined);
    assert.equal(calls.at(-1).options.actionableOnly, true); assert.equal(calls.at(-1).options.status, 'PENDING');
    assert.equal(calls.at(-1).context.actor.userId, user.id);
    const publicId = '71717171-7171-4717-8717-717171717171';
    await loadWorkModePage(repository, { kind, itemId: publicId }, { ...actor, role: 'REVIEWER' });
    assert.equal(calls.at(-1).options.itemPublicId, publicId);
    assert.equal(calls.at(-1).options.actionableOnly, true);
    if (kind === 'COPY_QA') assert.equal(calls.at(-1).options.sampleKind, 'ALL');
  }
});

test('copy QA kind is applied before pagination and is rejected for other work', async () => {
  const reviewer = { ...user, role: 'REVIEWER', copyQcEnabled: true, imageQcEnabled: true };
  const mixed = [
    ...Array.from({ length: 51 }, (_, index) => ({ id: `random-${index}`, anonymousCode: `首次-${index}`, sampleKind: 'RANDOM' })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `mandatory-${index}`, anonymousCode: `复检-${index}`, sampleKind: 'MANDATORY_RECHECK' })),
  ];
  const calls = [];
  const repository = {
    getUserByUsername: async () => reviewer,
    listCopyQaItems: async options => {
      calls.push(options);
      const matching = mixed.filter(item => options.sampleKind === 'ALL' || item.sampleKind === options.sampleKind);
      return matching.slice(options.offset, options.offset + options.limit);
    },
  };
  const reviewerActor = { ...actor, role: 'REVIEWER' };
  const first = await loadWorkModePage(repository, { kind: 'COPY_QA', sampleKind: 'MANDATORY_RECHECK', limit: 2 }, reviewerActor);
  assert.deepEqual(first.items.map(item => item.id), ['mandatory-0', 'mandatory-1']);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, null);
  assert.equal(calls[0].sampleKind, 'MANDATORY_RECHECK');
  const second = await loadWorkModePage(repository, { kind: 'COPY_QA', sampleKind: 'MANDATORY_RECHECK', limit: 2, offset: 2 }, reviewerActor);
  assert.deepEqual(second.items.map(item => item.id), ['mandatory-2']);
  assert.equal(second.hasMore, false);
  assert.equal(second.total, 3);
  const random = await loadWorkModePage(repository, { kind: 'COPY_QA', sampleKind: 'RANDOM', limit: 2 }, reviewerActor);
  assert.deepEqual(random.items.map(item => item.id), ['random-0', 'random-1']);
  assert.equal(calls.at(-1).sampleKind, 'RANDOM');
  const all = await loadWorkModePage(repository, { kind: 'COPY_QA', limit: 2 }, reviewerActor);
  assert.deepEqual(all.items.map(item => item.id), ['random-0', 'random-1']);
  assert.equal(calls.at(-1).sampleKind, 'ALL');
  for (const sampleKind of ['BOGUS', '', 'random']) {
    await assert.rejects(loadWorkModePage(repository, { kind: 'COPY_QA', sampleKind }, reviewerActor), TypeError);
  }
  await assert.rejects(loadWorkModePage(repository, { kind: 'IMAGE_QA', sampleKind: 'RANDOM' }, reviewerActor), TypeError);
});

test('task query excludes paused and missing content before both the page and total SQL', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({ pool: { query: async (sql, values) => {
    queries.push({ sql, values }); return { rows: sql.includes('COUNT(*) AS total') ? [{ total: 0 }] : [] };
  } } });
  await repository.listTasks({ workModeKind: 'IMAGE', states: 'MANUAL_ARCHIVE,IMAGE_REWORK_PENDING',
    assignedToUserId: 'worker', assignedToAccountId: 8, includeTotal: true });
  assert.ok(queries.length >= 2);
  for (const { sql, values } of queries) {
    assert.match(sql, /priority_paused = false AND current_copy_revision_id IS NOT NULL/u);
    assert.match(sql, /current_image_run_id IS NOT NULL/u);
    assert.match(sql, /exact_assignee\.id = \$\d+/u); assert.ok(values.includes(8));
  }
});

test('HTTP work endpoint ignores forged ownership, denies permission loss and unsupported writes', async () => {
  let account = { ...user }; let filters;
  const repository = { getUserByUsername: async () => account, listTasks: async options => { filters = options; return { items: [], total: 0 }; } };
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/work-mode/items`;
  const headers = { 'X-Actor-User-Id': '8', 'X-Actor-Username': 'worker', 'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '2' };
  try {
    let response = await fetch(base+'?kind=COPY&assignedToUserId=someone&assignedToAccountId=99', { headers });
    assert.equal(response.status, 200); assert.equal(filters.assignedToUserId, 'worker'); assert.equal(filters.assignedToAccountId, 8);
    response = await fetch(base+'?kind=COPY&itemId=99&assignedToAccountId=99', { headers });
    assert.equal(response.status, 200); assert.equal(filters.taskId, 99); assert.equal(filters.assignedToAccountId, 8);
    account.copyReviewEnabled = false;
    response = await fetch(base+'?kind=COPY', { headers }); assert.equal(response.status, 403);
    response = await fetch(base, { method: 'POST', headers }); assert.equal(response.status, 405);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('HTTP work endpoint forwards copy quality type and rejects invalid values', async () => {
  const reviewer = { ...user, role: 'REVIEWER', copyQcEnabled: true };
  let filters;
  const repository = { getUserByUsername: async () => reviewer,
    listCopyQaItems: async options => { filters = options; return []; } };
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/work-mode/items`;
  const headers = { 'X-Actor-User-Id': '8', 'X-Actor-Username': 'worker',
    'X-Actor-Role': 'REVIEWER', 'X-Actor-Credential-Version': '2' };
  try {
    let response = await fetch(`${base}?kind=COPY_QA&sampleKind=RANDOM`, { headers });
    assert.equal(response.status, 200); assert.equal(filters.sampleKind, 'RANDOM');
    response = await fetch(`${base}?kind=COPY_QA&sampleKind=MANDATORY_RECHECK`, { headers });
    assert.equal(response.status, 200); assert.equal(filters.sampleKind, 'MANDATORY_RECHECK');
    response = await fetch(`${base}?kind=COPY_QA&sampleKind=OTHER`, { headers });
    assert.equal(response.status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
