import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('administrator can release shared login limits from user management', async () => {
  const [manager, route, loginRoute] = await Promise.all([
    source('app/users/user-manager.tsx'),
    source('app/api/auth/login-limit/reset/route.ts'),
    source('app/api/auth/login/route.ts'),
  ]);

  assert.match(manager, /解除登录限制/u);
  assert.match(manager, /\/api\/auth\/login-limit\/reset/u);
  assert.match(manager, /method: 'POST'/u);
  assert.match(manager, /useConfirmDialog/u);

  assert.match(route, /apiHandler\(request, \{ mutation: true, roles: \['ADMIN'\] \}/u);
  assert.match(route, /loginRateLimitStore\.resetAll\(\)/u);
  assert.match(loginRoute, /loginRateLimitStore\.check\(username\)/u);
  assert.match(loginRoute, /loginRateLimitStore\.recordFailure\(username\)/u);
});
