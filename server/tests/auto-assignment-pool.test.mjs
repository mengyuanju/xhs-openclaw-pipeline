import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrations } from '../src/database-migrations.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  normalizeAutoAssignmentEnabled,
  normalizeAutoAssignmentExpectedVersion,
  normalizeAutoAssignmentLimit,
  normalizeAutoAssignmentWorkerStatus,
} from '../src/task-auto-assignment-domain.mjs';

function settingsRow(patch = {}) {
  return {
    singleton: 1,
    enabled: false,
    version: 1,
    updated_by_username: null,
    created_at: new Date('2026-09-08T00:00:00.000Z'),
    updated_at: new Date('2026-09-08T00:00:00.000Z'),
    ...patch,
  };
}

function workerRow(username, patch = {}) {
  return {
    username,
    status: 'ACTIVE',
    assignment_limit: 5,
    version: 1,
    created_by_username: 'admin',
    updated_by_username: 'admin',
    created_at: new Date('2026-09-08T00:00:00.000Z'),
    updated_at: new Date('2026-09-08T00:00:00.000Z'),
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
    'X-Actor-User-Id': String(username === 'admin' ? 1 : username === 'alice' ? 2 : username === 'reviewer' ? 3 : ''),
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': '1',
  };
}

test('automatic assignment domain accepts only explicit safe settings', () => {
  assert.equal(normalizeAutoAssignmentEnabled(true), true);
  assert.equal(normalizeAutoAssignmentWorkerStatus(' paused '), 'PAUSED');
  assert.equal(normalizeAutoAssignmentLimit(1), 1);
  assert.equal(normalizeAutoAssignmentLimit(500), 500);
  assert.equal(normalizeAutoAssignmentExpectedVersion(undefined, { required: false }), null);
  assert.equal(normalizeAutoAssignmentExpectedVersion(3), 3);

  for (const value of [undefined, null, 0, 1, 'true']) {
    assert.throws(() => normalizeAutoAssignmentEnabled(value));
  }
  for (const value of ['', 'DISABLED', 'RUNNING']) {
    assert.throws(() => normalizeAutoAssignmentWorkerStatus(value));
  }
  for (const value of [0, 501, 1.5, '5']) {
    assert.throws(() => normalizeAutoAssignmentLimit(value));
  }
  for (const value of [undefined, null, 0, 1.5, '1']) {
    assert.throws(() => normalizeAutoAssignmentExpectedVersion(value));
  }
});

test('0018 creates an opt-in empty worker pool with bounded settings and audit history', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0018_auto_assignment_pool');
  assert.ok(migration);
  assert.match(migration.sql, /enabled boolean NOT NULL DEFAULT false/u);
  assert.match(migration.sql, /status IN \('ACTIVE', 'PAUSED'\)/u);
  assert.match(migration.sql, /assignment_limit BETWEEN 1 AND 500/u);
  assert.match(migration.sql, /version integer NOT NULL DEFAULT 1 CHECK \(version > 0\)/u);
  assert.match(migration.sql, /task_auto_assignment_admin_events/u);
  assert.doesNotMatch(migration.sql, /INSERT\s+INTO\s+task_auto_assignment_workers/iu);
  assert.doesNotMatch(migration.sql, /(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?tasks/iu);
});

test('overview reports configured capacity separately from eligibility and switch state', async () => {
  const pool = { async query(sql) {
    const source = String(sql);
    if (source.includes('task_auto_assignment_settings')) {
      return { rows: [settingsRow()] };
    }
    if (source.includes('FROM task_auto_assignment_workers AS pool')) {
      return { rows: [workerRow('alice', {
        display_name: 'Alice', user_role: 'USER', user_status: 'ACTIVE', current_task_count: '3',
      }), workerRow('bob', {
        status: 'PAUSED', assignment_limit: 2, display_name: 'Bob', user_role: 'USER',
        user_status: 'ACTIVE', current_task_count: '1',
      })] };
    }
    if (source.includes('assigned_to_user_id IS NULL')) {
      return { rows: [{ count: '17', auto_assignable_count: '11' }] };
    }
    if (source.includes('task_auto_assignment_admin_events')) {
      return { rows: [{ id: '9', actor_username: 'admin', action: 'WORKER_ADDED',
        worker_username: 'alice', details: { next: { assignmentLimit: 5 } },
        created_at: new Date('2026-09-08T01:00:00.000Z') }] };
    }
    throw new Error(`unexpected query: ${source}`);
  } };
  const overview = await new PostgresControlPlaneRepository({ pool }).getAutoAssignmentOverview();
  assert.equal(overview.settings.enabled, false);
  assert.equal(overview.unassignedTaskCount, 17);
  assert.equal(overview.autoAssignableTaskCount, 11);
  assert.equal(overview.manualAttentionTaskCount, 6);
  assert.deepEqual(overview.workers.map(({ username, availableSlots, canReceive }) => ({
    username, availableSlots, canReceive,
  })), [
    { username: 'alice', availableSlots: 2, canReceive: true },
    { username: 'bob', availableSlots: 1, canReceive: false },
  ]);
  assert.equal(overview.events[0].actorUsername, 'admin');
});

test('settings updates use an optimistic version and write one management audit', async () => {
  let settings = settingsRow();
  const audits = [];
  const calls = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    calls.push(source);
    if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
    if (source.includes('SELECT * FROM task_auto_assignment_settings')) return { rows: [{ ...settings }] };
    if (source.includes('UPDATE task_auto_assignment_settings')) {
      if (Number(settings.version) !== values[2]) return { rows: [] };
      settings = settingsRow({
        ...settings, enabled: values[0], version: Number(settings.version) + 1,
        updated_by_username: values[1], updated_at: new Date('2026-09-08T01:00:00.000Z'),
      });
      return { rows: [{ ...settings }] };
    }
    if (source.includes('INSERT INTO task_auto_assignment_admin_events')) {
      audits.push({ action: values[1], actor: values[0], details: JSON.parse(values[3]) });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${source}`);
  });

  const updated = await repository.updateAutoAssignmentSettings({
    enabled: true, expectedVersion: 1, actorUsername: 'admin',
  });
  assert.deepEqual({ enabled: updated.enabled, version: updated.version, actor: updated.updatedByUsername },
    { enabled: true, version: 2, actor: 'admin' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'SETTINGS_UPDATED');
  assert.deepEqual(audits[0].details.next, { enabled: true, version: 2 });

  await assert.rejects(repository.updateAutoAssignmentSettings({
    enabled: false, expectedVersion: 1, actorUsername: 'admin',
  }), { code: 'VERSION_CONFLICT' });
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(audits.length, 1);
});

test('automatic assignment settings recheck the immutable administrator identity', async () => {
  const calls = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    calls.push({ sql: source, values });
    return { rows: [] };
  });
  await assert.rejects(repository.updateAutoAssignmentSettings({
    enabled: true,
    expectedVersion: 1,
    actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
  }), { code: 'SESSION_STALE' });
  assert.equal(calls.some(({ sql }) => sql.includes('task_auto_assignment_settings')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('worker CRUD accepts only active ordinary users, locks versions and audits changes', async () => {
  const users = new Map([
    ['alice', { username: 'alice', display_name: 'Alice', role: 'USER', status: 'ACTIVE' }],
    ['bob', { username: 'bob', display_name: 'Bob', role: 'USER', status: 'DISABLED' }],
    ['reviewer', { username: 'reviewer', display_name: 'Reviewer', role: 'REVIEWER', status: 'ACTIVE' }],
  ]);
  const members = new Map();
  const audits = [];
  const taskWrites = [];
  const eligibilityReads = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    if (/(?:UPDATE|DELETE\s+FROM)\s+tasks/iu.test(source)) taskWrites.push(source);
    if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
    if (source.includes('FROM task_auto_assignment_workers AS pool')) {
      const member = members.get(values[0]);
      const user = users.get(values[0]);
      return { rows: member && user ? [{ ...member, display_name: user.display_name,
        user_role: user.role, user_status: user.status, current_task_count: '0' }] : [] };
    }
    if (source.includes('SELECT * FROM task_auto_assignment_workers')) {
      const member = members.get(values[0]);
      return { rows: member ? [{ ...member }] : [] };
    }
    if (source.includes("role = 'USER'")) {
      eligibilityReads.push(source);
      const user = users.get(values[0]);
      return { rows: user?.status === 'ACTIVE' && user.role === 'USER' ? [{ username: user.username }] : [] };
    }
    if (source.includes('INSERT INTO task_auto_assignment_workers')) {
      const member = workerRow(values[0], {
        status: values[1], assignment_limit: values[2],
        created_by_username: values[3], updated_by_username: values[3],
      });
      members.set(values[0], member);
      return { rows: [{ ...member }] };
    }
    if (source.includes('UPDATE task_auto_assignment_workers')) {
      const member = members.get(values[0]);
      if (!member || Number(member.version) !== values[4]) return { rows: [] };
      const updated = workerRow(values[0], { ...member, status: values[1], assignment_limit: values[2],
        version: Number(member.version) + 1, updated_by_username: values[3] });
      members.set(values[0], updated);
      return { rows: [{ ...updated }] };
    }
    if (source.includes('DELETE FROM task_auto_assignment_workers')) {
      const member = members.get(values[0]);
      if (!member || Number(member.version) !== values[1]) return { rows: [] };
      members.delete(values[0]);
      return { rows: [{ ...member }] };
    }
    if (source.includes('INSERT INTO task_auto_assignment_admin_events')) {
      audits.push({ actor: values[0], action: values[1], worker: values[2], details: JSON.parse(values[3]) });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${source}`);
  });

  const created = await repository.putAutoAssignmentWorker('Alice', {
    status: 'ACTIVE', assignmentLimit: 5, actorUsername: 'admin',
  });
  assert.deepEqual({ username: created.username, version: created.version, canReceive: created.canReceive },
    { username: 'alice', version: 1, canReceive: true });
  assert.equal(audits[0].action, 'WORKER_ADDED');
  assert.ok(eligibilityReads.every((source) => /FOR UPDATE/u.test(source)));

  await assert.rejects(repository.putAutoAssignmentWorker('bob', {
    status: 'ACTIVE', assignmentLimit: 5, actorUsername: 'admin',
  }), { code: 'ASSIGNEE_UNAVAILABLE' });
  await assert.rejects(repository.putAutoAssignmentWorker('reviewer', {
    status: 'PAUSED', assignmentLimit: 5, actorUsername: 'admin',
  }), { code: 'ASSIGNEE_UNAVAILABLE' });

  const paused = await repository.putAutoAssignmentWorker('alice', {
    status: 'PAUSED', assignmentLimit: 8, expectedVersion: 1, actorUsername: 'admin',
  });
  assert.deepEqual({ status: paused.status, assignmentLimit: paused.assignmentLimit, version: paused.version },
    { status: 'PAUSED', assignmentLimit: 8, version: 2 });
  assert.equal(audits[1].action, 'WORKER_UPDATED');
  await assert.rejects(repository.putAutoAssignmentWorker('alice', {
    status: 'ACTIVE', assignmentLimit: 8, expectedVersion: 1, actorUsername: 'admin',
  }), { code: 'VERSION_CONFLICT' });

  assert.deepEqual(await repository.removeAutoAssignmentWorker('alice', {
    expectedVersion: 2, actorUsername: 'admin',
  }), { username: 'alice', removed: true });
  assert.equal(audits[2].action, 'WORKER_REMOVED');
  assert.equal(members.has('alice'), false);
  assert.deepEqual(taskWrites, []);
});

test('an identical concurrent worker creation is idempotent and does not duplicate its audit', async () => {
  let member = null;
  let auditCount = 0;
  let initialRead = true;
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
    if (source.includes('FROM task_auto_assignment_workers AS pool')) {
      return { rows: member ? [{ ...member, display_name: 'Alice', user_role: 'USER',
        user_status: 'ACTIVE', current_task_count: '0' }] : [] };
    }
    if (source.includes('SELECT * FROM task_auto_assignment_workers')) {
      if (initialRead) {
        initialRead = false;
        return { rows: [] };
      }
      return { rows: member ? [{ ...member }] : [] };
    }
    if (source.includes("role = 'USER'")) return { rows: [{ username: 'alice' }] };
    if (source.includes('INSERT INTO task_auto_assignment_workers')) {
      member = workerRow(values[0], { status: values[1], assignment_limit: values[2] });
      return { rows: [] };
    }
    if (source.includes('INSERT INTO task_auto_assignment_admin_events')) {
      auditCount += 1;
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${source}`);
  });

  const result = await repository.putAutoAssignmentWorker('alice', {
    status: 'ACTIVE', assignmentLimit: 5, actorUsername: 'admin',
  });
  assert.equal(result.version, 1);
  assert.equal(auditCount, 0);
});

test('a stale pool editor cannot pause or update a same-name replacement account', async () => {
  const calls = [];
  const repository = transactionRepository(async (sql, values) => {
    const source = String(sql);
    calls.push({ sql: source, values });
    if (['BEGIN', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.includes('SELECT * FROM app_users')) {
      return { rows: [{ id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credential_version: 1 }] };
    }
    if (source.includes('WHERE id = $1 AND username = $2')) return { rows: [] };
    throw new Error(`unexpected query: ${source}`);
  });

  await assert.rejects(repository.putAutoAssignmentWorker('alice', {
    accountId: 2,
    status: 'PAUSED',
    assignmentLimit: 8,
    expectedVersion: 1,
    actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
  }), { code: 'ASSIGNEE_UNAVAILABLE' });
  assert.equal(calls.some(({ sql }) => sql.includes('task_auto_assignment_workers')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('creating an account does not implicitly add it to the automatic assignment pool', async () => {
  const calls = [];
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql, values) {
    const source = String(sql);
    calls.push(source);
    return { rows: [{
      id: 5, username: values[0], display_name: values[1], role: values[2], status: 'ACTIVE',
      must_change_password: true, credential_version: 1, version: 1,
      created_at: new Date(), updated_at: new Date(),
    }] };
  } } });
  await repository.createUser({ username: 'new.worker', displayName: 'New Worker', role: 'USER' });
  assert.ok(calls.some((source) => source.includes('INSERT INTO app_users')));
  assert.ok(calls.every((source) => !source.includes('task_auto_assignment_workers')));
});

test('automatic assignment management HTTP routes are administrator-only and trust session identity', async () => {
  const users = {
    admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    reviewer: { id: 3, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
  };
  const calls = [];
  const repository = {
    getUserByUsername: async (username) => users[username] ?? null,
    getAutoAssignmentOverview: async () => ({ settings: { enabled: false, version: 1 }, workers: [] }),
    updateAutoAssignmentSettings: async (input) => { calls.push(['settings', input]); return input; },
    putAutoAssignmentWorker: async (username, input) => { calls.push(['put', username, input]); return { username, ...input }; },
    removeAutoAssignmentWorker: async (username, input) => { calls.push(['delete', username, input]); return { username, removed: true }; },
  };
  await withServer(repository, async (root) => {
    const adminJson = { ...actorHeaders('admin', 'ADMIN'), 'content-type': 'application/json' };
    const userJson = { ...actorHeaders('alice', 'USER'), 'content-type': 'application/json' };
    assert.equal((await fetch(`${root}/v1/auto-assignment`, {
      headers: actorHeaders('admin', 'ADMIN'),
    })).status, 200);
    assert.equal((await fetch(`${root}/v1/auto-assignment`, { headers: actorHeaders('alice') })).status, 403);

    const missingWorkerAccount = await fetch(`${root}/v1/auto-assignment/workers/alice`, {
      method: 'PUT', headers: adminJson,
      body: JSON.stringify({ status: 'ACTIVE', assignmentLimit: 5 }),
    });
    assert.equal(missingWorkerAccount.status, 400);
    assert.equal((await missingWorkerAccount.json()).error.code, 'VALIDATION_ERROR');

    const missingDeleteWorkerAccount = await fetch(`${root}/v1/auto-assignment/workers/alice`, {
      method: 'DELETE', headers: adminJson,
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(missingDeleteWorkerAccount.status, 400);
    assert.equal((await missingDeleteWorkerAccount.json()).error.code, 'VALIDATION_ERROR');

    assert.equal((await fetch(`${root}/v1/auto-assignment/settings`, {
      method: 'PATCH', headers: adminJson,
      body: JSON.stringify({ enabled: true, expectedVersion: 1, actorUsername: 'forged' }),
    })).status, 200);
    assert.equal((await fetch(`${root}/v1/auto-assignment/workers/alice`, {
      method: 'PUT', headers: adminJson,
      body: JSON.stringify({ accountId: 2, status: 'ACTIVE', assignmentLimit: 5, actorUsername: 'forged' }),
    })).status, 200);
    assert.equal((await fetch(`${root}/v1/auto-assignment/workers/alice`, {
      method: 'DELETE', headers: adminJson,
      body: JSON.stringify({ accountId: 2, expectedVersion: 1, actorUsername: 'forged' }),
    })).status, 200);
    assert.equal((await fetch(`${root}/v1/auto-assignment/settings`, {
      method: 'PATCH', headers: userJson,
      body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
    })).status, 403);

    const protectedRequests = [
      { path: '/v1/auto-assignment', method: 'GET' },
      { path: '/v1/auto-assignment/settings', method: 'PATCH', body: { enabled: true, expectedVersion: 1 } },
      { path: '/v1/auto-assignment/workers/alice', method: 'PUT', body: { status: 'ACTIVE', assignmentLimit: 5 } },
      { path: '/v1/auto-assignment/workers/alice', method: 'DELETE', body: { expectedVersion: 1 } },
    ];
    for (const role of ['USER', 'REVIEWER']) {
      const username = role === 'USER' ? 'alice' : 'reviewer';
      for (const request of protectedRequests) {
        const response = await fetch(`${root}${request.path}`, {
          method: request.method,
          headers: request.body
            ? { ...actorHeaders(username, role), 'content-type': 'application/json' }
            : actorHeaders(username, role),
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        });
        assert.equal(response.status, 403, `${role} ${request.method} ${request.path}`);
      }
    }
    for (const request of protectedRequests) {
      const response = await fetch(`${root}${request.path}`, {
        method: request.method,
        ...(request.body ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        } : {}),
      });
      assert.equal(response.status, 401, `anonymous ${request.method} ${request.path}`);
    }
    assert.equal((await fetch(`${root}/v1/auto-assignment/settings`, {
      method: 'PATCH', headers: actorHeaders('admin', 'ADMIN'), body: '{}',
    })).status, 415);
  });

  assert.deepEqual(calls, [
    ['settings', { enabled: true, expectedVersion: 1,
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
    ['put', 'alice', { status: 'ACTIVE', assignmentLimit: 5, expectedVersion: undefined,
      accountId: 2, actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
    ['delete', 'alice', { expectedVersion: 1, accountId: 2,
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
  ]);
});
