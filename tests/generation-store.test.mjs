import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createGenerationStore,
  initializeGenerationSchema,
} from '../src/admin/generation-store.mjs';

function databaseWithTasks() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY) STRICT; INSERT INTO tasks (id) VALUES (1);');
  return db;
}

function researchSnapshot() {
  return {
    schemaVersion: 1,
    status: 'COMPLETED',
    query: '桌面整理',
    searchedAt: '2026-08-29T08:00:00.000Z',
    provider: 'duckduckgo',
    summary: null,
    attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
    sources: [{
      title: '整理来源',
      url: 'https://example.com/desk',
      snippet: '整理摘要',
      siteName: 'example.com',
      provider: 'duckduckgo',
      retrievedAt: '2026-08-29T08:00:00.000Z',
    }],
  };
}

test('generation runs persist bounded QC detail for human-readable review reasons', () => {
  const db = databaseWithTasks();
  try {
    initializeGenerationSchema(db);
    const store = createGenerationStore(db);
    const qc = {
      overallScore: 2,
      disposition: 'manual_review_required',
      rubric: {
        finalScore: 2,
        lowestObstacleDimensions: ['imageTextQuality'],
        dimensions: {
          imageTextQuality: {
            score: 2,
            evidence: ['图片文字逐字一致，但美观度仍需人工确认。'],
            source: 'hybrid',
            applicable: true,
          },
        },
        issueLabels: [],
      },
      limitations: ['仍需人工终审。'],
    };

    const saved = store.addGenerationRun({
      taskId: 1,
      attempt: 1,
      mode: 'live',
      status: 'COMPLETED',
      outputDir: 'output/1/attempt-1',
      startedAt: '2026-08-27T01:00:00.000Z',
      finishedAt: '2026-08-27T01:09:30.000Z',
      qc,
      promptTrace: {
        contentKind: 'USER_PROMPT',
        text: { status: 'SUBMITTED', content: '完整文案生成提示词' },
        images: [
          { pageIndex: 1, status: 'SUBMITTED', content: '第 1 张完整图片生成提示词' },
        ],
      },
      visualPlan: {
        schemaVersion: 1,
        contentProfile: { category: '收纳' },
        pages: [{ pageIndex: 1, layoutDirection: '主体居中，标题置顶。' }],
      },
      researchSnapshot: researchSnapshot(),
    });

    assert.deepEqual(saved.qcDetail, qc);
    assert.equal(saved.startedAt, '2026-08-27T01:00:00.000Z');
    assert.equal(saved.finishedAt, '2026-08-27T01:09:30.000Z');
    assert.equal(saved.durationMs, 9.5 * 60_000);
    assert.deepEqual(saved.promptTrace, {
      contentKind: 'USER_PROMPT',
      text: { status: 'SUBMITTED', content: '完整文案生成提示词' },
      images: [
        { pageIndex: 1, status: 'SUBMITTED', content: '第 1 张完整图片生成提示词' },
      ],
    });
    assert.deepEqual(saved.visualPlan, {
      schemaVersion: 1,
      contentProfile: { category: '收纳' },
      pages: [{ pageIndex: 1, layoutDirection: '主体居中，标题置顶。' }],
    });
    assert.deepEqual(saved.researchSnapshot, researchSnapshot());
    assert.deepEqual(store.listGenerationRuns(1)[0].qcDetail, qc);
    assert.deepEqual(store.listGenerationRuns(1)[0].promptTrace, saved.promptTrace);
    assert.deepEqual(store.listGenerationRuns(1)[0].visualPlan, saved.visualPlan);
    assert.deepEqual(store.listGenerationRuns(1)[0].researchSnapshot, researchSnapshot());
  } finally {
    db.close();
  }
});

test('generation schema adds the QC detail column to historical databases', () => {
  const db = databaseWithTasks();
  try {
    db.exec(`
      CREATE TABLE generation_runs (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        mode TEXT NOT NULL CHECK (mode IN ('mock', 'live')),
        status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
        output_dir TEXT,
        qc_score REAL,
        qc_disposition TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, attempt, status)
      ) STRICT;
    `);

    initializeGenerationSchema(db);

    const columns = db.prepare('PRAGMA table_info(generation_runs)').all().map(({ name }) => name);
    assert.ok(columns.includes('qc_detail_json'));
    assert.ok(columns.includes('started_at'));
    assert.ok(columns.includes('finished_at'));
    assert.ok(columns.includes('duration_ms'));
    assert.ok(columns.includes('prompt_trace_json'));
    assert.ok(columns.includes('visual_plan_json'));
    assert.ok(columns.includes('research_snapshot_json'));
  } finally {
    db.close();
  }
});

test('generation runs do not expose legacy mixed prompt traces as user prompts', () => {
  const db = databaseWithTasks();
  try {
    initializeGenerationSchema(db);
    const store = createGenerationStore(db);
    const saved = store.addGenerationRun({
      taskId: 1,
      attempt: 1,
      mode: 'live',
      status: 'FAILED',
      promptTrace: {
        text: { status: 'SUBMITTED', content: '旧版混合文案系统提示词' },
        images: [{ pageIndex: 1, status: 'SUBMITTED', content: '旧版混合图片系统提示词' }],
      },
    });

    assert.equal(saved.promptTrace, null);
    assert.equal(store.listGenerationRuns(1)[0].promptTrace, null);
  } finally {
    db.close();
  }
});
