import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { createAdminWorkerIntegration } from '../src/admin/worker-service.mjs';
import { processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('admin worker integration', () => {
  it('syncs a failed delivery as an unverified read-only preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-admin-failed-preview-'));
    directories.push(directory);
    const databasePath = join(directory, 'queue.db');
    const assetRoot = join(directory, 'assets');
    const outputDir = join(directory, 'output', '1', 'attempt-1');
    const store = createAdminStore(databasePath);
    try {
      const batch = store.createImportBatch({
        name: '失败预览',
        sourceFileName: 'failed-preview.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'failed-preview-1',
          query: '保留失败图片预览',
          input: { category: '测试' },
          imageCount: 3,
          referenceImageFiles: [],
          screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const integration = createAdminWorkerIntegration({ store, assetRoot });
      const post = {
        title: '失败也保留预览',
        body: '这是一份未通过质量门禁但应当保留给人工查看的生成结果。',
        tags: ['#失败预览'],
      };
      const visualPlan = { schemaVersion: 1, pages: [] };
      const imageBuffer = await sharp({
        create: { width: 1080, height: 1440, channels: 3, background: '#d9e5e8' },
      }).png().toBuffer();
      const images = Array.from({ length: 3 }, (_, index) => ({
        file: `0${index + 1}-preview.png`,
        provider: 'openclaw-image-edit',
        alignment: { passed: false, failureClass: 'STYLE_LAYOUT', ocrConfidence: 0.99 },
      }));
      const qc = { overallScore: 1, disposition: 'blocked' };
      const researchSnapshot = {
        schemaVersion: 1,
        status: 'COMPLETED',
        query: '保留失败图片预览',
        searchedAt: '2026-08-29T08:00:00.000Z',
        provider: 'duckduckgo',
        summary: null,
        attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
        sources: [{
          title: '失败预览来源',
          url: 'https://example.com/failed-preview',
          snippet: '来源摘要',
          siteName: 'example.com',
          provider: 'duckduckgo',
          retrievedAt: '2026-08-29T08:00:00.000Z',
        }],
      };
      const stageReviews = {
        query: {
          schemaVersion: 1,
          stage: 'QUERY',
          decision: 'PASS',
          summary: 'Query 可以继续。',
          issues: [],
          source: 'OPENCLAW',
          model: 'fake-review',
          reviewedAt: '2026-08-31T08:00:00.000Z',
          subjectSha256: 'a'.repeat(64),
        },
        text: null,
      };
      await mkdir(outputDir, { recursive: true });
      await Promise.all([
        writeFile(join(outputDir, 'post.json'), JSON.stringify(post)),
        writeFile(join(outputDir, 'visual-plan.json'), JSON.stringify(visualPlan)),
        writeFile(join(outputDir, 'qc.json'), JSON.stringify(qc)),
        ...images.map((image) => writeFile(join(outputDir, image.file), imageBuffer)),
      ]);
      await writeFile(join(outputDir, 'manifest.json'), JSON.stringify({ images, imageCount: 3 }));

      await integration.onFailed({
        task: { ...task, attempts: 1 },
        outputDir,
        mode: 'live',
        error: new Error('质量门禁未通过'),
        researchSnapshot,
        stageReviews,
      });

      const detail = store.getTask(task.id);
      const previews = detail.assets.filter((asset) => asset.kind === 'GENERATED');
      assert.equal(detail.currentTextRevision.title, post.title);
      assert.equal(detail.config.reviewStatus, 'WAITING_REVIEW');
      assert.equal(previews.length, 3);
      assert.ok(previews.every((asset) => asset.alignmentStatus === 'UNVERIFIED'));
      assert.equal(detail.generationRuns.at(-1).status, 'FAILED');
      assert.equal(detail.generationRuns.at(-1).qcDisposition, 'blocked');
      assert.deepEqual(detail.generationRuns.at(-1).researchSnapshot, researchSnapshot);
      assert.deepEqual(detail.generationRuns.at(-1).stageReviews, stageReviews);
      const retryConfig = await integration.getTaskConfig({ id: task.id });
      assert.equal(retryConfig.currentTextRevisionId, null);
      assert.equal(retryConfig.postOverride, null);

      const secondOutputDir = join(directory, 'output', '1', 'attempt-2');
      const secondPost = { ...post, title: '第二次失败预览' };
      await mkdir(secondOutputDir, { recursive: true });
      await Promise.all([
        writeFile(join(secondOutputDir, 'post.json'), JSON.stringify(secondPost)),
        writeFile(join(secondOutputDir, 'visual-plan.json'), JSON.stringify(visualPlan)),
        writeFile(join(secondOutputDir, 'qc.json'), JSON.stringify(qc)),
        ...images.map((image) => writeFile(join(secondOutputDir, image.file), imageBuffer)),
      ]);
      await writeFile(join(secondOutputDir, 'manifest.json'), JSON.stringify({ images, imageCount: 3 }));

      await integration.onFailed({
        task: { ...task, attempts: 2 },
        outputDir: secondOutputDir,
        mode: 'live',
        error: new Error('第二次质量门禁未通过'),
      });

      const retained = store.getTask(task.id);
      assert.equal(retained.generationRuns.length, 2);
      assert.equal(retained.assets.filter((asset) => asset.kind === 'GENERATED').length, 3);
      assert.ok(retained.assets.every(
        (asset) => asset.sourceTextRevisionId === retained.currentTextRevision.id,
      ));
      for (const image of images) {
        await assert.rejects(access(join(outputDir, image.file)), { code: 'ENOENT' });
        await access(join(secondOutputDir, image.file));
      }
      await access(join(outputDir, 'post.json'));
    } finally {
      store.close();
    }
  });

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
          screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const integration = createAdminWorkerIntegration({ store, assetRoot });
      const initialConfig = await integration.getTaskConfig(task);
      assert.equal(initialConfig.imageCountMode, 'auto');

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
      const generatedAssets = detail.assets.filter((asset) => asset.kind === 'GENERATED');
      assert.equal(generatedAssets.length, 5);
      assert.ok(generatedAssets.every((asset) => asset.sourceTextRevisionId === detail.currentTextRevision.id));
      assert.deepEqual(generatedAssets.map((asset) => asset.pageIndex), [1, 2, 3, 4, 5]);
      assert.ok(generatedAssets.every((asset) => asset.alignmentStatus === 'UNVERIFIED'));
      assert.ok(generatedAssets.every((asset) => /^[a-f0-9]{64}$/.test(asset.visualPlanSha256)));
      assert.equal(detail.generationRuns[0].qcDisposition, 'mock_only');
      assert.equal(detail.generationRuns[0].visualPlan.pages.length, 5);
      assert.equal(detail.generationRuns[0].stageReviews.query.source, 'MOCK');
      assert.equal(detail.generationRuns[0].stageReviews.text.source, 'MOCK');
      assert.throws(
        () => store.setReviewStatus(task.id, { status: 'APPROVED', note: '不应通过 Mock' }),
        /mock_only/i,
      );
      for (const asset of detail.assets) await access(join(assetRoot, asset.relativePath));
      const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.images.length, 5);
      for (const [index, asset] of generatedAssets.entries()) {
        const [outputStat, assetStat] = await Promise.all([
          stat(join(result.outputDir, manifest.images[index].file)),
          stat(join(assetRoot, asset.relativePath)),
        ]);
        assert.equal(outputStat.dev, assetStat.dev);
        assert.equal(outputStat.ino, assetStat.ino);
      }

      const manualRevision = store.addTextRevision(task.id, {
        title: '人工定稿后的桌面整理',
        body: '这是人工定稿后的正文，需要复用既有页面职责重新规划和生成全部图片。',
        tags: ['#桌面整理'],
        source: 'MANUAL',
      });
      const requeued = store.getTask(task.id);
      assert.equal(requeued.status, 'pending');
      assert.ok(requeued.assets.filter((asset) => asset.kind === 'GENERATED')
        .every((asset) => asset.alignmentStatus === 'STALE'));
      const incompleteOutputDir = join(outputRoot, String(task.id), 'attempt-2');
      await mkdir(incompleteOutputDir, { recursive: true });
      store.addGenerationRun({
        taskId: task.id,
        attempt: 2,
        mode: 'live',
        status: 'FAILED',
        outputDir: incompleteOutputDir,
        error: '图片分页规划在 post.json 写入前失败',
      });
      const regenerationConfig = await integration.getTaskConfig({ id: task.id });
      assert.equal(regenerationConfig.currentTextRevisionId, manualRevision.id);
      assert.equal(regenerationConfig.postOverride.title, '人工定稿后的桌面整理');
      assert.match(regenerationConfig.postOverride.body, /人工定稿后的正文/);
    } finally {
      queue.close();
      store.close();
    }
  });
});
