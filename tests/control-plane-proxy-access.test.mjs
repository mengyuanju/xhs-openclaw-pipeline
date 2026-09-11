import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  nonAdminCanAccessQueryPackageRoute,
  userCanAccessControlPlaneRoute,
} from '../src/control-plane/proxy-access.mjs';

test('ordinary users can work on assigned tasks and screen only their visible Query packages', () => {
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
  const queryPackageAccess = [
    ['/v1/query-packages', 'GET'],
    ['/v1/query-packages', 'HEAD'],
    ['/v1/query-packages/7', 'GET'],
    ['/v1/query-packages/7', 'HEAD'],
    ['/v1/query-packages/7/screening', 'PUT'],
  ];
  for (const [path, method] of queryPackageAccess) {
    assert.equal(nonAdminCanAccessQueryPackageRoute(path, method), true, `${method} ${path}`);
    assert.equal(userCanAccessControlPlaneRoute(path, method), true, `${method} ${path}`);
  }
  const queryPackageManagement = [
    ['/v1/query-packages', 'POST'],
    ['/v1/query-packages/7', 'PUT'],
    ['/v1/query-packages/7/screening', 'GET'],
    ['/v1/query-packages/7/screening', 'POST'],
    ['/v1/query-packages/7/screening', 'PATCH'],
    '/v1/query-packages/7/production-batches',
    '/v1/query-packages/7/assignee',
    '/v1/query-packages/7/abandon',
    '/v1/query-packages/7/permanent-delete-preview',
    '/v1/query-packages/7/permanent',
    ['/v1/query-packages/not-an-id', 'GET'],
  ];
  for (const entry of queryPackageManagement) {
    const [path, methods] = Array.isArray(entry) ? [entry[0], [entry[1]]] : [entry, ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']];
    for (const method of methods) {
      assert.equal(nonAdminCanAccessQueryPackageRoute(path, method), false, `${method} ${path}`);
      assert.equal(userCanAccessControlPlaneRoute(path, method), false, `${method} ${path}`);
    }
  }
  const administratorOnlyPaths = [
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

test('the web proxy applies the narrow Query package exception to every non-administrator role', async () => {
  const source = await readFile(
    new URL('../app/api/control-plane/[...path]/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /role !== 'ADMIN'[\s\S]*!nonAdminCanAccessQueryPackageRoute\(routePath, request\.method\)/u);
  assert.equal(source.includes("role === 'REVIEWER' && /^\\/v1\\/(?:query-packages|production-batches)"), false);
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
