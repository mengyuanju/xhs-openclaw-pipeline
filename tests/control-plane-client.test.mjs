import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ControlPlaneApiError,
  createControlPlaneClient,
} from '../src/control-plane/client.mjs';

test('control plane client sends image claims only when called', async () => {
  const calls = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://10.0.0.8:4310/',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await client.registerNode({ nodeId: 'node-a', imageWorkerEnabled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://10.0.0.8:4310/v1/nodes');
  assert.equal(JSON.parse(calls[0].init.body).imageWorkerEnabled, false);
});

test('control plane client surfaces structured stale execution conflicts', async () => {
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'STALE_EXECUTION', message: 'old execution' },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  await assert.rejects(
    client.updateProgress('d9428888-122b-11e1-b85c-61cd3cbb3210', {
      stage: 'RESEARCH', progressPercent: 25, message: '',
    }),
    (error) => error instanceof ControlPlaneApiError
      && error.status === 409
      && error.code === 'STALE_EXECUTION',
  );
});
