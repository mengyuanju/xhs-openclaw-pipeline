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

  it('updates saved analysis content and label links without replacing its metadata', () => {
    const store = createAdminStore(':memory:');
    try {
      const created = store.createCopyKnowledge(knowledgeInput({
        labels: ['方法型', '强开头'],
      }));

      const updated = store.updateCopyKnowledge(created.id, {
        title: '修改后的分析标题',
        sourceCopy: '这是修改后的优秀文案。',
        analysisPrompt: '改为分析叙事节奏与转化路径。',
        summary: '修改后的摘要。',
        analysis: '修改后的完整分析。',
        labels: ['故事型', '#强结尾', '故事型'],
      });

      assert.equal(updated.id, created.id);
      assert.equal(updated.title, '修改后的分析标题');
      assert.equal(updated.sourceCopy, '这是修改后的优秀文案。');
      assert.equal(updated.analysisModel, 'fake-text-model');
      assert.equal(updated.createdAt, created.createdAt);
      assert.deepEqual(updated.labels, ['故事型', '强结尾']);
      assert.equal(store.listCopyKnowledge({ label: '方法型' }).pagination.totalItems, 0);
      assert.equal(store.listCopyKnowledge({ label: '故事型' }).data[0].id, created.id);
      assert.deepEqual(store.listCopyKnowledgeLabels(), [
        { name: '强结尾', itemCount: 1 },
        { name: '故事型', itemCount: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it('returns null when updating a copy knowledge item that does not exist', () => {
    const store = createAdminStore(':memory:');
    try {
      assert.equal(store.updateCopyKnowledge(999, knowledgeInput()), null);
    } finally {
      store.close();
    }
  });

  it('deletes a saved analysis and removes it from reusable label counts', () => {
    const store = createAdminStore(':memory:');
    try {
      const created = store.createCopyKnowledge(knowledgeInput({ labels: ['方法型', '清单'] }));

      assert.equal(store.deleteCopyKnowledge(created.id), true);
      assert.equal(store.deleteCopyKnowledge(created.id), false);
      assert.equal(store.listCopyKnowledge().pagination.totalItems, 0);
      assert.deepEqual(store.listCopyKnowledgeLabels(), []);
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
