import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { ControlPlaneConflictError } from '../src/domain.mjs';

async function withArchive(action) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-prepared-http-'));
  const path = join(root, 'tasks', '12', 'image.png'); await mkdir(join(root, 'tasks', '12'), { recursive: true }); await writeFile(path, 'original-bytes');
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const user = { id: 2, username: 'alice', role: 'USER', credentialVersion: 1, status: 'ACTIVE' };
  const admin = { id: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1, status: 'ACTIVE' };
  const task = { id: 12, state: 'REVIEWED', assignedToUserId: 'alice', assignedToAccountId: 2,
    currentCopyRevisionId: 1, currentImageRunId: 'run',
    copyRevisions: [{ id: 1, content: { copy: { title: '私有文案', body: '正文' } } }],
    imageRuns: [{ id: 'run', result: { images: [{ assetId: 1 }] } }],
    assets: [{ id: 1, taskId: 12, imageRunId: 'run', mediaType: 'image/png' }] };
  const binding = { taskId: 12, copyRevisionId: 1, imageRunId: 'run' };
  const state = { ready: true };
  const repository = {
    getUserByUsername: async name => name === 'alice' ? user : admin,
    getUserByIdentity: async actor => actor.userId === 2 ? user : admin,
    getTaskAccess: async () => task,
    getTask: async () => assert.fail('archive must use its narrow pinned snapshot'),
    getTaskForDelivery: async () => ({ task, binding }),
    assertTasksReadyForDelivery: async () => { if (!state.ready) throw new ControlPlaneConflictError('FINAL_DELIVERY_BLOCKED', '交付版本已改变'); },
    getAsset: async () => { entered.resolve(); await released.promise; return { id: 1, taskId: 12, mediaType: 'image/png', originalName: '原图.png', storagePath: path }; },
  };
  const app = createControlPlaneApp({ repository, storageRoot: root, enforceUserAuth: true });
  const server = await new Promise(resolveServer => { const value = app.listen(0, '127.0.0.1', () => resolveServer(value)); });
  try { await action({ url: `http://127.0.0.1:${server.address().port}`, task, state, entered, released, root, path }); }
  finally {
    released.resolve(); await new Promise(resolveServer => server.close(resolveServer)); await app.context.disposeControlPlaneResources();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
  }
}
function headers(role = 'USER') {
  return { 'X-Actor-User-Id': role === 'USER' ? '2' : '1', 'X-Actor-Username': role === 'USER' ? 'alice' : 'admin',
    'X-Actor-Role': role, 'X-Actor-Credential-Version': '1', 'Content-Type': 'application/json' };
}
async function noPreparedFile(fixture) {
  assert.deepEqual(await readdir(join(fixture.root, '.task-archives')), []);
  assert.equal(await readFile(fixture.path, 'utf8'), 'original-bytes');
}

test('prepared single archive rechecks immutable ownership before any ZIP bytes are returned', async () => {
  await withArchive(async fixture => {
    const pending = fetch(`${fixture.url}/v1/tasks/12/archive`, { headers: headers() });
    await fixture.entered.promise; fixture.task.assignedToUserId = 'bob'; fixture.task.assignedToAccountId = 3; fixture.released.resolve();
    const response = await pending; assert.equal(response.status, 403);
    assert.equal(response.headers.get('content-disposition'), null); assert.equal((await response.json()).error.code, 'FORBIDDEN');
    await noPreparedFile(fixture);
  });
});

for (const batch of [false, true]) test(`prepared ${batch ? 'batch' : 'single'} archive rejects changed delivery bindings and removes its file`, async () => {
  await withArchive(async fixture => {
    const pending = fetch(`${fixture.url}${batch ? '/v1/tasks/batch-archive' : '/v1/tasks/12/archive'}`, {
      method: batch ? 'POST' : 'GET', headers: headers(batch ? 'ADMIN' : 'USER'), ...(batch ? { body: JSON.stringify({ taskIds: [12] }) } : {}),
    });
    await fixture.entered.promise; fixture.state.ready = false; fixture.released.resolve();
    const response = await pending; assert.equal(response.status, 409);
    assert.equal(response.headers.get('content-disposition'), null); assert.equal((await response.json()).error.code, 'FINAL_DELIVERY_BLOCKED');
    await noPreparedFile(fixture);
  });
});
