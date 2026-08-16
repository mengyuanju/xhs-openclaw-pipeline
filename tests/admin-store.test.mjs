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

function createReviewTask(store) {
  const batch = store.createImportBatch({
    name: '审核测试',
    sourceFileName: 'review.xlsx',
    rows: [{
      rowNumber: 2,
      externalId: 'review-1',
      query: '卧室桌面整理',
      input: {},
      imageCount: 3,
      referenceImageFiles: [],
      errors: [],
    }],
  });
  store.commitImportBatch(batch.id);
  return store.listTasks({ page: 1, pageSize: 1 }).data[0];
}

describe('admin review revisions', () => {
  it('preserves text revisions and invalidates approval after a new edit', () => {
    const store = createAdminStore(':memory:');
    try {
      const task = createReviewTask(store);
      const generated = store.addTextRevision(task.id, {
        title: '桌面整理先做减法',
        body: '这是第一版正文。',
        tags: ['#桌面整理'],
        source: 'GENERATED',
      });
      const manual = store.addTextRevision(task.id, {
        title: '租房桌面整理，先做减法',
        body: '这是审核人员修改后的正文。',
        tags: ['#桌面整理', '#租房生活'],
        source: 'MANUAL',
      });

      assert.equal(manual.parentRevisionId, generated.id);
      assert.equal(store.getTask(task.id).textRevisions.length, 2);
      assert.equal(store.getTask(task.id).config.reviewStatus, 'WAITING_REVIEW');

      store.addAsset({
        taskId: task.id,
        kind: 'GENERATED',
        parentAssetId: null,
        fileName: '01-hero.png',
        relativePath: '1/attempt-1/01-hero.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'a'.repeat(64),
        source: 'mock',
      });
      store.setReviewStatus(task.id, { status: 'APPROVED', note: '可以交付' });
      assert.equal(store.getTask(task.id).config.reviewStatus, 'APPROVED');

      store.addTextRevision(task.id, {
        title: '租房桌面整理最终版',
        body: '通过后再次编辑，应自动回到待审核。',
        tags: ['#桌面整理'],
        source: 'MANUAL',
      });
      const detail = store.getTask(task.id);
      assert.equal(detail.config.reviewStatus, 'WAITING_REVIEW');
      assert.ok(detail.auditLogs.some((log) => log.action === 'REVIEW_APPROVE'));
      assert.ok(detail.auditLogs.some((log) => log.action === 'TEXT_REVISION_CREATE'));
    } finally {
      store.close();
    }
  });

  it('refuses approval until text and at least one delivery image exist', () => {
    const store = createAdminStore(':memory:');
    try {
      const task = createReviewTask(store);
      assert.throws(
        () => store.setReviewStatus(task.id, { status: 'APPROVED', note: '' }),
        /current text revision is required/i,
      );
      store.addTextRevision(task.id, {
        title: '桌面整理步骤',
        body: '正文',
        tags: [],
        source: 'GENERATED',
      });
      assert.throws(
        () => store.setReviewStatus(task.id, { status: 'APPROVED', note: '' }),
        /delivery image is required/i,
      );
    } finally {
      store.close();
    }
  });
});

describe('admin console queries', () => {
  it('lists import batches and task pages with stable filters', () => {
    const store = createAdminStore(':memory:');
    try {
      const firstTask = createReviewTask(store);
      const secondTask = createReviewTask(store);
      store.addTextRevision(secondTask.id, {
        title: '待审核内容',
        body: '正文',
        tags: [],
        source: 'GENERATED',
      });

      const batches = store.listImportBatches({ page: 1, pageSize: 1 });
      assert.equal(batches.data.length, 1);
      assert.equal(batches.pagination.totalItems, 2);
      assert.equal(store.getImportBatch(batches.data[0].id).rows.length, 1);

      const waiting = store.listTasks({
        page: 1,
        pageSize: 20,
        status: 'pending',
        reviewStatus: 'WAITING_REVIEW',
      });
      assert.equal(waiting.data.length, 1);
      assert.equal(waiting.data[0].id, secondTask.id);
      assert.notEqual(waiting.data[0].id, firstTask.id);

      const stats = store.getDashboardStats();
      assert.equal(stats.tasks.total, 2);
      assert.equal(stats.tasks.pending, 2);
      assert.equal(stats.reviews.waiting, 1);
      assert.equal(stats.imports.committed, 2);
    } finally {
      store.close();
    }
  });
});
