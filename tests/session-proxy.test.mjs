import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_SESSION_COOKIE, createSessionToken, REVIEW_ACCOUNT_ROLES } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

const environment = { XHS_SESSION_SECRET: 'session-proxy-fixture-secret-at-least-32-bytes' };

test('every signed account can read its session and renew, including the forced password-change flow', () => {
  for (const role of REVIEW_ACCOUNT_ROLES) {
    for (const mustChangePassword of [false, true]) {
      const token = createSessionToken(environment.XHS_SESSION_SECRET, {
        actor: { userId: 42, username: 'session-fixture', roles: [role], credentialVersion: 1, mustChangePassword },
      });
      for (const path of ['/api/auth/session', '/api/auth/renew']) {
        assert.deepEqual(evaluateAdminProxyRequest(new Request(`http://127.0.0.1:3001${path}`, {
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
        }), environment), { type: 'next' }, `${role}/${mustChangePassword}/${path}`);
      }
    }
  }
});

test('session endpoints remain authenticated and reauth bypasses the valid-cookie login redirect', () => {
  for (const path of ['/api/auth/session', '/api/auth/renew']) {
    assert.deepEqual(evaluateAdminProxyRequest(new Request(`http://127.0.0.1:3001${path}`), environment), { type: 'unauthorized' });
  }
  const token = createSessionToken(environment.XHS_SESSION_SECRET, {
    actor: { userId: 42, username: 'session-fixture', roles: ['USER'], credentialVersion: 1 },
  });
  assert.deepEqual(evaluateAdminProxyRequest(new Request('http://127.0.0.1:3001/login?reauth=1&next=%2Fprofile', {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  }), environment), { type: 'next' });
});
