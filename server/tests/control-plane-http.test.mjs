import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { ControlPlaneConflictError } from '../src/domain.mjs';

async function withServer(repository, action, { storageRoot = 'test-storage' } = {}) {
  const app = createControlPlaneApp({ repository, storageRoot });
  let server;
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('control plane HTTP exposes node registration and batched task creation', async () => {
  const calls = [];
  const repository = {
    registerNode: async (input) => { calls.push(['node', input]); return { id: input.nodeId }; },
    createTasks: async (input) => { calls.push(['tasks', input]); return [{ id: 1, state: 'COPY_QUEUED' }]; },
  };
  await withServer(repository, async (root) => {
    const registered = await fetch(`${root}/v1/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', imageWorkerEnabled: false }),
    });
    assert.equal(registered.status, 200);
    const created = await fetch(`${root}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', tasks: [{ query: '选题' }] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).data, [{ id: 1, state: 'COPY_QUEUED' }]);
  });
  assert.deepEqual(calls.map(([name]) => name), ['node', 'tasks']);
});

test('control plane HTTP returns a structured stale execution conflict', async () => {
  const repository = {
    updateProgress: async () => {
      throw new ControlPlaneConflictError('STALE_EXECUTION', 'execution was replaced');
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(
      `${root}/v1/executions/d9428888-122b-11e1-b85c-61cd3cbb3210/progress`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'RESEARCH', progressPercent: 20 }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: { code: 'STALE_EXECUTION', message: 'execution was replaced' },
    });
  });
});

test('unknown control plane routes do not leak implementation details', async () => {
  await withServer({}, async (root) => {
    const response = await fetch(`${root}/v1/not-real`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'NOT_FOUND', message: 'route not found' },
    });
  });
});

test('Koa JSON middleware leaves JSON execution assets as raw upload bytes', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-control-plane-'));
  let recorded;
  const repository = {
    activeImageUploadContext: async () => ({ taskId: 7, imageRunId: 'run-a' }),
    recordAsset: async (input) => {
      recorded = input;
      return { id: 'asset-a' };
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/executions/d9428888-122b-11e1-b85c-61cd3cbb3210/assets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-File-Name': 'trace.json' },
        body: '{"stage":"IMAGE"}',
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).data.url, '/v1/assets/asset-a');
    }, { storageRoot });
    assert.equal(recorded.mediaType, 'application/json');
    assert.equal(recorded.byteSize, 17);
    assert.equal(recorded.originalName, 'trace.json');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
