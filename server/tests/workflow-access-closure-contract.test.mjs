import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';

function actorHeaders(user) {
  return {
    'Content-Type': 'application/json',
    'X-Actor-User-Id': String(user.id),
    'X-Actor-Username': user.username,
    'X-Actor-Role': user.role,
    'X-Actor-Credential-Version': '1',
  };
}

test('legacy raw task creation is administrator-only so workers cannot bypass Query screening', async () => {
  const users = new Map([
    ['worker', { id: 2, username: 'worker', role: 'USER', status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false }],
    ['admin', { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false }],
  ]);
  const calls = [];
  const repository = {
    getUserByUsername: async (username) => users.get(username) ?? null,
    createTasks: async (input) => { calls.push(input); return [{ id: 1, state: 'COPY_QUEUED' }]; },
  };
  const server = createControlPlaneApp({ repository, storageRoot: 'test-storage' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/tasks`;
  const body = JSON.stringify({
    nodeId: 'web-admin',
    tasks: [{ query: '只能经过词包投产的 Query', input: {}, requestedImageCount: 'auto' }],
  });
  try {
    const worker = await fetch(url, { method: 'POST', headers: actorHeaders(users.get('worker')), body });
    assert.equal(worker.status, 403);
    assert.equal(calls.length, 0);

    const admin = await fetch(url, { method: 'POST', headers: actorHeaders(users.get('admin')), body });
    assert.equal(admin.status, 201);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('blind batch-return membership stops hiding a task once it reaches image work', async () => {
  const source = await readFile(new URL('../src/postgres-repository.mjs', import.meta.url), 'utf8');
  assert.match(source, /blind_freeze\.status = 'BATCH_RETURNED'[\s\S]*tasks\.state IN \('COPY_REVIEW_PENDING', 'COPY_QC_PENDING'\)/u);
  assert.match(source, /blind_freeze\.status = 'BATCH_RETURNED'[\s\S]*task\.state IN \('COPY_REVIEW_PENDING', 'COPY_QC_PENDING'\)/u);
  assert.doesNotMatch(source, /blind_freeze\.status IN \('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED'\)/u);
});
