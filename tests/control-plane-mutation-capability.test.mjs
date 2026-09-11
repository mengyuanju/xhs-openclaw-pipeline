import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/admin/http.mjs';
import {
  assertMutationCapability,
  requiredMutationCapability,
} from '../src/control-plane/mutation-capability.mjs';

test('protected control-plane operations declare their version contracts', () => {
  for (const [routePath, method, capability, minimumVersion] of [
    ['/v1/settings/xhs_query_search', 'PUT', 'xiaohongshuQuerySearchVersion', 3],
    ['/v1/tasks', 'POST', 'taskAssignmentVersion', 3],
    ['/v1/tasks/42/assignee', 'PATCH', 'taskAssignmentVersion', 3],
    ['/v1/tasks/batch-assignee', 'POST', 'taskAssignmentVersion', 3],
    ['/v1/auto-assignment/settings', 'PATCH', 'autoAssignmentPoolVersion', 3],
    ['/v1/auto-assignment/workers/alice', 'PUT', 'autoAssignmentPoolVersion', 3],
    ['/v1/auto-assignment/workers/alice', 'DELETE', 'autoAssignmentPoolVersion', 3],
    ['/v1/executor-statuses', 'DELETE', 'executorManagementVersion', 1],
    ['/v1/tasks/duplicate-query-discard-preview', 'POST', 'duplicateQueryDiscardVersion', 1],
    ['/v1/tasks/duplicate-query-discard', 'POST', 'duplicateQueryDiscardVersion', 1],
    ['/v1/query-packages', 'POST', 'queryPackageVersion', 2],
    ['/v1/query-packages/9/assignee', 'PATCH', 'queryPackageVersion', 3],
    ['/v1/query-packages/9/screening', 'PUT', 'queryPackageVersion', 2],
    ['/v1/query-packages/9/production-batches', 'POST', 'queryPackageVersion', 2],
    ['/v1/query-packages/9/abandon', 'POST', 'queryPackageVersion', 2],
    ['/v1/query-packages/9/permanent', 'DELETE', 'queryPackageVersion', 2],
    ['/v1/delivery-pool', 'GET', 'finalDeliveryVersion', 2],
    ['/v1/delivery-pool/archive', 'POST', 'finalDeliveryVersion', 2],
    ['/v1/delivery-pool/archive/token', 'HEAD', 'finalDeliveryVersion', 2],
    ['/v1/delivery-pool/archive/token', 'GET', 'finalDeliveryVersion', 2],
    ['/v1/delivery-pool/xlsx', 'POST', 'deliverySpreadsheetVersion', 1],
    ['/v1/delivery-pool/xlsx/token', 'HEAD', 'deliverySpreadsheetVersion', 1],
    ['/v1/delivery-pool/xlsx/token', 'GET', 'deliverySpreadsheetVersion', 1],
    ['/v1/delivery-pool/previews', 'POST', 'deliveryPreviewVersion', 4],
    ['/v1/tasks/batch-archive', 'POST', 'finalDeliveryVersion', 2],
    ['/v1/tasks/42/archive', 'HEAD', 'finalDeliveryVersion', 2],
    ['/v1/tasks/42/archive', 'GET', 'finalDeliveryVersion', 2],
  ]) {
    assert.deepEqual(requiredMutationCapability(routePath, method), {
      capability,
      minimumVersion,
    });
  }
  assert.equal(requiredMutationCapability('/v1/tasks', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/settings/xhs_query_search', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/settings/production', 'PUT'), null);
  assert.equal(requiredMutationCapability('/v1/tasks/42/retry', 'POST'), null);
  assert.equal(requiredMutationCapability('/v1/auto-assignment', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/executor-statuses', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/executor-statuses/node-a', 'DELETE'), null);
  assert.equal(requiredMutationCapability('/v1/tasks/duplicate-query-discard-preview', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/tasks/duplicate-query-discard', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/query-packages', 'GET'), null);
  assert.equal(requiredMutationCapability('/v1/query-packages/9', 'GET'), null);
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
    routePath: '/v1/settings/xhs_query_search',
    method: 'PUT',
    fetchImpl: async () => Response.json({
      data: { capabilities: { xiaohongshuQuerySearchVersion: 3 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/executor-statuses',
    method: 'DELETE',
    fetchImpl: async () => Response.json({
      data: { capabilities: { executorManagementVersion: 1 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/tasks/duplicate-query-discard-preview',
    method: 'POST',
    fetchImpl: async () => Response.json({
      data: { capabilities: { duplicateQueryDiscardVersion: 1 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/query-packages/9/screening',
    method: 'PUT',
    fetchImpl: async () => Response.json({
      data: { capabilities: { queryPackageVersion: 2 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/query-packages/9/assignee',
    method: 'PATCH',
    fetchImpl: async () => Response.json({
      data: { capabilities: { queryPackageVersion: 3 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/delivery-pool/archive',
    method: 'POST',
    fetchImpl: async () => Response.json({
      data: { capabilities: { finalDeliveryVersion: 2 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/delivery-pool/xlsx',
    method: 'POST',
    fetchImpl: async () => Response.json({
      data: { capabilities: { deliverySpreadsheetVersion: 1 } },
    }),
  });

  await assertMutationCapability({
    root: 'http://center.test',
    routePath: '/v1/delivery-pool/previews',
    method: 'POST',
    fetchImpl: async () => Response.json({
      data: { capabilities: { deliveryPreviewVersion: 4 } },
    }),
  });
});

test('mutation capability check fails closed for legacy, malformed and unavailable centers', async () => {
  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/settings/xhs_query_search',
      method: 'PUT',
      fetchImpl: async () => Response.json({
        data: { capabilities: { xiaohongshuQuerySearchVersion: 2 } },
      }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/delivery-pool/previews',
      method: 'POST',
      fetchImpl: async () => Response.json({
        data: { capabilities: { finalDeliveryVersion: 2 } },
      }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );
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

  for (const routePath of [
    '/v1/tasks/duplicate-query-discard-preview',
    '/v1/tasks/duplicate-query-discard',
  ]) {
    await assert.rejects(
      assertMutationCapability({
        root: 'http://center.test',
        routePath,
        method: 'POST',
        fetchImpl: async () => Response.json({
          data: { capabilities: { duplicateQueryDiscardVersion: 0 } },
        }),
      }),
      (error) => error instanceof ApiError
        && error.status === 503
        && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
      routePath,
    );
  }

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/query-packages/9/assignee',
      method: 'PATCH',
      fetchImpl: async () => Response.json({
        data: { capabilities: { queryPackageVersion: 2 } },
      }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );

  for (const routePath of [
    '/v1/query-packages',
    '/v1/query-packages/9/screening',
    '/v1/query-packages/9/production-batches',
    '/v1/query-packages/9/abandon',
    '/v1/query-packages/9/permanent',
  ]) {
    await assert.rejects(
      assertMutationCapability({
        root: 'http://center.test',
        routePath,
        method: routePath.endsWith('/screening') ? 'PUT'
          : routePath.endsWith('/permanent') ? 'DELETE' : 'POST',
        fetchImpl: async () => Response.json({
          data: { capabilities: { queryPackageVersion: 1 } },
        }),
      }),
      (error) => error instanceof ApiError
        && error.status === 503
        && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
      routePath,
    );
  }

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/delivery-pool/xlsx',
      method: 'POST',
      fetchImpl: async () => Response.json({
        data: { capabilities: { finalDeliveryVersion: 2 } },
      }),
    }),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === 'CONTROL_PLANE_UPGRADE_REQUIRED',
  );

  await assert.rejects(
    assertMutationCapability({
      root: 'http://center.test',
      routePath: '/v1/delivery-pool/archive',
      method: 'POST',
      fetchImpl: async () => Response.json({
        data: { capabilities: { finalDeliveryVersion: 1 } },
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
