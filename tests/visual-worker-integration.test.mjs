import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { createAdminWorkerIntegration } from '../src/admin/worker-service.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createTask(store) {
  const batch = store.createImportBatch({
    name: '视觉 Worker 测试',
    sourceFileName: 'visual-worker.xlsx',
    rows: [{
      rowNumber: 2,
      externalId: 'visual-worker-1',
      query: '低成本整理卧室桌面',
      input: { category: '收纳', targetAudience: '租房用户' },
      imageCount: 3,
      referenceImageFiles: [],
      errors: [],
    }],
  });
  store.commitImportBatch(batch.id);
  return store.listTasks({ pageSize: 1 }).data[0];
}

describe('visual knowledge worker adapter', () => {
  it('locks a published recipe and resolves its authorized image under the knowledge root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-visual-worker-'));
    directories.push(root);
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      const item = store.createVisualKnowledge({
        name: '授权暖色主图',
        type: 'PHOTO_HERO',
        generationTarget: 'MODEL_IMAGE',
        retentionMode: 'IMAGE_AND_PROMPT',
        rightsStatus: 'SELF_OWNED',
        sourceImageSha256: 'a'.repeat(64),
        promptTemplate: '围绕 {{query}} 生成适合 {{targetAudience}} 的暖色生活场景。',
        negativePrompt: '不要水印。',
        styleTags: ['暖色'],
        categories: ['收纳'],
        layoutRules: {},
        qualityScore: 4.8,
        analysisModel: 'fake-vision',
        asset: {
          fileName: 'reference.png',
          relativePath: 'references/reference.png',
          mimeType: 'image/png',
          width: 1080,
          height: 1440,
          sha256: 'b'.repeat(64),
        },
      });
      store.publishVisualKnowledgeVersion(item.latestVersion.id);

      const integration = createAdminWorkerIntegration({
        store,
        assetRoot: join(root, 'assets'),
        knowledgeRoot: join(root, 'knowledge'),
      });
      const config = integration.getTaskConfig(task);

      assert.equal(config.visualReference.versionId, item.latestVersion.id);
      assert.match(config.visualReference.promptTemplate, /\{\{query\}\}/);
      assert.deepEqual(config.visualReferenceImagePaths, [
        join(root, 'knowledge', 'references', 'reference.png'),
      ]);
      assert.equal(store.getTaskVisualReference(task.id).versionId, item.latestVersion.id);
    } finally {
      store.close();
    }
  });
});
