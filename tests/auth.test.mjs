import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LoginRateLimiter,
  createSessionToken,
  hashAdminPassword,
  readAuthConfig,
  verifyAdminPassword,
  verifySessionToken,
} from '../src/admin/auth.mjs';

const SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';

describe('admin password authentication', () => {
  it('hashes a strong password with a unique salt and verifies it', async () => {
    const password = 'correct horse battery staple';
    const first = await hashAdminPassword(password);
    const second = await hashAdminPassword(password);

    assert.match(first, /^scrypt-v1\./);
    assert.notEqual(first, second);
    assert.equal(await verifyAdminPassword(password, first), true);
    assert.equal(await verifyAdminPassword('wrong password', first), false);
  });

  it('rejects weak passwords and malformed stored hashes', async () => {
    await assert.rejects(() => hashAdminPassword('too-short'), /at least 12/i);
    assert.equal(await verifyAdminPassword('any password here', 'not-a-hash'), false);
  });
});

describe('admin session authentication', () => {
  it('accepts an unexpired signed session and rejects tampering or expiry', () => {
    const issuedAt = 1_800_000_000;
    const token = createSessionToken(SESSION_SECRET, { nowSeconds: issuedAt });

    assert.deepEqual(verifySessionToken(token, SESSION_SECRET, {
      nowSeconds: issuedAt + 60,
    }), {
      subject: 'admin',
      issuedAt,
      expiresAt: issuedAt + (8 * 60 * 60),
    });
    assert.equal(verifySessionToken(`${token}x`, SESSION_SECRET, {
      nowSeconds: issuedAt + 60,
    }), null);
    assert.equal(verifySessionToken(token, SESSION_SECRET, {
      nowSeconds: issuedAt + (8 * 60 * 60),
    }), null);
    assert.equal(verifySessionToken(token, `${SESSION_SECRET}-different`, {
      nowSeconds: issuedAt + 60,
    }), null);
  });

  it('fails closed when authentication environment variables are missing or weak', () => {
    assert.equal(readAuthConfig({}), null);
    assert.equal(readAuthConfig({
      XHS_ADMIN_PASSWORD_HASH: 'scrypt-v1.bad',
      XHS_SESSION_SECRET: 'short',
    }), null);
  });
});

describe('login rate limiting', () => {
  it('blocks after five failures in fifteen minutes and resets after success', () => {
    const limiter = new LoginRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000 });
    const startedAt = 10_000;

    for (let index = 0; index < 5; index += 1) {
      assert.equal(limiter.check(startedAt + index).allowed, true);
      limiter.recordFailure(startedAt + index);
    }
    const blocked = limiter.check(startedAt + 10);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);

    limiter.reset();
    assert.equal(limiter.check(startedAt + 11).allowed, true);
  });

  it('forgets failures outside the configured window', () => {
    const limiter = new LoginRateLimiter({ maxFailures: 1, windowMs: 1_000 });
    limiter.recordFailure(2_000);

    assert.equal(limiter.check(2_500).allowed, false);
    assert.equal(limiter.check(3_001).allowed, true);
  });
});
