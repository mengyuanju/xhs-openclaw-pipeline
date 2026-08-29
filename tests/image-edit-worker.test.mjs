import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { saveUploadedImage } from '../src/admin/asset-service.mjs';
import { processNextImageEdit } from '../src/admin/image-edit-worker.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { createMockVisualPlan } from '../src/visual-plan.mjs';

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
        rows: [{
          rowNumber: 2,
          externalId: 'edit-1',
          query: '桌面图片',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
          errors: [],
        }],
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

  it('revalidates a live AI edit against the source text revision and page contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-image-edit-live-'));
    directories.push(directory);
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '图片编辑验收', sourceFileName: 'edit-live.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'edit-live-1',
          query: '桌面图片',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      store.updateProductionSettings({ aiDisclosureEnabled: false });
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const post = createMockPost(3);
      const visualPlan = createMockVisualPlan(post, { imageCount: 3 });
      const outputDir = join(directory, 'output', '1', 'attempt-1');
      await mkdir(outputDir, { recursive: true });
      await Promise.all([
        writeFile(join(outputDir, 'post.json'), JSON.stringify(post)),
        writeFile(join(outputDir, 'visual-plan.json'), JSON.stringify(visualPlan)),
      ]);
      store.addGenerationRun({
        taskId: task.id,
        attempt: 1,
        mode: 'live',
        status: 'COMPLETED',
        outputDir,
        qc: { overallScore: 2, disposition: 'manual_review_required' },
      });
      const revision = store.addTextRevision(task.id, {
        title: post.title,
        body: post.body,
        tags: post.tags,
        source: 'GENERATED',
      });
      const sourcePath = join(directory, 'generated', 'source.png');
      await mkdir(join(directory, 'generated'), { recursive: true });
      const imageBuffer = await sharp({
        create: { width: 1080, height: 1440, channels: 3, background: '#d8c7b3' },
      }).png().toBuffer();
      await writeFile(sourcePath, imageBuffer);
      const visualPlanSha256 = 'd'.repeat(64);
      const source = store.addAsset({
        taskId: task.id,
        kind: 'GENERATED',
        fileName: 'source.png',
        relativePath: 'generated/source.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'e'.repeat(64),
        source: 'live:openclaw',
        sourceTextRevisionId: revision.id,
        pageIndex: 1,
        visualPlanSha256,
        alignmentStatus: 'PASSED',
        alignmentResult: { passed: true },
      });
      store.createImageEditRequest(task.id, {
        sourceAssetId: source.id,
        instruction: '保留桌面主体，让背景更简洁',
      });
      const passingAlignment = {
        schemaVersion: 1,
        subjectMatched: true,
        sceneMatched: true,
        headlineMatched: true,
        bulletCoverage: 1,
        styleMatched: true,
        layoutMatched: true,
        contradictions: [],
        extraClaims: [],
        textErrors: [],
        recognizedText: {
          headline: visualPlan.pages[0].allowedVisibleText.headline,
          subtitle: visualPlan.pages[0].allowedVisibleText.subtitle,
          bullets: visualPlan.pages[0].allowedVisibleText.bullets,
          otherText: [],
        },
        unreadableText: [],
        hasTraditionalChinese: false,
        ocrConfidence: 0.98,
        failureClass: 'PASS',
        repairInstruction: '',
      };

      const result = await processNextImageEdit({
        store,
        assetRoot: directory,
        workerId: 'edit-live-worker',
        mock: false,
        openclaw: {
          runImageEdit({ outputPath }) {
            writeFileSync(outputPath, imageBuffer);
            return { outputPath, model: 'fake-image' };
          },
          runVision() {
            return { rawText: JSON.stringify(passingAlignment), model: 'fake-vision' };
          },
        },
      });

      assert.equal(result.status, 'completed');
      const edited = store.getAsset(result.assetId);
      assert.equal(edited.sourceTextRevisionId, revision.id);
      assert.equal(edited.pageIndex, 1);
      assert.equal(edited.alignmentStatus, 'PASSED');
      assert.equal(edited.alignmentResult.model, 'fake-vision');
    } finally {
      store.close();
    }
  });
});
