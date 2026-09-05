import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { checkExecutorReady, createExecutorAgent } from '../src/executor/agent.mjs';

test('concurrent same-kind failures retain independent reports without rerunning either model', async () => {
  const claims = [1, 2].map(id => ({ task: { id }, execution: { id: randomUUID(), status: 'RUNNING' } }));
  const reports = new Map();
  const models = [];
  const agent = createExecutorAgent({ nodeId: 'a', readinessCheck: async () => {}, availabilityCheck: async () => {},
    executeCopy: async ({ claim }) => { models.push(claim.task.id); throw new Error(`failed ${claim.task.id}`); },
    controlPlane: { failExecution: async id => {
      reports.set(id, (reports.get(id) ?? 0) + 1);
      if (reports.get(id) === 1) throw new Error('offline');
    } } });
  await agent.prepare();
  const failures = await Promise.allSettled(claims.map(claim => agent.executeClaim('COPY', claim)));
  assert.ok(failures.every(r => r.status === 'rejected'));
  const finished = await Promise.all(claims.flatMap(claim => [agent.executeClaim('COPY', claim), agent.executeClaim('COPY', claim)]));
  assert.ok(finished.every(r => r.status === 'FAILED'));
  assert.deepEqual(models.sort(), [1, 2]);
  assert.deepEqual([...reports.values()], [2, 2]);
});

test('concurrent executor refuses an old center before registration', async () => {
  const agent = createExecutorAgent({ nodeId: 'a', concurrencyEnabled: true, controlPlane: {},
    readinessCheck: async () => ({ health: { ok: true } }) });
  await assert.rejects(agent.prepare(), /executorConcurrency/);
});

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
      modelClient: { checkReady() {} },
      controlPlane: {
        health: async () => { calls.push('health'); return { ok: true, capabilities: { executionRetryControl: true } }; },
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

test('Codex readiness rejects older centers before login or task claiming', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-old-center-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(checkExecutorReady({ workRoot: root, environment: { XHS_AGENT_PROVIDER: 'CODEX' },
    controlPlane: { health: async () => ({ ok: true }) },
    modelClient: { checkReady() { assert.fail('old center must be rejected first'); } },
  }), /executionRetryControl/u);
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

test('image internal retries and failure-report retries count as one outer execution', async () => {
  const claim = { task: { id: 41 }, execution: { id: '4c8649a9-8c8f-4708-aeb7-2df0a3171a5a' } };
  let internalAttempts = 0;
  let claims = 0;
  let reports = 0;
  const agent = createExecutorAgent({
    nodeId: 'image-node', imageWorkerEnabled: true, readinessCheck: async () => {},
    controlPlane: {
      claimImage: async () => { claims += 1; return claim; },
      failExecution: async (id) => {
        assert.equal(id, claim.execution.id);
        assert.equal(internalAttempts, 4, 'report only after all internal attempts finish');
        reports += 1;
        if (reports === 1) throw new Error('report temporarily unavailable');
      },
    },
    executeImage: async () => {
      for (let internal = 0; internal < 4; internal += 1) {
        assert.equal(reports, 0);
        internalAttempts += 1;
      }
      throw new Error('internal image retries exhausted');
    },
  });
  await agent.prepare();
  await assert.rejects(agent.runImageOnce(), /report temporarily unavailable/u);
  assert.equal((await agent.runImageOnce()).status, 'FAILED');
  assert.equal(claims, 1);
  assert.equal(internalAttempts, 4);
  assert.equal(reports, 2);
});
