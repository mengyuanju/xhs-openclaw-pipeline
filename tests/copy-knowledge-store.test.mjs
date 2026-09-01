import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';

function knowledgeInput(overrides = {}) {
  return {
    title: '把普通体验写成可复制的方法',
    sourceCopy: '这是一条待分析的优秀文案。',
    analysisPrompt: '分析开头、信息结构和行动引导。',
    summary: '用具体场景建立信任，再给出可执行步骤。',
    analysis: '开头先交代真实问题，中段拆成三个步骤，结尾降低行动门槛。',
    labels: ['方法型', '强开头', '方法型'],
    analysisModel: 'fake-text-model',
    ...overrides,
  };
}

describe('copy knowledge store', () => {
  it('stores one excellent-copy analysis under every normalized label', () => {
    const store = createAdminStore(':memory:');
    try {
      const created = store.createCopyKnowledge(knowledgeInput({
        labels: [' 方法型 ', '#强开头', '方法型'],
      }));

      assert.deepEqual(created.labels, ['方法型', '强开头']);
      assert.equal(store.listCopyKnowledge({ label: '方法型' }).pagination.totalItems, 1);
      assert.equal(store.listCopyKnowledge({ label: '#强开头' }).data[0].id, created.id);
      assert.deepEqual(store.listCopyKnowledgeLabels(), [
        { name: '强开头', itemCount: 1 },
        { name: '方法型', itemCount: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it('keeps shared labels as reusable categories with accurate item counts', () => {
    const store = createAdminStore(':memory:');
    try {
      store.createCopyKnowledge(knowledgeInput({ title: '第一条', labels: ['方法型', '清单'] }));
      store.createCopyKnowledge(knowledgeInput({ title: '第二条', labels: ['方法型', '故事'] }));

      assert.deepEqual(store.listCopyKnowledgeLabels(), [
        { name: '方法型', itemCount: 2 },
        { name: '故事', itemCount: 1 },
        { name: '清单', itemCount: 1 },
      ]);
      assert.equal(store.listCopyKnowledge({ label: '方法型' }).pagination.totalItems, 2);
      assert.equal(store.listCopyKnowledge({ label: '清单' }).data[0].title, '第一条');
    } finally {
      store.close();
    }
  });

  it('rejects entries without a usable classification label', () => {
    const store = createAdminStore(':memory:');
    try {
      assert.throws(
        () => store.createCopyKnowledge(knowledgeInput({ labels: [] })),
        /between 1 and 12 labels/i,
      );
      assert.throws(
        () => store.createCopyKnowledge(knowledgeInput({ labels: ['#', '   '] })),
        /label cannot be empty/i,
      );
    } finally {
      store.close();
    }
  });
});
