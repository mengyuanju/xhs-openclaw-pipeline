import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneClient } from '../src/control-plane/client.mjs';
import { PostgresControlPlaneRepository } from '../server/src/postgres-repository.mjs';

test('control-plane settings client sends an optional expected version', async () => {
  const requests = [];
  const client = createControlPlaneClient({ baseUrl: 'http://127.0.0.1:4310',
    async fetchImpl(_url, init) {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: { key: 'production', value: {}, version: 5 } }),
        { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.updateSetting('production', { modelApi: {} }, { expectedVersion: 4 });
  await client.updateSetting('production', { modelApi: {} });
  assert.deepEqual(requests[0], { value: { modelApi: {} }, expectedVersion: 4 });
  assert.deepEqual(requests[1], { value: { modelApi: {} } });
});

test('central settings reject a concurrent change instead of overwriting it', async () => {
  let version = 4;
  const pool = { async query(sql, parameters) {
    if (sql.includes('SELECT version FROM global_settings')) return { rows: [{ version }] };
    assert.match(sql, /WHERE global_settings\.version = \$3/u);
    if (parameters[2] !== version) return { rows: [] };
    version++;
    return { rows: [{ key: parameters[0], value: parameters[1], version }] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool });
  const saved = await repository.upsertSetting('production', { modelApi: { webSearchProvider: 'DEEPSEEK' } },
    { expectedVersion: 4 });
  assert.equal(saved.version, 5);
  await assert.rejects(repository.upsertSetting('production', { modelApi: { webSearchProvider: 'DOUBAO' } },
    { expectedVersion: 4 }), /其他管理员修改/u);
  assert.equal(version, 5);
});
