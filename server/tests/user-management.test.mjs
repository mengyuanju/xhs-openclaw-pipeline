import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
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

function actorHeaders(username, role, credentialVersion = 1) {
  return {
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
    getTask: async (id) => ({ id: Number(id), createdByUserId: 'bob' }),
    cancelTask: async (id) => { cancelled.push(id); return { id: Number(id), state: 'CANCELLED' }; },
  };
  await withServer(repository, async (root) => {
    const mine = await fetch(`${root}/v1/tasks?createdByUserId=bob`, { headers: actorHeaders('alice', 'USER') });
    assert.equal(mine.status, 200);
    assert.equal(lists[0].createdByUserId, 'alice');

    const all = await fetch(`${root}/v1/tasks`, { headers: actorHeaders('reviewer', 'REVIEWER') });
    assert.equal(all.status, 200);
    assert.equal(lists[1].createdByUserId, undefined);

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

test('reviewers cannot mutate prompts or production settings and cannot manage users', async () => {
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
    assert.equal((await fetch(`${root}/v1/knowledge`, { headers })).status, 200);
  });
});
