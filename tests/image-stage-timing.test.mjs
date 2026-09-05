import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageStageTimer, imageTimingProfile, readImageTimingSamples, recordImageTimingSample } from '../src/image-stage-timing.mjs';
import { readStandaloneImageProgress } from '../src/standalone-image-generation.mjs';

const profile = imageTimingProfile({ provider: 'codex', imageCount: 3, concurrency: 1, modelApi: {} });
const stages = { PREPARING: 1000, PLANNING: 30000, GENERATING: 600000, QUALITY_CHECK: 50000, FINALIZING: 1000 };

test('cold estimates account for first-page dependency, thinking, count and actual image concurrency', () => {
  const estimate = (options) => createImageStageTimer({ imageCount: 3, ...options }).update('PREPARING', 0).estimatedTotalMs;
  assert.ok(estimate({ concurrency: 1 }) > estimate({ concurrency: 2 }));
  assert.ok(estimate({ thinking: 'high' }) > estimate({ thinking: 'low' }));
  assert.ok(estimate({ imageCount: 5 }) > estimate({ imageCount: 3 }));
});

test('stage history uses a recent median and excludes bad samples', () => {
  const timer = createImageStageTimer({ imageCount: 3, samples: [stages, stages,
    { ...stages, GENERATING: 5000000 }, { ...stages, PLANNING: -1 }] });
  const start = timer.update('PREPARING', 0);
  assert.equal(start.estimateBasis, 'stage-history');
  assert.equal(start.estimateSampleSize, 3);
  assert.equal(start.estimatedTotalMs, 682000);
  const planning = timer.update('PLANNING', 1000);
  assert.equal(planning.estimatedRemainingMs, 681000);
  const render = timer.update('GENERATING', 31000);
  assert.equal(render.estimatedRemainingMs, 651000);
});

test('alignment heartbeats do not reset rendering phase and overdue estimates become unknown', () => {
  const timer = createImageStageTimer({ imageCount: 3, samples: [stages, stages, stages] });
  timer.update('PREPARING', 0); timer.update('PLANNING', 1000); timer.update('GENERATING', 31000);
  timer.update('ALIGNING', 500000);
  const overdue = timer.update('GENERATING', 650000);
  assert.equal(overdue.estimatedRemainingMs, null);
  assert.equal(overdue.estimateOverdue, true);
  const quality = timer.update('QUALITY_CHECK', 660000);
  assert.equal(quality.estimatedRemainingMs, 51000);
  assert.equal(quality.stageDurationsMs.GENERATING, 629000);
  timer.update('FINALIZING', 710000);
  const end = timer.update('COMPLETED', 711000);
  assert.equal(end.estimatedRemainingMs, 0);
  assert.equal(end.stageDurationsMs.QUALITY_CHECK, 50000);
});

test('history is isolated by model, thinking, image count and concurrency; only bounded samples persist', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'timing.sqlite');
  for (let index = 0; index < 35; index += 1) {
    assert.equal(recordImageTimingSample({ databasePath, profile, stages, runId: String(index) }), true);
  }
  assert.equal(readImageTimingSamples({ databasePath, profile }).length, 30);
  for (const variation of [{ concurrency: 2 }, { imageCount: 5 }, { modelApi: { copyGenerationThinking: 'high' } },
    { modelApi: { textModel: 'openai/gpt-5.4' } }]) {
    const other = imageTimingProfile({ provider: 'codex', imageCount: 3, concurrency: 1, modelApi: {}, ...variation });
    assert.notEqual(other, profile);
    assert.deepEqual(readImageTimingSamples({ databasePath, profile: other }), []);
  }
  assert.equal(recordImageTimingSample({ databasePath, profile, stages: { ...stages, PLANNING: -1 }, runId: 'bad' }), false);
});

test('unavailable timing storage cannot fail or replay generation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-timing-io-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'not-a-db');
  await writeFile(databasePath, 'invalid SQLite');
  assert.deepEqual(readImageTimingSamples({ databasePath, profile }), []);
  assert.equal(recordImageTimingSample({ databasePath, profile, stages, runId: 'fake' }), false);
});

test('polling marks a slow active stage overdue even before its next heartbeat and before the full-run deadline', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'xhs-timing-poll-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const runId = '66666666-6666-4666-8666-666666666666';
  const directory = join(outputRoot, 'standalone-image-generations', runId);
  await mkdir(directory, { recursive: true });
  const startedAt = new Date(Date.now() - 120000).toISOString();
  const progress = { runId, mode: 'LIVE', status: 'RUNNING', stage: 'PLANNING', progressPercent: 8,
    message: 'fake slow planning', totalImages: 3, completedImages: 0, startedAt, updatedAt: startedAt,
    finishedAt: null, estimatedTotalMs: 900000, estimateBasis: 'stage-defaults', estimatedStageDeadlineElapsedMs: 45000 };
  await writeFile(join(directory, 'progress.json'), JSON.stringify(progress));
  const result = await readStandaloneImageProgress({ outputRoot, runId });
  assert.equal(result.estimatedRemainingMs, null);
  assert.equal(result.estimateOverdue, true);
  delete progress.estimatedStageDeadlineElapsedMs;
  progress.estimateBasis = 'mode-and-page-count';
  await writeFile(join(directory, 'progress.json'), JSON.stringify(progress));
  const legacy = await readStandaloneImageProgress({ outputRoot, runId });
  assert.ok(legacy.estimatedRemainingMs > 0);
  assert.equal(legacy.estimateOverdue, false);
});
