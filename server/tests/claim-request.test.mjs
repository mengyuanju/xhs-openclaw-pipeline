import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { claimRequestExpiry } from '../src/claim-request.mjs';
import { requestIdAt } from './fixtures/claim-request-id.mjs';

test('claim timestamps reject old IDs, UUIDv4 and excessive future clock skew', () => {
  const now = Date.now();
  assert.equal(claimRequestExpiry(requestIdAt(now), now).getTime(), now + 86_400_000);
  assert.throws(() => claimRequestExpiry(randomUUID(), now), /UUIDv7/);
  assert.throws(() => claimRequestExpiry(requestIdAt(now - 86_400_000), now), { code: 'CLAIM_REQUEST_EXPIRED' });
  assert.throws(() => claimRequestExpiry(requestIdAt(now + 300_001), now), { code: 'CLAIM_REQUEST_CLOCK_SKEW' });
});
