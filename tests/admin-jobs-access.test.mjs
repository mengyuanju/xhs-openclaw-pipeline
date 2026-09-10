import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionToken, ADMIN_SESSION_COOKIE } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

test('administrator-only pages stay closed without removing each role\'s work queue', () => {
  const secret = 'isolated-test-session-secret-for-all-jobs';
  for (const role of ['ADMIN', 'REVIEWER', 'USER']) {
    const token = createSessionToken(secret, {
      actor: { username: role.toLowerCase(), userId: 1,
        displayName: role, roles: [role], credentialVersion: 1 },
    });
    const request = (path) => new Request(`http://127.0.0.1:3001${path}`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    const environment = { XHS_SESSION_SECRET: secret };
    assert.deepEqual(evaluateAdminProxyRequest(request('/workbench/all'), environment),
      { type: role === 'ADMIN' ? 'next' : 'forbidden' });
    assert.equal(evaluateAdminProxyRequest(request('/workbench/personal'), environment).type, 'next');
    assert.equal(evaluateAdminProxyRequest(request('/api/workbench-statistics?scope=personal'), environment).type, 'next');
    assert.equal(evaluateAdminProxyRequest(request('/workbench-statistics'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    assert.equal(evaluateAdminProxyRequest(request('/api/workbench-statistics/anything'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    for (const path of ['/query-packages', '/query-packages/7', '/delivery-pool', '/delivery-pool/ready']) {
      assert.equal(evaluateAdminProxyRequest(request(path), environment).type,
        role === 'ADMIN' ? 'next' : 'forbidden', `${role} ${path}`);
    }
    if (role === 'REVIEWER') {
      assert.equal(evaluateAdminProxyRequest(request('/workbench/copy-review'), environment).type, 'next');
      assert.equal(evaluateAdminProxyRequest(request('/copy-qa'), environment).type, 'next');
    }
    if (role === 'USER') {
      assert.equal(evaluateAdminProxyRequest(request('/copy-qa'), environment).type, 'forbidden');
    }
  }
});
