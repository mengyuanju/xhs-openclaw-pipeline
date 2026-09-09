import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createSessionToken } from '../src/admin/auth.mjs';
import { evaluateAdminProxyRequest } from '../src/admin/proxy-policy.mjs';

test('retired production pages and mutation endpoints are no longer Next routes', async () => {
  for (const path of [
    'jobs/page.tsx', 'imports/page.tsx', 'copy-generation/page.tsx',
    'image-generation/page.tsx', 'tasks/page.tsx', 'reviews/page.tsx',
    'analytics/page.tsx', 'openclaw-traces/page.tsx',
    'api/worker-runs/route.ts', 'api/copy-generations/route.ts',
    'api/image-generations/route.ts', 'api/tasks/route.ts',
  ]) await assert.rejects(access(new URL(`../app/${path}`, import.meta.url)), { code: 'ENOENT' });
  const home = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(home, /redirect\('\/workbench\/personal'\)/);
});

test('all current account roles can enter the new home redirect', () => {
  const environment = { XHS_SESSION_SECRET: 'cleanup-test-only-session-secret-with-32-characters' };
  for (const role of ['ADMIN', 'REVIEWER', 'USER']) {
    const token = createSessionToken(environment.XHS_SESSION_SECRET, {
      actor: { userId: 1, username: 'fixture', roles: [role], credentialVersion: 1 },
    });
    const request = new Request('http://127.0.0.1:3000/', {
      headers: { cookie: `xhs_admin_session=${token}` },
    });
    assert.deepEqual(evaluateAdminProxyRequest(request, environment), { type: 'next' }, role);
  }
});
