import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import {
  buildTaskTiming,
  summarizeTaskDurations,
} from '../src/admin/task-timing.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('task timing estimates', () => {
  it('uses the median live duration and prefers samples with the same image count', () => {
    const summary = summarizeTaskDurations([
      { durationMs: 10 * 60_000, imageCount: 3 },
      { durationMs: 20 * 60_000, imageCount: 3 },
      { durationMs: 40 * 60_000, imageCount: 5 },
    ]);

    assert.equal(summary.sampleSize, 3);
    assert.equal(summary.typicalDurationMs, 20 * 60_000);
    assert.deepEqual(summary.byImageCount['3'], {
      sampleSize: 2,
      typicalDurationMs: 15 * 60_000,
    });
  });

  it('reports live elapsed and remaining time for the processing row', () => {
    const timing = buildTaskTiming({
      status: 'processing',
      processingStartedAt: '2026-08-25T01:00:00.000Z',
      finishedAt: null,
      queuePosition: null,
      config: { imageCount: 3 },
    }, {
      sampleSize: 2,
      typicalDurationMs: 10 * 60_000,
      byImageCount: {
        3: { sampleSize: 2, typicalDurationMs: 10 * 60_000 },
      },
      activeTasks: [],
    }, { now: '2026-08-25T01:04:00.000Z' });

    assert.equal(timing.elapsedMs, 4 * 60_000);
    assert.equal(timing.estimatedDurationMs, 10 * 60_000);
    assert.equal(timing.estimatedRemainingMs, 6 * 60_000);
    assert.equal(timing.estimatedCompletionAt, '2026-08-25T01:10:00.000Z');
    assert.equal(timing.estimateSampleSize, 2);
    assert.equal(timing.estimateScope, 'same_image_count');
  });

  it('labels an estimate as overall when no same-image-count sample exists', () => {
    const timing = buildTaskTiming({
      status: 'processing',
      processingStartedAt: '2026-08-25T01:00:00.000Z',
      finishedAt: null,
      queuePosition: null,
      config: { imageCount: 3 },
    }, {
      sampleSize: 2,
      typicalDurationMs: 12 * 60_000,
      byImageCount: {
        5: { sampleSize: 2, typicalDurationMs: 12 * 60_000 },
      },
      activeTasks: [],
    }, { now: '2026-08-25T01:04:00.000Z' });

    assert.equal(timing.estimatedDurationMs, 12 * 60_000);
    assert.equal(timing.estimateScope, 'all');
  });

  it('includes the active row and earlier queued rows in a pending completion estimate', () => {
    const timing = buildTaskTiming({
      status: 'pending',
      processingStartedAt: null,
      finishedAt: null,
      queuePosition: 2,
      config: { imageCount: 3 },
    }, {
      sampleSize: 4,
      typicalDurationMs: 10 * 60_000,
      byImageCount: {
        3: { sampleSize: 4, typicalDurationMs: 10 * 60_000 },
      },
      activeTasks: [{
        processingStartedAt: '2026-08-25T01:00:00.000Z',
        imageCount: 3,
      }],
    }, { now: '2026-08-25T01:02:00.000Z' });

    assert.equal(timing.estimatedRemainingMs, 28 * 60_000);
    assert.equal(timing.estimatedCompletionAt, '2026-08-25T01:30:00.000Z');
  });

  it('reports actual duration for a finished row without replacing it with an estimate', () => {
    const timing = buildTaskTiming({
      status: 'completed',
      processingStartedAt: '2026-08-25T01:00:00.000Z',
      finishedAt: '2026-08-25T01:11:30.000Z',
      queuePosition: null,
      config: { imageCount: 3 },
    }, {
      sampleSize: 0,
      typicalDurationMs: null,
      byImageCount: {},
      activeTasks: [],
    }, { now: '2026-08-25T02:00:00.000Z' });

    assert.equal(timing.actualDurationMs, 11.5 * 60_000);
    assert.equal(timing.estimatedDurationMs, null);
  });
});

describe('admin task timing statistics', () => {
  it('reads completed live attempts and exposes queue timing fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-task-timing-'));
    directories.push(directory);
    const databasePath = join(directory, 'queue.db');
    const store = createAdminStore(databasePath);
    const queue = createQueue(databasePath);
    try {
      const batch = store.createImportBatch({
        name: '耗时测试',
        sourceFileName: 'timing.xlsx',
        rows: [{
          rowNumber: 2,
          query: '三图耗时任务',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          screening: {
            admitted: true,
            demandLevel: 'STRONG',
            reason: '用于测试任务耗时。',
            source: 'EXCEL',
          },
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      const claimed = queue.claimNext({
        workerId: 'timing-worker',
        now: new Date('2026-08-25T01:00:00.000Z'),
      });
      store.addGenerationRun({
        taskId: claimed.id,
        attempt: claimed.attempts,
        mode: 'live',
        status: 'COMPLETED',
        outputDir: 'output/1',
        startedAt: '2026-08-25T01:00:00.000Z',
        finishedAt: '2026-08-25T01:09:00.000Z',
      });
      queue.complete(claimed.id, {
        workerId: 'timing-worker',
        outputDir: 'output/1',
        now: new Date('2026-08-25T01:09:00.000Z'),
      });

      const [task] = store.listTasks({ pageSize: 1 }).data;
      const stats = store.getTaskTimingStats();
      const batchWithTiming = store.getImportBatch(batch.id);

      assert.equal(task.processingStartedAt, '2026-08-25T01:00:00.000Z');
      assert.equal(task.finishedAt, '2026-08-25T01:09:00.000Z');
      assert.equal(task.queuePosition, null);
      assert.equal(stats.sampleSize, 1);
      assert.equal(stats.typicalDurationMs, 9 * 60_000);
      assert.deepEqual(stats.byImageCount['3'], {
        sampleSize: 1,
        typicalDurationMs: 9 * 60_000,
      });
      assert.equal(batchWithTiming.statistics.startedAt, '2026-08-25T01:00:00.000Z');
      assert.equal(batchWithTiming.statistics.finishedAt, '2026-08-25T01:09:00.000Z');
      assert.equal(batchWithTiming.statistics.wallDurationMs, 9 * 60_000);
      assert.equal(batchWithTiming.statistics.averageRunDurationMs, 9 * 60_000);
    } finally {
      queue.close();
      store.close();
    }
  });
});
