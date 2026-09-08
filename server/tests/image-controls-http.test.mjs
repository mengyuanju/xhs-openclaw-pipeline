import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('image revision HTTP permissions enforce owner or admin and forward actor identity', async t => {
  const calls = [];
  const roles = { alice: 'USER', bob: 'USER', reviewer: 'REVIEWER', admin: 'ADMIN' };
  const app = createControlPlaneApp({ enforceUserAuth: true, storageRoot: 'unused', repository: {
    getUserByUsername: async username => ({ id: 1, username, role: roles[username], status: 'ACTIVE', credentialVersion: 1 }),
    getTask: async () => ({
      id: 1,
      createdByUserId: 'alice',
      createdByAccountId: 1,
      assignedToUserId: 'alice',
      assignedToAccountId: 1,
    }),
    reviseImages: async (...args) => { calls.push(args); return { state: 'IMAGE_QUEUED' }; },
  } });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [username, role] of Object.entries(roles)) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/tasks/1/image-revisions`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Actor-User-Id': '1', 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1',
    }, body: JSON.stringify({ operation: 'REPROCESS' }) });
    assert.equal(response.status, ['alice', 'admin'].includes(username) ? 201 : 403);
  }
  assert.deepEqual(calls.map(args => args[2]), ['alice', 'admin']);
});

test('old image executors cannot claim configured tasks, and rejection rolls back before task allocation', async () => {
  const calls = [];
  const client = { release() {}, async query(sql) {
    calls.push(sql);
    if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ image_worker_enabled: true, image_concurrency: 1 }] };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('SELECT last_assignee_user_id FROM execution_claim_cursors')) {
      return { rows: [{ last_assignee_user_id: null }] };
    }
    if (sql.includes('FOR UPDATE OF task SKIP LOCKED')) return { rows: [{ id: 1, assigned_to_user_id: 'alice', pending_snapshot: { copyRevision: { content: { imageSettings: { format: 'WEBP' } } } } }] };
    return { rows: [] };
  } };
  const repo = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repo.claimImage('old-worker'), { code: 'IMAGE_CONTROLS_UPGRADE_REQUIRED' });
  assert.equal(calls.some(sql => sql.includes('INSERT INTO task_executions')), false);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('executor source downloads are restricted to the active execution snapshot and pinned asset hash', async () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const sourceRunId = '22222222-2222-4222-8222-222222222222';
  const hash = 'a'.repeat(64);
  const execution = { id: runId, task_id: 1, kind: 'IMAGE', status: 'RUNNING', current_execution_id: runId,
    snapshot: { copyRevision: { content: { imageReprocess: { sourceRunId, sources: [{ assetId: 5, sha256: hash }] } } } } };
  const asset = { id: 5, task_id: 1, image_run_id: sourceRunId, sha256: hash, media_type: 'image/png' };
  const client = { release() {}, async query(sql) { return { rows: sql.includes('SELECT t.id') && sql.includes('SELECT e.task_id') ? [{ id: 1 }] : sql.includes('SELECT e.*') ? [execution] : sql.includes('SELECT * FROM assets') ? [asset] : [] }; } };
  const repo = new PostgresControlPlaneRepository({ pool: { connect: async () => client, query: async () => assert.fail('source download must reuse the transaction connection') } });
  assert.equal((await repo.imageReprocessAsset(runId, 5)).taskId, 1);
  await assert.rejects(repo.imageReprocessAsset(runId, 6), /source asset/);
  asset.task_id = 99;
  await assert.rejects(repo.imageReprocessAsset(runId, 5), /source asset/);
  asset.task_id = 1; asset.sha256 = 'b'.repeat(64);
  await assert.rejects(repo.imageReprocessAsset(runId, 5), /source asset/);
});
