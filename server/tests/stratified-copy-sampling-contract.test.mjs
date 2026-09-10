import assert from 'node:assert/strict';
import test from 'node:test';

import { selectStratifiedCopySample } from '../src/stratified-copy-sampling.mjs';

const digest = (value) => Number(value).toString(16).padStart(64, '0');

function member(taskId, finalApproverAccountId, patch = {}) {
  return {
    taskId,
    copyRevisionId: 1_000 + taskId,
    approvalEventId: 2_000 + taskId,
    finalApproverAccountId,
    contentSha256: digest(taskId),
    ...patch,
  };
}

test('zero and full sampling preserve the complete frozen population with exact quotas', () => {
  const population = [member(1, 11), member(2, 11), member(3, 22), member(4, 22)];
  const none = selectStratifiedCopySample({ population, rateBps: 0, seed: 'boundary-none' });
  assert.equal(none.populationCount, 4);
  assert.equal(none.sampleCount, 0);
  assert.ok(none.members.every((item) => item.selected === false));
  assert.deepEqual(none.strata.map((item) => item.quota), [0, 0]);

  const all = selectStratifiedCopySample({ population, rateBps: 10_000, seed: 'boundary-all' });
  assert.equal(all.populationCount, 4);
  assert.equal(all.sampleCount, 4);
  assert.ok(all.members.every((item) => item.selected === true));
  assert.deepEqual(all.strata.map((item) => item.quota), [2, 2]);
});

test('the frozen version identity participates in both ranking and the snapshot digest', () => {
  const baseline = [member(1, 11), member(2, 11), member(3, 11)];
  const first = selectStratifiedCopySample({ population: baseline, rateBps: 5_000, seed: 'version-bound' });
  for (const patch of [
    { copyRevisionId: 9_001 },
    { approvalEventId: 9_002 },
    { contentSha256: digest(9_003) },
  ]) {
    const changed = selectStratifiedCopySample({
      population: [{ ...baseline[0], ...patch }, ...baseline.slice(1)],
      rateBps: 5_000,
      seed: 'version-bound',
    });
    assert.notEqual(changed.members[0].rankHash, first.members[0].rankHash);
    assert.notEqual(changed.snapshotSha256, first.snapshotSha256);
  }
});

test('sampling is pure and rejects identities that cannot support an immutable audit', () => {
  const population = [member(2, 20), member(1, 10)];
  const before = structuredClone(population);
  const result = selectStratifiedCopySample({ population, rateBps: 2_500, seed: 'pure' });
  assert.deepEqual(population, before);
  assert.deepEqual(result.members.map((item) => item.taskId), [1, 2]);

  for (const invalid of [
    [],
    [member(1, 0)],
    [{ ...member(1, 10), approvalEventId: null }],
    [member(1, 10), { ...member(2, 20), approvalEventId: 2_001 }],
  ]) {
    assert.throws(() => selectStratifiedCopySample({
      population: invalid,
      rateBps: 1_000,
      seed: 'invalid',
    }));
  }
  for (const rateBps of [-1, 1.5, 10_001]) {
    assert.throws(() => selectStratifiedCopySample({ population, rateBps, seed: 'invalid-rate' }));
  }
});

test('per-approver quotas sum exactly to the ceil batch target', () => {
  const population = [
    ...Array.from({ length: 7 }, (_, index) => member(index + 1, 10)),
    ...Array.from({ length: 2 }, (_, index) => member(index + 8, 20)),
    member(10, 30),
  ];
  const result = selectStratifiedCopySample({ population, rateBps: 2_501, seed: 'quota' });
  assert.equal(result.sampleCount, 3);
  assert.equal(result.strata.reduce((sum, item) => sum + item.quota, 0), 3);
  for (const stratum of result.strata) {
    assert.equal(
      result.members.filter((item) => item.finalApproverAccountId === stratum.finalApproverAccountId
        && item.selected).length,
      stratum.quota,
    );
  }
});

test('the v1 algorithm has a cross-process golden vector', () => {
  const population = [
    member(1, 10), member(2, 10), member(3, 20), member(4, 20), member(5, 30),
  ];
  const result = selectStratifiedCopySample({
    population,
    rateBps: 4_000,
    seed: 'golden-batch-v1',
  });
  assert.equal(result.snapshotSha256, 'ebad01e5f3059e70100fc04a25b470420ccb0b006012000d40105c77ce0e2ca8');
  assert.deepEqual(
    result.members.filter((item) => item.selected).map((item) => item.taskId),
    [2, 4],
  );
  assert.deepEqual(result.members.map((item) => item.rankHash), [
    'e3d3edc6a16c05a632cce5ac148332e865a39212c1c0dd64fe5478b6dca29764',
    'c9bf0d4f050d9c5efdc9274cb68e8e443914c8760cc6481ceeaf886d10760295',
    '57bb564d2d34d061e5ebf35ec81fed346bffb9c3c3f3febca1df84f45fb908e1',
    '090bb8d7f38aec0a8fc22a253dddda2bf6c47701c1e977c646b4a6fe4749505c',
    'c3be381d51f50ffc5cc537555d2d3374b1e2748b3798b02e14bc2976faab1230',
  ]);
});

test('equal quota remainders use the frozen seed instead of permanently favoring low account ids', () => {
  const population = [member(1, 10), member(2, 20), member(3, 30)];
  const winner = (seed) => selectStratifiedCopySample({ population, rateBps: 1, seed })
    .strata.find((item) => item.quota === 1)?.finalApproverAccountId;
  assert.equal(winner('tie-0'), 20);
  assert.equal(winner('tie-7'), 30);
});
