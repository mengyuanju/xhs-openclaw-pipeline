import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  createStandaloneCopyGenerationStore,
  initializeStandaloneCopyGenerationSchema,
} from '../src/admin/standalone-copy-generation-store.mjs';
import { createMockPost } from '../src/pipeline.mjs';

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
      assert.equal(running.error, null);
      assert.equal(running.finishedAt, null);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), [running]);

      const failed = store.failStandaloneCopyGenerationJob(
        running.id,
        '联网研究失败 Bearer abcdefghijklmnop，请重试',
      );
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.error, '联网研究失败 Bearer [REDACTED_TOKEN]，请重试');
      assert.match(failed.finishedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(store.listStandaloneCopyGenerationJobs(), [failed]);
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
      assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
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
      ]) assert.equal(columns.has(column), true);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE type = 'table' AND name = 'standalone_copy_generation_jobs'
        `).get().count,
        1,
      );
    } finally {
      db.close();
    }
  });
});
