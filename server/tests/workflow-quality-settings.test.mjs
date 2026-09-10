import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertQueryPackageImportAllowed,
  assertReviewerBatchReturnAllowed,
  normalizeWorkflowQualitySettings,
  updateWorkflowQualitySettings,
} from '../src/workflow-quality-settings.mjs';

const settings = normalizeWorkflowQualitySettings({
  queryPackage: { workerImportEnabled: false },
  copySampling: {
    enabled: true,
    rateBps: 2500,
    blindReviewEnabled: true,
    reviewerBatchReturnEnabled: false,
  },
});

test('worker import and reviewer batch-return permissions remain independent', () => {
  assert.doesNotThrow(() => assertQueryPackageImportAllowed({ role: 'ADMIN' }, settings));
  assert.throws(() => assertQueryPackageImportAllowed({ role: 'USER' }, settings), { code: 'FORBIDDEN' });
  assert.throws(() => assertReviewerBatchReturnAllowed({ role: 'REVIEWER' }, settings), { code: 'FORBIDDEN' });
  assert.doesNotThrow(() => assertReviewerBatchReturnAllowed({ role: 'ADMIN' }, settings));

  const enabled = normalizeWorkflowQualitySettings({
    queryPackage: { workerImportEnabled: true },
    copySampling: { reviewerBatchReturnEnabled: true },
  }, settings);
  assert.doesNotThrow(() => assertQueryPackageImportAllowed({ role: 'USER' }, enabled));
  assert.doesNotThrow(() => assertReviewerBatchReturnAllowed({ role: 'REVIEWER' }, enabled));
});

test('workflow quality settings validate exact basis-point limits', () => {
  assert.equal(normalizeWorkflowQualitySettings({ copySampling: { rateBps: 10_000 } }, settings)
    .copySampling.rateBps, 10_000);
  assert.throws(() => normalizeWorkflowQualitySettings({ copySampling: { rateBps: 10_001 } }, settings),
    /between 0 and 10000/u);
  assert.throws(() => normalizeWorkflowQualitySettings({ queryPackage: { workerImportEnabled: 'yes' } }, settings),
    /must be a boolean/u);
});

test('workflow quality settings reject an administrator revoked after request authentication', async () => {
  const queries = [];
  let actorValues = null;
  let released = false;
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/gu, ' ').trim();
      queries.push(normalized);
      if (normalized === 'BEGIN' || normalized === 'ROLLBACK') return { rows: [] };
      if (normalized.includes('FROM app_users')) {
        actorValues = values;
        return { rows: [] };
      }
      throw new Error(`settings query must not run after actor revocation: ${normalized}`);
    },
    release() { released = true; },
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(updateWorkflowQualitySettings(pool, {
    expectedVersion: 1,
    copySampling: { reviewerBatchReturnEnabled: true },
  }, {
    userId: 7,
    username: 'Admin',
    role: 'ADMIN',
    credentialVersion: 3,
  }), { code: 'SESSION_STALE' });

  assert.deepEqual(queries, [
    'BEGIN',
    "SELECT id FROM app_users WHERE id = $1 AND username = $2 AND role = 'ADMIN' AND status = 'ACTIVE' AND credential_version = $3 FOR SHARE",
    'ROLLBACK',
  ]);
  assert.deepEqual(actorValues, [7, 'admin', 3]);
  assert.equal(released, true);
});
