import assert from 'node:assert/strict';
import test from 'node:test';

import { withKnowledgeStore, listAllKnowledge } from '../src/admin/knowledge-runtime.mjs';
import { createSessionToken } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

function remoteRuntime(t, fetchImpl) {
  const previous = process.env.CONTROL_PLANE_URL;
  process.env.CONTROL_PLANE_URL = 'http://127.0.0.1:4310';
  t.after(() => {
    if (previous === undefined) delete process.env.CONTROL_PLANE_URL;
    else process.env.CONTROL_PLANE_URL = previous;
  });
  t.mock.method(globalThis, 'fetch', fetchImpl);
}

const actor = (username, role, credentialVersion = 3) => ({
  subject: 'user', userId: 2, username, roles: [role], credentialVersion,
});

test('knowledge reads and writes keep each concurrent user identity, role and credential version', async (t) => {
  const users = [actor('manager', 'ADMIN', 5), actor('reviewer', 'REVIEWER', 8)];
  const calls = [];
  remoteRuntime(t, async (url, init) => {
    const headers = new Headers(init.headers);
    const user = users.find((entry) => entry.username === headers.get('X-Actor-Username'));
    if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED', message: 'authenticated user context is required' } }, { status: 401 });
    assert.equal(headers.get('X-Actor-Role'), user.roles[0]);
    assert.equal(headers.get('X-Actor-Credential-Version'), String(user.credentialVersion));
    assert.equal(headers.has('cookie'), false);
    calls.push({ username: user.username, path: new URL(url).pathname, ...init });
    if (init.method === 'GET') {
      const data = url.endsWith('/capabilities') ? { workbenchVersion: 1 }
        : url.endsWith('/settings') ? [{ key: 'production', value: { modelApi: { visionModel: 'fake-vision' } } }]
          : url.endsWith('/copy-analysis-prompts') ? [{ id: 1, content: '分析结构' }] : [];
      return Response.json({ data });
    }
    if (init.method === 'PUT') {
      assert.equal(headers.get('content-type'), 'image/png');
      assert.deepEqual(init.body, Buffer.from('fake-image'));
    } else {
      assert.equal(headers.get('content-type'), 'application/json');
    }
    return Response.json({ data: { id: 1, itemId: 1, versionId: 2, status: 'PUBLISHED' } });
  });

  await Promise.all(users.map((user) => withKnowledgeStore(async (store) => {
    const [visual, copy, labels, prompts] = await Promise.all([
      listAllKnowledge(store, 'listVisualKnowledge'), listAllKnowledge(store, 'listCopyKnowledge'),
      store.listCopyKnowledgeLabels(), store.listCopyAnalysisPrompts(),
    ]);
    assert.deepEqual([visual, copy, labels], [[], [], []]);
    assert.equal(prompts[0].content, '分析结构');
    await store.createCopyAnalysisPrompt({ content: '分析结构' });
    await store.replaceCopyAnalysisPrompt(1, { content: '分析节奏' });
    await store.createCopyKnowledge({
      title: '经验', sourceCopy: '原文', analysisPrompt: '分析要求', summary: '摘要',
      analysis: '完整分析', labels: ['科普'], analysisModel: 'fake',
    });
    await store.client.uploadKnowledgeAsset(2, Buffer.from('fake-image'));
    await store.publishVisualKnowledgeVersion(2);
    await store.retireVisualKnowledge(1);
    assert.equal((await store.getProductionSettings()).settings.modelApi.visionModel, 'fake-vision');
  }, user)));
  for (const user of users) {
    const requests = calls.filter(({ username }) => username === user.username);
    assert.ok(requests.some(({ method, path }) => method === 'POST' && path === '/v1/knowledge/versions'));
    assert.ok(requests.some(({ method }) => method === 'PATCH'));
    assert.ok(requests.some(({ method }) => method === 'PUT'));
  }
});

test('anonymous, ordinary and legacy reviewer accounts cannot send knowledge management requests', async (t) => {
  remoteRuntime(t, () => { assert.fail('unauthorized requests must not reach the control plane'); });
  for (const [session, status] of [
    [null, 401], [actor('reader', 'USER'), 403], [actor('legacy', 'COPY_REVIEWER'), 403],
    [{ subject: 'user', roles: ['ADMIN'], credentialVersion: 3 }, 403],
  ]) {
    await assert.rejects(withKnowledgeStore((store) => store.listCopyAnalysisPrompts(), session), { status });
  }
});

test('central credential expiry remains a 401 response so the knowledge page can request sign-in', async (t) => {
  remoteRuntime(t, async () => Response.json({
    error: { code: 'SESSION_STALE', message: '账号状态已变化，请重新登录' },
  }, { status: 401 }));
  await assert.rejects(withKnowledgeStore((store) => store.listCopyAnalysisPrompts(), actor('reviewer', 'REVIEWER')), {
    status: 401, code: 'SESSION_STALE', message: '账号状态已变化，请重新登录',
  });
});

test('knowledge visual analysis is available to reviewers while ordinary users remain restricted', () => {
  const environment = { XHS_SESSION_SECRET: 'knowledge-auth-test-secret-at-least-32-characters' };
  for (const [role, expected] of [['ADMIN', 'next'], ['REVIEWER', 'next'], ['USER', 'forbidden']]) {
    const token = createSessionToken(environment.XHS_SESSION_SECRET, { actor: actor('tester', role) });
    for (const path of ['/knowledge', '/api/visual-analyses', '/api/knowledge-items', '/api/copy-analysis-prompts']) {
      const request = new Request(`http://127.0.0.1:3001${path}`, {
        headers: { cookie: `xhs_admin_session=${token}` },
      });
      assert.deepEqual(evaluateAdminProxyRequest(request, environment), { type: expected });
    }
  }
});
