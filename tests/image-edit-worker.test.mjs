import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { saveUploadedImage } from '../src/admin/asset-service.mjs';
import { processNextImageEdit } from '../src/admin/image-edit-worker.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('image edit worker', () => {
  it('processes a queued mock edit into a child asset and preserves the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-image-edit-worker-'));
    directories.push(directory);
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '图片编辑', sourceFileName: 'edit.xlsx',
        rows: [{ rowNumber: 2, externalId: 'edit-1', query: '桌面图片', input: {}, imageCount: 3, referenceImageFiles: [], errors: [] }],
      });
      store.commitImportBatch(batch.id);
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const buffer = await sharp({
        create: { width: 600, height: 800, channels: 3, background: '#d8c7b3' },
      }).png().toBuffer();
      const source = await saveUploadedImage({
        store, taskId: task.id, buffer, fileName: 'source.png', mimeType: 'image/png', uploadRoot: directory,
      });
      store.createImageEditRequest(task.id, {
        sourceAssetId: source.id,
        instruction: '保留桌面主体，让背景更简洁',
      });

      const result = await processNextImageEdit({
        store, assetRoot: directory, workerId: 'edit-worker', mock: true,
      });

      assert.equal(result.status, 'completed');
      const detail = store.getTask(task.id);
      const request = detail.imageEditRequests[0];
      assert.equal(request.status, 'COMPLETED');
      assert.equal(detail.assets.find((asset) => asset.id === request.resultAssetId).parentAssetId, source.id);
      assert.equal(store.getAsset(source.id).kind, 'REFERENCE');
    } finally { store.close(); }
  });
});
