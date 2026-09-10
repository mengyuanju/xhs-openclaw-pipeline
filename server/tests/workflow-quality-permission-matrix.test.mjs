import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertQueryPackageImportAllowed,
  assertReviewerBatchReturnAllowed,
  normalizeWorkflowQualitySettings,
} from '../src/workflow-quality-settings.mjs';

function settings({ workerImportEnabled = false, blindReviewEnabled = false,
  reviewerBatchReturnEnabled = false } = {}) {
  return normalizeWorkflowQualitySettings({
    queryPackage: { workerImportEnabled },
    copySampling: {
      enabled: true,
      rateBps: 2_000,
      blindReviewEnabled,
      reviewerBatchReturnEnabled,
    },
  });
}

function allowed(action) {
  try {
    action();
    return true;
  } catch (error) {
    assert.equal(error.code, 'FORBIDDEN');
    return false;
  }
}

test('the complete Query-package import permission matrix is server-enforceable', () => {
  for (const workerImportEnabled of [false, true]) {
    const current = settings({ workerImportEnabled });
    assert.equal(allowed(() => assertQueryPackageImportAllowed({ role: 'ADMIN' }, current)), true);
    assert.equal(
      allowed(() => assertQueryPackageImportAllowed({ role: 'USER' }, current)),
      workerImportEnabled,
    );
    assert.equal(allowed(() => assertQueryPackageImportAllowed({ role: 'REVIEWER' }, current)), false);
  }
});

test('reviewer batch return depends only on its own switch', () => {
  for (const blindReviewEnabled of [false, true]) {
    for (const workerImportEnabled of [false, true]) {
      for (const reviewerBatchReturnEnabled of [false, true]) {
        const current = settings({
          blindReviewEnabled,
          workerImportEnabled,
          reviewerBatchReturnEnabled,
        });
        assert.equal(
          allowed(() => assertReviewerBatchReturnAllowed({ role: 'ADMIN' }, current)),
          true,
        );
        assert.equal(
          allowed(() => assertReviewerBatchReturnAllowed({ role: 'REVIEWER' }, current)),
          reviewerBatchReturnEnabled,
        );
        assert.equal(
          allowed(() => assertReviewerBatchReturnAllowed({ role: 'USER' }, current)),
          false,
        );
      }
    }
  }
});

test('partial settings updates preserve all independent controls', () => {
  const original = settings({
    workerImportEnabled: true,
    blindReviewEnabled: true,
    reviewerBatchReturnEnabled: false,
  });
  const changed = normalizeWorkflowQualitySettings({
    copySampling: { reviewerBatchReturnEnabled: true },
  }, original);
  assert.deepEqual(changed, {
    queryPackage: { workerImportEnabled: true },
    copySampling: {
      enabled: true,
      rateBps: 2_000,
      blindReviewEnabled: true,
      reviewerBatchReturnEnabled: true,
    },
  });
});
