import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPY_SAMPLING_ALGORITHM_VERSION,
  selectStratifiedCopySample,
} from '../src/stratified-copy-sampling.mjs';

function member(taskId, finalApproverAccountId) {
  return {
    taskId,
    copyRevisionId: 100 + taskId,
    approvalEventId: 200 + taskId,
    finalApproverAccountId,
    contentSha256: String(taskId).padStart(64, '0'),
  };
}

test('fixed stratified sampling uses an exact batch quota and stable membership', () => {
  const population = [
    member(1, 10), member(2, 10), member(3, 10), member(4, 10),
    member(5, 20), member(6, 20), member(7, 20),
    member(8, 30), member(9, 30), member(10, 30),
  ];
  const first = selectStratifiedCopySample({ population, rateBps: 3000, seed: 'batch-7-v1' });
  const reordered = selectStratifiedCopySample({
    population: population.toReversed(), rateBps: 3000, seed: 'batch-7-v1',
  });
  assert.equal(first.algorithmVersion, COPY_SAMPLING_ALGORITHM_VERSION);
  assert.equal(first.populationCount, 10);
  assert.equal(first.sampleCount, 3);
  assert.deepEqual(first.strata, [
    { finalApproverAccountId: 10, populationCount: 4, quota: 1 },
    { finalApproverAccountId: 20, populationCount: 3, quota: 1 },
    { finalApproverAccountId: 30, populationCount: 3, quota: 1 },
  ]);
  assert.deepEqual(reordered, first);
  assert.equal(first.members.filter((item) => item.selected).length, 3);
});

test('small batches use ceil without silently forcing one item per approver', () => {
  const sample = selectStratifiedCopySample({
    population: [member(1, 10), member(2, 20), member(3, 30)],
    rateBps: 1,
    seed: 'small',
  });
  assert.equal(sample.sampleCount, 1);
  assert.equal(sample.strata.reduce((total, item) => total + item.quota, 0), 1);
});

test('sampling rejects duplicate tasks and malformed hashes', () => {
  assert.throws(() => selectStratifiedCopySample({
    population: [member(1, 10), member(1, 20)], rateBps: 1000, seed: 'duplicate',
  }), /task ids must be unique/u);
  assert.throws(() => selectStratifiedCopySample({
    population: [{ ...member(1, 10), contentSha256: 'bad' }], rateBps: 1000, seed: 'bad',
  }), /SHA-256/u);
});
