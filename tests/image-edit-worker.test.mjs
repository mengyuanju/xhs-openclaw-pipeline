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
import { createPromptRuntime } from '../src/prompt-runtime.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('image edit worker', () => {
  it('keeps governed model pixels unchanged and marks missing image text as failed instead of overlaying it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-governed-image-edit-'));
    directories.push(directory);
    const previousOutput = join(directory, 'previous');
    await mkdir(previousOutput, { recursive: true });
    const post = createMockPost(3);
    const visualPlan = createMockVisualPlan(post);
    await writeFile(join(previousOutput, 'post.json'), JSON.stringify(post));
    await writeFile(join(previousOutput, 'visual-plan.json'), JSON.stringify(visualPlan));
    const modelImage = await sharp({ create: { width: 1086, height: 1448, channels: 3, background: '#89abcd' } }).png().toBuffer();
    await writeFile(join(directory, 'source.png'), modelImage);
    const expectedPixels = await sharp(modelImage).raw().toBuffer();
    const runtime = createPromptRuntime({ prompts: {
      IMAGE_EDIT_SYSTEM: { content: '人工图片编辑规则：执行 {{reviewInstruction}}，保留未请求修改的元素。', versionId: 1 },
      IMAGE_ALIGNMENT_SYSTEM: { content: '照实识别所有文字，不补字；无文字就返回空。', versionId: 2 },
    } });
    let storedAsset;
    let completed = 0;
    let visionCalls = 0;
    const store = {
      claimNextImageEdit() { return { id: 1, taskId: 1, sourceAssetId: 1, instruction: '简化背景' }; },
      getAsset() { return { id: 1, relativePath: 'source.png', sourceTextRevisionId: 1, pageIndex: 1, visualPlanSha256: 'a'.repeat(64) }; },
      getWorkerConfig() { return { query: '桌面整理', input: {}, imageCount: 3, promptRuntime: runtime,
        productionSettings: { aiDisclosureEnabled: false } }; },
      getTask() { return { generationRuns: [{ outputDir: previousOutput }] }; },
      addAsset(asset) { storedAsset = { ...asset, id: 2 }; return storedAsset; },
      completeImageEdit() { completed += 1; },
      failImageEdit(_id, { error }) { assert.fail(error.message); },
    };
    const result = await processNextImageEdit({ store, assetRoot: directory, outputRoot: join(directory, 'output'),
      workerId: 'governed-edit-worker', mock: false, openclaw: {
        runImageEdit({ prompt, outputPath }) {
          assert.match(prompt, /<trusted_business_rules kind="IMAGE_EDIT_SYSTEM">/u);
          assert.match(prompt, /执行 简化背景/u);
          writeFileSync(outputPath, modelImage);
          return { outputPath, model: 'fake-image' };
        },
        async runVision({ prompt, inputPaths }) {
          visionCalls += 1;
          assert.match(prompt, /<trusted_business_rules kind="IMAGE_ALIGNMENT_SYSTEM">/u);
          assert.deepEqual(await sharp(inputPaths[0]).raw().toBuffer(), expectedPixels,
            'no deterministic text layer may alter the native model output in governed mode');
          return { rawText: JSON.stringify({ schemaVersion: 1, subjectMatched: true, sceneMatched: true,
            headlineMatched: false, bulletCoverage: 0, styleMatched: true, layoutMatched: true,
            contradictions: [], extraClaims: [], textErrors: [],
            recognizedText: { headline: '', subtitle: '', bullets: [], otherText: [] },
            unreadableText: [], hasTraditionalChinese: false, ocrConfidence: 0.99,
            failureClass: 'PASS', repairInstruction: '' }), model: 'fake-vision' };
        },
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(completed, 1);
    assert.equal(visionCalls, 1);
    assert.equal(storedAsset.alignmentStatus, 'FAILED');
    assert.equal(storedAsset.alignmentResult.passed, false);
    assert.equal(storedAsset.alignmentResult.modelAssessment.failureClass, 'PASS');
    assert.equal(storedAsset.alignmentResult.failureClass, 'OCR_MISMATCH');
    assert.deepEqual(await sharp(join(directory, storedAsset.relativePath)).raw().toBuffer(), expectedPixels);
  });

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
      const edited = detail.assets.find((asset) => asset.id === request.resultAssetId);
      assert.equal(edited.parentAssetId, source.id);
      assert.deepEqual([edited.width, edited.height], [1086, 1448]);
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
      assert.deepEqual([edited.width, edited.height], [1086, 1448]);
      assert.equal(edited.alignmentStatus, 'PASSED');
      assert.equal(edited.alignmentResult.model, 'fake-vision');
    } finally {
      store.close();
    }
  });
});
