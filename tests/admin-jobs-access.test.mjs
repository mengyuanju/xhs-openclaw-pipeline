import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionToken, ADMIN_SESSION_COOKIE } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

test('permitted workflows stay available to current roles while administrator-only pages stay closed', () => {
  const secret = 'isolated-test-session-secret-for-all-jobs';
  for (const role of ['ADMIN', 'REVIEWER', 'USER']) {
    const token = createSessionToken(secret, {
      actor: { username: role.toLowerCase(), userId: 1,
        displayName: role, roles: [role], credentialVersion: 1,
        copyReviewEnabled: true, copyQcEnabled: true },
    });
    const request = (path) => new Request(`http://127.0.0.1:3001${path}`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    const environment = { XHS_SESSION_SECRET: secret };
    assert.deepEqual(evaluateAdminProxyRequest(request('/copy-flow'), environment),
      role === 'USER' ? { type: 'redirect', location: '/workbench/personal' } : { type: 'next' });
    if (role === 'USER') {
      for (const path of ['/copy-flow/', '/copy-flow?source=bookmark']) {
        assert.deepEqual(evaluateAdminProxyRequest(request(path), environment),
          { type: 'redirect', location: '/workbench/personal' }, path);
      }
    }
    assert.deepEqual(evaluateAdminProxyRequest(request('/workbench/all'), environment),
      { type: role === 'ADMIN' ? 'next' : 'forbidden' });
    assert.equal(evaluateAdminProxyRequest(request('/workbench/personal'), environment).type, 'next');
    assert.equal(evaluateAdminProxyRequest(request('/workbench/personal-statistics'), environment).type, 'next');
    assert.equal(evaluateAdminProxyRequest(request('/api/workbench-statistics?scope=personal'), environment).type, 'next');
    assert.equal(evaluateAdminProxyRequest(request('/workbench-statistics'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    assert.equal(evaluateAdminProxyRequest(request('/reports/task-data'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    assert.equal(evaluateAdminProxyRequest(request('/api/workbench-statistics/anything'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    for (const path of ['/query-packages', '/query-packages/7']) {
      assert.equal(evaluateAdminProxyRequest(request(path), environment).type, 'next', `${role} ${path}`);
    }
    assert.equal(evaluateAdminProxyRequest(request('/query-packages-evil'), environment).type,
      role === 'ADMIN' ? 'next' : 'forbidden');
    for (const path of ['/delivery-pool', '/delivery-pool/ready']) {
      assert.equal(evaluateAdminProxyRequest(request(path), environment).type,
        role === 'ADMIN' || (role === 'USER' && path === '/delivery-pool') ? 'next' : 'forbidden',
        `${role} ${path}`);
    }
    if (role === 'REVIEWER') {
      assert.equal(evaluateAdminProxyRequest(request('/workbench/copy-review'), environment).type, 'next');
      assert.equal(evaluateAdminProxyRequest(request('/copy-qa'), environment).type, 'next');
    }
    if (role === 'USER') {
      assert.equal(evaluateAdminProxyRequest(request('/copy-qa'), environment).type, 'next');
    }
  }
});

test('ordinary users cannot enter workflow pages whose permission switches are off', () => {
  const secret = 'isolated-test-session-secret-for-workflow-permissions';
  const token = createSessionToken(secret, {
    actor: {
      username: 'worker', userId: 2, roles: ['USER'], credentialVersion: 1,
      copyReviewEnabled: false, copyQcEnabled: false,
    },
  });
  const request = (path) => new Request(`http://127.0.0.1:3001${path}`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  });
  const environment = { XHS_SESSION_SECRET: secret };

  assert.equal(evaluateAdminProxyRequest(request('/workbench/personal'), environment).type, 'next');
  assert.deepEqual(evaluateAdminProxyRequest(request('/copy-flow'), environment),
    { type: 'redirect', location: '/workbench/personal' });
  for (const path of ['/query-packages', '/copy-qa']) {
    assert.equal(evaluateAdminProxyRequest(request(path), environment).type, 'forbidden', path);
  }
});


test('standalone image editing is independent of business workflow permission switches',()=>{
  const secret='standalone-editor-session-test-secret';
  for(const role of ['ADMIN','USER','REVIEWER']) {
    const token=createSessionToken(secret,{actor:{username:role.toLowerCase(),userId:1,roles:[role],credentialVersion:1,
      copyReviewEnabled:false,copyQcEnabled:false,imageQcEnabled:false}});
    const request=new Request('http://127.0.0.1:3001/image-editor?workspace=1',{headers:{cookie:`${ADMIN_SESSION_COOKIE}=${token}`}});
    assert.equal(evaluateAdminProxyRequest(request,{XHS_SESSION_SECRET:secret}).type,role==='REVIEWER'?'forbidden':'next');
  }
});
