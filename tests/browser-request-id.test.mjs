import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestId } from '../app/components/request-id.ts';

test('request IDs prefer the browser native random UUID implementation', () => {
  const expected = '11111111-2222-4333-8444-555555555555';
  let fallbackCalled = false;
  const requestId = createRequestId({
    randomUUID: () => expected,
    getRandomValues: (bytes) => {
      fallbackCalled = true;
      return bytes;
    },
  });

  assert.equal(requestId, expected);
  assert.equal(fallbackCalled, false);
});

test('request IDs remain valid when randomUUID is unavailable outside a secure context', () => {
  const requestId = createRequestId({
    getRandomValues: (bytes) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  });

  assert.equal(requestId, '00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
