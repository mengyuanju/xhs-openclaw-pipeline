import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { HttpError } from '../src/http-route-common.mjs';
import { captureWorkspaceMutation, workspaceMutationCommitted, workspaceCountsNeedInvalidation } from '../src/http-workspace-invalidation.mjs';
import { readPersonalCurrentPage } from '../src/personal-workspace-query.mjs';
import { personalFactsSql } from '../src/personal-workspace.mjs';
import { commitTaskListChange, taskListFactVersion } from '../src/task-list-facts.mjs';
import { normalizePersonalFilters } from '../../src/personal-workspace.mjs';

const actor = { userId: 2, username: 'alice', role: 'USER', credentialVersion: 1 };
const headers = { 'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice',
  'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '1' };
const now = Date.parse('2026-10-02T12:00:00+08:00');

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-http-optimized-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function withServer(repository, storageRoot, action, enforceUserAuth = true) {
  const app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth,
    logger: { info() {}, error() {} }, reportProjectionEnabled: false, disposableCleanupEnabled: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done, fail) => { server.once('listening', done); server.once('error', fail); });
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeIdleConnections();
    await new Promise(done => server.close(done));
    await app.context.disposeControlPlaneResources();
  }
}

async function imageFixture(t) {
  const root = await temporaryRoot(t), path = join(root, 'original.png');
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#33669980' } }).png().toBuffer();
  await writeFile(path, bytes);
  const asset = { id: 7, taskId: 12, storagePath: path, mediaType: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const task = { id: 12, assignedToUserId: 'alice', assignedToAccountId: 2 };
  const repository = {
    getAsset: async () => asset,
    getTaskAccess: async () => task,
    getUserByUsername: async () => ({ id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 }),
  };
  return { root, path, asset, repository };
}

test('matching thumbnail ETag skips derivative generation after checking original existence', async t => {
  const fixture = await imageFixture(t);
  const etag = `"${fixture.asset.sha256}-thumb-480-v1"`;
  await withServer(fixture.repository, fixture.root, async root => {
    const response = await fetch(`${root}/v1/assets/7?variant=thumbnail`, {
      headers: { ...headers, 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
    });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('etag'), etag);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.deepEqual(await readdir(fixture.root), ['original.png']);
    await rm(fixture.path);
    const missing = await fetch(`${root}/v1/assets/7?variant=thumbnail`, {
      headers: { ...headers, 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('etag'), null);
    assert.equal((await missing.json()).error.code, 'ASSET_FILE_MISSING');
  });
});

test('early conditional assets still recheck task ownership and current account identity', async t => {
  for (const revoke of ['assignment', 'account']) {
    const fixture = await imageFixture(t), etag = `"${fixture.asset.sha256}-thumb-480-v1"`;
    let accessReads = 0;
    if (revoke === 'assignment') fixture.repository.getTaskAccess = async () => ({ id: 12,
      assignedToUserId: ++accessReads === 1 ? 'alice' : 'bob', assignedToAccountId: accessReads === 1 ? 2 : 3 });
    else fixture.repository.getUserByIdentity = async () => null;
    await withServer(fixture.repository, fixture.root, async root => {
      const response = await fetch(`${root}/v1/assets/7?variant=thumbnail`, {
        headers: { ...headers, 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
      });
      assert.equal(response.status, revoke === 'assignment' ? 403 : 401);
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok((await response.json()).error);
      await assert.rejects(stat(join(fixture.root, 'thumbnails')), { code: 'ENOENT' });
    });
  }
});

test('image QA assets recheck item-scoped access before streaming or conditional responses', async t => {
  for (const conditional of [false, true]) {
    const fixture = await imageFixture(t);
    let accessReads = 0;
    fixture.repository.getUserByUsername = async () => ({ id: 2, username: 'alice', role: 'REVIEWER',
      status: 'ACTIVE', credentialVersion: 1 });
    fixture.repository.getImageQaAsset = async (itemId, assetId, { actor: reviewer }) => {
      assert.equal(itemId, 'opaque-item'); assert.equal(assetId, 'opaque-asset');
      assert.equal(reviewer.role, 'REVIEWER');
      if (++accessReads > 1) throw new HttpError(403, 'FORBIDDEN', 'image QA access was revoked');
      return fixture.asset;
    };
    await withServer(fixture.repository, fixture.root, async root => {
      const response = await fetch(`${root}/v1/image-qa/items/opaque-item/assets/opaque-asset`, {
        headers: { ...headers, 'X-Actor-Role': 'REVIEWER', ...(conditional ? {
          'If-None-Match': `"${fixture.asset.sha256}-original"`, 'Cache-Control': 'max-age=0',
        } : {}) },
      });
      assert.equal(accessReads, 2);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).error.code, 'FORBIDDEN');
    });
  }
});

function countReader(pool) {
  let total = 5, reads = 0;
  const client = { async query(sql) {
    if (sql.includes('FROM filtered f')) { reads++; return { rows: [{ ALL: total }] }; }
    return { rows: [] };
  } };
  return {
    read: () => readPersonalCurrentPage(client, pool, { actor, filters: normalizePersonalFilters({}, now),
      factsSql: options => personalFactsSql('false', options) }, { now, countsOnly: true }),
    get reads() { return reads; },
    set total(value) { total = value; },
  };
}

test('empty claims, no-op tasks and report writes retain scoped counts; committed recovery invalidates them', async t => {
  const root = await temporaryRoot(t), pool = {}, counts = countReader(pool);
  let recover = false;
  const repository = {
    pool, getWorkspaceMutationVersion: () => taskListFactVersion(pool),
    claimCopyBatch: async input => {
      if (recover) { counts.total = 9; commitTaskListChange(pool); }
      return { requestId: input.requestId, claims: [] };
    },
    setTaskPriority: async () => ({ changed: 0 }),
    getTaskAccess: async () => ({ id: 12 }),
    updateOwnProfile: async () => ({}),
  };
  await withServer(repository, root, async root => {
    assert.equal((await counts.read()).total, 5);
    const post = async path => {
      const result = await fetch(`${root}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'fake', requestId: 'fake', taskIds: [12] }) });
      assert.equal(result.status, 200); await result.arrayBuffer();
    };
    await post('/v1/executions/claim-copy-batch');
    assert.equal((await counts.read()).total, 5); assert.equal(counts.reads, 1);
    await post('/v1/tasks/priority');
    assert.equal((await counts.read()).total, 5); assert.equal(counts.reads, 1);
    recover = true;
    await post('/v1/executions/claim-copy-batch');
    assert.equal((await counts.read()).total, 9); assert.equal(counts.reads, 2);
    counts.total = 11;
    const profile = await fetch(`${root}/v1/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(profile.status, 200); await profile.arrayBuffer();
    assert.equal((await counts.read()).total, 11); assert.equal(counts.reads, 3, 'permission-scoped profiles retain conservative invalidation');
  }, false);
});

test('business versions fence old in-flight counts and cover background changes without HTTP writes', async () => {
  const pool = {}, counts = countReader(pool);
  assert.equal((await counts.read()).total, 5);
  counts.total = 8; commitTaskListChange(pool);
  assert.equal((await counts.read()).total, 8); assert.equal(counts.reads, 2);
  let finish;
  const inFlightPool = {}, freshCounts = countReader(inFlightPool);
  const stale = readPersonalCurrentPage({ query: async () => new Promise(resolve => { finish = resolve; }) }, inFlightPool,
    { actor, filters: normalizePersonalFilters({}, now), factsSql: options => personalFactsSql('false', options) },
    { now, countsOnly: true });
  commitTaskListChange(inFlightPool);
  finish({ rows: [{ ALL: 1 }] });
  assert.equal((await stale).total, 1);
  assert.equal((await freshCounts.read()).total, 5, 'the previous transaction response cannot repopulate a newer version');
  assert.equal(freshCounts.reads, 1);
  const before = captureWorkspaceMutation({ getWorkspaceMutationVersion: () => taskListFactVersion(pool) });
  assert.equal(workspaceMutationCommitted({ getWorkspaceMutationVersion: () => taskListFactVersion(pool) },
    { method: 'POST', path: '/v1/admin/task-data-report/export', status: 200 }, before), false);
});

test('scoped count caches retain their own invalidation while real commits still wake maintenance', () => {
  const repository = { supportsScopedWorkspaceCounts: true, getWorkspaceMutationVersion: () => 2 };
  const ctx = { method: 'POST', path: '/v1/tasks/priority', status: 200 };
  assert.equal(workspaceMutationCommitted(repository, ctx, 1), true, 'the HTTP maintenance wake still observes the commit');
  assert.equal(workspaceCountsNeedInvalidation(repository, ctx), false, 'scoped caches invalidate themselves');
  assert.equal(workspaceCountsNeedInvalidation(repository, { method: 'PATCH', path: '/v1/users/2', status: 200 }), true);
  assert.equal(workspaceCountsNeedInvalidation(repository, { method: 'PATCH', path: '/v1/profile', status: 200 }), true);
  assert.equal(workspaceCountsNeedInvalidation({}, ctx), true, 'old repositories retain conservative clearing');
});
