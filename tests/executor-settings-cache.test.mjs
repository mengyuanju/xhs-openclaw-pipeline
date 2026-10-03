import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutorSettingsReader } from '../src/executor/settings-cache.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';

test('settings reads share in-flight work and expire from successful completion', async () => {
  let now = 100, calls = 0;
  const first = Promise.withResolvers();
  const read = createExecutorSettingsReader(() => { calls++; return first.promise; }, { ttlMs: 15_000, now: () => now });
  const copy = read(), image = read();
  assert.equal(copy, image);
  await Promise.resolve();
  assert.equal(calls, 1);
  now = 500;
  first.resolve([{ key: 'production', value: { version: 1 } }]);
  const value = await copy;
  now = 15_499;
  assert.equal(await read(), value);
  assert.equal(calls, 1);
  now = 15_500;
  await read();
  assert.equal(calls, 2);
});

test('expired settings failures fail closed, release in-flight work and recover on the next read', async () => {
  let now = 0, calls = 0;
  const read = createExecutorSettingsReader(async () => {
    calls++;
    if (calls === 2) throw new Error('center unavailable');
    return [{ version: calls }];
  }, { ttlMs: 10, now: () => now });
  assert.deepEqual(await read(), [{ version: 1 }]);
  now = 10;
  const results = await Promise.allSettled([read(), read()]);
  assert.ok(results.every(result => result.status === 'rejected' && /unavailable/.test(result.reason.message)));
  assert.equal(calls, 2);
  assert.deepEqual(await read(), [{ version: 3 }]);
});

test('two executor lanes cache only settings and repeat capacity checks; refresh failure prevents fresh claims but permits receipt replay', async () => {
  let now = 0, settingsCalls = 0, capacityChecks = 0, claims = 0;
  const agent = createExecutorAgent({ nodeId: 'cache-test', imageWorkerEnabled: true, now: () => now,
    settingsCacheMs: 10,
    readinessCheck: async ({ controlPlane }) => { await controlPlane.listSettings(); },
    availabilityCheck: async ({ controlPlane }) => { await controlPlane.listSettings(); capacityChecks++; },
    controlPlane: {
      listSettings: async () => { settingsCalls++; if (settingsCalls === 2) throw new Error('settings offline'); return []; },
      claimCopyBatch: async ({ requestId }) => { claims++; return { requestId, claims: [] }; },
      claimImageBatch: async ({ requestId }) => { claims++; return { requestId, claims: [] }; },
    },
  });
  await agent.prepare();
  await Promise.all(['COPY', 'IMAGE'].map(kind => agent.claimBatch(kind, { requestId: kind, limit: 1 })));
  assert.equal(settingsCalls, 1);
  assert.equal(capacityChecks, 2);
  assert.equal(claims, 2);
  now = 10;
  await assert.rejects(agent.claimBatch('COPY', { requestId: 'fresh', limit: 1 }),
    error => /offline/.test(error.message) && error.claimRequestNotSent === true);
  assert.equal(claims, 2);
  await agent.claimBatch('COPY', { requestId: 'replay', limit: 1, reconcile: true });
  assert.equal(settingsCalls, 2);
  assert.equal(claims, 3);
  await agent.claimBatch('COPY', { requestId: 'recovered', limit: 1 });
  assert.equal(settingsCalls, 3);
  assert.equal(capacityChecks, 3);
});

test('invalid settings responses are not cached and the next read can recover immediately', async () => {
  let calls = 0;
  const read = createExecutorSettingsReader(async () => ++calls === 1 ? {} : []);
  await assert.rejects(read(), /must be an array/);
  assert.deepEqual(await read(), []);
  assert.equal(calls, 2);
});

test('a settings revision invalidates warm cached data and fences an older in-flight response', async () => {
  let calls = 0;
  const stale = Promise.withResolvers();
  const read = createExecutorSettingsReader(async () => {
    calls++;
    if (calls === 2) return stale.promise;
    return [{ version: calls }];
  });
  assert.deepEqual(await read(), [{ version: 1 }]);
  read.invalidate();
  const running = read(); await Promise.resolve();
  read.invalidate();
  stale.resolve([{ version: 2 }]);
  assert.deepEqual(await running, [{ version: 3 }], 'waiting claims receive the refreshed version');
  assert.deepEqual(await read(), [{ version: 3 }]);
  assert.equal(calls, 3);
});
