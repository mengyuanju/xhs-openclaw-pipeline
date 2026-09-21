import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimDeliveryPreviewRevocationJobs,
  failDeliveryPreviewRevocationJob,
  markDeliveryPreviewRevoked,
  withdrawReadyDeliveryEntries,
} from '../src/final-delivery.mjs';

const previewId = '33333333-3333-4333-8333-333333333333';

test('delivery withdrawal and preview revocation are joined by a durable idempotent job', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (String(sql).includes('UPDATE delivery_entries') && String(sql).includes("status = 'WITHDRAWN'")) {
        return { rows: [{ id: 71, task_id: 7, preview_id: previewId, preview_status: 'REVOKING' }] };
      }
      return { rows: [] };
    },
  };
  assert.deepEqual(await withdrawReadyDeliveryEntries(database, 7, 'image_revision'), {
    withdrawnCount: 1,
    revocationCount: 1,
  });
  const withdrawal = calls[0];
  assert.match(withdrawal.sql, /status = 'WITHDRAWN'/u);
  assert.match(withdrawal.sql, /preview_status IN \('PUBLISHED', 'REVOKE_FAILED'\)/u);
  const job = calls[1];
  assert.deepEqual(job.values, [previewId, 71, 7, 'IMAGE_REVISION']);
  assert.match(job.sql, /ON CONFLICT\(preview_id\) DO UPDATE/u);
  assert.match(job.sql, /next_attempt_at = now\(\)/u);
});

test('revocation jobs use leasing, bounded exponential retry and atomic completion', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (String(sql).includes('UPDATE delivery_preview_revocation_jobs AS job')) {
        return { rows: [{ id: 8, preview_id: previewId, attempt_count: 3 }] };
      }
      return { rows: [] };
    },
  };
  assert.deepEqual(await claimDeliveryPreviewRevocationJobs(database, 5), [{
    id: 8,
    previewId,
    attemptCount: 3,
  }]);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/u);
  assert.match(calls[0].sql, /lease_expires_at/u);

  await failDeliveryPreviewRevocationJob(database, 8, new Error('Bearer secret-token failed'));
  assert.match(calls[1].sql, /attempt_count >= 12/u);
  assert.match(calls[1].sql, /power\(2/u);
  assert.equal(calls[1].values[0], 8);
  assert.equal(calls[1].values[1], 'Bearer [REDACTED_TOKEN] failed');

  const revokedAt = new Date('2026-09-13T12:00:00.000Z');
  await markDeliveryPreviewRevoked(database, previewId, revokedAt);
  assert.match(calls[2].sql, /status = 'COMPLETED'/u);
  assert.match(calls[2].sql, /preview_status = 'REVOKED'/u);
  assert.deepEqual(calls[2].values, [previewId, revokedAt]);
});
