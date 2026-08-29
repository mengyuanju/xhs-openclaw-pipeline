import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createCheckpointFingerprint,
  createImageCheckpointRecord,
  loadPipelineCheckpoint,
  resolveReusableImageCheckpoints,
  savePipelineCheckpoint,
} from '../src/checkpoint.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('pipeline checkpoints', () => {
  it('loads only the exact task and pinned-config fingerprint', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'xhs-checkpoint-'));
    directories.push(outputRoot);
    const task = { id: 1, query: '桌面整理', input: { category: '收纳' } };
    const workerConfig = { imageCount: 3, textPromptContent: '规则 A' };
    const fingerprint = createCheckpointFingerprint({ task, workerConfig, mock: false });
    const research = {
      schemaVersion: 1,
      status: 'COMPLETED',
      query: '桌面整理',
      searchedAt: '2026-08-29T08:00:00.000Z',
      provider: 'duckduckgo',
      summary: null,
      attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
      sources: [{
        title: '整理来源',
        url: 'https://example.com/desk',
        snippet: '整理摘要',
        siteName: 'example.com',
        provider: 'duckduckgo',
        retrievedAt: '2026-08-29T08:00:00.000Z',
      }],
    };
    await savePipelineCheckpoint({
      outputRoot,
      taskId: task.id,
      fingerprint,
      research,
      post: { value: { title: '已生成正文' }, model: 'fake-text' },
      visualPlan: null,
    });

    const loaded = await loadPipelineCheckpoint({ outputRoot, taskId: task.id, fingerprint });
    assert.deepEqual(loaded.research, research);
    const checkpointPath = join(outputRoot, String(task.id), 'checkpoint.json');
    const previousSchema = JSON.parse(await readFile(checkpointPath, 'utf8'));
    previousSchema.schemaVersion = 4;
    await writeFile(checkpointPath, JSON.stringify(previousSchema));
    assert.equal(await loadPipelineCheckpoint({ outputRoot, taskId: task.id, fingerprint }), null);
    const changed = createCheckpointFingerprint({
      task,
      workerConfig: { ...workerConfig, textPromptContent: '规则 B' },
      mock: false,
    });
    assert.equal(await loadPipelineCheckpoint({ outputRoot, taskId: task.id, fingerprint: changed }), null);
  });

  it('refuses a checkpoint image after its file hash changes', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'xhs-image-checkpoint-'));
    directories.push(outputRoot);
    const outputDir = join(outputRoot, '1', 'attempt-1');
    await mkdir(outputDir, { recursive: true });
    const imagePath = join(outputDir, '01-hero.png');
    await writeFile(imagePath, 'original normalized image');
    const alignment = { passed: true, failureClass: 'PASS' };
    const record = await createImageCheckpointRecord({
      outputRoot,
      outputDir,
      taskId: 1,
      pageIndex: 1,
      visualPlanSha256: 'a'.repeat(64),
      image: {
        file: '01-hero.png',
        provider: 'openclaw',
        model: 'fake-image',
        generationAttempts: 1,
        alignment,
      },
    });
    const options = {
      outputRoot,
      taskId: 1,
      checkpoint: { images: [record] },
      visualPlanSha256: 'a'.repeat(64),
      imagePlan: [{ kind: 'hero' }],
    };

    const reusable = await resolveReusableImageCheckpoints(options);
    assert.equal(reusable[0].sourcePath, imagePath);
    await writeFile(imagePath, 'tampered image');
    assert.deepEqual(await resolveReusableImageCheckpoints(options), [null]);
  });

  it('keeps automatic manual-revision checkpoints stable when only the discarded image plan changes', () => {
    const task = { id: 9, query: '人工正文重跑', input: {} };
    const baseConfig = {
      imageCount: 5,
      imageCountMode: 'auto',
      currentTextRevisionId: 24,
      postOverride: {
        title: '人工标题',
        body: '人工正文保持不变。',
        tags: ['#人工正文'],
        imagePlan: [{ kind: 'hero', headline: '旧封面' }],
      },
    };
    const first = createCheckpointFingerprint({ task, workerConfig: baseConfig, mock: false });
    const second = createCheckpointFingerprint({
      task,
      workerConfig: {
        ...baseConfig,
        postOverride: {
          ...baseConfig.postOverride,
          imagePlan: [{ kind: 'hero', headline: '另一次自动分页结果' }],
        },
      },
      mock: false,
    });

    assert.equal(first, second);
  });
});
