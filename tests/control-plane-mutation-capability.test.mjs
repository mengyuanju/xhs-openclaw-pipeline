import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/admin/http.mjs';
import {
  assertMutationCapability,
  requiredMutationCapability,
} from '../src/control-plane/mutation-capability.mjs';

test('assignment and opt-in pool mutations declare their version contracts', () => {
  for (const [routePath, method, capability] of [
    ['/v1/tasks', 'POST', 'taskAssignmentVersion'],
    ['/v1/tasks/42/assignee', 'PATCH', 'taskAssignmentVersion'],
    ['/v1/tasks/batch-assignee', 'POST', 'taskAssignmentVersion'],
    ['/v1/auto-assignment/settings', 'PATCH', 'autoAssignmentPoolVersion'],
    ['/v1/auto-assignment/workers/alice', 'PUT', 'autoAssignmentPoolVersion'],
    ['/v1/auto-assignment/workers/alice', 'DELETE', 'autoAssignmentPoolVersion'],
    ['/v1/executor-statuses', 'DELETE', 'executorManagementVersion'],
  ]) {
    assert.deepEqual(requiredMutationCapability(routePath, method), {
      capability,
      minimumVersion: capability === 'executorManagementVersion' ? 1 : 3,
    });
  }
  assert.equal(requiredMutationCapability('/v1/tasks', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/tasks/42/retry', 'POST'), null);
  assert.equal(requiredMutationCapability('/v1/auto-assignment', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/executor-statuses', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/executor-statuses/node-a', 'DELETE'), null);
});

test('mutation capability check allows only compatible center versions', async () => {
  const calls = [];
  await assertMutationCapability({
    root: 'http://center.test/base',
    routePath: '/v1/tasks/42/assignee',
    method: 'PATCH',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ data: { capabilities: { taskAssignmentVersion: 3 } } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://center.test/base/health');
  assert.equal(calls[0].init.cache, 'no-store');

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/executor-statuses',
    method: 'DELETE',
    fetchImpl: async () => Response.json({
      data: { capabilities: { executorManagementVersion: 1 } },
    }),
  });
});

test('mutation capability check fails closed for legacy, malformed and unavailable centers', async () => {
  for (const fetchImpl of [
    async () => Response.json({ data: { capabilities: { taskAssignmentVersion: 1 } } }),
    async () => Response.json({ data: { capabilities: { taskAssignmentVersion: 2 } } }),
    async () => Response.json({ data: { capabilities: {} } }),
    async () => Response.json({ capabilities: { taskAssignmentVersion: 3 } }),
    async () => new Response('legacy', { status: 404 }),
    async () => new Response('method missing', { status: 405 }),
  ]) {
    await assert.rejects(
      assertMutationCapability({
        root: 'http://center.test', routePath: '/v1/tasks', method: 'POST', fetchImpl,
      }),
      (error) => error instanceof ApiError
        && error.status === 503
        && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
    );
  }

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/auto-assignment/settings',
      method: 'PATCH',
      fetchImpl: async () => Response.json({
        data: { capabilities: { autoAssignmentPoolVersion: 2 } },
      }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/executor-statuses',
      method: 'DELETE',
      fetchImpl: async () => Response.json({ data: { capabilities: {} } }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/auto-assignment/workers/alice',
      method: 'DELETE',
      fetchImpl: async () => { throw new Error('offline'); },
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UNAVAILABLE',
  );

  for (const status of [429, 500, 503]) {
    await assert.rejects(
      assertMutationCapability({
        root: 'http://center.test',
        routePath: '/v1/auto-assignment/settings',
        method: 'PATCH',
        fetchImpl: async () => new Response('temporarily unavailable', { status }),
      }),
      (error) => error instanceof ApiError
        && error.status === 503
        && error.code === 'CONTROL_PLANE_UNAVAILABLE',
    );
  }
});

test('unrelated mutations do not perform a capability request', async () => {
  let calls = 0;
  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/profile',
    method: 'PATCH',
    fetchImpl: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(calls, 0);
});
