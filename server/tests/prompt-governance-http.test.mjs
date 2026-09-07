import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';

const ROLES = { admin: 'ADMIN', reviewer: 'REVIEWER', user: 'USER' };
const PRIVATE_RULE = 'private-fixture-business-rule';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROMPTS = [{ kind: 'TEXT_SYSTEM', versions: [{ id: 7, version: 1,
  status: 'PUBLISHED', content: PRIVATE_RULE }] }];
const SETTINGS = [
  { key: 'production', value: { modelApi: { agentProvider: 'CODEX',
    modelProxyUrl: 'https://private-fixture.invalid', textModel: 'private-fixture-model' },
  aiDisclosureEnabled: true, aiDisclosureText: PRIVATE_RULE } },
  { key: 'prompt_runtime', value: { visualPlanningEnabled: true, copyKnowledgeThreshold: 80 } },
  { key: 'private_business_rules', value: { content: PRIVATE_RULE } },
];
const CALL = { id: 'call-1', prompt: PRIVATE_RULE,
  request: 'private-fixture-actual-request', response: 'private-fixture-raw-response' };
const RUN = { id: RUN_ID, kind: 'VISUAL_ANALYSIS', status: 'SUCCEEDED',
  startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:00:01.000Z',
  runtime: { prompts: { TEXT_SYSTEM: { content: PRIVATE_RULE } } }, calls: [CALL] };

function actorHeaders(username) {
  return { 'X-Actor-Username': username, 'X-Actor-Role': ROLES[username],
    'X-Actor-Credential-Version': '1' };
}

function repositoryFixture() {
  const calls = { claims: 0, settings: 0, prompts: 0, task: 0, trace: 0 };
  const claim = async () => {
    calls.claims++;
    return { execution: { snapshot: { prompts: { TEXT_SYSTEM: { content: PRIVATE_RULE } } } } };
  };
  return {
    calls,
    getUserByUsername: async (username) => ROLES[username]
      ? { id: 1, username, role: ROLES[username], status: 'ACTIVE', credentialVersion: 1 } : null,
    listSettings: async () => { calls.settings++; return SETTINGS; },
    listPrompts: async () => { calls.prompts++; return PROMPTS; },
    getTask: async () => { calls.task++; return { id: 1, createdByUserId: 'user' }; },
    listModelCalls: async () => { calls.trace++; return { items: [{ id: CALL.id }], total: 1 }; },
    getModelCall: async () => { calls.trace++; return CALL; },
    claimCopy: claim, claimImage: claim, claimCopyBatch: claim, claimImageBatch: claim,
  };
}

async function withServer(repository, action) {
  const prefix = resolve(tmpdir(), 'xhs-prompt-governance-http-');
  const storageRoot = await mkdtemp(prefix);
  let server;
  try {
    await mkdir(join(storageRoot, 'prompt-runs'));
    await writeFile(join(storageRoot, 'prompt-runs', `${RUN_ID}.json`), JSON.stringify(RUN));
    const app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth: true });
    await new Promise((ready, reject) => {
      server = app.listen(0, '127.0.0.1', ready);
      server.once('error', reject);
    });
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server?.listening) await new Promise((closed) => server.close(closed));
    assert.ok(resolve(storageRoot).startsWith(prefix), 'cleanup must remain inside the generated fixture directory');
    await rm(storageRoot, { recursive: true, force: true });
  }
}

const PRIVATE_READ_PATHS = [
  '/v1/settings', '/v1/prompts', '/v1/tasks/1/model-calls',
  '/v1/tasks/1/model-calls/call-1', '/v1/prompt-runs', `/v1/prompt-runs?id=${RUN_ID}`,
];

test('USER and REVIEWER cannot obtain execution snapshots through any claim route', async () => {
  const repository = repositoryFixture();
  await withServer(repository, async (root) => {
    for (const username of ['user', 'reviewer']) {
      for (const kind of ['copy', 'image', 'copy-batch', 'image-batch']) {
        const response = await fetch(`${root}/v1/executions/claim-${kind}`, {
          method: 'POST', headers: { ...actorHeaders(username), 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'fixture-node', limit: 1, requestId: 'fixture-request' }),
        });
        assert.equal(response.status, 403, `${username}: claim-${kind}`);
        const body = await response.json();
        assert.equal(body.error.code, 'FORBIDDEN');
        assert.equal(body.data, undefined);
        assert.ok(!JSON.stringify(body).includes(PRIVATE_RULE));
      }
    }
  });
  assert.equal(repository.calls.claims, 0, 'rejected sessions must not consume queued work');
});

test('anonymous executor readiness sees only the provider and no business configuration', async () => {
  const repository = repositoryFixture();
  await withServer(repository, async (root) => {
    for (const provider of ['CODEX', 'OPENCLAW', null]) {
      repository.listSettings = async () => SETTINGS.map((record) => record.key === 'production'
        ? { ...record, value: { ...record.value, modelApi: { ...record.value.modelApi, agentProvider: provider } } }
        : record);
      const response = await fetch(`${root}/v1/settings`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { data: [{ key: 'production', value: {
        modelApi: provider ? { agentProvider: provider } : {},
      } }] });
      assert.doesNotMatch(JSON.stringify(body), /private-fixture|prompt_runtime|copyKnowledgeThreshold|aiDisclosure/u);
    }
  });
});

test('administrators can read complete published rules, settings and both trace stores', async () => {
  const repository = repositoryFixture();
  await withServer(repository, async (root) => {
    const expected = [SETTINGS, PROMPTS, { items: [{ id: CALL.id }], total: 1 }, CALL,
      [{ id: RUN_ID, kind: RUN.kind, status: RUN.status, startedAt: RUN.startedAt,
        finishedAt: RUN.finishedAt, callCount: 1 }], RUN];
    for (const [index, path] of PRIVATE_READ_PATHS.entries()) {
      const response = await fetch(`${root}${path}`, { headers: actorHeaders('admin') });
      assert.equal(response.status, 200, path);
      assert.deepEqual((await response.json()).data, expected[index], path);
    }
  });
  assert.equal(repository.calls.settings, 1);
  assert.equal(repository.calls.prompts, 1);
  assert.equal(repository.calls.trace, 2);
});

test('USER and REVIEWER cannot read prompts, settings or either trace store', async () => {
  const repository = repositoryFixture();
  await withServer(repository, async (root) => {
    for (const username of ['user', 'reviewer']) {
      for (const path of PRIVATE_READ_PATHS) {
        const response = await fetch(`${root}${path}`, { headers: actorHeaders(username) });
        assert.equal(response.status, 403, `${username}: ${path}`);
        const body = await response.json();
        assert.equal(body.error.code, 'FORBIDDEN');
        assert.equal(body.data, undefined);
        assert.ok(!JSON.stringify(body).includes(PRIVATE_RULE));
      }
    }
  });
  assert.deepEqual(repository.calls, { claims: 0, settings: 0, prompts: 0, task: 0, trace: 0 },
    'denied reads must stop before loading private repository data');
});

test('anonymous requests cannot read prompt versions or traces through administrator endpoints', async () => {
  const repository = repositoryFixture();
  await withServer(repository, async (root) => {
    for (const path of PRIVATE_READ_PATHS.filter((path) => path !== '/v1/settings')) {
      const response = await fetch(`${root}${path}`);
      assert.equal(response.status, 401, path);
      const body = await response.json();
      assert.equal(body.error.code, 'AUTH_REQUIRED');
      assert.equal(body.data, undefined);
    }
  });
  assert.deepEqual(repository.calls, { claims: 0, settings: 0, prompts: 0, task: 0, trace: 0 });
});
