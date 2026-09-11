import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/modular-workflow-e2e.mjs', import.meta.url));

async function startControlPlaneFixture(context) {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: projectRoot,
    env: { ...process.env, MODULAR_E2E_CONTROL_PLANE_ONLY: '1' },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`fixture startup timed out\n${stdout}\n${stderr}`)), 15_000);
    const inspect = () => {
      const match = stdout.match(/MODULAR_E2E_READY (\{[^\r\n]+\})/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(JSON.parse(match[1]));
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture exited before ready (${code})\n${stdout}\n${stderr}`));
    });
    inspect();
  });
  return ready;
}

function actorHeaders(actor, overrides = {}) {
  return {
    'X-Actor-User-Id': String(actor.userId),
    'X-Actor-Username': actor.username,
    'X-Actor-Role': actor.role,
    'X-Actor-Credential-Version': String(actor.credentialVersion),
    ...overrides,
  };
}

async function request(root, path, { actor, method = 'GET', body, headers, expectedStatus = 200 } = {}) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(actor ? actorHeaders(actor) : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

test('fixture enforces stable actors through Query-package assignment, screening and revocation', {
  timeout: 30_000,
}, async (context) => {
  const fixture = await startControlPlaneFixture(context);
  const root = fixture.controlPlaneUrl;
  const { admin, reviewer, worker } = fixture;

  const staleIdentityCases = [
    { 'X-Actor-User-Id': String(reviewer.userId) },
    { 'X-Actor-Credential-Version': String(worker.credentialVersion + 1) },
    { 'X-Actor-Role': 'ADMIN' },
    { 'X-Actor-User-Id': '' },
  ];
  for (const headers of staleIdentityCases) {
    const stale = await request(root, '/v1/query-packages', {
      actor: worker,
      headers,
      expectedStatus: 401,
    });
    assert.equal(stale.error.code, 'SESSION_STALE');
  }

  const deniedUserList = await request(root, '/v1/users', {
    actor: worker,
    expectedStatus: 403,
  });
  assert.equal(deniedUserList.error.code, 'FORBIDDEN');
  const assignableUsers = (await request(root, '/v1/users', { actor: admin })).data;
  assert.deepEqual(assignableUsers.map((user) => user.username).toSorted(), ['admin', 'reviewer', 'worker']);

  const deniedImport = await request(root, '/v1/query-packages', {
    actor: worker,
    method: 'POST',
    body: { name: '越权导入', items: [{ query: '不应写入' }] },
    expectedStatus: 403,
  });
  assert.equal(deniedImport.error.code, 'WORKER_QUERY_IMPORT_DISABLED');
  assert.deepEqual((await request(root, '/v1/query-packages', { actor: worker })).data, []);

  const created = (await request(root, '/v1/query-packages', {
    actor: admin,
    method: 'POST',
    expectedStatus: 201,
    body: {
      name: 'Fixture 分配与撤权词包',
      items: [{ query: '稳定身份筛选 Query' }],
    },
  })).data;
  assert.equal(created.assignedToAccountId, null);

  const assignedToWorker = (await request(root, `/v1/query-packages/${created.id}/assignee`, {
    actor: admin,
    method: 'PATCH',
    body: {
      expectedVersion: created.version,
      assignedToUserId: worker.username,
      assignedToAccountId: worker.userId,
    },
  })).data;
  assert.deepEqual({
    username: assignedToWorker.assignedToUserId,
    accountId: assignedToWorker.assignedToAccountId,
    role: assignedToWorker.assignedToRole,
    status: assignedToWorker.assigneeStatus,
  }, { username: worker.username, accountId: worker.userId, role: 'USER', status: 'ACTIVE' });
  assert.deepEqual((await request(root, '/v1/query-packages', { actor: worker })).data.map((item) => item.id), [created.id]);
  const workerDetail = (await request(root, `/v1/query-packages/${created.id}`, { actor: worker })).data;
  assert.equal(workerDetail.items.length, 1);
  assert.deepEqual((await request(root, '/v1/query-packages', { actor: reviewer })).data, []);
  assert.equal((await request(root, `/v1/query-packages/${created.id}`, {
    actor: reviewer,
    expectedStatus: 403,
  })).error.code, 'FORBIDDEN');

  const unassigned = (await request(root, `/v1/query-packages/${created.id}/assignee`, {
    actor: admin,
    method: 'PATCH',
    body: {
      expectedVersion: assignedToWorker.version,
      assignedToUserId: null,
      assignedToAccountId: null,
    },
  })).data;
  assert.equal(unassigned.assignedToUserId, null);
  assert.deepEqual((await request(root, '/v1/query-packages', { actor: worker })).data, []);
  assert.equal((await request(root, `/v1/query-packages/${created.id}`, {
    actor: worker,
    expectedStatus: 403,
  })).error.code, 'FORBIDDEN');

  const assignedToReviewer = (await request(root, `/v1/query-packages/${created.id}/assignee`, {
    actor: admin,
    method: 'PATCH',
    body: {
      expectedVersion: unassigned.version,
      assignedToUserId: reviewer.username,
      assignedToAccountId: reviewer.userId,
    },
  })).data;
  assert.deepEqual((await request(root, '/v1/query-packages', { actor: worker })).data, []);
  const reviewerDetail = (await request(root, `/v1/query-packages/${created.id}`, { actor: reviewer })).data;
  const screened = (await request(root, `/v1/query-packages/${created.id}/screening`, {
    actor: reviewer,
    method: 'PUT',
    body: {
      expectedVersion: assignedToReviewer.version,
      decisions: [{ itemId: reviewerDetail.items[0].id, decision: 'SELECT' }],
    },
  })).data;
  assert.equal(screened.status, 'USED_UP');
  assert.deepEqual(screened.counts, { total: 1, pending: 0, selected: 1, rejected: 0, produced: 1 });
  const endedScreening = await request(root, `/v1/query-packages/${created.id}/screening`, {
    actor: reviewer,
    method: 'PUT',
    body: {
      expectedVersion: screened.version,
      decisions: [{ itemId: reviewerDetail.items[0].id, decision: 'REJECT', reason: '不应再筛选' }],
    },
    expectedStatus: 409,
  });
  assert.equal(endedScreening.error.code, 'PACKAGE_NOT_SCREENABLE');
  assert.equal((await request(root, `/v1/query-packages/${created.id}/production-batches`, {
    actor: reviewer,
    method: 'POST',
    body: { expectedVersion: screened.version },
    expectedStatus: 403,
  })).error.code, 'FORBIDDEN');

  const fixtureState = (await request(root, '/__fixture/state')).data;
  const [task] = fixtureState.tasks.filter((item) => item.sourceQueryPackageId === created.id);
  assert.ok(task, 'screening a selected Query must create one task');
  assert.equal(task.createdByUserId, admin.username,
    'delegated screening must not grant task-creator access to the screener');
  assert.equal(task.assignedToUserId, null);
  assert.equal(task.assignedToAccountId, null);
});
