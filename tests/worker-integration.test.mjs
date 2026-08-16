import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { createAdminWorkerIntegration } from '../src/admin/worker-service.mjs';
import { processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('admin worker integration', () => {
  it('uses pinned config and syncs a five-image mock delivery into review history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-admin-worker-'));
    directories.push(directory);
    const databasePath = join(directory, 'queue.db');
    const outputRoot = join(directory, 'output');
    const assetRoot = join(directory, 'assets');
    const store = createAdminStore(databasePath);
    const queue = createQueue(databasePath);
    try {
      const batch = store.createImportBatch({
        name: 'Worker 集成',
        sourceFileName: 'worker.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'worker-1',
          query: '五张图的桌面整理内容',
          input: { category: '收纳', targetAudience: '租房用户' },
          imageCount: 5,
          referenceImageFiles: [],
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const integration = createAdminWorkerIntegration({ store, assetRoot });

      const result = await processNext({
        queue,
        workerId: 'admin-worker',
        outputRoot,
        mock: true,
        configProvider: integration.getTaskConfig,
        onCompleted: integration.onCompleted,
        onFailed: integration.onFailed,
      });

      assert.equal(result.status, 'completed');
      const detail = store.getTask(task.id);
      assert.equal(detail.config.reviewStatus, 'WAITING_REVIEW');
      assert.equal(detail.currentTextRevision.source, 'GENERATED');
      assert.equal(detail.assets.filter((asset) => asset.kind === 'GENERATED').length, 5);
      assert.equal(detail.generationRuns[0].qcDisposition, 'mock_only');
      assert.throws(
        () => store.setReviewStatus(task.id, { status: 'APPROVED', note: '不应通过 Mock' }),
        /mock_only/i,
      );
      for (const asset of detail.assets) await access(join(assetRoot, asset.relativePath));
      const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.images.length, 5);
    } finally {
      queue.close();
      store.close();
    }
  });
});
