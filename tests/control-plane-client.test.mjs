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
  await client.listNodes();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://10.0.0.8:4310/v1/nodes');
  assert.equal(JSON.parse(calls[0].init.body).imageWorkerEnabled, false);
  assert.equal(calls[1].url, 'http://10.0.0.8:4310/v1/nodes');
  assert.equal(calls[1].init.method, 'GET');
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

test('control plane client supports paged task search, counts and logical cancellation', async () => {
  const calls = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.listTasks({
    states: ['COPY_QUEUED', 'COPY_FAILED'],
    nodeId: 'node-a',
    query: '黄山',
    limit: 20,
    offset: 40,
    includeTotal: true,
  });
  await client.taskCounts('node-a');
  await client.cancelTask(7);

  assert.match(calls[0].url, /states=COPY_QUEUED%2CCOPY_FAILED/u);
  assert.match(calls[0].url, /query=%E9%BB%84%E5%B1%B1/u);
  assert.match(calls[0].url, /includeTotal=true/u);
  assert.equal(calls[1].url, 'http://127.0.0.1:4310/v1/task-counts?nodeId=node-a');
  assert.equal(calls[2].url, 'http://127.0.0.1:4310/v1/tasks/7/cancel');
  assert.equal(calls[2].init.method, 'POST');
});
