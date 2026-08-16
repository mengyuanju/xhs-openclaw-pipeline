import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';

describe('admin prompt versions', () => {
  it('seeds all prompt kinds and publishes a new immutable version', () => {
    const store = createAdminStore(':memory:');
    try {
      const templates = store.listPromptTemplates();
      assert.deepEqual(
        templates.map((template) => template.kind).sort(),
        ['IMAGE_EDIT_SYSTEM', 'IMAGE_SYSTEM', 'TEXT_SYSTEM'],
      );

      const textTemplate = templates.find((template) => template.kind === 'TEXT_SYSTEM');
      const original = textTemplate.versions.find((version) => version.status === 'PUBLISHED');
      const draft = store.createPromptVersion({
        templateId: textTemplate.id,
        content: '围绕 {{query}} 写一篇面向 {{targetAudience}} 的内容。',
      });

      assert.equal(draft.status, 'DRAFT');
      assert.match(draft.contentSha256, /^[a-f0-9]{64}$/);

      const published = store.publishPromptVersion(draft.id);
      assert.equal(published.status, 'PUBLISHED');
      assert.equal(store.getPromptVersion(original.id).status, 'RETIRED');
      assert.throws(
        () => store.updatePromptVersion(published.id, { content: '覆盖已经发布的版本' }),
        /published prompt versions are immutable/i,
      );

      const rolledBack = store.publishPromptVersion(original.id);
      assert.equal(rolledBack.status, 'PUBLISHED');
      assert.equal(store.getPromptVersion(published.id).status, 'RETIRED');
    } finally {
      store.close();
    }
  });

  it('rejects unknown prompt variables before saving a version', () => {
    const store = createAdminStore(':memory:');
    try {
      const template = store.listPromptTemplates().find(({ kind }) => kind === 'TEXT_SYSTEM');
      assert.throws(
        () => store.createPromptVersion({ templateId: template.id, content: '泄漏 {{apiKey}}' }),
        /unknown prompt variable: apiKey/i,
      );
    } finally {
      store.close();
    }
  });
});

describe('admin import batches', () => {
  it('commits valid rows once and pins published prompt versions', () => {
    const store = createAdminStore(':memory:');
    try {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        rowNumber: index + 2,
        externalId: `row-${index + 1}`,
        query: `第 ${index + 1} 个选题`,
        input: { category: '收纳', targetAudience: '租房用户' },
        imageCount: 3,
        referenceImageFiles: [],
        errors: [],
      }));
      const batch = store.createImportBatch({
        name: '一千条选题',
        sourceFileName: 'queries.xlsx',
        rows,
      });

      assert.equal(batch.status, 'PREVIEW');
      assert.equal(batch.validRows, 1000);
      assert.equal(store.countTasks(), 0);

      const firstCommit = store.commitImportBatch(batch.id);
      const secondCommit = store.commitImportBatch(batch.id);
      assert.equal(firstCommit.createdTasks, 1000);
      assert.equal(firstCommit.wasAlreadyCommitted, false);
      assert.equal(secondCommit.createdTasks, 1000);
      assert.equal(secondCommit.wasAlreadyCommitted, true);
      assert.equal(store.countTasks(), 1000);

      const task = store.listTasks({ page: 1, pageSize: 1 }).data[0];
      assert.equal(task.config.imageCount, 3);
      assert.match(task.config.textPromptSha256, /^[a-f0-9]{64}$/);
      assert.match(task.config.imagePromptSha256, /^[a-f0-9]{64}$/);
    } finally {
      store.close();
    }
  });

  it('keeps invalid rows in staging but never creates tasks for them', () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '包含错误',
        sourceFileName: 'bad.xlsx',
        rows: [
          {
            rowNumber: 2,
            externalId: 'ok',
            query: '合法选题',
            input: {},
            imageCount: 3,
            referenceImageFiles: [],
            errors: [],
          },
          {
            rowNumber: 3,
            externalId: 'bad',
            query: '',
            input: {},
            imageCount: 8,
            referenceImageFiles: [],
            errors: ['query不能为空', 'imageCount必须为3到5'],
          },
        ],
      });

      assert.equal(batch.invalidRows, 1);
      assert.equal(store.commitImportBatch(batch.id).createdTasks, 1);
      assert.equal(store.countTasks(), 1);
    } finally {
      store.close();
    }
  });
});
