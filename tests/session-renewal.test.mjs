import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ADMIN_SESSION_COOKIE,
  createSessionToken,
  serializeAdminSessionCookie,
  verifySessionToken,
} from '../src/admin/auth.mjs';
import {
  getSessionMetadata,
  readRequestSession,
  renewRequestSession,
} from '../src/admin/session-renewal.mjs';
import {
  ADMIN_SESSION_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_RENEW_BEFORE_SECONDS,
} from '../src/admin/session-policy.mjs';

const secret = 'test-session-secret-with-at-least-32-characters';
const nowSeconds = 1_800_000_000;
const actor = {
  userId: 42,
  username: 'query-qc-01',
  roles: ['QUERY_REVIEWER'],
  credentialVersion: 3,
};
const user = {
  id: actor.userId,
  username: actor.username,
  role: actor.roles[0],
  credentialVersion: actor.credentialVersion,
  status: 'ACTIVE',
  displayName: '审核人员',
  mustChangePassword: false,
  copyReviewEnabled: false,
  copyQcEnabled: false,
  imageQcEnabled: true,
};

function signedClaims(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function claimsFor(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function nearExpiryToken(options = {}) {
  return createSessionToken(secret, {
    nowSeconds: nowSeconds - ADMIN_SESSION_SECONDS + SESSION_RENEW_BEFORE_SECONDS,
    actor,
    renewal: {},
    ...options,
  });
}

function requestFor(token) {
  return new Request('http://127.0.0.1:3001/api/auth/renew', {
    method: 'POST',
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  });
}

function renew(token, overrides = {}) {
  const session = verifySessionToken(token, secret, { nowSeconds, includeMetadata: true });
  return renewRequestSession(requestFor(token), {
    sessionSecret: secret,
    controlPlaneRoot: 'http://control-plane.invalid',
    expectedSessionId: session?.sessionId || 'AAAAAAAAAAAAAAAAAAAAAA',
    fetchImpl: async () => Response.json({ data: user }),
    now: () => nowSeconds,
    ...overrides,
  });
}

describe('renewable signed sessions', () => {
  it('carries a stable session id and original authentication time in v3', () => {
    const token = nearExpiryToken();
    const session = verifySessionToken(token, secret, { nowSeconds });
    assert.equal(claimsFor(token).v, 3);
    assert.equal(session.authenticatedAt, nowSeconds - (7 * 60 * 60));
    assert.equal(session.expiresAt, nowSeconds + SESSION_RENEW_BEFORE_SECONDS);
    assert.equal(session.absoluteExpiresAt, session.authenticatedAt + SESSION_ABSOLUTE_SECONDS);
    assert.match(session.sessionId, /^[A-Za-z0-9_-]{22}$/u);
  });

  it('expires exactly at the eight-hour boundary', () => {
    const token = createSessionToken(secret, { nowSeconds, actor, renewal: {} });
    assert.ok(verifySessionToken(token, secret, { nowSeconds: nowSeconds + ADMIN_SESSION_SECONDS - 1 }));
    assert.equal(verifySessionToken(token, secret, { nowSeconds: nowSeconds + ADMIN_SESSION_SECONDS }), null);
  });

  it('accepts a truncated lifetime at seven days and expires at that boundary', () => {
    const token = createSessionToken(secret, {
      nowSeconds,
      actor,
      renewal: { authenticatedAt: nowSeconds - SESSION_ABSOLUTE_SECONDS + 900 },
    });
    const session = verifySessionToken(token, secret, { nowSeconds });
    assert.equal(session.expiresAt, nowSeconds + 900);
    assert.ok(verifySessionToken(token, secret, { nowSeconds: nowSeconds + 899 }));
    assert.equal(verifySessionToken(token, secret, { nowSeconds: nowSeconds + 900 }), null);
    assert.throws(() => createSessionToken(secret, {
      nowSeconds: nowSeconds + 900,
      actor,
      renewal: { authenticatedAt: session.authenticatedAt },
    }), /claims/i);
  });

  it('rejects invalid, missing, or oversized signed claims', () => {
    const validClaims = claimsFor(nearExpiryToken());
    const invalidClaims = [
      { authAt: undefined },
      { authAt: -1 },
      { authAt: validClaims.iat + 1 },
      { authAt: '1800000000' },
      { sid: undefined },
      { sid: 'short' },
      { sid: 'AAAAAAAAAAAAAAAAAAAAAB' },
      { exp: validClaims.exp + 1 },
      { exp: validClaims.iat },
      { iat: nowSeconds + 61, exp: nowSeconds + 61 + ADMIN_SESSION_SECONDS },
      { uid: 0 },
      { cv: 0 },
      { roles: ['QUERY_REVIEWER', 'QUERY_REVIEWER'] },
      { roles: ['SUPERUSER'] },
      { cre: 'true' },
      { v: 4 },
    ];
    for (const invalid of invalidClaims) {
      assert.equal(verifySessionToken(signedClaims({ ...validClaims, ...invalid }), secret, { nowSeconds }), null,
        JSON.stringify(invalid));
    }
    assert.equal(verifySessionToken('A'.repeat(8_193), secret, { nowSeconds }), null);
    assert.equal(verifySessionToken(nearExpiryToken(), secret, { nowSeconds: NaN }), null);
    assert.throws(() => createSessionToken(secret, { nowSeconds, renewal: {} }), /identity/i);
    assert.throws(() => createSessionToken(secret, {
      nowSeconds, actor, renewal: { authenticatedAt: nowSeconds + 1 },
    }), /claims/i);
  });

  it('preserves legacy verifier shapes while explicitly providing migration metadata', () => {
    const token = nearExpiryToken({ renewal: null });
    const basic = verifySessionToken(token, secret, { nowSeconds });
    assert.equal(basic.sessionId, undefined);
    assert.equal(basic.authenticatedAt, undefined);
    const enriched = verifySessionToken(token, secret, { nowSeconds, includeMetadata: true });
    assert.equal(enriched.sessionId, claimsFor(token).jti);
    assert.equal(enriched.authenticatedAt, basic.issuedAt);
    assert.equal(enriched.absoluteExpiresAt, basic.issuedAt + SESSION_ABSOLUTE_SECONDS);
  });

  it('serializes the actual remaining token lifetime using the existing secure attributes', () => {
    const cookie = serializeAdminSessionCookie(nearExpiryToken(), { secure: true, maxAge: 900 });
    assert.match(cookie, /Max-Age=900(?:;|$)/u);
    for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Priority=High', 'Secure']) {
      assert.ok(cookie.includes(attribute), attribute);
    }
    for (const maxAge of [0, -1, 900.5, ADMIN_SESSION_SECONDS + 1, Infinity]) {
      assert.throws(() => serializeAdminSessionCookie('token', { maxAge }), /lifetime/i);
    }
  });
});

describe('session renewal against the current central identity', () => {
  it('renews exactly at the one-hour threshold using the old immutable actor claims', async () => {
    const oldToken = nearExpiryToken();
    const original = verifySessionToken(oldToken, secret, { nowSeconds });
    let calls = 0;
    const result = await renew(oldToken, {
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, 'http://control-plane.invalid/v1/profile');
        assert.equal(options.method, 'GET');
        assert.equal(options.cache, 'no-store');
        assert.deepEqual(options.headers, {
          'X-Actor-User-Id': '42',
          'X-Actor-Username': 'query-qc-01',
          'X-Actor-Role': 'QUERY_REVIEWER',
          'X-Actor-Credential-Version': '3',
        });
        return Response.json({ data: user });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.renewed, true);
    assert.notEqual(result.token, oldToken);
    assert.notEqual(claimsFor(result.token).jti, claimsFor(oldToken).jti);
    assert.equal(result.maxAge, ADMIN_SESSION_SECONDS);
    const renewed = verifySessionToken(result.token, secret, { nowSeconds });
    assert.equal(renewed.sessionId, original.sessionId);
    assert.equal(renewed.authenticatedAt, original.authenticatedAt);
    assert.equal(renewed.absoluteExpiresAt, original.absoluteExpiresAt);
    assert.equal(renewed.expiresAt, nowSeconds + ADMIN_SESSION_SECONDS);
    assert.equal(renewed.credentialVersion, actor.credentialVersion);
    assert.equal(renewed.imageQcEnabled, true);
    assert.deepEqual(result.metadata, {
      sessionId: original.sessionId,
      userId: 42,
      expiresAt: renewed.expiresAt,
      absoluteExpiresAt: original.absoluteExpiresAt,
      renewable: true,
      serverTime: nowSeconds,
    });
  });

  it('does not write a token or contact the center before the threshold', async () => {
    const token = nearExpiryToken({ nowSeconds: nowSeconds - (7 * 60 * 60) + 1 });
    const result = await renew(token, { fetchImpl: () => assert.fail('early renewal contacted the center') });
    assert.equal(result.renewed, false);
    assert.equal(result.token, null);
    assert.equal(result.maxAge, null);
  });

  it('migrates legacy user sessions without resetting the absolute deadline or stable id', async () => {
    const oldToken = nearExpiryToken({ renewal: null });
    const legacyClaims = claimsFor(oldToken);
    const result = await renew(oldToken);
    const renewed = verifySessionToken(result.token, secret, { nowSeconds });
    assert.equal(claimsFor(result.token).v, 3);
    assert.equal(renewed.sessionId, legacyClaims.jti);
    assert.equal(renewed.authenticatedAt, legacyClaims.iat);
    assert.equal(renewed.absoluteExpiresAt, legacyClaims.iat + SESSION_ABSOLUTE_SECONDS);
  });

  it('ignores fake migration timing attached to a legacy payload', async () => {
    const token = nearExpiryToken({ renewal: null });
    const claims = claimsFor(token);
    const result = await renew(signedClaims({ ...claims, authAt: nowSeconds, sid: 'AAAAAAAAAAAAAAAAAAAAAA' }));
    const renewed = verifySessionToken(result.token, secret, { nowSeconds });
    assert.equal(renewed.authenticatedAt, claims.iat);
    assert.equal(renewed.sessionId, claims.jti);
  });

  it('caps the final renewal at seven days and does not replace that final token again', async () => {
    const authenticatedAt = nowSeconds - SESSION_ABSOLUTE_SECONDS + 7_200;
    const token = nearExpiryToken({ renewal: { authenticatedAt } });
    const result = await renew(token);
    assert.equal(result.maxAge, 7_200);
    assert.equal(result.metadata.expiresAt, authenticatedAt + SESSION_ABSOLUTE_SECONDS);
    const final = await renew(result.token, {
      now: () => nowSeconds + 6_300,
      fetchImpl: () => assert.fail('the capped token must not be replaced'),
    });
    assert.equal(final.renewed, false);
    assert.equal(final.token, null);
  });

  it('rejects a different session id without contacting the center or changing the cookie', async () => {
    await assert.rejects(() => renew(nearExpiryToken(), {
      expectedSessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
      fetchImpl: () => assert.fail('wrong session contacted the center'),
    }), (error) => error.status === 409 && error.code === 'SESSION_CHANGED');
  });

  it('requires a valid unexpired uniquely supplied cookie and does not revive expiry', async () => {
    const expired = nearExpiryToken({ nowSeconds: nowSeconds - ADMIN_SESSION_SECONDS });
    const noFetch = () => assert.fail('invalid cookie contacted the center');
    await assert.rejects(() => renew(expired, { fetchImpl: noFetch }), (error) => error.status === 401);
    const token = nearExpiryToken();
    const duplicate = new Request('http://127.0.0.1:3001/api/auth/renew', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}; ${ADMIN_SESSION_COOKIE}=${token}` },
    });
    assert.equal(readRequestSession(duplicate, secret, { nowSeconds }), null);
    assert.equal(readRequestSession(requestFor(`${token}x`), secret, { nowSeconds }), null);
    await assert.rejects(() => renew(token, {
      now: (() => {
        let calls = 0;
        return () => calls++ === 0 ? nowSeconds : nowSeconds + SESSION_RENEW_BEFORE_SECONDS;
      })(),
    }), (error) => error.status === 401);
  });

  it('keeps legacy admin tokens valid for reading but requires a fresh user login to renew', async () => {
    const token = nearExpiryToken({ actor: null, renewal: null });
    const session = readRequestSession(requestFor(token), secret, { nowSeconds });
    assert.equal(session.subject, 'admin');
    assert.equal(getSessionMetadata(session, { nowSeconds }).renewable, false);
    assert.equal(getSessionMetadata(session, { nowSeconds }).userId, null);
    await assert.rejects(() => renew(token, {
      fetchImpl: () => assert.fail('legacy admin contacted the center'),
    }), (error) => error.status === 401 && error.code === 'SESSION_REAUTH_REQUIRED');
  });

  it('does not upgrade stale ids, usernames, roles, credential versions, or disabled accounts', async () => {
    for (const changed of [
      { id: 99 }, { username: 'other-user' }, { role: 'ADMIN' }, { credentialVersion: 4 }, { status: 'DISABLED' },
    ]) {
      await assert.rejects(() => renew(nearExpiryToken(), {
        fetchImpl: async () => Response.json({ data: { ...user, ...changed } }),
      }), (error) => error.status === 401 && error.code === 'SESSION_STALE', JSON.stringify(changed));
    }
    await assert.rejects(() => renew(nearExpiryToken(), {
      fetchImpl: async () => Response.json({ error: { code: 'SESSION_STALE' } }, { status: 401 }),
    }), (error) => error.status === 401);
  });

  it('classifies unavailable or malformed upstream responses as transient failures', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('network down'); },
      async () => new Response('', { status: 503 }),
      async () => new Response('', { status: 403 }),
      async () => new Response('invalid JSON'),
      async () => Response.json({ data: null }),
      async () => Response.json({ data: { ...user, credentialVersion: '3' } }),
      async () => Response.json({ data: { ...user, imageQcEnabled: 'true' } }),
    ]) {
      await assert.rejects(() => renew(nearExpiryToken(), { fetchImpl }),
        (error) => error.status === 503 && error.code === 'CONTROL_PLANE_UNAVAILABLE');
    }
  });

  it('does not accept forged renewal parameters', async () => {
    for (const expectedSessionId of [null, '', 'short', 'A'.repeat(23), 42]) {
      await assert.rejects(() => renew(nearExpiryToken(), { expectedSessionId }), (error) => error.status === 400);
    }
  });
});
