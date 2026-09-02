import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  createImageGenerationDraft,
  readImageGenerationDraft,
  writeImageGenerationDraft,
} from '../app/image-generation/image-generation-draft.ts';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function memoryStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set('xhs:image-generation-draft:v1', initialValue);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

const imagePlan = [
  {
    kind: 'hero',
    headline: '桌面整理前后',
    subtitle: '低成本也能变清爽',
    bullets: ['先清空', '再分区'],
    prompt: '俯拍整洁的租房书桌，展示收纳前后对比',
  },
  {
    kind: 'steps',
    headline: '三步完成整理',
    subtitle: '按使用频率摆放',
    bullets: ['高频放手边', '低频收入盒中'],
    prompt: '三步整理流程信息图，清晰标出物品区域',
  },
  {
    kind: 'summary',
    headline: '今天就能照着做',
    subtitle: '先从一个抽屉开始',
    bullets: ['控制预算', '保持顺手'],
    prompt: '整理完成后的桌面和简洁总结文字',
  },
];

describe('copy-to-image draft transfer', () => {
  it('round-trips a reviewed copy and image plan through session storage', () => {
    const storage = memoryStorage();
    const draft = createImageGenerationDraft({
      query: '租房桌面怎么低成本整理？',
      copy: {
        title: '租房桌面低成本整理法',
        body: '这是用于验证直接导入图片模块的完整正文。'.repeat(15),
        tags: ['#桌面整理', '#租房生活', '#低成本收纳'],
      },
      imagePlan,
    });

    writeImageGenerationDraft(storage, draft);

    assert.deepEqual(readImageGenerationDraft(storage), draft);
  });

  it('rejects malformed or outdated browser data instead of filling the image form', () => {
    const malformed = memoryStorage('{"version":2,"query":"tampered"}');

    assert.equal(readImageGenerationDraft(malformed), null);
  });

  it('uses the image API limits when validating untrusted browser drafts', () => {
    const draft = createImageGenerationDraft({
      query: '租房桌面怎么低成本整理？',
      copy: {
        title: '租房桌面低成本整理法',
        body: '这是用于验证直接导入图片模块的完整正文。'.repeat(15),
        tags: ['#桌面整理', '#租房生活', '#低成本收纳'],
      },
      imagePlan,
    });
    const invalidTags = memoryStorage(JSON.stringify({
      ...draft,
      copy: { ...draft.copy, tags: ['桌面整理', '#租房生活', '#低成本收纳'] },
    }));

    assert.equal(readImageGenerationDraft(invalidTags), null);
  });

  it('refuses to create a transferable draft when the copy cannot satisfy the image form', () => {
    assert.throws(() => createImageGenerationDraft({
      query: '无效短文案',
      copy: {
        title: '无效短文案',
        body: '正文不足二百字',
        tags: ['#一个标签'],
      },
      imagePlan,
    }), /不能导入图片生成/u);
  });

  it('adds a reviewed copy import action and auto-fills controlled image inputs', async () => {
    const [comparison, workbench] = await Promise.all([
      source('app/copy-generation/copy-generation-comparison.tsx'),
      source('app/image-generation/image-generation-workbench.tsx'),
    ]);

    assert.match(comparison, /导入\{activeVersionLabel\}到图片生成/u);
    assert.match(comparison, /result\.reviewed\.copy/u);
    assert.match(comparison, /result\.reviewed\.imagePlan/u);
    assert.match(comparison, /writeImageGenerationDraft\(window\.sessionStorage/u);
    assert.match(comparison, /router\.push\('\/image-generation'\)/u);

    assert.match(workbench, /readImageGenerationDraft\(window\.sessionStorage\)/u);
    assert.match(workbench, /已从“单独生成文案”导入当前版本/u);
    assert.match(workbench, /value=\{form\.query\}/u);
    assert.match(workbench, /value=\{form\.title\}/u);
    assert.match(workbench, /value=\{form\.body\}/u);
    assert.match(workbench, /value=\{form\.tags\}/u);
    assert.match(workbench, /value=\{form\.imagePlan\}/u);
  });
});
