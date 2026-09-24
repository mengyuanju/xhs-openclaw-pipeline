import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';

test('task data report query, export, detail, and saved schemes require an active administrator', async () => {
  let reportReads = 0;
  const client = {
    async query(sql) {
      if (sql.includes('clock_timestamp() AS at')) return { rows: [{ at: new Date() }] };
      if (sql.includes('WITH filtered AS MATERIALIZED')) {
        reportReads++;
        return { rows: [{ total: 0, copy_qa_released: 0, image_qa_released: 0,
          by_state: {}, delivered: 0, with_rejection: 0, with_reassignment: 0,
          legacy_assignment_count: 0, missing_first_manual_assignment_count: 0 }] };
      }
      if (sql.includes('SELECT t.id FROM tasks t WHERE')) return { rows: [] };
      if (sql.includes('FROM tasks t') && sql.includes('WHERE t.id=ANY')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const roles = { admin: 'ADMIN', reviewer: 'REVIEWER', user: 'USER' };
  const ids = { admin: 1, reviewer: 2, user: 3 };
  const repository = {
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    getUserByUsername: async username => ({ id: ids[username], username,
      role: roles[username], status: 'ACTIVE', credentialVersion: 1 }),
    getUserByIdentity: async actor => ({ id: actor.userId, username: actor.username,
      role: roles[actor.username], status: 'ACTIVE', credentialVersion: 1 }),
  };
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage', enforceUserAuth: true });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const reportBody = JSON.stringify({ time: { field: 'CREATED_AT', mode: 'RELATIVE', days: 1 } });
  const routes = [
    ['POST', '/v1/admin/task-data-report/query', reportBody],
    ['POST', '/v1/admin/task-data-report/export', reportBody],
    ['GET', '/v1/admin/task-data-report/tasks/1'],
    ['GET', '/v1/admin/task-data-report/saved-queries'],
    ['POST', '/v1/admin/task-data-report/saved-queries', '{}'],
    ['PATCH', '/v1/admin/task-data-report/saved-queries/1', '{}'],
    ['DELETE', '/v1/admin/task-data-report/saved-queries/1'],
  ];
  try {
    for (const username of ['reviewer', 'user']) {
      for (const [method, path, body] of routes) {
        const response = await fetch(`${root}${path}`, { method, headers: {
          'Content-Type': 'application/json', 'X-Actor-User-Id': String(ids[username]),
          'X-Actor-Username': username, 'X-Actor-Role': roles[username],
          'X-Actor-Credential-Version': '1',
        }, ...(body ? { body } : {}) });
        assert.equal(response.status, 403, `${username} ${method} ${path}: ${await response.text()}`);
      }
    }
    assert.equal(reportReads, 0, 'denied actors must not execute report queries');
    for (const path of ['/v1/admin/task-data-report/query', '/v1/admin/task-data-report/export']) {
      const response = await fetch(`${root}${path}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Actor-User-Id': '1',
        'X-Actor-Username': 'admin', 'X-Actor-Role': 'ADMIN',
        'X-Actor-Credential-Version': '1',
      }, body: reportBody });
      assert.equal(response.status, 200, path);
    }
    assert.equal(reportReads, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
