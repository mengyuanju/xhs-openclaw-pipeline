import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_SESSION_COOKIE,
  LoginRateLimiter,
  attemptAdminLogin,
  createSessionToken,
  hashAdminPassword,
  serializeAdminSessionCookie,
} from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

const password = 'correct horse battery staple';
const sessionSecret = 'test-session-secret-with-at-least-32-characters';
const originalPasswordHash = process.env.XHS_ADMIN_PASSWORD_HASH;
const originalSessionSecret = process.env.XHS_SESSION_SECRET;

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(async () => {
  process.env.XHS_ADMIN_PASSWORD_HASH = await hashAdminPassword(password);
  process.env.XHS_SESSION_SECRET = sessionSecret;
});

after(() => {
  restoreEnvironment('XHS_ADMIN_PASSWORD_HASH', originalPasswordHash);
  restoreEnvironment('XHS_SESSION_SECRET', originalSessionSecret);
});

describe('authentication HTTP artifacts', () => {
  it('creates a hardened session cookie after a valid login attempt', async () => {
    const result = await attemptAdminLogin(password, {
      environment: process.env,
      limiter: new LoginRateLimiter(),
    });
    assert.equal(result.status, 'authenticated');
    const cookie = serializeAdminSessionCookie(result.token);

    assert.match(cookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Max-Age=28800/i);
    assert.doesNotMatch(cookie, /Secure/i);
  });

  it('returns no token for an invalid password', async () => {
    const result = await attemptAdminLogin('definitely the wrong password', {
      environment: process.env,
      limiter: new LoginRateLimiter(),
    });
    assert.deepEqual(result, { status: 'invalid' });
  });

  it('serializes a hardened cookie deletion for logout', () => {
    const cookie = serializeAdminSessionCookie('', { clear: true });

    assert.match(cookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
    assert.match(cookie, /Max-Age=0/i);
    assert.match(cookie, /HttpOnly/i);
  });
});

describe('Next.js authentication proxy', () => {
  it('redirects anonymous pages to login and returns JSON 401 for APIs', async () => {
    const pageDecision = evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/tasks'),
      process.env,
    );
    const apiDecision = evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/api/tasks'),
      process.env,
    );

    assert.deepEqual(pageDecision, { type: 'redirect', location: '/login?next=%2Ftasks' });
    assert.deepEqual(apiDecision, { type: 'unauthorized' });
  });

  it('allows login and valid sessions but rejects public hosts', async () => {
    const token = createSessionToken(sessionSecret);
    const loginDecision = evaluateAdminProxyRequest(
      new Request('http://192.168.1.8:3000/login'),
      process.env,
    );
    const sessionDecision = evaluateAdminProxyRequest(new Request('http://192.168.1.8:3000/tasks', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    }), process.env);
    const publicDecision = evaluateAdminProxyRequest(
      new Request('http://8.8.8.8:3000/login'),
      process.env,
    );

    assert.deepEqual(loginDecision, { type: 'next' });
    assert.deepEqual(sessionDecision, { type: 'next' });
    assert.deepEqual(publicDecision, { type: 'forbidden' });
  });

  it('confines accounts using an initial password to the profile password-change flow', () => {
    const environment = { XHS_SESSION_SECRET: sessionSecret };
    const requestFor = (role, path, mustChangePassword = true) => {
      const token = createSessionToken(sessionSecret, {
        actor: {
          userId: role === 'ADMIN' ? 41 : role === 'REVIEWER' ? 42 : 43,
          username: `initial-${role.toLowerCase()}`,
          roles: [role],
          credentialVersion: 1,
          mustChangePassword,
        },
      });
      return new Request(`http://127.0.0.1:3001${path}`, {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
      });
    };

    for (const role of ['ADMIN', 'REVIEWER', 'USER']) {
      for (const path of [
        '/profile',
        '/profile?from=login',
        '/api/auth/logout',
        '/api/control-plane/v1/profile',
        '/api/control-plane/v1/profile/password',
      ]) {
        assert.deepEqual(
          evaluateAdminProxyRequest(requestFor(role, path), environment),
          { type: 'next' },
          `${role} must be able to use ${path}`,
        );
      }

      for (const path of ['/', '/workbench/personal', '/workbench/all', '/users', '/knowledge']) {
        assert.deepEqual(
          evaluateAdminProxyRequest(requestFor(role, path), environment),
          { type: 'redirect', location: '/profile' },
          `${role} must be redirected away from ${path}`,
        );
      }

      for (const path of [
        '/api/workbench-statistics',
        '/api/control-plane/v1/tasks',
        '/api/control-plane/v1/profile/deletion-password',
        '/api/control-plane/v1/profiled',
      ]) {
        assert.deepEqual(
          evaluateAdminProxyRequest(requestFor(role, path), environment),
          { type: 'forbidden' },
          `${role} must be denied access to ${path}`,
        );
      }

      assert.deepEqual(
        evaluateAdminProxyRequest(requestFor(role, '/login'), environment),
        { type: 'redirect', location: '/profile' },
      );
      assert.deepEqual(
        evaluateAdminProxyRequest(requestFor(role, '/login?reauth=1'), environment),
        { type: 'next' },
      );
      assert.deepEqual(
        evaluateAdminProxyRequest(requestFor(role, '/workbench/personal', false), environment),
        { type: 'next' },
      );
    }
  });
});
