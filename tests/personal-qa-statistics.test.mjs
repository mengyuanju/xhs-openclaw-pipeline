import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPersonalQaActivity, personalQaMetricRows, summarizePersonalQa } from '../src/personal-qa-statistics.mjs';

const at = '2026-09-28T05:00:00Z';
const manual = (id, extra = {}) => ({ id:`copy-v2:${id}`, stage:'COPY', taskId:id, accountId:22,
  samplingItemId:id, qaBatchId:1, sampleKind:'RANDOM', kind:'QA_REVIEW', outcome:'PASS', at, ...extra });
const affected = (id, kind = 'BATCH_RELEASE', extra = {}) => ({ id:`coverage:${kind}:${id}`, stage:'COPY',
  taskId:id, accountId:22, reviewItemKey:`COPY:v2:${id}`, qaBatchId:1, kind, outcome:kind === 'BATCH_RELEASE' ? 'RELEASE' : 'RETURN',
  operationKey:`COPY:v2:1:${kind}`, at, ...extra });

test('ten manually passed samples cover a hundred members with automatic release', () => {
  const actual = Array.from({ length:10 }, (_, i) => manual(i + 1));
  const coverage = Array.from({ length:90 }, (_, i) => affected(i + 11));
  const summary = summarizePersonalQa(actual, coverage, 'COPY');
  assert.equal(summary.actualOperations, 10);
  assert.equal(summary.processingCoverage, 100);
  assert.equal(summary.batchReleased, 90);
  assert.equal(summary.batchActions, 1);
  assert.equal(personalQaMetricRows(actual, coverage, 'qaActual', 'COPY').length, 10);
  assert.equal(personalQaMetricRows(actual, coverage, 'qaCoverage', 'COPY').length, 100);
});

test('five real returns and ninety-five batch impacts are distinct work and coverage', () => {
  const actual = Array.from({ length:5 }, (_, i) => manual(i + 1, { outcome:'RETURN' }));
  const coverage = Array.from({ length:95 }, (_, i) => affected(i + 6, 'BATCH_RETURN'));
  const summary = summarizePersonalQa(actual, coverage);
  assert.equal(summary.actualOperations, 5);
  assert.equal(summary.returned, 5);
  assert.equal(summary.processingCoverage, 100);
  assert.equal(summary.batchReturned, 95);
  assert.equal(summary.batchActions, 1);
});

test('image direct and batch scopes overlap, while new recheck freezes remain separate', () => {
  const first = manual(1, { id:'image-review:1', stage:'IMAGE', freezeId:7, qaBatchId:null });
  const batch = { id:'image-batch-action:5', sourceEventId:5, stage:'IMAGE', accountId:22,
    freezeId:7, kind:'QA_BATCH_RETURN', at, affectedCount:10, affectedTaskIds:Array.from({ length:10 }, (_, i) => i + 1) };
  const rows = [first, { ...first }, batch];
  const summary = summarizePersonalQa(rows);
  assert.equal(summary.actualOperations, 1);
  assert.equal(summary.processingCoverage, 10);
  assert.equal(summary.batchReturned, 10);
  const recheck = { ...first, id:'image-review:20', samplingItemId:20, freezeId:8, sampleKind:'MANDATORY_RECHECK' };
  assert.equal(summarizePersonalQa([...rows, recheck]).processingCoverage, 11);
  assert.equal(summarizePersonalQa([...rows, recheck]).actualOperations, 2);
  assert.equal(summarizePersonalQa([...rows, recheck]).rechecks, 1);
});

test('member-level exclusions suppress the old full batch list without hiding valid work', () => {
  const batch = { id:'image-batch-action:5', sourceEventId:5, stage:'IMAGE', accountId:22,
    freezeId:7, kind:'QA_BATCH_RETURN', at, affectedCount:2, affectedTaskIds:[1,2] };
  const coverage = [affected(1, 'BATCH_RETURN', { stage:'IMAGE', reviewItemKey:'IMAGE:legacy:7:1',
    sourceEventId:5, operationKey:'image-return:5' }),
  affected(2, 'BATCH_RETURN', { stage:'IMAGE', reviewItemKey:'IMAGE:legacy:7:2',
    sourceEventId:5, operationKey:'image-return:5', exclusion:'SIMULATED' })];
  const summary = summarizePersonalQa([batch], coverage);
  assert.equal(summary.processingCoverage, 1);
  assert.equal(summary.batchActions, 1);
  assert.equal(summary.coverageIncomplete, false);
});

test('copy batch actions with no extra affected members are still counted', () => {
  const batch = { ...manual(1), kind:'QA_BATCH_RETURN', affectedCount:0, affectedTaskIds:[],
    operationKey:'COPY:v2:1:BATCH_RETURN' };
  const summary = summarizePersonalQa([manual(1, { outcome:'RETURN' }), batch]);
  assert.equal(summary.actualOperations, 1);
  assert.equal(summary.processingCoverage, 1);
  assert.equal(summary.batchActions, 1);
  assert.equal(summary.coverageIncomplete, false);
});

test('discard and escalation count as manual handling; direct approval and exclusions do not', () => {
  const rows = [manual(1), manual(2, { kind:'QA_DISCARD', outcome:'DISCARD' }),
    manual(3, { kind:'QA_ESCALATE', outcome:'ESCALATE' }), manual(4, { kind:'QA_DIRECT_PASS' }),
    manual(5, { exclusion:'SELF_REVIEW' }), manual(6, { exclusion:'SIMULATED' }), manual(7, { accountId:null })];
  const summary = summarizePersonalQa(rows);
  assert.equal(summary.actualOperations, 3);
  assert.equal(summary.processingCoverage, 3);
  assert.equal(summary.discarded, 1);
  assert.equal(summary.escalated, 1);
  assert.equal(personalQaMetricRows(rows, [], 'qaDiscarded').length, 1);
  assert.equal(personalQaMetricRows(rows, [], 'qaEscalated').length, 1);
});

test('historical incomplete scopes report a confirmed lower bound instead of guessed coverage', () => {
  const unknown = { ...manual(2), kind:'QA_BATCH_RETURN', freezeId:7, affectedCount:100 };
  const activity = buildPersonalQaActivity([manual(1), unknown], [{ kind:'COVERAGE_UNKNOWN', stage:'IMAGE' }]);
  assert.equal(activity.covered.length, 1);
  assert.equal(activity.coverageIncomplete, true);
  assert.equal(summarizePersonalQa([manual(1)], [{ kind:'COVERAGE_UNKNOWN', stage:'IMAGE' }], 'COPY').coverageIncomplete, false);
});

test('coverage detail merges source labels, preserves manual counters and counts repeated batches once per item', () => {
  const rows = [manual(1)];
  const coverage = [affected(1), affected(1, 'BATCH_RETURN'), affected(1, 'BATCH_RETURN', {
    id:'later-batch:1', operationKey:'later-batch' })];
  const summary = summarizePersonalQa(rows, coverage);
  assert.equal(summary.processingCoverage, 1);
  assert.equal(summary.actualOperations, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.batchActions, 3);
  assert.deepEqual(personalQaMetricRows(rows, coverage, 'qaCoverage')[0].coverageSources,
    ['DIRECT', 'BATCH_RETURN', 'BATCH_RELEASE']);
});
