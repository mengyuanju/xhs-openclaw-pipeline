import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutorAgent } from '../src/executor/agent.mjs';

test('executor never starts image polling when image capability is disabled', async () => {
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
  });
  await agent.register();
  assert.equal(await agent.runOnce(), null);
  assert.deepEqual(calls.map(([name]) => name), ['register', 'copy']);
  assert.equal(calls[0][1].imageWorkerEnabled, false);
});

test('idle image-enabled executor claims image only after its local copy queue is empty', async () => {
  const calls = [];
  const claim = {
    task: { id: 19 },
    execution: { id: 'd9428888-122b-11e1-b85c-61cd3cbb3210' },
  };
  const controlPlane = {
    registerNode: async () => {},
    claimCopy: async () => { calls.push('copy'); return null; },
    claimImage: async () => { calls.push('image'); return claim; },
    failExecution: async () => {},
  };
  const agent = createExecutorAgent({
    controlPlane,
    nodeId: 'hybrid-node',
    imageWorkerEnabled: true,
    executeImage: async ({ claim: received }) => {
      assert.equal(received.task.id, 19);
      calls.push('execute-image');
    },
  });
  const result = await agent.runOnce();
  assert.deepEqual(calls, ['copy', 'image', 'execute-image']);
  assert.equal(result.status, 'SUCCEEDED');
});
