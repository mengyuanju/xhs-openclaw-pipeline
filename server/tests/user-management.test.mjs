import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { ControlPlaneConflictError } from '../src/domain.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { hashUserPassword, verifyUserPassword } from '../src/user-auth.mjs';

const DEFAULT_ADMIN_HASH = 'scrypt-v1.YXV0by1jbG93LWFkbWluIQ.H0k0pdnIz73LcskpQsVwP7TDdqbNQUQTO6xAVIx8EzwuLhs1yIMG9HVTWHIsta0DlgkzyJle37uMZx1YRci6Tg';

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

function actorHeaders(username, role, credentialVersion = 1, userId) {
  return {
    'X-Actor-User-Id': String(userId ?? (username === 'admin' ? 1 : username === 'alice' ? 2 : username === 'reviewer' ? 3 : '')),
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': String(credentialVersion),
  };
}

test('default administrator password and user passwords use compatible scrypt hashes', async () => {
  assert.equal(await verifyUserPassword('123456', DEFAULT_ADMIN_HASH), true);
  assert.equal(await verifyUserPassword('not-it', DEFAULT_ADMIN_HASH), false);
  const hash = await hashUserPassword('654321');
  assert.equal(await verifyUserPassword('654321', hash), true);
  await assert.rejects(() => hashUserPassword('12345'), /at least 6/u);

  const migration = await readFile(new URL('../migrations/0005_user_management.sql', import.meta.url), 'utf8');
  assert.match(migration, /CHECK \(role IN \('ADMIN', 'REVIEWER', 'USER'\)\)/u);
  assert.match(migration, /'admin'[\s\S]*'系统管理员'[\s\S]*'ADMIN'/u);
});

function passwordChangeRepository(passwordHash) {
  const calls = [];
  let updatedHash = null;
  const current = {
    id: 1,
    username: 'admin',
    display_name: '系统管理员',
    role: 'ADMIN',
    status: 'ACTIVE',
    password_hash: passwordHash,
    must_change_password: true,
    credential_version: 1,
    version: 1,
  };
  const client = {
    async query(sql, values = []) {
      const source = String(sql);
      calls.push(source);
      if (source.includes('SELECT * FROM app_users')) return { rows: [current] };
      if (source.includes('UPDATE app_users SET password_hash')) {
        updatedHash = values[0];
        return { rows: [{
          ...current,
          password_hash: updatedHash,
          must_change_password: false,
          credential_version: 2,
          version: 2,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    get updatedHash() { return updatedHash; },
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
  };
}

const ADMIN_ACTOR = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };

test('changing the login password rejects an invalid current password and password reuse', async () => {
  const passwordHash = await hashUserPassword('123456');

  const invalid = passwordChangeRepository(passwordHash);
  await assert.rejects(
    invalid.repository.changeOwnPassword(ADMIN_ACTOR, {
      currentPassword: '654321', newPassword: 'new-secret',
    }),
    { code: 'CURRENT_PASSWORD_INVALID', message: '当前密码不正确' },
  );
  assert.equal(invalid.calls.some((sql) => sql.includes('UPDATE app_users SET password_hash')), false);

  const reused = passwordChangeRepository(passwordHash);
  await assert.rejects(
    reused.repository.changeOwnPassword(ADMIN_ACTOR, {
      currentPassword: '123456', newPassword: '123456',
    }),
    { code: 'PASSWORD_REUSED', message: '新密码不能与当前密码相同' },
  );
  assert.equal(reused.calls.some((sql) => sql.includes('UPDATE app_users SET password_hash')), false);
});

test('changing the login password clears the first-login gate and rotates credentials', async () => {
  const passwordHash = await hashUserPassword('123456');
  const change = passwordChangeRepository(passwordHash);
  const user = await change.repository.changeOwnPassword(ADMIN_ACTOR, {
    currentPassword: '123456', newPassword: 'new-secret',
  });

  assert.equal(user.mustChangePassword, false);
  assert.equal(user.credentialVersion, 2);
  assert.equal(user.version, 2);
  assert.ok(change.updatedHash);
  assert.equal(await verifyUserPassword('123456', change.updatedHash), false);
  assert.equal(await verifyUserPassword('new-secret', change.updatedHash), true);
});

test('the central service confines initial-password accounts to profile setup routes', async () => {
  const user = {
    id: 2,
    username: 'alice',
    displayName: 'Alice',
    role: 'USER',
    status: 'ACTIVE',
    mustChangePassword: true,
    credentialVersion: 1,
    version: 1,
  };
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => user,
    getUserByIdentity: async () => user,
    authenticateUser: async () => user,
    health: async () => ({ ok: true }),
    updateOwnProfile: async () => user,
    changeOwnPassword: async () => user,
    listTasks: async () => assert.fail('business route must be blocked before repository access'),
  };
  await withServer(repository, async (root) => {
    const headers = actorHeaders('alice', 'USER');
    const forbidden = await fetch(`${root}/v1/tasks`, { headers });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');

    const nearMatch = await fetch(`${root}/v1/profiled`, { headers });
    assert.equal(nearMatch.status, 403);
    assert.equal((await nearMatch.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');

    const actorMachineRoute = await fetch(`${root}/v1/nodes`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'must-change-user' }),
    });
    assert.equal(actorMachineRoute.status, 403);
    assert.equal((await actorMachineRoute.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');

    assert.equal((await fetch(`${root}/v1/profile`, { headers })).status, 200);
    const profileUpdate = await fetch(`${root}/v1/profile`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    });
    assert.equal(profileUpdate.status, 403);
    assert.equal((await profileUpdate.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await fetch(`${root}/v1/profile/password`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: '123456', newPassword: 'new-secret' }),
    })).status, 200);
    assert.equal((await fetch(`${root}/health`, { headers })).status, 200);
    assert.equal((await fetch(`${root}/v1/auth/login`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: '123456' }),
    })).status, 200);
  });
});

test('login password changes rate limit invalid current passwords', async () => {
  const users = {
    admin: {
      id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE',
      mustChangePassword: true, credentialVersion: 1,
    },
    alice: {
      id: 2, username: 'alice', role: 'USER', status: 'ACTIVE',
      mustChangePassword: true, credentialVersion: 1,
    },
  };
  const repository = {
    ownsPool: true,
    getUserByUsername: async (username) => users[username],
    changeOwnPassword: async (_actor, body) => {
      if (body.newPassword === 'bad') throw new TypeError('new password is invalid');
      throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', 'wrong password');
    },
  };
  await withServer(repository, async (root) => {
    const request = (username = 'admin', role = 'ADMIN', newPassword = 'new-secret') => fetch(`${root}/v1/profile/password`, {
      method: 'POST', headers: { ...actorHeaders(username, role), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-password', newPassword }),
    });
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await request()).status, 409);
    assert.equal((await request('admin', 'ADMIN', 'bad')).status, 400);
    assert.equal((await request()).status, 409);
    const blocked = await request();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await request('alice', 'USER')).status, 409);
  });
});

test('task visibility and destructive actions are enforced from the central user role', async () => {
  const users = {
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    reviewer: { id: 3, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
    admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
  };
  const lists = [];
  const cancelled = [];
  const repository = {
    ownsPool: true,
    getUserByUsername: async (username) => users[username] ?? null,
    listTasks: async (filters) => { lists.push(filters); return []; },
    getTask: async (id) => ({ id: Number(id), createdByUserId: 'bob', assignedToUserId: 'alice' }),
    cancelTask: async (id) => { cancelled.push(id); return { id: Number(id), state: 'CANCELLED' }; },
  };
  await withServer(repository, async (root) => {
    const mine = await fetch(`${root}/v1/tasks?createdByUserId=bob`, { headers: actorHeaders('alice', 'USER') });
    assert.equal(mine.status, 200);
    assert.equal(lists[0].createdByUserId, 'bob');
    assert.equal(lists[0].assignedToUserId, 'alice');

    const all = await fetch(`${root}/v1/tasks`, { headers: actorHeaders('reviewer', 'REVIEWER') });
    assert.equal(all.status, 200);
    assert.equal(lists[1].createdByUserId, undefined);
    assert.equal(lists[1].assignedToUserId, undefined);
    assert.equal(lists[1].excludeUnassigned, true);

    const reviewerCancel = await fetch(`${root}/v1/tasks/9/cancel`, {
      method: 'POST', headers: { ...actorHeaders('reviewer', 'REVIEWER'), 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(reviewerCancel.status, 403);

    const adminCancel = await fetch(`${root}/v1/tasks/9/cancel`, {
      method: 'POST', headers: { ...actorHeaders('admin', 'ADMIN'), 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(adminCancel.status, 200);
    assert.deepEqual(cancelled, ['9']);
  });
});

test('reviewers cannot access knowledge, prompts, production settings or user management', async () => {
  const reviewer = { id: 3, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => reviewer,
    listPrompts: async () => [],
    listSettings: async () => [],
    upsertSetting: async () => ({}),
    createPromptVersion: async () => ({}),
    listUsers: async () => [],
    listKnowledge: async () => [],
  };
  await withServer(repository, async (root) => {
    const headers = { ...actorHeaders('reviewer', 'REVIEWER'), 'content-type': 'application/json' };
    assert.equal((await fetch(`${root}/v1/settings/production`, { method: 'PUT', headers, body: JSON.stringify({ value: {} }) })).status, 403);
    assert.equal((await fetch(`${root}/v1/prompts/versions`, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(`${root}/v1/users`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/users/1`, { method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: 1 }) })).status, 403);
    assert.equal((await fetch(`${root}/v1/workflow-quality-settings`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/knowledge`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/knowledge/capabilities`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/copy-analysis-prompts`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/knowledge-versions/1/asset`, { headers })).status, 403);
    for (const path of [
      '/v1/copy-analysis-prompts', '/v1/knowledge/labels/import', '/v1/copy-knowledge/analyze',
      '/v1/visual-knowledge/analyze', '/v1/knowledge/1/retire', '/v1/knowledge/versions',
      '/v1/knowledge-versions/1/publish',
    ]) {
      assert.equal((await fetch(`${root}${path}`, { method: 'POST', headers, body: '{}' })).status, 403, path);
    }
    assert.equal((await fetch(`${root}/v1/copy-analysis-prompts/1`, {
      method: 'PATCH', headers, body: '{}',
    })).status, 403);
    assert.equal((await fetch(`${root}/v1/knowledge-versions/1/asset`, {
      method: 'PUT', headers: { ...actorHeaders('reviewer', 'REVIEWER'), 'content-type': 'image/png' }, body: 'image',
    })).status, 403);
  });
});

test('administrators can delete another user and the actor identity is enforced by the route', async () => {
  const admin = { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 };
  const calls = [];
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => admin,
    deleteUser: async (userId, input) => {
      calls.push({ userId, input });
      return { id: Number(userId), username: 'alice' };
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/users/2`, {
      method: 'DELETE',
      headers: { ...actorHeaders('admin', 'ADMIN'), 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4, actorUsername: 'spoofed' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ userId: '2', input: { expectedVersion: 4, actorUsername: 'admin' } }]);
  });
});

test('user deletion rejects the current account and the last active administrator', async () => {
  function repositoryFor(current, adminCount = 2) {
    const client = {
      async query(sql) {
        if (sql.includes('SELECT * FROM app_users')) return { rows: [{ version: 1, ...current }] };
        if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: String(adminCount) }] };
        return { rows: [] };
      },
      release() {},
    };
    return new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  }

  await assert.rejects(
    repositoryFor({ id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE' })
      .deleteUser(1, { actorUsername: 'admin', expectedVersion: 1 }),
    { code: 'SELF_DELETE' },
  );
  await assert.rejects(
    repositoryFor({ id: 2, username: 'backup-admin', role: 'ADMIN', status: 'ACTIVE' }, 1)
      .deleteUser(2, { actorUsername: 'admin', expectedVersion: 1 }),
    { code: 'LAST_ADMIN' },
  );
});

test('user deletion blocks unfinished assignments and safely detaches terminal history', async () => {
  function deletionRepository(assignedTasks) {
    const calls = [];
    const user = {
      id: 2,
      username: 'alice',
      display_name: 'Alice',
      role: 'USER',
      status: 'ACTIVE',
      version: 1,
    };
    const client = {
      async query(sql, values = []) {
        const source = String(sql);
        calls.push({ sql: source, values });
        if (source.includes('SELECT * FROM app_users WHERE id')) return { rows: [user] };
        if (source.includes('SELECT id, state FROM tasks')) return { rows: assignedTasks };
        if (source.includes('UPDATE tasks')) return { rows: [] };
        if (source.includes('DELETE FROM app_users')) return { rows: [user] };
        return { rows: [] };
      },
      release() {},
    };
    return {
      calls,
      repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
    };
  }

  for (const [index, state] of [
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE',
  ].entries()) {
    const active = deletionRepository([{ id: 41 + index, state }]);
    await assert.rejects(
      active.repository.deleteUser(2, { actorUsername: 'admin', expectedVersion: 1 }),
      { code: 'USER_HAS_ACTIVE_TASKS' },
      `${state} must block account deletion`,
    );
    assert.equal(active.calls.some(({ sql }) => sql.includes('DELETE FROM app_users')), false);
  }

  const terminal = deletionRepository([
    { id: 51, state: 'REVIEWED' },
    { id: 52, state: 'CANCELLED' },
  ]);
  const deleted = await terminal.repository.deleteUser(2, { actorUsername: 'admin', expectedVersion: 1 });
  assert.equal(deleted.username, 'alice');
  const detach = terminal.calls.find(({ sql }) => sql.includes('UPDATE tasks'));
  assert.ok(detach);
  assert.deepEqual(detach.values, ['alice']);
  assert.match(detach.sql, /assigned_to_user_id = NULL[\s\S]*assignment_source = NULL[\s\S]*assigned_at = NULL/u);
  const audit = terminal.calls.find(({ sql }) => sql.includes('INSERT INTO task_assignment_events'));
  assert.ok(audit);
  assert.deepEqual(audit.values, ['alice', 'admin']);
  const queryPackageDetach = terminal.calls.find(({ sql }) => sql.includes('UPDATE query_packages'));
  assert.ok(queryPackageDetach);
  assert.deepEqual(queryPackageDetach.values, [2, 'alice']);
  assert.match(queryPackageDetach.sql,
    /assigned_to_account_id = NULL, assigned_to_username = NULL,[\s\S]*version = version \+ 1/u);
  assert.ok(terminal.calls.findIndex(({ sql }) => sql.includes('INSERT INTO task_assignment_events'))
    < terminal.calls.findIndex(({ sql }) => sql.includes('UPDATE tasks')));
  assert.ok(terminal.calls.findIndex(({ sql }) => sql.includes('UPDATE tasks'))
    < terminal.calls.findIndex(({ sql }) => sql.includes('UPDATE query_packages')));
  assert.ok(terminal.calls.findIndex(({ sql }) => sql.includes('UPDATE query_packages'))
    < terminal.calls.findIndex(({ sql }) => sql.includes('DELETE FROM app_users')));
  assert.equal(terminal.calls[1].sql, 'SELECT pg_advisory_xact_lock(4310, 8301)');
});

test('user eligibility changes clear Query-package assignments while USER and REVIEWER transitions retain them', async () => {
  function updateRepository({ currentRole, nextRole, nextStatus }) {
    const calls = [];
    const client = {
      async query(sql, values = []) {
        const source = String(sql);
        calls.push({ sql: source, values });
        if (source.includes('SELECT * FROM app_users WHERE id')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice', role: currentRole, status: 'ACTIVE', version: 1,
        }] };
        if (source.includes('SELECT id FROM tasks')) return { rows: [] };
        if (source.includes("SELECT COUNT(*) AS count FROM app_users")) return { rows: [{ count: '2' }] };
        if (source.includes('UPDATE app_users')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice', role: nextRole, status: nextStatus, version: 2,
        }] };
        return { rows: [] };
      },
      release() {},
    };
    return {
      calls,
      repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
    };
  }

  for (const next of [
    { role: 'USER', status: 'DISABLED' },
    { role: 'ADMIN', status: 'ACTIVE' },
  ]) {
    const fixture = updateRepository({
      currentRole: 'USER', nextRole: next.role, nextStatus: next.status,
    });
    await fixture.repository.updateUser(2, {
      displayName: 'Alice', role: next.role, status: next.status, expectedVersion: 1,
    });
    const detach = fixture.calls.find(({ sql }) => sql.includes('UPDATE query_packages'));
    assert.ok(detach, `${next.role}/${next.status}`);
    assert.deepEqual(detach.values, [2, 'alice']);
    assert.ok(fixture.calls.findIndex(({ sql }) => sql.includes('UPDATE app_users'))
      < fixture.calls.findIndex(({ sql }) => sql.includes('UPDATE query_packages')));
  }

  for (const [currentRole, nextRole] of [['USER', 'REVIEWER'], ['REVIEWER', 'USER']]) {
    const fixture = updateRepository({ currentRole, nextRole, nextStatus: 'ACTIVE' });
    await fixture.repository.updateUser(2, {
      displayName: 'Alice', role: nextRole, status: 'ACTIVE', expectedVersion: 1,
    });
    assert.equal(fixture.calls.some(({ sql }) => sql.includes('UPDATE query_packages')), false,
      `${currentRole} -> ${nextRole}`);
  }
});

test('user updates and deletions share one roster lock before reading an account', async () => {
  function lockedRepository() {
    const calls = [];
    const client = {
      async query(sql) {
        const source = String(sql);
        calls.push(source);
        if (source.includes('SELECT * FROM app_users WHERE id')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice', role: 'USER', status: 'ACTIVE', version: 1,
        }] };
        if (source.includes('UPDATE app_users')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice 2', role: 'USER', status: 'ACTIVE', version: 2,
        }] };
        if (source.includes('SELECT id, state FROM tasks')) return { rows: [] };
        if (source.includes('DELETE FROM app_users')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice', role: 'USER', status: 'ACTIVE', version: 1,
        }] };
        return { rows: [] };
      },
      release() {},
    };
    return { calls, repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
  }

  const update = lockedRepository();
  await update.repository.updateUser(2, {
    displayName: 'Alice 2', role: 'USER', status: 'ACTIVE', expectedVersion: 1,
  });
  assert.deepEqual(update.calls.slice(0, 3), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(4310, 8301)',
    'SELECT * FROM app_users WHERE id = $1 FOR UPDATE',
  ]);

  const deletion = lockedRepository();
  await deletion.repository.deleteUser(2, { actorUsername: 'admin', expectedVersion: 1 });
  assert.deepEqual(deletion.calls.slice(0, 3), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(4310, 8301)',
    'SELECT * FROM app_users WHERE id = $1 FOR UPDATE',
  ]);
});

test('a worker with unfinished assignments cannot be disabled or moved out of the worker role', async () => {
  for (const update of [
    { displayName: 'Alice', role: 'USER', status: 'DISABLED', expectedVersion: 1 },
    { displayName: 'Alice', role: 'REVIEWER', status: 'ACTIVE', expectedVersion: 1 },
  ]) {
    const calls = [];
    const client = {
      async query(sql) {
        const source = String(sql);
        calls.push(source);
        if (source.includes('SELECT * FROM app_users WHERE id')) return { rows: [{
          id: 2, username: 'alice', display_name: 'Alice', role: 'USER', status: 'ACTIVE', version: 1,
        }] };
        if (source.includes('SELECT id FROM tasks')) return { rows: [{ id: 41 }] };
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PostgresControlPlaneRepository({
      pool: { connect: async () => client },
    });
    await assert.rejects(repository.updateUser(2, update), { code: 'USER_HAS_ACTIVE_TASKS' });
    assert.equal(calls.some((sql) => sql.includes('UPDATE app_users')), false);
  }
});

test('deletion password failures are rate limited per administrator', async () => {
  const admin = { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => admin,
    getTask: async () => ({ id: 9, createdByUserId: 'admin' }),
    permanentlyDeleteTask: async () => {
      throw new ControlPlaneConflictError('DELETION_PASSWORD_INVALID', 'wrong password');
    },
  };
  await withServer(repository, async (root) => {
    const request = () => fetch(`${root}/v1/tasks/9/permanent`, {
      method: 'DELETE', headers: { ...actorHeaders('admin', 'ADMIN'), 'content-type': 'application/json' },
      body: JSON.stringify({ deletionPassword: 'wrong-password' }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await request()).status, 409);
    const blocked = await request();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('setting a deletion password rate limits invalid current passwords', async () => {
  const admin = { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => admin,
    setOwnDeletionPassword: async () => {
      throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', 'wrong password');
    },
  };
  await withServer(repository, async (root) => {
    const request = () => fetch(`${root}/v1/profile/deletion-password`, {
      method: 'POST', headers: { ...actorHeaders('admin', 'ADMIN'), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-password', deletionPassword: 'delete-secret' }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await request()).status, 409);
    assert.equal((await request()).status, 429);
  });
});

test('a same-name replacement administrator does not inherit the deleted account password limiter', async () => {
  let admin = { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    ownsPool: true,
    getUserByUsername: async () => admin,
    setOwnDeletionPassword: async () => {
      throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', 'wrong password');
    },
  };
  await withServer(repository, async (root) => {
    const request = (userId) => fetch(`${root}/v1/profile/deletion-password`, {
      method: 'POST',
      headers: { ...actorHeaders('admin', 'ADMIN', 1, userId), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-password', deletionPassword: 'delete-secret' }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await request(1)).status, 409);
    assert.equal((await request(1)).status, 429);
    admin = { ...admin, id: 9 };
    assert.equal((await request(9)).status, 409);
  });
});

test('deletion password must differ from the verified login password', async () => {
  const passwordHash = await hashUserPassword('login-secret');
  let updateReached = false;
  const client = {
    async query(sql) {
      const source = String(sql);
      if (source.includes('SELECT * FROM app_users')) {
        return { rows: [{ id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE',
          credential_version: 1, password_hash: passwordHash }] };
      }
      if (source.includes('UPDATE app_users')) updateReached = true;
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

  await assert.rejects(
    repository.setOwnDeletionPassword({
      userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1,
    }, {
      currentPassword: 'login-secret',
      deletionPassword: 'login-secret',
    }),
    { code: 'DELETION_PASSWORD_REUSED' },
  );
  assert.equal(updateReached, false);
});
