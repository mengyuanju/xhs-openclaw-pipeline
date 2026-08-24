import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import {
  analyzeVisualImage,
  createVisualKnowledgeWithOptionalImage,
} from '../src/admin/visual-knowledge-service.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function imageBuffer() {
  return sharp({
    create: { width: 120, height: 160, channels: 3, background: '#d8c7b4' },
  }).png().toBuffer();
}

function analysisJson() {
  return JSON.stringify({
    name: '暖色生活感主图',
    type: 'PHOTO_HERO',
    generationTarget: 'MODEL_IMAGE',
    promptTemplate: '围绕 {{query}} 生成暖色自然光的真实生活场景，主体明确，适合 3:4 竖版裁切。',
    negativePrompt: '不要水印、Logo、乱码或虚构品牌。',
    styleTags: ['暖色', '生活感'],
    categories: ['收纳', '家居'],
    layoutRules: { composition: '主体居中，上方留白' },
    qualityScore: 4.5,
  });
}

function knowledgeInput(overrides = {}) {
  return {
    ...JSON.parse(analysisJson()),
    retentionMode: 'PROMPT_ONLY',
    rightsStatus: 'INTERNAL_ANALYSIS_ONLY',
    sourceImageSha256: 'a'.repeat(64),
    analysisModel: 'fake-vision-model',
    ...overrides,
  };
}

describe('visual image analysis', () => {
  it('validates, normalizes and deletes the temporary image after model analysis', async () => {
    let observedPath;
    const result = await analyzeVisualImage({
      buffer: await imageBuffer(),
      mimeType: 'image/png',
      fileName: '../untrusted.png',
      vision: {
        runVision({ inputPaths }) {
          [observedPath] = inputPaths;
          return { rawText: analysisJson(), model: 'fake-vision-model' };
        },
      },
    });

    assert.equal(result.analysis.type, 'PHOTO_HERO');
    assert.equal(result.analysis.analysisModel, 'fake-vision-model');
    assert.match(result.sourceImageSha256, /^[a-f0-9]{64}$/);
    await assert.rejects(() => access(observedPath), /ENOENT/);
  });

  it('rejects fake image content before calling the vision model', async () => {
    let called = false;
    await assert.rejects(() => analyzeVisualImage({
      buffer: Buffer.from('<script>alert(1)</script>'),
      mimeType: 'image/png',
      fileName: 'fake.png',
      vision: { runVision() { called = true; } },
    }), /could not be decoded/i);
    assert.equal(called, false);
  });
});

describe('visual knowledge image retention', () => {
  it('does not write image files for prompt-only knowledge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-knowledge-'));
    directories.push(root);
    const store = createAdminStore(':memory:');
    try {
      const created = await createVisualKnowledgeWithOptionalImage({
        store,
        knowledgeRoot: root,
        input: knowledgeInput(),
      });
      assert.equal(created.asset, null);
      assert.deepEqual(await readdir(root), []);
    } finally {
      store.close();
    }
  });

  it('stores a normalized PNG only for authorized retained-image knowledge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-knowledge-'));
    directories.push(root);
    const store = createAdminStore(':memory:');
    try {
      const created = await createVisualKnowledgeWithOptionalImage({
        store,
        knowledgeRoot: root,
        buffer: await imageBuffer(),
        mimeType: 'image/png',
        input: knowledgeInput({
          retentionMode: 'IMAGE_AND_PROMPT',
          rightsStatus: 'SELF_OWNED',
        }),
      });
      assert.equal(created.asset.mimeType, 'image/png');
      await access(join(root, created.asset.relativePath));
    } finally {
      store.close();
    }
  });
});
