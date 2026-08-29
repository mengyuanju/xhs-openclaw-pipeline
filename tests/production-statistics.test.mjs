import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeImportBatchStatistics } from '../src/admin/production-statistics.mjs';

describe('production statistics', () => {
  it('summarizes explicit batch timing, scores, progress, and quality repairs', () => {
    const summary = summarizeImportBatchStatistics({
      batch: {
        id: 9,
        committedAt: '2026-08-27T01:00:00.000Z',
      },
      tasks: [
        { id: 1, status: 'completed' },
        { id: 2, status: 'failed' },
      ],
      runs: [
        {
          taskId: 1,
          startedAt: '2026-08-27T01:02:00.000Z',
          finishedAt: '2026-08-27T01:12:00.000Z',
          durationMs: 10 * 60_000,
          qcScore: 3,
          qcDetail: { qualityRepair: { initialScore: 1, finalScore: 3, attempts: [{ round: 1 }] } },
        },
        {
          taskId: 2,
          startedAt: '2026-08-27T01:12:00.000Z',
          finishedAt: '2026-08-27T01:20:00.000Z',
          durationMs: 8 * 60_000,
          qcScore: 1,
          qcDetail: { qualityRepair: { initialScore: 1, finalScore: 1, attempts: [{ round: 1 }, { round: 2 }] } },
        },
      ],
      now: '2026-08-27T02:00:00.000Z',
    });

    assert.equal(summary.taskCount, 2);
    assert.equal(summary.finishedTaskCount, 2);
    assert.equal(summary.progressPercent, 100);
    assert.equal(summary.startedAt, '2026-08-27T01:02:00.000Z');
    assert.equal(summary.finishedAt, '2026-08-27T01:20:00.000Z');
    assert.equal(summary.wallDurationMs, 18 * 60_000);
    assert.equal(summary.averageRunDurationMs, 9 * 60_000);
    assert.deepEqual(summary.finalScoreCounts, { 0: 0, 1: 1, 2: 0, 3: 1 });
    assert.deepEqual(summary.initialScoreCounts, { 0: 0, 1: 2, 2: 0, 3: 0 });
    assert.equal(summary.qualityRepairAttempts, 3);
    assert.equal(summary.qualityRepairTargetReached, 1);
  });
});
