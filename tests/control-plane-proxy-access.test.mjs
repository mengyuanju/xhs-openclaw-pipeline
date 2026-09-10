import assert from 'node:assert/strict';
import test from 'node:test';
import { userCanAccessControlPlaneRoute } from '../src/control-plane/proxy-access.mjs';

test('ordinary users can check resume capabilities without gaining management access', () => {
  assert.equal(userCanAccessControlPlaneRoute('/health', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/health', 'POST'), false);
  for (const path of ['/v1/tasks/7/retry', '/v1/profile', '/v1/assets/7', '/v1/nodes', '/v1/human-quality-settings']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), true);
  }
  assert.equal(userCanAccessControlPlaneRoute('/v1/human-quality-settings', 'PUT'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/workflow-quality-settings', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/workflow-quality-settings', 'PUT'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool/archive', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool/archive/token', 'GET'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool/xlsx', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/delivery-pool/xlsx/token', 'GET'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/tasks/7/retry', 'POST'), true);
  for (const [path, method] of [
    ['/v1/query-packages', 'GET'],
    ['/v1/query-packages', 'POST'],
    ['/v1/query-packages/7/screening', 'PUT'],
    ['/v1/query-packages/7/production-batches', 'POST'],
  ]) assert.equal(userCanAccessControlPlaneRoute(path, method), true);
  assert.equal(userCanAccessControlPlaneRoute('/v1/query-packages/7/assignee', 'PATCH'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/query-packages/7/abandon', 'POST'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/query-packages/7/permanent-delete-preview', 'GET'), false);
  assert.equal(userCanAccessControlPlaneRoute('/v1/query-packages/7/permanent', 'DELETE'), false);
  for (const path of ['/v1/settings', '/v1/users', '/v1/prompts', '/health/private', '/v1/tasks-admin']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), false);
  }
});
