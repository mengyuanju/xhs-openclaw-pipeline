import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRange, compactTask, compactDetail, summarizeCounts, summarizeEfficiency } from '../src/web-statistics/summary.mjs';

const now = Date.parse('2026-09-06T08:00:00Z');
const task = (id, patch = {}) => compactTask({ id, state: 'COPY_QUEUED', createdByUserId: 'alice', createdByAccountId: 2,
  assignedToUserId: 'alice', assignedToAccountId: 2,
  createdAt: '2026-09-06T01:00:00Z', updatedAt: '2026-09-06T02:00:00Z', ...patch });

test('Shanghai day boundaries and valid bounded calendar ranges', () => {
  const range = normalizeRange({}, Date.parse('2026-09-05T16:00:00Z'));
  assert.equal(range.from, '2026-09-06');
  assert.equal(range.startMs, Date.parse('2026-09-05T16:00:00Z'));
  assert.equal(range.endMs, Date.parse('2026-09-06T16:00:00Z'));
  assert.equal(normalizeRange({ period: '7d' }, now).from, '2026-08-31');
  for (const input of [{ period: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { period: 'custom', from: '2026-09-07', to: '2026-09-06' },
    { period: 'custom', from: '2020-01-01', to: '2026-09-06' }]) assert.throws(() => normalizeRange(input, now));
});

test('counts deduplicate tasks, include discarded history and distinguish creation from completion', () => {
  const rows = [task(1), task(2, { state: 'CANCELLED' }), task(3, { state: 'REVIEWED',
    createdAt: '2026-09-04T01:00:00Z', imageReviewedAt: '2026-09-06T01:00:00Z' }),
    task(4, { createdAt: '2026-09-05T15:59:59Z', state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED' }), task(1)];
  const summary = summarizeCounts(rows, normalizeRange({}, now), now);
  assert.equal(summary.total, 4);
  assert.equal(summary.createdInPeriod, 2);
  assert.equal(summary.completedInPeriod, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.anomalies, 1);
  assert.equal(summary.trend[0].created, 2);
  assert.equal(summary.trend[0].completed, 1);
});

test('people include unassigned history and no-count periods still report cumulative totals', () => {
  const summary = summarizeCounts([task(1, { createdByUserId: null, createdByAccountId: null }), task(2, { createdByUserId: 'bob', createdByAccountId: 3,
    createdAt: '2026-08-01T01:00:00Z' })], normalizeRange({}, now), now);
  assert.equal(summary.people.find(p => p.username === 'bob').createdInPeriod, 0);
  assert.equal(summary.people.find(p => p.username === 'bob').total, 1);
  assert.equal(summary.people.find(p => p.username === null).total, 1);
});

test('people statistics keep a deleted account separate from a same-name replacement', () => {
  const summary = summarizeCounts([
    task(1, { createdByAccountId: null, createdByDisplayName: null, createdByRole: null }),
    task(2, { createdByAccountId: 9, createdByDisplayName: '新 Alice', createdByRole: 'USER' }),
  ], normalizeRange({}, now), now);
  assert.equal(summary.people.length, 2);
  const historical = summary.people.find(person => person.accountId === null);
  const replacement = summary.people.find(person => person.accountId === 9);
  assert.equal(historical.displayName, '历史账号（alice）');
  assert.equal(historical.total, 1);
  assert.equal(historical.role, null);
  assert.equal(replacement.displayName, '新 Alice');
  assert.equal(replacement.total, 1);
});

test('cached task and detail facts never retain prompts, model responses or snapshots', () => {
  const minimal = task(1, { input: { prompt: 'private' }, error: 'private error', secret: 'private' });
  const detail = compactDetail({ id: 1, executions: [{ id: 'copy', kind: 'COPY', status: 'SUCCEEDED',
    snapshot: { secret: 'private' }, progressDetails: { prompt: 'private' } }],
    copyRevisions: [{ content: { body: 'private' } }], imageRuns: [], assets: [],
    humanQualityAssessments: [{ id: 1, stage: 'COPY', score: 2.5, ratingContext: 'ORIGINAL',
      copyRevisionId: 1, reasonCodes: ['private'], note: 'private', createdAt: '2026-09-06T01:00:00Z' }] });
  assert.equal(JSON.stringify([minimal, detail]).includes('private'), false);
  assert.equal(minimal.assignedToUserId, 'alice');
  assert.equal(minimal.assignedToAccountId, 2);
  assert.deepEqual(detail.assessments, [{ id: 1, stage: 'COPY', scoreX10: 25, ratingContext: 'ORIGINAL',
    createdAt: '2026-09-06T01:00:00Z', copyRevisionId: 1, imageRunId: null }]);
});

test('execution means exclude failures, abandoned and simulation; delivery and image output have separate units', () => {
  const rows = [task(1, { state: 'REVIEWED', imageReviewedAt: '2026-09-06T02:00:00Z', currentImageRunId: 'run' })];
  const execution = (id, kind, status, seconds) => ({ id, kind, status, startedAt: '2026-09-06T01:00:00Z',
    finishedAt: new Date(Date.parse('2026-09-06T01:00:00Z') + seconds * 1000).toISOString() });
  const detail = compactDetail({ id: 1, executions: [execution('c1', 'COPY', 'FAILED', 100),
    execution('c2', 'COPY', 'SUCCEEDED', 20), execution('c3', 'COPY', 'SUCCEEDED', 40),
    execution('i1', 'IMAGE', 'SUCCEEDED', 60), execution('sim', 'IMAGE', 'SUCCEEDED', 1),
    execution('abandoned', 'IMAGE', 'ABANDONED', 90),
    { id: 'invalid', kind: 'COPY', status: 'SUCCEEDED', finishedAt: '2026-09-06T01:00:00Z' }],
    imageRuns: [{ id: 'run', executionId: 'i1' }, { id: 'simulation', executionId: 'sim', result: { simulation: { enabled: true } } }],
    assets: [{ id: 1, imageRunId: 'run', mediaType: 'image/png' }, { id: 2, imageRunId: 'run', mediaType: 'image/png' },
      { id: 3, imageRunId: 'old', mediaType: 'image/png' }, { id: 4, imageRunId: 'run', mediaType: 'text/plain' }] });
  const summary = summarizeEfficiency(rows, new Map([[1, detail]]), normalizeRange({}, now));
  assert.equal(summary.copy.meanMs, 30000);
  assert.equal(summary.copy.samples, 2);
  assert.equal(summary.copy.medianMs, 30000);
  assert.equal(summary.copy.p90Ms, 40000);
  assert.equal(summary.copy.failed, 1);
  assert.equal(summary.copy.invalid, 1);
  assert.equal(summary.image.meanMs, 60000);
  assert.equal(summary.image.abandoned, 1);
  assert.equal(summary.simulated, 1);
  assert.equal(summary.effectiveImages, 2);
  assert.equal(summary.delivery.meanMs, 3600000);
  assert.equal(summarizeEfficiency([], new Map(), normalizeRange({}, now)).copy.meanMs, null);
});

test('human quality uses one genuine first-rating sample per task and excludes edits, repeats, simulations and unrated work', () => {
  const assessment = (id, stage, score, createdAt, patch = {}) => ({ id, stage, score, createdAt,
    ratingContext: stage === 'COPY' ? 'ORIGINAL' : 'IMAGE', ...patch });
  const first = compactDetail({ executions: [], assets: [], imageRuns: [
    { id: 'simulated-run', result: { simulation: { enabled: true } } }, { id: 'real-run' },
  ], humanQualityAssessments: [
    assessment('edited', 'COPY', 3, '2026-09-06T00:55:00Z', { ratingContext: 'EDITED', copyRevisionId: 2 }),
    assessment('copy-first', 'COPY', 2.5, '2026-09-06T01:00:00Z', { copyRevisionId: 1 }),
    assessment('copy-repeat', 'COPY', 3, '2026-09-06T01:05:00Z', { copyRevisionId: 1 }),
    assessment('image-simulated', 'IMAGE', 3, '2026-09-06T01:10:00Z', { imageRunId: 'simulated-run' }),
    assessment('image-first-real', 'IMAGE', 2, '2026-09-06T01:15:00Z', { imageRunId: 'real-run' }),
    assessment('image-repeat', 'IMAGE', 3, '2026-09-06T01:20:00Z', { imageRunId: 'real-run' }),
  ] });
  const second = compactDetail({ executions: [], assets: [], imageRuns: [{ id: 'second-run' }],
    humanQualityAssessments: [
      assessment('copy-second-task', 'COPY', 3, '2026-09-06T02:00:00Z', { copyRevisionId: 3 }),
      assessment('image-second-task', 'IMAGE', 3, '2026-09-06T02:05:00Z', { imageRunId: 'second-run' }),
    ] });
  const outside = compactDetail({ executions: [], assets: [], imageRuns: [], humanQualityAssessments: [
    assessment('outside-first', 'COPY', 1, '2026-09-04T01:00:00Z', { copyRevisionId: 1 }),
    assessment('inside-repeat', 'COPY', 3, '2026-09-06T03:00:00Z', { copyRevisionId: 1 }),
  ] });
  const rows = [task(1), task(2), task(3), task(4)];
  const summary = summarizeEfficiency(rows, new Map([[1, first], [2, second], [3, outside],
    [4, compactDetail({ executions: [], assets: [], imageRuns: [], humanQualityAssessments: [] })]]), normalizeRange({}, now));
  assert.deepEqual(summary.quality.copy, { samples: 2, threePoint: 1, qualified: 2,
    threePointRate: .5, qualifiedRate: 1 });
  assert.deepEqual(summary.quality.image, { samples: 2, threePoint: 1, qualified: 1,
    threePointRate: .5, qualifiedRate: .5 });
});

test('terminal tasks with old retry markers are not current anomalies and unattached assets are not delivered images', () => {
  const rows = [task(1, { state: 'CANCELLED', currentStage: 'IMAGE_RETRY_EXHAUSTED' }),
    task(2, { state: 'REVIEWED', imageReviewedAt: '2026-09-06T02:00:00Z' })];
  const range = normalizeRange({}, now);
  assert.equal(summarizeCounts(rows, range, now).anomalies, 0);
  const detail = compactDetail({ executions: [], imageRuns: [], assets: [{ id: 1, imageRunId: null, mediaType: 'image/png' }] });
  assert.equal(summarizeEfficiency(rows, new Map([[2, detail]]), range).effectiveImages, 0);
});

test('malformed execution kinds fail closed and metadata cannot retain arbitrary objects', () => {
  assert.throws(() => compactTask({ id: 1, state: 'COPY_QUEUED' }), /账号身份/u);
  assert.throws(() => compactTask({ id: 1, state: 'COPY_QUEUED', createdByAccountId: '2' }), /账号身份/u);
  assert.throws(() => compactDetail({ executions: [{ id: 'bad', kind: '__proto__', status: 'SUCCEEDED' }], imageRuns: [], assets: [] }));
  assert.throws(() => compactDetail({ executions: [], imageRuns: [], assets: [],
    humanQualityAssessments: [{ id: 1, stage: 'COPY', score: 2.1 }] }));
  const row = task(1, { createdByDisplayName: { secret: 'private' }, createdAt: { private: true }, currentImageRunId: { private: true } });
  assert.equal(row.createdByDisplayName, null);
  assert.equal(JSON.stringify(row).includes('private'), false);
});
