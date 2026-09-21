import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLoginRateLimitStore } from '../src/admin/login-rate-limits.mjs';

describe('shared login rate limits', () => {
  it('releases account and global login blocks immediately', () => {
    const limits = createLoginRateLimitStore({
      accountMaxFailures: 2,
      globalMaxFailures: 3,
      windowMs: 60_000,
    });
    const startedAt = 10_000;

    limits.recordFailure('alice', startedAt);
    limits.recordFailure('alice', startedAt + 1);
    assert.deepEqual(limits.check('alice', startedAt + 2), {
      allowed: false,
      retryAfterSeconds: 60,
      scope: 'account',
    });

    limits.recordFailure('bob', startedAt + 3);
    assert.deepEqual(limits.check('carol', startedAt + 4), {
      allowed: false,
      retryAfterSeconds: 60,
      scope: 'global',
    });

    assert.deepEqual(limits.resetAll(), { clearedAccountCount: 2 });
    assert.deepEqual(limits.check('alice', startedAt + 5), {
      allowed: true,
      retryAfterSeconds: 0,
      scope: 'account',
    });
  });

  it('clears one account after a successful login without clearing global failures', () => {
    const limits = createLoginRateLimitStore({
      accountMaxFailures: 1,
      globalMaxFailures: 2,
      windowMs: 60_000,
    });

    limits.recordFailure('alice', 1_000);
    assert.equal(limits.resetAccount('alice'), true);
    assert.equal(limits.check('alice', 1_001).allowed, true);

    limits.recordFailure('bob', 1_002);
    assert.deepEqual(limits.check('carol', 1_003), {
      allowed: false,
      retryAfterSeconds: 60,
      scope: 'global',
    });
  });
});
