import assert from 'node:assert/strict';
import test from 'node:test';
import { createListRefreshCoordinator } from '../app/workbench/list-refresh-coordinator.ts';
import { createSessionReadCache } from '../app/components/session-read-cache.ts';
import { notifyWorkspaceUpdated, subscribeWorkspaceUpdates, workspaceUpdateRevision } from '../app/components/workspace-updates.ts';

test('local mutation refresh covers its delayed notification without starting or cancelling another request', async () => {
  const coordinator = createListRefreshCoordinator(), gate = Promise.withResolvers();
  let reads = 0;
  const read = async () => { reads += 1; await gate.promise; };
  const first = coordinator.request(read, { revision: 1 });
  const notification = coordinator.request(read, { revision: 1, invalidation: true });
  assert.equal(first, notification);
  gate.resolve(); await first;
  await coordinator.request(read, { revision: 1, invalidation: true });
  assert.equal(reads, 1);
  await coordinator.request(read, { revision: 1 });
  assert.equal(reads, 2, 'a deliberate manual refresh still reads the server');
});

test('new changes received in flight coalesce to one follow-up and retain the newest revision', async () => {
  const coordinator = createListRefreshCoordinator(), gate = Promise.withResolvers(), reads = [];
  const first = coordinator.request(async () => { reads.push(1); await gate.promise; }, { revision: 1 });
  coordinator.request(async () => reads.push(3), { revision: 3, invalidation: true });
  coordinator.request(async () => reads.push(2), { revision: 2, invalidation: true });
  gate.resolve(); await first;
  assert.deepEqual(reads, [1, 3]);
  await coordinator.request(async () => reads.push('duplicate'), { revision: 3, invalidation: true });
  assert.deepEqual(reads, [1, 3]);
});

test('changing list filters resets old queued work and cannot suppress the new scope', async () => {
  const coordinator = createListRefreshCoordinator(), gate = Promise.withResolvers(), reads = [];
  const first = coordinator.request(async () => { reads.push('old'); await gate.promise; }, { revision: 1 });
  coordinator.request(async () => reads.push('old follow-up'), { revision: 2, invalidation: true });
  coordinator.reset();
  await coordinator.request(async () => reads.push('new'), { revision: 1 });
  gate.resolve(); await first;
  assert.deepEqual(reads, ['old', 'new']);
});

test('authenticated readers share one flight, reuse a fresh value and re-read after invalidation', async () => {
  let reads = 0, clock = 100;
  const cache = createSessionReadCache({ scope: () => 'session-a', ttlMs: 1000, now: () => clock,
    read: async () => ({ version: ++reads }) });
  const [one, two] = await Promise.all([cache.load(), cache.load()]);
  assert.equal(one, two); assert.equal(reads, 1);
  await cache.load(); assert.equal(reads, 1);
  clock += 1001; await cache.load(); assert.equal(reads, 2);
  cache.invalidate(); await cache.load(); assert.equal(reads, 3);
});

test('invalidation received in flight gets one newer read even when several subscribers refresh', async () => {
  const gate = Promise.withResolvers(); let reads = 0;
  const cache = createSessionReadCache({ scope: () => 'session-a', ttlMs: 1000,
    read: async () => { reads += 1; if (reads === 1) return gate.promise; return { version: reads }; } });
  const first = cache.load();
  cache.invalidate(); const next = cache.load(), shared = cache.load();
  gate.resolve({ version: 1 });
  assert.equal((await first).version, 1);
  assert.equal((await next).version, 2); assert.equal((await shared).version, 2);
  assert.equal(reads, 2);
});

test('session changes abort old reads and reject late data even if an upstream ignores cancellation', async () => {
  const gate = Promise.withResolvers(); let session = 'account-a', reads = 0, oldSignal;
  const cache = createSessionReadCache({ scope: () => session, ttlMs: 1000,
    read: async signal => { reads += 1; if (reads === 1) { oldSignal = signal; return gate.promise; } return { account: session }; } });
  const first = cache.load(); const rejection = assert.rejects(first, /登录账号已变化/u);
  session = 'account-b';
  assert.equal(cache.getSnapshot().data, null); assert.equal(oldSignal.aborted, true);
  assert.equal((await cache.load()).account, 'account-b');
  gate.resolve({ account: 'account-a' }); await rejection;
  assert.equal(cache.getSnapshot().data.account, 'account-b');
});

test('SSR seed is reused without a hydration request and authorization errors are never cached', async () => {
  let reads = 0;
  const cache = createSessionReadCache({ scope: () => 'a', ttlMs: 1000,
    read: async () => { reads += 1; throw Object.assign(Error('forbidden'), { status: 403 }); } });
  cache.seed([]); await cache.load(); assert.equal(reads, 0);
  cache.invalidate(); await assert.rejects(cache.load(), { status: 403 });
  assert.equal(cache.getSnapshot().data, null, 'a denied read clears data from before the permission change');
  await assert.rejects(cache.load(), { status: 403 }); assert.equal(reads, 2);
});

test('workspace revision advances at receipt before the debounced callback, once per event', async () => {
  const previous = globalThis.window, fake = new EventTarget();
  fake.localStorage = { setItem() {} }; globalThis.window = fake;
  let callbacks = 0;
  const off = subscribeWorkspaceUpdates(() => { callbacks += 1; }, { scopes: ['tasks'] });
  try {
    assert.equal(workspaceUpdateRevision(), 0);
    notifyWorkspaceUpdated({ scopes: ['tasks'], taskIds: [7] });
    assert.equal(workspaceUpdateRevision(), 1); assert.equal(callbacks, 0);
    const event = new Event('storage'); Object.assign(event, { key: 'xhs:workspace-updated:v1', newValue: JSON.stringify({ scopes: ['tasks'] }) });
    fake.dispatchEvent(event); assert.equal(workspaceUpdateRevision(), 2);
    await new Promise(done => setTimeout(done, 350)); assert.equal(callbacks, 1);
  } finally { off(); globalThis.window = previous; }
});
