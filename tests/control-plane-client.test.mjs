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

test('claim body timeouts propagate instead of pretending the queue is empty', async () => {
  const timeout = new DOMException('response body timed out', 'TimeoutError');
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => { throw timeout; },
    }),
  });
  await assert.rejects(client.claimCopy('node-a'), (error) => error === timeout);
});

test('claims reject malformed successful responses but accept an explicit empty queue', async () => {
  for (const body of ['{"data":', '{}', 'null', '<html>unavailable</html>']) {
    const client = createControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4310',
      fetchImpl: async () => new Response(body, {
        headers: { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' },
      }),
    });
    await assert.rejects(client.claimCopy('node-a'), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
  }
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310', fetchImpl: async () => Response.json({ data: null }),
  });
  assert.equal(await client.claimCopy('node-a'), null);
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

test('failure reporting falls back to a bounded message for an older control plane varchar limit', async () => {
  const errors = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async (_url, init) => {
      const { error } = JSON.parse(init.body);
      errors.push(error);
      const tooLong = [...error].length > 500;
      return new Response(JSON.stringify(tooLong
        ? { error: { code: 'INTERNAL_ERROR', message: 'control plane request failed' } }
        : { data: { state: 'COPY_FAILED' } }), {
        status: tooLong ? 500 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const message = '联网搜索失败：' + '错误🔍'.repeat(350);
  const result = await client.failExecution('4c8649a9-8c8f-4708-aeb7-2df0a3171a5a', new Error(message));
  assert.equal(result.state, 'COPY_FAILED');
  assert.equal(errors.length, 2);
  assert.equal(errors[0], message);
  assert.ok([...errors[1]].length <= 500);
  assert.ok(errors[1].isWellFormed());
  assert.match(errors[1], /^联网搜索失败/u);
});

test('failure reporting does not retry stale executions or hide other errors', async () => {
  for (const status of [400, 409, 503]) {
    let calls = 0;
    const client = createControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4310',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 'TEST_ERROR', message: 'failed' } }), {
          status, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await assert.rejects(client.failExecution('execution', new Error('x'.repeat(900))), { status });
    assert.equal(calls, 1);
  }
});
