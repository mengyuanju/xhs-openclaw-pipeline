import assert from 'node:assert/strict';
import test from 'node:test';
import { userCanAccessControlPlaneRoute } from '../src/control-plane/proxy-access.mjs';

test('ordinary users can check resume capabilities without gaining management access', () => {
  assert.equal(userCanAccessControlPlaneRoute('/health', 'GET'), true);
  assert.equal(userCanAccessControlPlaneRoute('/health', 'POST'), false);
  for (const path of ['/v1/tasks/7/retry', '/v1/profile', '/v1/assets/7', '/v1/nodes']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), true);
  }
  for (const path of ['/v1/settings', '/v1/users', '/v1/prompts', '/health/private', '/v1/tasks-admin']) {
    assert.equal(userCanAccessControlPlaneRoute(path, 'GET'), false);
  }
});
