import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { composeVisualImagePrompt } from '../src/admin/visual-knowledge-store.mjs';

function createTask(store, input = { category: '收纳', targetAudience: '租房用户' }) {
  const batch = store.createImportBatch({
    name: '视觉知识测试',
    sourceFileName: 'visual.xlsx',
    rows: [{
      rowNumber: 2,
      externalId: 'visual-1',
      query: '低成本整理卧室桌面',
      input,
      imageCount: 3,
      referenceImageFiles: [],
      screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
      errors: [],
    }],
  });
  store.commitImportBatch(batch.id);
  return store.listTasks({ pageSize: 1 }).data[0];
}

function promptOnlyInput(overrides = {}) {
  return {
    name: '暖色生活感主图',
    type: 'PHOTO_HERO',
    generationTarget: 'MODEL_IMAGE',
    retentionMode: 'PROMPT_ONLY',
    rightsStatus: 'INTERNAL_ANALYSIS_ONLY',
    sourceImageSha256: 'a'.repeat(64),
    promptTemplate: '围绕 {{query}} 生成暖色自然光的真实生活场景，主体明确，适合小红书 3:4 竖版裁切。',
    negativePrompt: '不要水印、Logo、乱码或虚构品牌。',
    styleTags: ['暖色', '生活感'],
    categories: ['收纳', '家居'],
    layoutRules: { composition: '主体居中，上方留白' },
    qualityScore: 4.6,
    analysisModel: 'fake-vision-model',
    ...overrides,
  };
}

describe('visual knowledge store', () => {
  it('stores prompt-only knowledge without an asset and publishes an immutable version', () => {
    const store = createAdminStore(':memory:');
    try {
      const created = store.createVisualKnowledge(promptOnlyInput());
      assert.equal(created.latestVersion.status, 'DRAFT');
      assert.equal(created.asset, null);
      assert.match(created.latestVersion.contentSha256, /^[a-f0-9]{64}$/);

      const published = store.publishVisualKnowledgeVersion(created.latestVersion.id);
      assert.equal(published.status, 'PUBLISHED');
      assert.throws(
        () => store.updateVisualKnowledgeVersion(published.id, { promptTemplate: '覆盖发布版本' }),
        /published visual knowledge versions are immutable/i,
      );

      const page = store.listVisualKnowledge({ status: 'PUBLISHED', pageSize: 10 });
      assert.equal(page.pagination.totalItems, 1);
      assert.equal(page.data[0].name, '暖色生活感主图');
    } finally {
      store.close();
    }
  });

  it('requires authorized rights and a validated asset for retained images', () => {
    const store = createAdminStore(':memory:');
    try {
      assert.throws(
        () => store.createVisualKnowledge(promptOnlyInput({ retentionMode: 'IMAGE_AND_PROMPT' })),
        /self-owned or licensed/i,
      );
      assert.throws(
        () => store.createVisualKnowledge(promptOnlyInput({
          retentionMode: 'IMAGE_AND_PROMPT',
          rightsStatus: 'SELF_OWNED',
        })),
        /asset is required/i,
      );

      const created = store.createVisualKnowledge(promptOnlyInput({
        retentionMode: 'IMAGE_AND_PROMPT',
        rightsStatus: 'LICENSED',
        asset: {
          fileName: 'reference.png',
          relativePath: 'references/reference.png',
          mimeType: 'image/png',
          width: 1080,
          height: 1440,
          sha256: 'b'.repeat(64),
        },
      }));
      assert.equal(created.asset.mimeType, 'image/png');
    } finally {
      store.close();
    }
  });

  it('matches only published model-image recipes and pins the first selection for retries', () => {
    const store = createAdminStore(':memory:');
    try {
      const task = createTask(store);
      const first = store.createVisualKnowledge(promptOnlyInput({ qualityScore: 4.2 }));
      store.publishVisualKnowledgeVersion(first.latestVersion.id);

      const locked = store.resolveVisualReferenceForTask(task.id);
      assert.equal(locked.versionId, first.latestVersion.id);
      assert.equal(locked.type, 'PHOTO_HERO');

      const better = store.createVisualKnowledge(promptOnlyInput({
        name: '后来发布的高分配方',
        qualityScore: 5,
      }));
      store.publishVisualKnowledgeVersion(better.latestVersion.id);

      const retryReference = store.resolveVisualReferenceForTask(task.id);
      assert.equal(retryReference.versionId, first.latestVersion.id);
      assert.equal(store.getTaskVisualReference(task.id).versionId, first.latestVersion.id);
    } finally {
      store.close();
    }
  });

  it('composes global rules, a rendered recipe, negative constraints and task content', () => {
    const prompt = composeVisualImagePrompt({
      systemPrompt: '保持 3:4 竖版构图。',
      visualReference: {
        promptTemplate: '围绕 {{query}} 使用 {{category}} 场景。',
        negativePrompt: '不要水印。',
      },
      variables: { query: '桌面整理', category: '收纳' },
      taskPrompt: '木质桌面和暖色自然光。',
    });

    assert.match(prompt, /保持 3:4 竖版构图/);
    assert.match(prompt, /围绕 桌面整理 使用 收纳 场景/);
    assert.match(prompt, /不要水印/);
    assert.match(prompt, /木质桌面和暖色自然光/);
  });

  it('treats SQL wildcard characters as literal knowledge search text', () => {
    const store = createAdminStore(':memory:');
    try {
      store.createVisualKnowledge(promptOnlyInput({ name: '100% 可复用主图' }));
      assert.equal(store.listVisualKnowledge({ query: '%' }).data[0].name, '100% 可复用主图');
      assert.equal(store.listVisualKnowledge({ query: '_' }).pagination.totalItems, 0);
    } finally {
      store.close();
    }
  });

  it('accepts a long global image rule when the final composed prompt stays within 3000 characters', () => {
    const prompt = composeVisualImagePrompt({
      systemPrompt: '全局规则'.repeat(550),
      taskPrompt: '真实生活场景主图，主体居中。',
    });
    assert.ok(prompt.length < 3_000);
  });
});
