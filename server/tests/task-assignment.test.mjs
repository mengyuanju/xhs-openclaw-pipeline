import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

function taskRow(id, patch = {}) {
  return {
    id,
    query: `任务${id}`,
    input: {},
    requested_image_count: 'auto',
    state: 'COPY_QUEUED',
    created_by_node_id: 'node-a',
    created_by_user_id: 'admin',
    assigned_to_user_id: null,
    assignment_source: null,
    assigned_at: null,
    progress_percent: 0,
    progress_message: '等待管理员分配作业员',
    ...patch,
  };
}

function transactionRepository(query) {
  const client = { query, release() {} };
  return new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
}

async function withServer(repository, action) {
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage', enforceUserAuth: true });
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
    value.once('error', reject);
  });
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function actorHeaders(username, role = 'USER') {
  return {
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': '1',
  };
}

test('health advertises the task assignment contract before the UI enables it', async () => {
  const repository = new PostgresControlPlaneRepository({
    pool: { query: async () => ({ rows: [{ now: new Date('2026-09-08T00:00:00.000Z') }] }) },
  });
  const health = await repository.health();
  assert.equal(health.capabilities.taskAssignmentVersion, 1);
});

test('task creation keeps creator audit identity separate from its assignee', async () => {
  const calls = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    calls.push({ sql: source, values });
    if (source.includes("role = 'USER'")) return { rows: [{ username: 'alice' }] };
    if (source.includes('INSERT INTO tasks')) return { rows: [taskRow(1, {
      assigned_to_user_id: values[6], assignment_source: values[7], assigned_at: new Date(),
      progress_message: values[6] === null ? '等待管理员分配作业员' : '等待文案执行机领取',
    })] };
    return { rows: [] };
  });

  const [assigned] = await repository.createTasks({
    nodeId: 'node-a', createdByUserId: 'admin', assignedToUserId: 'alice', assignmentSource: 'MANUAL',
    tasks: [{ query: '管理员代建' }],
  });
  assert.equal(assigned.createdByUserId, 'admin');
  assert.equal(assigned.assignedToUserId, 'alice');
  assert.equal(assigned.assignmentSource, 'MANUAL');
  assert.ok(calls.some(({ sql, values }) => sql.includes('task_assignment_events')
    && values[1] === 'admin' && values[2] === 'alice'));

  calls.length = 0;
  const [unassigned] = await repository.createTasks({
    nodeId: 'node-a', createdByUserId: 'admin', assignedToUserId: null,
    tasks: [{ query: '进入待分配池' }],
  });
  assert.equal(unassigned.assignedToUserId, null);
  assert.equal(calls.some(({ sql }) => sql.includes('task_assignment_events')), false);
});

test('manual assignment is atomic, audited and only targets active ordinary workers', async () => {
  const calls = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    calls.push({ sql: source, values });
    if (source.includes("role = 'USER'")) return { rows: [{ username: 'alice' }] };
    if (source.includes('SELECT * FROM tasks WHERE id = ANY')) {
      return { rows: [taskRow(1), taskRow(2, { assigned_to_user_id: 'bob', assignment_source: 'SELF' })] };
    }
    if (source.includes('UPDATE tasks SET')) {
      return { rows: values[0].map((id) => taskRow(id, {
        assigned_to_user_id: values[1], assignment_source: 'MANUAL', assigned_at: new Date(),
      })) };
    }
    return { rows: [] };
  });
  const tasks = await repository.assignTasks([2, 1], {
    assignedToUserId: 'alice', actorUserId: 'admin', reason: '夜班接手',
  });
  assert.deepEqual(tasks.map((task) => task.id), [1, 2]);
  assert.ok(tasks.every((task) => task.assignedToUserId === 'alice'));
  const auditWrites = calls.filter(({ sql }) => sql.includes('INSERT INTO task_assignment_events'));
  assert.equal(auditWrites.length, 2);
  assert.ok(auditWrites.every(({ values }) => values[1] === 'admin' && values[3] === 'alice'));
  assert.equal(calls.at(-1).sql, 'COMMIT');

  const unavailable = transactionRepository(async (sql) => {
    if (String(sql).includes("role = 'USER'")) return { rows: [] };
    return { rows: [] };
  });
  await assert.rejects(unavailable.assignTask(1, {
    assignedToUserId: 'disabled.user', actorUserId: 'admin',
  }), { code: 'ASSIGNEE_UNAVAILABLE' });
});

test('unassigning is limited to copy work that has not started', async () => {
  const repository = transactionRepository(async (sql) => {
    if (String(sql).includes('SELECT * FROM tasks WHERE id = ANY')) {
      return { rows: [taskRow(1, { state: 'COPY_RUNNING', assigned_to_user_id: 'alice' })] };
    }
    return { rows: [] };
  });
  await assert.rejects(repository.assignTask(1, {
    assignedToUserId: null, actorUserId: 'admin',
  }), { code: 'TASK_ALREADY_STARTED' });
});

test('task list and executor claims use assignee ownership and exclude the pending pool', async () => {
  const listCalls = [];
  const listing = new PostgresControlPlaneRepository({ pool: {
    async query(sql, values) {
      listCalls.push({ sql: String(sql), values });
      return String(sql).includes('COUNT(*) AS total') ? { rows: [{ total: 0 }] } : { rows: [] };
    },
  } });
  await listing.listTasks({ assignedToUserId: 'alice', includeTotal: true });
  assert.ok(listCalls.every(({ sql }) => sql.includes('assigned_to_user_id = $1')));

  let candidateSql = '';
  const claiming = transactionRepository(async (sql) => {
    const source = String(sql);
    if (source.includes('SELECT * FROM executor_nodes')) {
      return { rows: [{ id: 'node-a', copy_concurrency: 1, image_worker_enabled: false }] };
    }
    if (source.includes('COUNT(*)') && source.includes('task_executions')) return { rows: [{ count: 0 }] };
    if (source.includes('SELECT last_assignee_user_id FROM execution_claim_cursors')) {
      return { rows: [{ last_assignee_user_id: null }] };
    }
    if (source.includes('FOR UPDATE OF task SKIP LOCKED')) {
      candidateSql = source;
      return { rows: [] };
    }
    return { rows: [] };
  });
  assert.equal(await claiming.claimCopy('node-a'), null);
  assert.match(candidateSql, /assigned_to_user_id IS NOT NULL/u);
});

test('HTTP task creation, visibility and reassignment derive authority from the session', async () => {
  const users = {
    admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    bob: { id: 3, username: 'bob', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    reviewer: { id: 4, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
  };
  const calls = [];
  let detail = { ...taskRow(9), createdByUserId: 'admin', assignedToUserId: 'bob', executions: [] };
  const repository = {
    ownsPool: true,
    getUserByUsername: async (username) => users[username] ?? null,
    createTasks: async (input) => { calls.push(['create', input]); return [input]; },
    listTasks: async (input) => { calls.push(['list', input]); return []; },
    getTask: async () => detail,
    assignTask: async (id, input) => { calls.push(['assign', id, input]); return { id: Number(id), ...input }; },
    assignTasks: async (ids, input) => { calls.push(['assign-batch', ids, input]); return ids.map(Number); },
  };
  await withServer(repository, async (root) => {
    const jsonHeaders = (username, role) => ({ ...actorHeaders(username, role), 'content-type': 'application/json' });
    const adminCreate = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: jsonHeaders('admin', 'ADMIN'),
      body: JSON.stringify({ nodeId: 'node-a', assignedToUserId: 'bob', tasks: [{ query: '代建' }] }),
    });
    assert.equal(adminCreate.status, 201);
    const userCreate = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: jsonHeaders('alice', 'USER'),
      body: JSON.stringify({ nodeId: 'node-a', tasks: [{ query: '自建' }] }),
    });
    assert.equal(userCreate.status, 201);
    const forged = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: jsonHeaders('alice', 'USER'),
      body: JSON.stringify({ nodeId: 'node-a', assignedToUserId: 'bob', tasks: [{ query: '伪造' }] }),
    });
    assert.equal(forged.status, 403);

    assert.equal((await fetch(`${root}/v1/tasks/9`, { headers: actorHeaders('bob') })).status, 200);
    assert.equal((await fetch(`${root}/v1/tasks/9`, { headers: actorHeaders('alice') })).status, 403);
    detail = { ...detail, assignedToUserId: null };
    assert.equal((await fetch(`${root}/v1/tasks/9`, { headers: actorHeaders('reviewer', 'REVIEWER') })).status, 403);
    assert.equal((await fetch(`${root}/v1/tasks/9`, { headers: actorHeaders('admin', 'ADMIN') })).status, 200);

    const assign = await fetch(`${root}/v1/tasks/9/assignee`, {
      method: 'PATCH', headers: jsonHeaders('admin', 'ADMIN'),
      body: JSON.stringify({ assignedToUserId: 'alice', reason: '重新分工' }),
    });
    assert.equal(assign.status, 200);
    const denied = await fetch(`${root}/v1/tasks/9/assignee`, {
      method: 'PATCH', headers: jsonHeaders('alice', 'USER'),
      body: JSON.stringify({ assignedToUserId: 'alice' }),
    });
    assert.equal(denied.status, 403);

    const batch = await fetch(`${root}/v1/tasks/batch-assignee`, {
      method: 'POST', headers: jsonHeaders('admin', 'ADMIN'),
      body: JSON.stringify({ taskIds: [9, 10], assignedToUserId: 'alice', reason: '批量调整' }),
    });
    assert.equal(batch.status, 200);
    const deniedBatch = await fetch(`${root}/v1/tasks/batch-assignee`, {
      method: 'POST', headers: jsonHeaders('alice', 'USER'),
      body: JSON.stringify({ taskIds: [9, 10], assignedToUserId: 'alice' }),
    });
    assert.equal(deniedBatch.status, 403);
  });

  assert.equal(calls[0][1].createdByUserId, 'admin');
  assert.equal(calls[0][1].assignedToUserId, 'bob');
  assert.equal(calls[1][1].createdByUserId, 'alice');
  assert.equal(calls[1][1].assignedToUserId, 'alice');
  assert.deepEqual(calls.find(([kind]) => kind === 'assign').slice(1), [
    '9', { assignedToUserId: 'alice', actorUserId: 'admin', reason: '重新分工' },
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === 'assign-batch').slice(1), [
    [9, 10], { assignedToUserId: 'alice', actorUserId: 'admin', reason: '批量调整' },
  ]);
});
