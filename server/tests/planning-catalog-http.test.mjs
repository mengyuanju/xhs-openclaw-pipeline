import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { resolvePlanningCatalog } from '../src/planning-catalog.mjs';

test('planning catalog is authenticated read-only design data for all workbench roles', async t => {
  const roles = { alice: 'USER', reviewer: 'REVIEWER', admin: 'ADMIN' };
  const catalog = resolvePlanningCatalog();
  catalog.pageTypes[0].description = '测试封面描述';
  const app = createControlPlaneApp({ enforceUserAuth: true, storageRoot: 'unused', repository: {
    getUserByUsername: async username => roles[username] ? { username, role: roles[username], status: 'ACTIVE', credentialVersion: 1 } : null,
    listSettings: async () => [{ key: 'production', value: { planningCatalog: catalog, modelApi: { sensitiveSetting: 'not-for-readers' } } }],
  } });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const unauthenticated = await fetch(`${root}/v1/planning-catalog`);
  assert.ok([401, 403].includes(unauthenticated.status));
  for (const [username, role] of Object.entries(roles)) {
    const headers = { 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1' };
    const response = await fetch(`${root}/v1/planning-catalog`, { headers });
    assert.equal(response.status, 200);
    const content = await response.text();
    assert.match(content, /测试封面描述/u);
    assert.doesNotMatch(content, /modelApi|not-for-readers/u);
    const write = await fetch(`${root}/v1/settings/production`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    if (role !== 'ADMIN') assert.equal(write.status, 403);
  }
});
