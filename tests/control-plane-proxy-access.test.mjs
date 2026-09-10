import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { userCanAccessControlPlaneRoute } from '../src/control-plane/proxy-access.mjs';

test('ordinary users can work on assigned tasks without reaching package or delivery data', () => {
  assert.equal(userCanAccessControlPlaneRoute('/health', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/health', 'POST'), false);
  for (const path of ['/v1/tasks/7/retry', '/v1/profile', '/v1/assets/7', '/v1/nodes', '/v1/human-quality-settings']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), true);
  }
  assert.equal(userCanAccessControlPlaneRoute('/v1/human-quality-settings', 'PUT'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/workflow-quality-settings', 'GET'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/workflow-quality-settings', 'HEAD'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/workflow-quality-settings', 'PUT'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks/7/retry', 'POST'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks/7/archive', 'HEAD'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks/7/archive', 'GET'), false);
  const administratorOnlyPaths = [
    '/v1/query-packages',
    '/v1/query-packages/7',
    '/v1/query-packages/7/screening',
    '/v1/query-packages/7/production-batches',
    '/v1/query-packages/7/assignee',
    '/v1/query-packages/7/abandon',
    '/v1/query-packages/7/permanent-delete-preview',
    '/v1/query-packages/7/permanent',
    '/v1/delivery-pool',
    '/v1/delivery-pool/archive',
    '/v1/delivery-pool/archive/token',
    '/v1/delivery-pool/xlsx',
    '/v1/delivery-pool/xlsx/token',
  ];
  for (const path of administratorOnlyPaths) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal(userCanAccessControlPlaneRoute(path, method), false, `${method} ${path}`);
    }
  }
  for (const path of ['/v1/settings', '/v1/settings/xhs_query_search', '/v1/users', '/v1/prompts', '/health/private', '/v1/tasks-admin']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), false);
  }
});

test('duplicate Query discard routes are guarded as administrator-only at the web proxy', async () => {
  const source = await readFile(
    new URL('../app/api/control-plane/[...path]/route.ts', import.meta.url),
    'utf8',
  );
  const guardStart = source.indexOf("if (role !== 'ADMIN' && (routePath === '/v1/task-views'");
  const guardEnd = source.indexOf("throw new ApiError(403, 'FORBIDDEN', '仅管理员可使用任务集中处理功能');", guardStart);
  assert.notEqual(guardStart, -1);
  assert.notEqual(guardEnd, -1);
  const administratorOnlyGuard = source.slice(guardStart, guardEnd);
  assert.match(administratorOnlyGuard, /'\/v1\/tasks\/duplicate-query-discard-preview'/u);
  assert.match(administratorOnlyGuard, /'\/v1\/tasks\/duplicate-query-discard'/u);
});
