import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaimRequestId } from '../src/control-plane/claim-request.mjs';

test('claim IDs encode RFC 9562 UUIDv7 time with independent random identities', () => {
  // RFC 9562 Appendix A.6 timestamp example.
  const id = createClaimRequestId(1645557742000);
  assert.match(id, /^017f22e2-79b0-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(createClaimRequestId(1645557742000), id);
  for (const value of [-1, 1.5, 0x1000000000000]) assert.throws(() => createClaimRequestId(value), RangeError);
});
