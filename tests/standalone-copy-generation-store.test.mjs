import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  createStandaloneCopyGenerationStore,
  initializeStandaloneCopyGenerationSchema,
} from '../src/admin/standalone-copy-generation-store.mjs';
import { createMockPost } from '../src/pipeline.mjs';

const BATCH_A = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '9月3日混合选题',
};
const BATCH_B = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '补充选题',
};

function review(stage, summary) {
  return {
    schemaVersion: 1,
    stage,
    decision: 'PASS',
    summary,
    issues: [],
    source: 'OPENCLAW',
    model: 'review-model',
    reviewedAt: '2026-09-01T08:00:00.000Z',
    subjectSha256: stage === 'QUERY' ? 'a'.repeat(64) : 'b'.repeat(64),
  };
}

function researchSnapshot() {
  return {
    schemaVersion: 1,
    status: 'COMPLETED',
    query: '租房桌面整理',
    searchedAt: '2026-09-01T07:55:00.000Z',
    provider: 'codex',
    summary: '公开资料显示，桌面整理应优先保留高频使用区域。',
    attempts: [{ provider: 'codex', status: 'COMPLETED', error: null }],
    sources: [{
      title: '桌面整理公开资料',
      url: 'https://example.com/desk-guide',
      snippet: '优先保留高频使用区域，并减少桌面上的长期闲置物品。',
      siteName: 'example.com',
      provider: 'codex',
      retrievedAt: '2026-09-01T07:55:00.000Z',
    }],
  };
}

function generationRecord(query, suffix, totalMs = 1_090) {
  const originalPost = { ...createMockPost(3), title: `原始版${suffix}` };
  const reviewedPost = { ...createMockPost(3), title: `质检版${suffix}` };
  return {
    query,
    input: { category: '收纳' },
    requestedImageCount: 'auto',
    originalPost,
    reviewedPost,
    originalModel: 'original-model',
    reviewedModel: 'reviewed-model',
    originalThinking: 'high',
    reviewedThinking: 'high',
    researchSnapshot: null,
    timing: {
      queryReviewMs: 100,
      researchMs: 200,
      originalGenerationMs: 300,
      originalReviewMs: 40,
      reviewedGenerationMs: totalMs - 690,
      reviewedReviewMs: 50,
      totalMs,
    },
    stageReviews: {
      query: review('QUERY', 'Query 通过'),
      originalText: review('TEXT', '原始版质检'),
      reviewedText: review('TEXT', '质检版复检'),
    },
  };
}

describe('standalone copy generation persistence', () => {
  it('persists running and failed jobs so page reloads can recover their status', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const running = store.createStandaloneCopyGenerationJob({ query: '刷新后仍能看到我' });

      assert.equal(running.id, 1);
      assert.equal(running.status, 'RUNNING');
      assert.equal(running.query, '刷新后仍能看到我');
      assert.equal(running.currentStage, 'QUERY_REVIEW');
      assert.match(running.stageUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(running.error, null);
      assert.equal(running.finishedAt, null);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), [running]);

      const researching = store.updateStandaloneCopyGenerationJobStage(running.id, 'RESEARCH');
      assert.equal(researching.currentStage, 'RESEARCH');
      assert.match(researching.stageUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), [researching]);

      assert.throws(
        () => store.updateStandaloneCopyGenerationJobStage(running.id, 'UNKNOWN_STAGE'),
        /stage/iu,
      );

      const failed = store.failStandaloneCopyGenerationJob(
        running.id,
        '联网研究失败 Bearer abcdefghijklmnop，请重试',
      );
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.error, '联网研究失败 Bearer [REDACTED_TOKEN]，请重试');
      assert.match(failed.finishedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), [failed]);

      const overlong = store.createStandaloneCopyGenerationJob({ query: '错误信息过长' });
      const boundedFailure = store.failStandaloneCopyGenerationJob(
        overlong.id,
        `联网失败 Bearer abcdefghijklmnop ${'详细原因'.repeat(400)}`,
      );
      assert.equal([...boundedFailure.error].length, 1_000);
      assert.match(boundedFailure.error, /Bearer \[REDACTED_TOKEN\]/u);
      assert.ok(boundedFailure.error.endsWith('…'));
    } finally {
      db.close();
    }
  });

  it('persists batch grouping on running and failed jobs and filters by batch', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const grouped = store.createStandaloneCopyGenerationJob({
        query: '同一批次中的失败选题',
        batch: BATCH_A,
      });
      store.createStandaloneCopyGenerationJob({ query: '未分组选题' });

      assert.equal(grouped.batchId, BATCH_A.id);
      assert.equal(grouped.batchName, BATCH_A.name);
      const failed = store.failStandaloneCopyGenerationJob(grouped.id, '联网研究失败');
      assert.equal(failed.batchId, BATCH_A.id);
      assert.equal(failed.batchName, BATCH_A.name);
      assert.deepEqual(
        store.listStandaloneCopyGenerationJobs({ batchId: BATCH_A.id }),
        [failed],
      );
    } finally {
      db.close();
    }
  });

  it('atomically completes a running job with its saved comparison', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const job = store.createStandaloneCopyGenerationJob({ query: '生成后进入历史' });
      const saved = store.saveStandaloneCopyGeneration({
        ...generationRecord('生成后进入历史', 'J'),
        jobId: job.id,
      });

      assert.equal(saved.id, 1);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), []);
      const completed = db.prepare(`
        SELECT status, generation_id, error, finished_at
        FROM standalone_copy_generation_jobs WHERE id = ?
      `).get(job.id);
      assert.equal(completed.status, 'COMPLETED');
      assert.equal(Number(completed.generation_id), saved.id);
      assert.equal(completed.error, null);
      assert.match(completed.finished_at, /^\d{4}-\d{2}-\d{2}T/u);

      assert.throws(
        () => store.saveStandaloneCopyGeneration({
          ...generationRecord('不存在的任务不能留下历史', 'X'),
          jobId: 999,
        }),
        /running copy generation job not found/u,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM standalone_copy_generations').get().count,
        1,
      );
      const jobColumns = new Set(
        db.prepare('PRAGMA table_info(standalone_copy_generation_jobs)').all()
          .map((column) => column.name),
      );
      assert.equal(jobColumns.has('current_stage'), true);
      assert.equal(jobColumns.has('stage_updated_at'), true);
    } finally {
      db.close();
    }
  });

  it('inherits the running job batch when saving a completed comparison', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const job = store.createStandaloneCopyGenerationJob({
        query: '生成成功也留在原批次',
        batch: BATCH_A,
      });
      const saved = store.saveStandaloneCopyGeneration({
        ...generationRecord('生成成功也留在原批次', 'B'),
        jobId: job.id,
        batch: BATCH_B,
      });

      assert.equal(saved.batchId, BATCH_A.id);
      assert.equal(saved.batchName, BATCH_A.name);
      assert.deepEqual(
        store.listStandaloneCopyGenerations({ batchId: BATCH_A.id }).data,
        [saved],
      );
      assert.equal(
        store.listStandaloneCopyGenerations({ batchId: BATCH_B.id }).data.length,
        0,
      );
    } finally {
      db.close();
    }
  });

  it('atomically preserves both copy versions and their review evidence', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const saved = store.saveStandaloneCopyGeneration(generationRecord('租房桌面整理', 'A'));

      assert.equal(saved.id, 1);
      assert.equal(saved.query, '租房桌面整理');
      assert.deepEqual(saved.input, { category: '收纳' });
      assert.equal(saved.requestedImageCount, 'auto');
      assert.equal(saved.originalPost.title, '原始版A');
      assert.equal(saved.reviewedPost.title, '质检版A');
      assert.equal(saved.originalModel, 'original-model');
      assert.equal(saved.reviewedModel, 'reviewed-model');
      assert.equal(saved.originalThinking, 'high');
      assert.equal(saved.reviewedThinking, 'high');
      assert.equal(saved.stageReviews.originalText.summary, '原始版质检');
      assert.equal(saved.stageReviews.reviewedText.summary, '质检版复检');
      assert.deepEqual(saved.timing, generationRecord('租房桌面整理', 'A').timing);
      assert.equal(saved.manualReview, null);
      assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      db.close();
    }
  });

  it('persists an idempotent manual approval across history reloads', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const saved = store.saveStandaloneCopyGeneration(
        generationRecord('人工确认后允许生图', 'M'),
      );

      const approved = store.approveStandaloneCopyGeneration(saved.id, {
        reviewedBy: 'admin',
      });
      assert.deepEqual(approved.manualReview, {
        decision: 'APPROVED',
        reviewedAt: approved.manualReview.reviewedAt,
        reviewedBy: 'admin',
      });
      assert.match(approved.manualReview.reviewedAt, /^\d{4}-\d{2}-\d{2}T/u);

      const repeated = store.approveStandaloneCopyGeneration(saved.id, {
        reviewedBy: 'another-admin',
      });
      assert.deepEqual(repeated.manualReview, approved.manualReview);
      assert.deepEqual(
        store.listStandaloneCopyGenerations().data[0].manualReview,
        approved.manualReview,
      );
      assert.equal(
        store.approveStandaloneCopyGeneration(999, { reviewedBy: 'admin' }),
        null,
      );
    } finally {
      db.close();
    }
  });

  it('persists the complete research snapshot for historical display', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const record = {
        ...generationRecord('租房桌面整理', 'R'),
        researchSnapshot: researchSnapshot(),
      };

      const saved = store.saveStandaloneCopyGeneration(record);
      const listed = store.listStandaloneCopyGenerations({ page: 1, pageSize: 20 });
      const persistedJson = db.prepare(`
        SELECT research_snapshot_json FROM standalone_copy_generations WHERE id = ?
      `).get(saved.id).research_snapshot_json;

      assert.deepEqual(saved.researchSnapshot, researchSnapshot());
      assert.deepEqual(listed.data[0].researchSnapshot, researchSnapshot());
      assert.deepEqual(JSON.parse(persistedJson), researchSnapshot());
    } finally {
      db.close();
    }
  });

  it('lists saved comparisons newest first with bounded pagination', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      store.saveStandaloneCopyGeneration(generationRecord('第一条', '1', 1_000));
      store.saveStandaloneCopyGeneration(generationRecord('第二条', '2', 2_000));
      store.saveStandaloneCopyGeneration(generationRecord('第三条', '3', 10_000));

      const page = store.listStandaloneCopyGenerations({ page: 1, pageSize: 1 });
      assert.equal(page.data.length, 1);
      assert.equal(page.data[0].query, '第三条');
      assert.deepEqual(page.pagination, {
        page: 1,
        pageSize: 1,
        totalItems: 3,
        totalPages: 3,
      });
      assert.deepEqual(page.statistics, {
        sampleSize: 3,
        averageMs: 4_333,
        p50Ms: 2_000,
        p95Ms: 10_000,
        stageAverages: {
          queryReviewMs: 100,
          researchMs: 200,
          originalGenerationMs: 300,
          originalReviewMs: 40,
          reviewedGenerationMs: 3_643,
          reviewedReviewMs: 50,
        },
      });

      const bounded = store.listStandaloneCopyGenerations({
        page: 'Infinity',
        pageSize: 'Infinity',
      });
      assert.equal(bounded.data.length, 3);
      assert.deepEqual(bounded.pagination, {
        page: 1,
        pageSize: 20,
        totalItems: 3,
        totalPages: 1,
      });
    } finally {
      db.close();
    }
  });

  it('aggregates recent batches without double-counting completed jobs', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      const completedJob = store.createStandaloneCopyGenerationJob({
        query: '批次 A 成功',
        batch: BATCH_A,
      });
      store.saveStandaloneCopyGeneration({
        ...generationRecord('批次 A 成功', 'A'),
        jobId: completedJob.id,
      });
      const failedJob = store.createStandaloneCopyGenerationJob({
        query: '批次 A 失败',
        batch: BATCH_A,
      });
      store.failStandaloneCopyGenerationJob(failedJob.id, '生成失败');
      store.createStandaloneCopyGenerationJob({ query: '批次 B 运行中', batch: BATCH_B });
      store.saveStandaloneCopyGeneration(generationRecord('历史未分组', 'L'));

      const batches = store.listStandaloneCopyGenerationBatches();
      const batchA = batches.find((batch) => batch.id === BATCH_A.id);
      const batchB = batches.find((batch) => batch.id === BATCH_B.id);
      assert.deepEqual(batchA, {
        id: BATCH_A.id,
        name: BATCH_A.name,
        totalCount: 2,
        completedCount: 1,
        failedCount: 1,
        runningCount: 0,
        lastActivityAt: batchA.lastActivityAt,
      });
      assert.match(batchA.lastActivityAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(batchB, {
        id: BATCH_B.id,
        name: BATCH_B.name,
        totalCount: 1,
        completedCount: 0,
        failedCount: 0,
        runningCount: 1,
        lastActivityAt: batchB.lastActivityAt,
      });
      assert.equal(batches.some((batch) => batch.name === '未分组'), false);
    } finally {
      db.close();
    }
  });

  it('rejects malformed or incomplete batch metadata at the storage boundary', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeStandaloneCopyGenerationSchema(db);
      const store = createStandaloneCopyGenerationStore(db);
      assert.throws(
        () => store.createStandaloneCopyGenerationJob({
          query: '非法 ID',
          batch: { id: 'not-a-uuid', name: '非法批次' },
        }),
        /batch id/iu,
      );
      assert.throws(
        () => store.createStandaloneCopyGenerationJob({
          query: '名称缺失',
          batch: { id: BATCH_A.id },
        }),
        /batch name/iu,
      );
      assert.throws(
        () => store.createStandaloneCopyGenerationJob({
          query: '名称过长',
          batch: { id: BATCH_A.id, name: '批'.repeat(101) },
        }),
        /100 characters/iu,
      );
      store.createStandaloneCopyGenerationJob({ query: '合法批次', batch: BATCH_A });
      assert.throws(
        () => store.createStandaloneCopyGenerationJob({
          query: '同一 ID 不得改名',
          batch: { id: BATCH_A.id, name: '另一个名字' },
        }),
        /batch name does not match/iu,
      );
    } finally {
      db.close();
    }
  });

  it('adds nullable timing columns to legacy comparison tables', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE standalone_copy_generations (
          id INTEGER PRIMARY KEY,
          query TEXT NOT NULL,
          input_json TEXT NOT NULL,
          requested_image_count TEXT NOT NULL,
          original_post_json TEXT NOT NULL,
          reviewed_post_json TEXT NOT NULL,
          original_model TEXT NOT NULL,
          reviewed_model TEXT NOT NULL,
          query_review_json TEXT NOT NULL,
          original_text_review_json TEXT NOT NULL,
          reviewed_text_review_json TEXT NOT NULL,
          research_snapshot_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE standalone_copy_generation_jobs (
          id INTEGER PRIMARY KEY,
          query TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
          generation_id INTEGER REFERENCES standalone_copy_generations(id) ON DELETE RESTRICT,
          current_stage TEXT NOT NULL DEFAULT 'QUERY_REVIEW',
          stage_updated_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          finished_at TEXT
        ) STRICT;
      `);

      initializeStandaloneCopyGenerationSchema(db);

      const columns = new Set(
        db.prepare('PRAGMA table_info(standalone_copy_generations)').all()
          .map((column) => column.name),
      );
      for (const column of [
        'query_review_ms',
        'research_ms',
        'original_generation_ms',
        'original_review_ms',
        'reviewed_generation_ms',
        'reviewed_review_ms',
        'total_ms',
        'original_thinking',
        'reviewed_thinking',
        'manual_reviewed_at',
        'manual_reviewed_by',
        'batch_id',
        'batch_name',
      ]) assert.equal(columns.has(column), true);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE type = 'table' AND name = 'standalone_copy_generation_jobs'
        `).get().count,
        1,
      );
      const jobColumns = new Set(
        db.prepare('PRAGMA table_info(standalone_copy_generation_jobs)').all()
          .map((column) => column.name),
      );
      assert.equal(jobColumns.has('batch_id'), true);
      assert.equal(jobColumns.has('batch_name'), true);
    } finally {
      db.close();
    }
  });
});
