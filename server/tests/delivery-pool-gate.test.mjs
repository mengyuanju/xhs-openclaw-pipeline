import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';

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

function task(id, state, sourceQueryPackageName = null) {
  return {
    id,
    query: `Query ${id}`,
    sourceQueryPackageName,
    xiaohongshuLinks: [{
      noteId: `note-${id}`,
      url: `https://www.xiaohongshu.com/explore/note-${id}`,
      title: `参考 ${id}`,
      rank: 1,
    }],
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

async function writeSolidPng(path, background) {
  const content = await sharp({
    create: { width: 24, height: 32, channels: 4, background },
  }).png().toBuffer();
  await writeFile(path, content);
  return content;
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
    assert.ok(zip.file('未归属词包/任务-1-资源包.zip'));
    assert.ok(zip.file('未归属词包/任务-51-资源包.zip'));
    const replay = await fetch(`${root}/v1/delivery-pool/archive/${prepared.downloadId}`);
    assert.equal(replay.status, 404, 'the prepared archive token must be one-time');
  });
  assert.equal(snapshotActors.length, 1);
  assert.equal(snapshotActors[0].role, 'ADMIN');
});

test('package-scoped ZIP and Excel exports keep the exact package scope and safe package filenames', async () => {
  const selected = task(7, 'REVIEWED', '秋季/收纳');
  const snapshotCalls = [];
  let asset;
  await withServer({
    listAllDeliveryPoolTaskIds: async (options) => {
      snapshotCalls.push(options);
      return [7];
    },
    getTask: async (id) => Number(id) === 7 ? selected : null,
    assertTaskReadyForDelivery: async () => ({
      taskId: 7,
      copyRevisionId: 107,
      imageRunId: 'run-7',
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async () => asset,
  }, async (root, storageRoot) => {
    const directory = join(storageRoot, 'tasks', '7', 'image-runs', 'run-7');
    const storagePath = join(directory, '01.png');
    await mkdir(directory, { recursive: true });
    const content = await writeSolidPng(storagePath, '#2563EB');
    asset = {
      ...selected.assets[0],
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      storagePath,
    };

    const input = { scope: 'QUERY_PACKAGE', queryPackageName: '  秋季/收纳  ' };
    const zipResponse = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(zipResponse.status, 201);
    const zipPrepared = (await zipResponse.json()).data;
    assert.equal(zipPrepared.fileName, '秋季_收纳-交付资源.zip');
    const zipDownload = await fetch(`${root}/v1/delivery-pool/archive/${zipPrepared.downloadId}`);
    const zip = await JSZip.loadAsync(await zipDownload.arrayBuffer());
    assert.ok(zip.file('秋季_收纳/任务-7-资源包.zip'));

    const xlsxResponse = await fetch(`${root}/v1/delivery-pool/xlsx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(xlsxResponse.status, 201);
    assert.equal((await xlsxResponse.json()).data.fileName, '秋季_收纳-交付内容.xlsx');
  });
  assert.deepEqual(snapshotCalls.map(({ queryPackageName }) => queryPackageName), [
    '秋季/收纳', '秋季/收纳',
  ]);
  assert.ok(snapshotCalls.every(({ actor }) => actor.role === 'ADMIN'));
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

test('delivery spreadsheet exports one complete-article column plus ordered embedded images', async () => {
  const selected = task(7, 'REVIEWED');
  selected.copyRevisions[0].content.copy = {
    title: '=这是一篇标题',
    body: '+这是完整正文',
    tags: ['不应导出'],
  };
  selected.imageRuns[0].result.images = [{ assetId: 209 }, { assetId: 207 }];
  selected.assets = [
    { id: 207, taskId: 7, imageRunId: 'run-7', mediaType: 'image/png' },
    { id: 209, taskId: 7, imageRunId: 'run-7', mediaType: 'image/png' },
    { id: 999, taskId: 7, imageRunId: 'run-7', mediaType: 'image/png' },
  ];
  const assets = new Map();
  const sourceContentById = new Map();
  const loadedAssetIds = [];
  await withServer({
    getTask: async (id) => (Number(id) === 7 ? selected : null),
    assertTaskReadyForDelivery: async () => ({
      taskId: 7,
      copyRevisionId: 107,
      imageRunId: 'run-7',
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async (id) => {
      loadedAssetIds.push(Number(id));
      return assets.get(Number(id));
    },
  }, async (root, storageRoot) => {
    const imageDirectory = join(storageRoot, 'tasks', '7', 'image-runs', 'run-7');
    await mkdir(imageDirectory, { recursive: true });
    for (const [id, name, background] of [
      [209, 'first.png', '#DC2626'],
      [207, 'second.png', '#2563EB'],
    ]) {
      const storagePath = join(imageDirectory, name);
      const content = await writeSolidPng(storagePath, background);
      sourceContentById.set(id, content);
      assets.set(id, {
        id,
        taskId: 7,
        imageRunId: 'run-7',
        mediaType: 'image/png',
        byteSize: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        originalName: name,
        storagePath,
      });
    }

    const response = await fetch(`${root}/v1/delivery-pool/xlsx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'SELECTED', taskIds: [7] }),
    });
    const responsePayload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(responsePayload));
    const prepared = responsePayload.data;
    assert.equal(prepared.taskCount, 1);
    assert.match(prepared.fileName, /\.xlsx$/u);

    const probe = await fetch(`${root}/v1/delivery-pool/xlsx/${prepared.downloadId}`, {
      method: 'HEAD',
    });
    assert.equal(probe.status, 200);
    assert.equal(
      probe.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(probe.headers.get('x-delivery-task-count'), '1');
    assert.ok(Number(probe.headers.get('content-length')) > 0);

    const download = await fetch(`${root}/v1/delivery-pool/xlsx/${prepared.downloadId}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /delivery-pool\.xlsx/u);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
    const worksheet = workbook.getWorksheet('交付内容');
    assert.ok(worksheet);
    assert.equal(worksheet.getCell('A1').value, '词包名称');
    assert.equal(worksheet.getCell('A2').value, '未归属词包');
    assert.equal(worksheet.getCell('B1').value, 'Query');
    assert.equal(worksheet.getCell('B2').value, 'Query 7');
    assert.equal(worksheet.getCell('C1').value, '完整文章');
    assert.equal(worksheet.getCell('C2').value, '=这是一篇标题\n\n+这是完整正文');
    assert.notEqual(worksheet.getCell('C2').font?.bold, true);
    assert.equal(worksheet.getCell('D1').value, '小红书链接');
    assert.equal(
      worksheet.getCell('D2').value,
      'https://www.xiaohongshu.com/explore/note-7',
    );
    assert.equal(worksheet.getCell('E1').value, '图片 1');
    assert.equal(worksheet.getCell('F1').value, '图片 2');
    assert.equal(worksheet.actualColumnCount, 6);
    const embeddedImages = worksheet.getImages();
    assert.equal(embeddedImages.length, 2);
    assert.deepEqual(
      embeddedImages.map((image) => Buffer.from(workbook.getImage(Number(image.imageId)).buffer)),
      [sourceContentById.get(209), sourceContentById.get(207)],
      'the downloaded workbook must contain the exact original image bytes in result order',
    );
    assert.deepEqual(loadedAssetIds, [209, 207]);

    const replay = await fetch(`${root}/v1/delivery-pool/xlsx/${prepared.downloadId}`);
    assert.equal(replay.status, 404, 'the prepared spreadsheet token must be one-time');
  });
});

test('delivery spreadsheet rejects unsupported original formats without leaving staged files or locking export', async () => {
  const selected = task(7, 'REVIEWED');
  selected.assets[0].mediaType = 'image/webp';
  selected.assets[0].originalName = '01.webp';
  let asset;
  await withServer({
    getTask: async (id) => (Number(id) === 7 ? selected : null),
    assertTaskReadyForDelivery: async () => ({
      taskId: 7,
      copyRevisionId: 107,
      imageRunId: 'run-7',
    }),
    assertTasksReadyForDelivery: async (bindings) => bindings,
    getAsset: async () => asset,
  }, async (root, storageRoot) => {
    const imageDirectory = join(storageRoot, 'tasks', '7', 'image-runs', 'run-7');
    const storagePath = join(imageDirectory, '01.webp');
    await mkdir(imageDirectory, { recursive: true });
    const content = await sharp({
      create: {
        width: 30,
        height: 20,
        channels: 3,
        background: { r: 37, g: 99, b: 235 },
      },
    }).webp().toBuffer();
    await writeFile(storagePath, content);
    asset = {
      ...selected.assets[0],
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      storagePath,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${root}/v1/delivery-pool/xlsx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'SELECTED', taskIds: [7] }),
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.error.code, 'VALIDATION_ERROR');
      assert.match(payload.error.message, /仅支持 PNG、JPEG 或 GIF/u);
      assert.equal(payload.data, undefined);
    }

    assert.deepEqual(await readdir(join(storageRoot, '.delivery-exports')), []);
  });
});

test('all-ready spreadsheet export rejects more than 200 articles before loading tasks', async () => {
  let taskReads = 0;
  await withServer({
    listAllDeliveryPoolTaskIds: async () => Array.from({ length: 201 }, (_, index) => index + 1),
    getTask: async () => { taskReads += 1; },
  }, async (root) => {
    const response = await fetch(`${root}/v1/delivery-pool/xlsx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'ALL_READY' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'DELIVERY_SPREADSHEET_TOO_LARGE');
  });
  assert.equal(taskReads, 0);
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
