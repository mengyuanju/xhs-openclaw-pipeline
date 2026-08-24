import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  it('requires demand screening and only admits strong or medium rows', () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '需求筛选批次',
        sourceFileName: 'screening.xlsx',
        rows: [
          {
            rowNumber: 2,
            externalId: 'pending',
            query: '租房合同怎么签才不踩坑',
            input: {},
            imageCount: 3,
            referenceImageFiles: [],
            errors: [],
            screening: null,
          },
          {
            rowNumber: 3,
            externalId: 'strong',
            query: '两款投影仪怎么选',
            input: {},
            imageCount: 3,
            referenceImageFiles: [],
            errors: [],
            screening: {
              admitted: true,
              demandLevel: 'STRONG',
              reason: '真实体验与对比决策需求。',
              source: 'EXCEL',
            },
          },
          {
            rowNumber: 4,
            externalId: 'weak',
            query: '今天上海天气',
            input: {},
            imageCount: 3,
            referenceImageFiles: [],
            errors: [],
            screening: {
              admitted: false,
              demandLevel: 'WEAK',
              reason: '一句话即可闭环。',
              source: 'EXCEL',
            },
          },
        ],
      });

      assert.equal(batch.pendingScreeningRows, 1);
      assert.equal(batch.admittedRows, 1);
      assert.equal(batch.discardedRows, 1);
      assert.equal(batch.screeningComplete, false);
      assert.throws(() => store.commitImportBatch(batch.id), /demand screening.*complete/i);

      const pendingRow = store.getImportBatch(batch.id).rows.find((row) => row.externalId === 'pending');
      const screened = store.screenImportBatch(batch.id, {
        decisions: [{
          rowId: pendingRow.id,
          demandLevel: 'MEDIUM',
          reason: '专业答案为主，真实经验可作补充。',
        }],
      });

      assert.equal(screened.pendingScreeningRows, 0);
      assert.equal(screened.admittedRows, 2);
      assert.equal(screened.discardedRows, 1);
      assert.equal(screened.demandCounts.STRONG, 1);
      assert.equal(screened.demandCounts.MEDIUM, 1);
      assert.equal(screened.demandCounts.WEAK, 1);
      assert.equal(screened.demandCounts.NONE, 0);
      assert.equal(screened.screeningComplete, true);
      const screenedRows = store.getImportBatch(batch.id).rows;
      assert.equal(screenedRows.find((row) => row.externalId === 'pending').screeningSource, 'MANUAL');
      assert.equal(screenedRows.find((row) => row.externalId === 'strong').screeningSource, 'EXCEL');
      assert.equal(screenedRows.find((row) => row.externalId === 'weak').screeningSource, 'EXCEL');

      const commit = store.commitImportBatch(batch.id);
      assert.equal(commit.createdTasks, 2);
      assert.deepEqual(
        store.listTasks({ page: 1, pageSize: 10 }).data.map((task) => task.input.taskJudgement.demandLevel).sort(),
        ['medium', 'strong'],
      );
    } finally {
      store.close();
    }
  });

  it('records OpenClaw screening provenance and the actual model name', () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '模型筛选批次',
        sourceFileName: 'model-screened.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'model-screened',
          query: '两款投影仪怎么选',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          errors: [],
          screening: {
            admitted: true,
            demandLevel: 'STRONG',
            reason: '存在明确的体验比较和购买决策需求。',
            source: 'OPENCLAW',
            model: 'openai-codex/fake-screening-model',
          },
        }],
      });

      const [row] = store.getImportBatch(batch.id).rows;
      assert.equal(row.screeningSource, 'OPENCLAW');
      assert.equal(row.screeningModel, 'openai-codex/fake-screening-model');
      assert.equal(row.screeningStatus, 'COMPLETED');
    } finally {
      store.close();
    }
  });

  it('migrates legacy screening constraints without losing import rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-screening-migration-'));
    const databasePath = join(directory, 'queue.db');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY, query TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT, lease_until TEXT, output_dir TEXT, error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE import_batches (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, source_file_name TEXT NOT NULL,
          status TEXT NOT NULL, total_rows INTEGER NOT NULL, valid_rows INTEGER NOT NULL,
          invalid_rows INTEGER NOT NULL, created_at TEXT NOT NULL, committed_at TEXT
        ) STRICT;
        CREATE TABLE import_rows (
          id INTEGER PRIMARY KEY,
          batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
          row_number INTEGER NOT NULL, external_id TEXT, query TEXT NOT NULL,
          input_json TEXT NOT NULL, image_count INTEGER NOT NULL,
          reference_image_files_json TEXT NOT NULL, errors_json TEXT NOT NULL,
          is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
          screening_status TEXT NOT NULL DEFAULT 'PENDING',
          demand_level TEXT, screening_reason TEXT NOT NULL DEFAULT '',
          screening_source TEXT CHECK (screening_source IN ('EXCEL', 'MANUAL')),
          is_admitted INTEGER, task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
          UNIQUE(batch_id, row_number)
        ) STRICT;
        INSERT INTO import_batches
          (id, name, source_file_name, status, total_rows, valid_rows, invalid_rows, created_at)
        VALUES (1, '旧批次', 'legacy.xlsx', 'PREVIEW', 1, 1, 0, '2026-01-01T00:00:00.000Z');
        INSERT INTO import_rows
          (id, batch_id, row_number, query, input_json, image_count,
           reference_image_files_json, errors_json, is_valid, screening_status,
           demand_level, screening_reason, screening_source, is_admitted)
        VALUES (1, 1, 2, '旧选题', '{}', 3, '[]', '[]', 1, 'COMPLETED',
                'STRONG', '旧 Excel 判定', 'EXCEL', 1);
      `);
    } finally {
      legacy.close();
    }

    const store = createAdminStore(databasePath);
    try {
      const [preserved] = store.getImportBatch(1).rows;
      assert.equal(preserved.query, '旧选题');
      assert.equal(preserved.screeningSource, 'EXCEL');
      assert.equal(preserved.screeningModel, null);
      const batch = store.createImportBatch({
        name: '新模型批次',
        sourceFileName: 'openclaw.xlsx',
        rows: [{
          rowNumber: 2,
          query: '新选题',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          errors: [],
          screening: {
            admitted: true,
            demandLevel: 'MEDIUM',
            reason: '模型判定。',
            source: 'OPENCLAW',
            model: 'fake-model',
          },
        }],
      });
      assert.equal(store.getImportBatch(batch.id).rows[0].screeningSource, 'OPENCLAW');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('can complete a fully screened batch when every query is discarded', () => {
    const store = createAdminStore(':memory:');
    try {
      const batch = store.createImportBatch({
        name: '全量废弃批次',
        sourceFileName: 'discarded.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'discarded',
          query: '聊斋全书 txt 下载',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          errors: [],
          screening: {
            admitted: false,
            demandLevel: 'NONE',
            reason: '资源下载类非笔记需求。',
            source: 'EXCEL',
          },
        }],
      });

      const result = store.commitImportBatch(batch.id);

      assert.equal(result.createdTasks, 0);
      assert.equal(result.batch.status, 'COMMITTED');
      assert.equal(store.countTasks(), 0);
    } finally {
      store.close();
    }
  });

  it('rejects duplicate or foreign screening row ids without partial updates', () => {
    const store = createAdminStore(':memory:');
    try {
      const makeBatch = (name, externalId) => store.createImportBatch({
        name,
        sourceFileName: `${externalId}.xlsx`,
        rows: [{
          rowNumber: 2,
          externalId,
          query: `${name}待筛选选题`,
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          errors: [],
          screening: null,
        }],
      });
      const first = makeBatch('第一批', 'first');
      const second = makeBatch('第二批', 'second');
      const firstRow = store.getImportBatch(first.id).rows[0];
      const secondRow = store.getImportBatch(second.id).rows[0];

      assert.throws(() => store.screenImportBatch(first.id, {
        decisions: [
          { rowId: firstRow.id, demandLevel: 'STRONG', reason: '有效判定' },
          { rowId: firstRow.id, demandLevel: 'WEAK', reason: '重复篡改' },
        ],
      }), /row ids must be unique/i);
      assert.throws(() => store.screenImportBatch(first.id, {
        decisions: [
          { rowId: firstRow.id, demandLevel: 'STRONG', reason: '有效判定' },
          { rowId: secondRow.id, demandLevel: 'MEDIUM', reason: '跨批次篡改' },
        ],
      }), /not a valid row in this batch/i);

      assert.equal(store.getImportBatch(first.id).pendingScreeningRows, 1);
      assert.equal(store.getImportBatch(second.id).pendingScreeningRows, 1);
    } finally {
      store.close();
    }
  });

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
        screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
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
            screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
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
      screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
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

describe('admin image edit requests', () => {
  it('queues, claims and completes an AI image edit without replacing the source asset', () => {
    const store = createAdminStore(':memory:');
    try {
      const task = createReviewTask(store);
      const source = store.addAsset({
        taskId: task.id,
        kind: 'REFERENCE',
        fileName: 'source.png',
        relativePath: 'references/1/source.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'b'.repeat(64),
        source: 'upload',
      });
      const request = store.createImageEditRequest(task.id, {
        sourceAssetId: source.id,
        instruction: '保留桌面主体，去掉背景杂物',
      });
      const claimed = store.claimNextImageEdit({ workerId: 'edit-worker' });
      assert.equal(claimed.id, request.id);
      assert.equal(claimed.status, 'PROCESSING');

      const result = store.addAsset({
        taskId: task.id,
        kind: 'EDITED',
        parentAssetId: source.id,
        fileName: 'result.png',
        relativePath: 'revisions/1/result.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'c'.repeat(64),
        source: 'openclaw:image-edit',
      });
      store.completeImageEdit(request.id, { workerId: 'edit-worker', resultAssetId: result.id });

      const detail = store.getTask(task.id);
      assert.equal(detail.imageEditRequests[0].status, 'COMPLETED');
      assert.equal(detail.imageEditRequests[0].resultAssetId, result.id);
      assert.equal(store.getAsset(source.id).kind, 'REFERENCE');
    } finally { store.close(); }
  });
});
