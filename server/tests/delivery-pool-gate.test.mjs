import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import { createControlPlaneApp } from '../src/http-server.mjs';

async function withServer(repository, action) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-delivery-pool-gate-'));
  const app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth: false });
  let server;
  try {
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    await action(`http://127.0.0.1:${server.address().port}`, storageRoot);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(storageRoot, { recursive: true, force: true });
  }
}

function task(id, state) {
  return {
    id,
    state,
    createdByUserId: 'admin',
    currentCopyRevisionId: 100 + id,
    currentImageRunId: `run-${id}`,
    copyRevisions: [{
      id: 100 + id,
      content: { copy: { title: `任务${id}`, body: '正文', tags: [] } },
    }],
    imageRuns: [{
      id: `run-${id}`,
      result: { images: [{ assetId: 200 + id }] },
    }],
    assets: [{
      id: 200 + id,
      taskId: id,
      imageRunId: `run-${id}`,
      mediaType: 'image/png',
      originalName: '01.png',
    }],
  };
}

test('single delivery download rejects every state before final image review', async () => {
  let currentState = 'MANUAL_ARCHIVE';
  let assetReads = 0;
  await withServer({
    getTask: async () => task(7, currentState),
    getAsset: async () => {
      assetReads += 1;
      assert.fail('a non-deliverable task must be rejected before reading files');
    },
  }, async (root) => {
    for (const state of ['COPY_QC_PENDING', 'IMAGE_QUEUED', 'MANUAL_ARCHIVE']) {
      currentState = state;
      const response = await fetch(`${root}/v1/tasks/7/archive`);
      assert.equal(response.status, 409, state);
      assert.equal((await response.json()).error.code, 'INVALID_TASK_STATE', state);
      assert.equal(response.headers.get('content-disposition'), null, state);
    }
  });
  assert.equal(assetReads, 0);
});

test('batch delivery download is fail-closed when one selected task is not in the delivery pool', async () => {
  const tasks = new Map([
    [7, task(7, 'REVIEWED')],
    [8, task(8, 'MANUAL_ARCHIVE')],
  ]);
  let assetReads = 0;
  await withServer({
    getTask: async (id) => tasks.get(Number(id)),
    assertTaskReadyForDelivery: async (id) => ({
      taskId: Number(id),
      copyRevisionId: 100 + Number(id),
      imageRunId: `run-${id}`,
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async () => {
      assetReads += 1;
      assert.fail('batch preflight must finish before any delivery file is read');
    },
  }, async (root) => {
    const response = await fetch(`${root}/v1/tasks/batch-archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: [7, 8] }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'INVALID_TASK_STATE');
    assert.equal(response.headers.get('content-disposition'), null);
  });
  assert.equal(assetReads, 0);
});

test('delivery pool export packages the complete server-side snapshot beyond legacy page and batch limits', async () => {
  const taskIds = Array.from({ length: 51 }, (_, index) => index + 1);
  const tasks = new Map(taskIds.map((id) => [id, task(id, 'REVIEWED')]));
  const assets = new Map();
  const snapshotActors = [];
  await withServer({
    listAllDeliveryPoolTaskIds: async ({ actor }) => {
      snapshotActors.push(actor);
      return taskIds;
    },
    getTask: async (id) => tasks.get(Number(id)),
    assertTaskReadyForDelivery: async (id) => ({
      taskId: Number(id),
      copyRevisionId: 100 + Number(id),
      imageRunId: `run-${id}`,
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async (id) => assets.get(Number(id)),
  }, async (root, storageRoot) => {
    for (const id of taskIds) {
      const storagePath = join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`, '01.png');
      await mkdir(join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`), { recursive: true });
      await writeFile(storagePath, Buffer.from([id]));
      assets.set(200 + id, {
        id: 200 + id,
        taskId: id,
        imageRunId: `run-${id}`,
        mediaType: 'image/png',
        originalName: '01.png',
        storagePath,
      });
    }

    const response = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'ALL_READY' }),
    });
    assert.equal(response.status, 201);
    const prepared = (await response.json()).data;
    assert.equal(prepared.taskCount, 51);
    const probe = await fetch(`${root}/v1/delivery-pool/archive/${prepared.downloadId}`, {
      method: 'HEAD',
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.headers.get('x-delivery-task-count'), '51');
    assert.ok(Number(probe.headers.get('content-length')) > 0);
    assert.equal(await probe.text(), '');
    const download = await fetch(`${root}/v1/delivery-pool/archive/${prepared.downloadId}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /delivery-pool\.zip/u);
    const zip = await JSZip.loadAsync(await download.arrayBuffer());
    assert.equal(Object.keys(zip.files).length, 51);
    assert.ok(zip.file('任务-1-资源包.zip'));
    assert.ok(zip.file('任务-51-资源包.zip'));
    const replay = await fetch(`${root}/v1/delivery-pool/archive/${prepared.downloadId}`);
    assert.equal(replay.status, 404, 'the prepared archive token must be one-time');
  });
  assert.equal(snapshotActors.length, 1);
  assert.equal(snapshotActors[0].role, 'ADMIN');
});

test('selected delivery pool export accepts more than the legacy 20-task limit', async () => {
  const taskIds = Array.from({ length: 21 }, (_, index) => index + 1);
  const tasks = new Map(taskIds.map((id) => [id, task(id, 'REVIEWED')]));
  const assets = new Map();
  await withServer({
    getTask: async (id) => tasks.get(Number(id)),
    assertTaskReadyForDelivery: async (id) => ({
      taskId: Number(id),
      copyRevisionId: 100 + Number(id),
      imageRunId: `run-${id}`,
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async (id) => assets.get(Number(id)),
  }, async (root, storageRoot) => {
    for (const id of taskIds) {
      const storagePath = join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`, '01.png');
      await mkdir(join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`), { recursive: true });
      await writeFile(storagePath, Buffer.from([id]));
      assets.set(200 + id, {
        id: 200 + id,
        taskId: id,
        imageRunId: `run-${id}`,
        mediaType: 'image/png',
        originalName: '01.png',
        storagePath,
      });
    }
    const response = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'SELECTED', taskIds }),
    });
    assert.equal(response.status, 201);
    const prepared = (await response.json()).data;
    assert.equal(prepared.taskCount, 21);
    const download = await fetch(`${root}/v1/delivery-pool/archive/${prepared.downloadId}`);
    assert.equal(download.status, 200);
    const zip = await JSZip.loadAsync(await download.arrayBuffer());
    assert.equal(Object.keys(zip.files).length, 21);
  });
});

test('empty all-ready delivery export returns a clear conflict without reading tasks', async () => {
  let taskReads = 0;
  await withServer({
    listAllDeliveryPoolTaskIds: async () => [],
    getTask: async () => { taskReads += 1; },
  }, async (root) => {
    const response = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'ALL_READY' }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, 'DELIVERY_POOL_EMPTY');
  });
  assert.equal(taskReads, 0);
});

test('delivery downloads fail closed without the READY version-binding capability', async () => {
  await withServer({
    getTask: async () => task(7, 'REVIEWED'),
    getAsset: async () => assert.fail('must not read an asset without the READY gate'),
  }, async (root) => {
    const response = await fetch(`${root}/v1/tasks/7/archive`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'FINAL_DELIVERY_UNAVAILABLE');
  });
});

test('delivery downloads reject a task snapshot that differs from the READY binding', async () => {
  await withServer({
    getTask: async () => task(7, 'REVIEWED'),
    assertTaskReadyForDelivery: async () => ({
      taskId: 7,
      copyRevisionId: 108,
      imageRunId: 'run-7',
    }),
    getAsset: async () => assert.fail('must not read an asset from a stale snapshot'),
  }, async (root) => {
    const response = await fetch(`${root}/v1/tasks/7/archive`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'DELIVERY_VERSION_CHANGED');
  });
});
