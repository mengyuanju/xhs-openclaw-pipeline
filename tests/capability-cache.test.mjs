import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityReader, invalidateControlPlaneCapabilities } from '../src/control-plane/capability-cache.mjs';
import { assertMutationCapability } from '../src/control-plane/mutation-capability.mjs';

test('simultaneous protected reads share a check, expire, and never reuse a failed refresh', async () => {
  let now = 0, checks = 0, fail = false;
  const gate = Promise.withResolvers();
  const reader = createCapabilityReader({ now: () => now, ttlMs: 100, fetchImpl: async () => {
    checks++;
    if (checks === 1) await gate.promise;
    if (fail) throw Error('offline');
    return Response.json({ data: { capabilities: { finalDeliveryVersion: 5 } } });
  } });
  const followers = Array.from({ length: 30 }, () => reader.read('http://fake.test'));
  assert.equal(checks, 1);
  gate.resolve();
  assert.ok((await Promise.all(followers)).every(value => value.finalDeliveryVersion === 5));
  now = 99; await reader.read('http://fake.test'); assert.equal(checks, 1);
  now = 100; fail = true;
  await assert.rejects(reader.read('http://fake.test'), { code: 'CONTROL_PLANE_UNAVAILABLE' });
  assert.equal(checks, 2);
  fail = false; await reader.read('http://fake.test'); assert.equal(checks, 3);
});

test('center identities are separate and invalidated in-flight checks cannot refill the cache', async () => {
  let checks = 0;
  const gate = Promise.withResolvers();
  const reader = createCapabilityReader({ fetchImpl: async () => {
    const version = ++checks;
    if (version === 1) await gate.promise;
    return Response.json({ data: { capabilities: { version } } });
  } });
  const old = reader.read('http://one.test');
  reader.invalidate('http://one.test');
  assert.equal((await reader.read('http://one.test')).version, 2);
  gate.resolve(); await old;
  assert.equal((await reader.read('http://one.test')).version, 2);
  assert.equal((await reader.read('http://two.test')).version, 3);
});

test('legacy, malformed and unsupported receipts fail closed and do not delay an upgraded center', async () => {
  for (const response of [new Response('', { status: 404 }), Response.json({ data: { capabilities: [] } })]) {
    const reader = createCapabilityReader({ fetchImpl: async () => response });
    await assert.rejects(reader.read('http://fake.test'), { code: 'CONTROL_PLANE_UPGRADE_REQUIRED' });
  }
  let checks = 0;
  const fetchImpl = async () => Response.json({ data: { capabilities: { finalDeliveryVersion: ++checks === 1 ? 4 : 5 } } });
  const input = { root: 'http://upgrade.test', routePath: '/v1/delivery-pool', method: 'GET', fetchImpl };
  await assert.rejects(assertMutationCapability(input), { code: 'CONTROL_PLANE_UPGRADE_REQUIRED' });
  await assertMutationCapability(input);
  await assertMutationCapability(input); assert.equal(checks, 2);
  invalidateControlPlaneCapabilities(input.root, { fetchImpl });
  await assertMutationCapability(input); assert.equal(checks, 3);
});

test('completed center cache is bounded', async () => {
  let checks = 0;
  const reader = createCapabilityReader({ maxCenters: 2, fetchImpl: async () => {
    checks++; return Response.json({ data: { capabilities: {} } });
  } });
  await reader.read('http://one.test'); await reader.read('http://two.test'); await reader.read('http://three.test');
  await reader.read('http://two.test'); assert.equal(checks, 3);
  await reader.read('http://one.test'); assert.equal(checks, 4);
});
