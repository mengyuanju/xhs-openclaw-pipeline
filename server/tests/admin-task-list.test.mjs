import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';

const USERS = {
  admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
  reviewer: { id: 2, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
  alice: { id: 3, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  bob: { id: 4, username: 'bob', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
};

const TASKS = [
  { id: 1, createdByUserId: 'admin', assignedToUserId: 'alice', state: 'COPY_QUEUED', query: 'summer' },
  { id: 2, createdByUserId: 'reviewer', assignedToUserId: 'bob', state: 'COPY_RUNNING', query: 'summer' },
  { id: 3, createdByUserId: 'alice', assignedToUserId: 'bob', state: 'COPY_FAILED', query: 'summer' },
  { id: 4, createdByUserId: 'bob', assignedToUserId: 'alice', state: 'COPY_REVIEW_PENDING', query: 'summer' },
  { id: 5, createdByUserId: 'alice', assignedToUserId: 'alice', state: 'IMAGE_QUEUED', query: 'summer' },
  { id: 6, createdByUserId: 'reviewer', assignedToUserId: 'bob', state: 'IMAGE_RUNNING', query: 'summer' },
  { id: 7, createdByUserId: 'alice', assignedToUserId: 'alice', state: 'IMAGE_FAILED', query: 'summer trip' },
  { id: 8, createdByUserId: 'admin', assignedToUserId: 'bob', state: 'MANUAL_ARCHIVE', query: 'summer' },
  { id: 9, createdByUserId: 'bob', assignedToUserId: 'bob', state: 'CANCELLED', query: 'summer' },
  { id: 10, createdByUserId: null, assignedToUserId: 'alice', state: 'IMAGE_FAILED', query: 'legacy' },
  { id: 11, createdByUserId: 'deleted-account', assignedToUserId: 'bob', state: 'CANCELLED', query: 'legacy' },
  { id: 12, createdByUserId: 'bob', assignedToUserId: 'bob', state: 'IMAGE_FAILED', query: 'summer beach' },
  { id: 13, createdByUserId: 'reviewer', assignedToUserId: 'alice', state: 'IMAGE_FAILED', query: 'summer trip' },
  { id: 14, createdByUserId: 'alice', assignedToUserId: 'alice', state: 'IMAGE_FAILED', query: 'winter trip' },
];

function actorHeaders(username, role = USERS[username]?.role, credentialVersion = 1) {
  return {
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': String(credentialVersion),
  };
}

// Keep PostgreSQL outside these HTTP boundary tests. Role ownership is resolved
// from the saved users, and filtering precedes pagination in this repository fake.
function taskRepository(tasks = TASKS, users = USERS) {
  let listCalls = 0;
  return {
    get listCalls() { return listCalls; },
    getUserByUsername: async (username) => users[username] ?? null,
    async listTasks(filters) {
      listCalls += 1;
      const states = [filters.state, ...(filters.states?.split(',') ?? [])].filter(Boolean);
      const matches = tasks.filter((task) => (
        (!filters.createdByRole || (users[task.createdByUserId]?.role ?? 'UNKNOWN') === filters.createdByRole)
        && (!filters.createdByUserId || task.createdByUserId === filters.createdByUserId)
        && (!filters.assignedToUserId || task.assignedToUserId === filters.assignedToUserId)
        && (!filters.unassignedOnly || task.assignedToUserId === null)
        && (!filters.excludeUnassigned || task.assignedToUserId !== null)
        && (states.length === 0 || states.includes(task.state))
        && (!filters.query || task.query.toLowerCase().includes(filters.query.toLowerCase()))
      ));
      const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
      const offset = Math.max(0, Number(filters.offset) || 0);
      const items = matches.slice(offset, offset + limit);
      return filters.includeTotal ? { items, total: matches.length, limit, offset } : items;
    },
  };
}

async function withServer(repository, action) {
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage' });
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

test('administrator task listing includes every state and creators from every role without filters', async () => {
  await withServer(taskRepository(), async (root) => {
    const response = await fetch(`${root}/v1/tasks?includeTotal=true`, { headers: actorHeaders('admin') });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.items.map((task) => task.id), TASKS.map((task) => task.id));
    assert.equal(data.total, TASKS.length);
    assert.ok(data.items.some((task) => task.state === 'IMAGE_FAILED'));
    assert.ok(data.items.some((task) => task.state === 'CANCELLED'));
  });
});

for (const [role, expectedIds] of [
  ['ADMIN', [1, 8]],
  ['REVIEWER', [2, 6, 13]],
  ['USER', [3, 4, 5, 7, 9, 12, 14]],
  ['UNKNOWN', [10, 11]],
]) {
  test(`administrator can filter task creators by ${role}`, async () => {
    await withServer(taskRepository(), async (root) => {
      const response = await fetch(`${root}/v1/tasks?createdByRole=${role}&includeTotal=true`, {
        headers: actorHeaders('admin'),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.deepEqual(data.items.map((task) => task.id), expectedIds);
      assert.equal(data.total, expectedIds.length);
    });
  });
}

test('role, state and search filters compose before server pagination and total counting', async () => {
  await withServer(taskRepository(), async (root) => {
    const response = await fetch(`${root}/v1/tasks?createdByRole=USER&state=IMAGE_FAILED&query=summer&limit=1&offset=1&includeTotal=true`, {
      headers: actorHeaders('admin'),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.items.map((task) => task.id), [12]);
    assert.equal(data.total, 2);
    assert.equal(data.limit, 1);
    assert.equal(data.offset, 1);
  });
});

test('role filtering preserves multiple states and the unpaginated response shape', async () => {
  await withServer(taskRepository(), async (root) => {
    const response = await fetch(`${root}/v1/tasks?createdByRole=USER&states=IMAGE_FAILED,CANCELLED`, {
      headers: actorHeaders('admin'),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.map((task) => task.id), [7, 9, 12, 14]);
  });
});

test('administrator can page filtered jobs beyond the first 200 records', async () => {
  const tasks = Array.from({ length: 230 }, (_, index) => ({
    id: index + 1, createdByUserId: 'alice', state: 'IMAGE_FAILED', query: 'summer',
  }));
  tasks.unshift({ id: 999, createdByUserId: 'reviewer', state: 'IMAGE_FAILED', query: 'summer' });
  await withServer(taskRepository(tasks), async (root) => {
    const response = await fetch(`${root}/v1/tasks?createdByRole=USER&limit=20&offset=200&includeTotal=true`, {
      headers: actorHeaders('admin'),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.items.map((task) => task.id), Array.from({ length: 20 }, (_, index) => index + 201));
    assert.equal(data.total, 230);
  });
});

test('invalid creator roles are rejected before listing tasks', async () => {
  const repository = taskRepository();
  await withServer(repository, async (root) => {
    for (const role of ['SUPERADMIN', 'ADMIN,USER', '0']) {
      const response = await fetch(`${root}/v1/tasks?createdByRole=${encodeURIComponent(role)}`, {
        headers: actorHeaders('admin'),
      });
      assert.equal(response.status, 400, `role ${role} must be rejected`);
    }
    assert.equal(repository.listCalls, 0);
  });
});

test('ordinary users and reviewers cannot use creator role filtering', async () => {
  const repository = taskRepository();
  await withServer(repository, async (root) => {
    for (const username of ['alice', 'reviewer']) {
      const response = await fetch(`${root}/v1/tasks?createdByRole=USER`, { headers: actorHeaders(username) });
      assert.equal(response.status, 403, `${username} must not use administrator role filters`);
    }
    assert.equal(repository.listCalls, 0);
  });
});

test('only administrators can use the centralized attention filter', async () => {
  const repository = taskRepository();
  await withServer(repository, async (root) => {
    const admin = await fetch(`${root}/v1/tasks?attention=STALE&includeTotal=true`, { headers: actorHeaders('admin') });
    assert.equal(admin.status, 200);
    for (const username of ['alice', 'reviewer']) {
      const denied = await fetch(`${root}/v1/tasks?attention=FAILED`, { headers: actorHeaders(username) });
      assert.equal(denied.status, 403);
    }
  });
  assert.equal(repository.listCalls, 1);
});

test('role filters reject forged administrators and stale or missing identities', async () => {
  const repository = taskRepository();
  await withServer(repository, async (root) => {
    for (const headers of [actorHeaders('alice', 'ADMIN'), actorHeaders('admin', 'ADMIN', 2), {}]) {
      const response = await fetch(`${root}/v1/tasks?createdByRole=ADMIN`, { headers });
      assert.equal(response.status, 401);
    }
    assert.equal(repository.listCalls, 0);
  });
});

test('saved central role revocation prevents an old administrator from filtering all creators', async () => {
  const users = { ...USERS, admin: { ...USERS.admin, role: 'REVIEWER' } };
  const repository = taskRepository(TASKS, users);
  await withServer(repository, async (root) => {
    const forged = await fetch(`${root}/v1/tasks?createdByRole=USER`, { headers: actorHeaders('admin', 'ADMIN') });
    assert.equal(forged.status, 401);
    const refreshed = await fetch(`${root}/v1/tasks?createdByRole=USER`, { headers: actorHeaders('admin', 'REVIEWER') });
    assert.equal(refreshed.status, 403);
    assert.equal(repository.listCalls, 0);
  });
});

test('without a role filter users remain restricted by assignee and reviewers retain assigned visibility', async () => {
  await withServer(taskRepository(), async (root) => {
    const mine = await fetch(`${root}/v1/tasks?createdByUserId=bob`, { headers: actorHeaders('alice') });
    assert.equal(mine.status, 200);
    assert.deepEqual((await mine.json()).data.map((task) => task.id), [4]);

    const allMine = await fetch(`${root}/v1/tasks`, { headers: actorHeaders('alice') });
    assert.deepEqual((await allMine.json()).data.map((task) => task.id), [1, 4, 5, 7, 10, 13, 14]);

    const all = await fetch(`${root}/v1/tasks`, { headers: actorHeaders('reviewer') });
    assert.equal(all.status, 200);
    assert.deepEqual((await all.json()).data.map((task) => task.id), TASKS.map((task) => task.id));
  });
});
