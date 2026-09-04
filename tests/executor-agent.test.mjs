import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkExecutorReady, createExecutorAgent } from '../src/executor/agent.mjs';

test('executor never claims images when image capability is disabled', async () => {
  const calls = [];
  const controlPlane = {
    registerNode: async (input) => { calls.push(['register', input]); },
    claimCopy: async () => { calls.push(['copy']); return null; },
    claimImage: async () => { calls.push(['image']); return null; },
  };
  const agent = createExecutorAgent({
    controlPlane,
    nodeId: 'copy-only-node',
    imageWorkerEnabled: false,
    readinessCheck: async () => { calls.push(['ready']); },
  });
  await assert.rejects(agent.runCopyOnce(), /not ready/u);
  await agent.prepare();
  await agent.register();
  assert.equal(await agent.runCopyOnce(), null);
  assert.equal(await agent.runImageOnce(), null);
  assert.deepEqual(calls.map(([name]) => name), ['ready', 'register', 'copy']);
  assert.equal(calls[1][1].imageWorkerEnabled, false);
});

test('image-enabled executor runs an image lane while its copy lane is busy', async () => {
  const calls = [];
  const copyClaim = {
    task: { id: 18 },
    execution: { id: 'c8428888-122b-11e1-b85c-61cd3cbb3210' },
  };
  const imageClaim = {
    task: { id: 19 },
    execution: { id: 'd9428888-122b-11e1-b85c-61cd3cbb3210' },
  };
  let releaseCopy;
  const copyBlocked = new Promise((resolve) => { releaseCopy = resolve; });
  const controlPlane = {
    registerNode: async () => {},
    claimCopy: async () => { calls.push('claim-copy'); return copyClaim; },
    claimImage: async () => { calls.push('claim-image'); return imageClaim; },
    failExecution: async () => {},
  };
  const agent = createExecutorAgent({
    controlPlane,
    nodeId: 'hybrid-node',
    imageWorkerEnabled: true,
    readinessCheck: async () => {},
    executeCopy: async () => {
      calls.push('execute-copy-start');
      await copyBlocked;
      calls.push('execute-copy-finish');
    },
    executeImage: async ({ claim: received }) => {
      assert.equal(received.task.id, 19);
      calls.push('execute-image');
    },
  });
  await agent.prepare();
  const copyResult = agent.runCopyOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const imageResult = await agent.runImageOnce();
  assert.deepEqual(calls, ['claim-copy', 'execute-copy-start', 'claim-image', 'execute-image']);
  assert.equal(imageResult.status, 'SUCCEEDED');
  releaseCopy();
  assert.equal((await copyResult).status, 'SUCCEEDED');
});

test('executor readiness completes control-plane and work-directory checks before registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-executor-ready-'));
  const workRoot = join(root, 'work');
  const calls = [];
  try {
    const result = await checkExecutorReady({
      controlPlane: {
        health: async () => { calls.push('health'); return { ok: true }; },
      },
      workRoot,
    });
    await access(workRoot);
    assert.deepEqual(calls, ['health']);
    assert.equal(result.health.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executor retries an unreported failure before claiming more work, without rerunning the model', async () => {
  const claim = { task: { id: 11 }, execution: { id: '4c8649a9-8c8f-4708-aeb7-2df0a3171a5a' } };
  const modelError = new Error('OpenClaw web search failed: EBUSY');
  let claims = 0;
  let modelCalls = 0;
  let reports = 0;
  const agent = createExecutorAgent({
    nodeId: 'test',
    readinessCheck: async () => {},
    controlPlane: {
      claimCopy: async () => { claims += 1; return claims === 1 ? claim : null; },
      failExecution: async (id, error) => {
        assert.equal(id, claim.execution.id);
        assert.equal(error, modelError);
        reports += 1;
        if (reports === 1) throw new Error('control plane temporarily unavailable');
      },
    },
    executeCopy: async () => { modelCalls += 1; throw modelError; },
  });
  await agent.prepare();
  await assert.rejects(agent.runCopyOnce(), /temporarily unavailable/u);
  const result = await agent.runCopyOnce();
  assert.equal(result?.status, 'FAILED');
  assert.equal(result?.error, modelError);
  assert.equal(claims, 1);
  assert.equal(modelCalls, 1);
  assert.equal(reports, 2);
  assert.equal(await agent.runCopyOnce(), null);
  assert.equal(claims, 2);
});
