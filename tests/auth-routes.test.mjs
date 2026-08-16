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
});
