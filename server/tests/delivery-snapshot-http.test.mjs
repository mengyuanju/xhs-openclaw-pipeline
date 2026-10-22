import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { ControlPlaneAuthorizationError } from '../src/domain.mjs';

const headers = { 'X-Actor-User-Id': '1', 'X-Actor-Username': 'admin',
  'X-Actor-Role': 'ADMIN', 'X-Actor-Credential-Version': '1', 'content-type': 'application/json' };

async function fixture(action) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-snapshot-http-'));
  const path = join(storageRoot, 'tasks', '12', 'image.png');
  await mkdir(join(storageRoot, 'tasks', '12'), { recursive: true });
  const bytes = Buffer.from('frozen-image'); await writeFile(path, bytes);
  const imageRunId = randomUUID();
  const task = { id: 12, query: '交付时的问题', state: 'REVIEWED', currentCopyRevisionId: 2,
    currentImageRunId: imageRunId, sourceClientBatchCode: '甲方批次',
    copyRevisions: [{ id: 2, content: { copy: { title: '交付时标题', body: '冻结正文', tags: [] } } }],
    imageRuns: [{ id: imageRunId, result: { images: [{ assetId: 7 }] } }],
    assets: [{ id: 7, taskId: 12, imageRunId, mediaType: 'image/png', originalName: '原图.png' }] };
  const binding = { taskId: 12, copyRevisionId: 2, imageRunId };
  let batch, downloads = 0, authorized = true, failCreation = false;
  const repository = {
    getUserByUsername: async () => ({ id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 }),
    getTaskForDelivery: async () => ({ task, binding }),
    getAsset: async () => ({ ...task.assets[0], storagePath: path, byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }),
    assertTasksReadyForDelivery: async () => {},
    createDeliveryBatch: async input => {
      if (failCreation) throw new Error('fixture database failure');
      assert.equal(input.snapshotAssets[0].storagePath, path);
      batch = { ...input, taskCount: 1 }; return batch;
    },
    getDeliveryBatchArtifact: async id => {
      if (!authorized) throw new ControlPlaneAuthorizationError('fixture forbidden');
      assert.equal(id, batch.publicId); return batch;
    },
    recordDeliveryBatchDownload: async () => { downloads += 1; },
  };
  const app = createControlPlaneApp({ repository, storageRoot, logger: { info() {}, error() {} } });
  const server = await new Promise(done => { const value = app.listen(0, '127.0.0.1', () => done(value)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await action({ storageRoot, path, task, url, get batch() { return batch; }, get downloads() { return downloads; },
    forbid() { authorized = false; }, failCreation() { failCreation = true; } }); }
  finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await app.context.disposeControlPlaneResources();
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function prepare(f) {
  const response = await fetch(`${f.url}/v1/delivery-pool/archive`, { method: 'POST', headers,
    body: JSON.stringify({ scope: 'SELECTED', taskIds: [12] }) });
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
  return { ...body.data, downloadUrl: `/v1/delivery-pool/archive/${body.data.downloadId}` };
}
async function assertClean(f) {
  for (let i = 0; i < 100; i += 1) {
    const entries = await readdir(join(f.storageRoot, '.delivery-exports')).catch(() => []);
    if (!entries.length) break;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.deepEqual(await readdir(join(f.storageRoot, '.delivery-exports')), []);
  assert.deepEqual(await readdir(join(f.storageRoot, '.delivery-batches')).catch(() => []), []);
  assert.equal(await readFile(f.path, 'utf8'), 'frozen-image');
}

test('delivery ZIPs are temporary and historical downloads rebuild frozen members from the snapshot', async () => {
  await fixture(async f => {
    const prepared = await prepare(f);
    const response = await fetch(`${f.url}${prepared.downloadUrl}`, { headers });
    assert.equal(response.status, 200);
    const first = await JSZip.loadAsync(await response.arrayBuffer());
    await assertClean(f);
    assert.equal((await readdir(join(f.storageRoot, '.delivery-snapshots'))).length, 1);
    f.task.copyRevisions[0].content.copy.body = '后来改过的内容';
    f.task.currentImageRunId = randomUUID();
    const endpoint = `${f.url}/v1/delivery-batches/${f.batch.publicId}/archive`;
    const countBeforeHead = f.downloads;
    assert.equal((await fetch(endpoint, { method: 'HEAD', headers })).status, 200);
    assert.equal(f.downloads, countBeforeHead); await assertClean(f);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const item = await fetch(endpoint, { headers });
      assert.equal(item.status, 200);
      const rebuilt = await JSZip.loadAsync(await item.arrayBuffer());
      assert.deepEqual(Object.keys(rebuilt.files), Object.keys(first.files));
      for (const name of Object.keys(first.files)) assert.deepEqual(await rebuilt.file(name).async('nodebuffer'), await first.file(name).async('nodebuffer'));
      await assertClean(f);
    }
    await assertClean(f);
  });
});

test('missing or changed local originals fail historical downloads without leaving a ZIP', async () => {
  await fixture(async f => {
    const prepared = await prepare(f);
    await (await fetch(`${f.url}${prepared.downloadUrl}`, { headers })).arrayBuffer(); await assertClean(f);
    await writeFile(f.path, 'changed-data');
    const response = await fetch(`${f.url}/v1/delivery-batches/${f.batch.publicId}/archive`, { headers });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'DELIVERY_SOURCE_MISSING');
    assert.deepEqual(await readdir(join(f.storageRoot, '.delivery-exports')), []);
  });
});

test('batch creation rollback removes both snapshot and temporary ZIP', async () => {
  await fixture(async f => {
    f.failCreation();
    const response = await fetch(`${f.url}/v1/delivery-pool/archive`, { method: 'POST', headers,
      body: JSON.stringify({ scope: 'SELECTED', taskIds: [12] }) });
    assert.equal(response.status, 500); await response.arrayBuffer();
    await assertClean(f);
    assert.deepEqual(await readdir(join(f.storageRoot, '.delivery-snapshots')), []);
  });
});

test('historical authorization is checked before a ZIP is reconstructed', async () => {
  await fixture(async f => {
    const prepared = await prepare(f);
    await (await fetch(`${f.url}${prepared.downloadUrl}`, { headers })).arrayBuffer(); await assertClean(f);
    f.forbid();
    const response = await fetch(`${f.url}/v1/delivery-batches/${f.batch.publicId}/archive`, { headers });
    assert.equal(response.status, 403); await response.arrayBuffer(); await assertClean(f);
  });
});
