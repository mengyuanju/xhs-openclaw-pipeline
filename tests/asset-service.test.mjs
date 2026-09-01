import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { createImageRevision, saveUploadedImage } from '../src/admin/asset-service.mjs';

function createTask(store) {
  const batch = store.createImportBatch({
    name: '素材测试',
    sourceFileName: 'assets.xlsx',
    rows: [{
      rowNumber: 2,
      externalId: 'asset-1',
      query: '参考图测试',
      input: {},
      imageCount: 3,
      referenceImageFiles: [],
      screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
      errors: [],
    }],
  });
  store.commitImportBatch(batch.id);
  return store.listTasks({ pageSize: 1 }).data[0];
}

describe('admin asset service', () => {
  it('decodes and stores an uploaded reference image under a generated safe path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-assets-'));
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      const buffer = await sharp({
        create: { width: 120, height: 160, channels: 3, background: '#d8c7b4' },
      }).png().toBuffer();

      const asset = await saveUploadedImage({
        store,
        taskId: task.id,
        buffer,
        fileName: '../不能作为路径.png',
        mimeType: 'image/png',
        uploadRoot: root,
      });

      assert.equal(asset.kind, 'REFERENCE');
      assert.equal(asset.width, 120);
      assert.equal(asset.height, 160);
      assert.equal(relative(root, asset.absolutePath).startsWith('..'), false);
      assert.notEqual(asset.fileName, '../不能作为路径.png');
      assert.ok((await readFile(asset.absolutePath)).byteLength > 0);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a fake image even when its claimed MIME type is allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-assets-'));
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      await assert.rejects(
        () => saveUploadedImage({
          store,
          taskId: task.id,
          buffer: Buffer.from('<script>alert(1)</script>'),
          fileName: 'fake.png',
          mimeType: 'image/png',
          uploadRoot: root,
        }),
        /could not be decoded/i,
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a child image revision without overwriting its parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-assets-'));
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      const buffer = await sharp({
        create: { width: 120, height: 160, channels: 3, background: '#6f8f72' },
      }).png().toBuffer();
      const parent = await saveUploadedImage({
        store,
        taskId: task.id,
        buffer,
        fileName: 'reference.png',
        mimeType: 'image/png',
        uploadRoot: root,
      });
      const parentBefore = await readFile(parent.absolutePath);

      const child = await createImageRevision({
        store,
        taskId: task.id,
        assetId: parent.id,
        operation: { type: 'rotate', degrees: 90 },
        uploadRoot: root,
      });

      assert.equal(child.parentAssetId, parent.id);
      assert.equal(child.kind, 'EDITED');
      assert.equal(child.width, 160);
      assert.equal(child.height, 120);
      assert.deepEqual(await readFile(parent.absolutePath), parentBefore);
      assert.equal(store.getTask(task.id).assets.length, 2);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes a 3:4 crop revision to the delivery resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-assets-'));
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      const buffer = await sharp({
        create: { width: 800, height: 800, channels: 3, background: '#6f8f72' },
      }).png().toBuffer();
      const parent = await saveUploadedImage({
        store,
        taskId: task.id,
        buffer,
        fileName: 'square.png',
        mimeType: 'image/png',
        uploadRoot: root,
      });

      const child = await createImageRevision({
        store,
        taskId: task.id,
        assetId: parent.id,
        operation: { type: 'crop-3x4' },
        uploadRoot: root,
      });

      assert.deepEqual([child.width, child.height], [1086, 1448]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
