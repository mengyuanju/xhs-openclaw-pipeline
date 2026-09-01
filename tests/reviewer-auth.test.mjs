import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LoginRateLimiter,
  attemptReviewUserLogin,
  createSessionToken,
  hashAdminPassword,
  verifySessionToken,
} from '../src/admin/auth.mjs';
import { assertAuthorizedSession } from '../src/admin/http.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

const SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';

describe('reviewer session authentication', () => {
  it('signs the minimum reviewer identity and validated roles', () => {
    const issuedAt = 1_800_000_000;
    const token = createSessionToken(SESSION_SECRET, {
      nowSeconds: issuedAt,
      actor: {
        userId: 42,
        username: 'query-qc-01',
        roles: ['QUERY_REVIEWER', 'QC_LEAD'],
        credentialVersion: 3,
      },
    });

    assert.deepEqual(verifySessionToken(token, SESSION_SECRET, {
      nowSeconds: issuedAt + 60,
    }), {
      subject: 'user',
      userId: 42,
      username: 'query-qc-01',
      roles: ['QUERY_REVIEWER', 'QC_LEAD'],
      credentialVersion: 3,
      issuedAt,
      expiresAt: issuedAt + (8 * 60 * 60),
    });
  });

  it('rejects unknown roles and malformed reviewer identity before signing', () => {
    assert.throws(() => createSessionToken(SESSION_SECRET, {
      actor: {
        userId: 1,
        username: 'reviewer',
        roles: ['SUPERUSER'],
        credentialVersion: 1,
      },
    }), /role/i);
    assert.throws(() => createSessionToken(SESSION_SECRET, {
      actor: {
        userId: 0,
        username: 'reviewer',
        roles: ['COPY_REVIEWER'],
        credentialVersion: 1,
      },
    }), /user/i);
  });

  it('keeps the existing administrator token contract unchanged', () => {
    const issuedAt = 1_800_000_000;
    const token = createSessionToken(SESSION_SECRET, { nowSeconds: issuedAt });

    assert.deepEqual(verifySessionToken(token, SESSION_SECRET, {
      nowSeconds: issuedAt + 1,
    }), {
      subject: 'admin',
      issuedAt,
      expiresAt: issuedAt + (8 * 60 * 60),
    });
  });

  it('authenticates an active reviewer without revealing whether a username exists', async () => {
    const passwordHash = await hashAdminPassword('correct horse battery staple');
    const lookupUser = (username) => username === 'query-qc-01' ? {
      id: 7,
      username,
      passwordHash,
      roles: ['QUERY_REVIEWER'],
      credentialVersion: 1,
    } : null;

    const authenticated = await attemptReviewUserLogin({
      username: 'query-qc-01',
      password: 'correct horse battery staple',
      lookupUser,
      sessionSecret: SESSION_SECRET,
      limiter: new LoginRateLimiter(),
    });
    const missing = await attemptReviewUserLogin({
      username: 'missing-user',
      password: 'correct horse battery staple',
      lookupUser,
      sessionSecret: SESSION_SECRET,
      limiter: new LoginRateLimiter(),
    });

    assert.equal(authenticated.status, 'authenticated');
    assert.equal(verifySessionToken(authenticated.token, SESSION_SECRET).userId, 7);
    assert.deepEqual(missing, { status: 'invalid' });
  });

  it('enforces role allowlists and keeps reviewers inside the review center', () => {
    const reviewerSession = {
      subject: 'user',
      userId: 7,
      username: 'query-qc-01',
      roles: ['QUERY_REVIEWER'],
      credentialVersion: 1,
    };
    assert.doesNotThrow(() => assertAuthorizedSession(reviewerSession, ['QUERY_REVIEWER']));
    assert.throws(() => assertAuthorizedSession(reviewerSession, ['ADMIN']), (error) => error?.status === 403);

    const environment = {
      XHS_ADMIN_PASSWORD_HASH: 'scrypt-v1.MDEyMzQ1Njc4OWFiY2RlZg.MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg',
      XHS_SESSION_SECRET: SESSION_SECRET,
    };
    const token = createSessionToken(SESSION_SECRET, { actor: reviewerSession });
    const headers = { cookie: `xhs_admin_session=${token}` };
    assert.deepEqual(evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/reviews', { headers }),
      environment,
    ), { type: 'next' });
    assert.deepEqual(evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/api/review-task-assignments/1/assets/2', { headers }),
      environment,
    ), { type: 'next' });
    assert.deepEqual(evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/login?reauth=1', { headers }),
      environment,
    ), { type: 'next' });
    assert.deepEqual(evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/tasks', { headers }),
      environment,
    ), { type: 'forbidden' });
    assert.deepEqual(evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/login', { headers }),
      environment,
    ), { type: 'redirect', location: '/reviews' });
  });
});
