import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createActionLock } from '../src/control-plane/action-lock.mjs';

test('action lock rejects repeated starts until the active action settles', () => {
  const lock = createActionLock();

  assert.equal(lock.acquire(), true);
  assert.equal(lock.isLocked(), true);
  assert.equal(lock.acquire(), false);

  lock.release();

  assert.equal(lock.isLocked(), false);
  assert.equal(lock.acquire(), true);
});
