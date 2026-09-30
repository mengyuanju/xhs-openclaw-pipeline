import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionCookieLock, SESSION_COOKIE_LOCK } from '../src/admin/session-cookie-lock.mjs';
import { createIndexedSessionLeaseStore } from '../src/admin/session-indexed-lock.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function atomicLeaseStore({ initial = null, attempted = () => {} } = {}) {
  const leases = new Map(initial ? [[SESSION_COOKIE_LOCK, initial]] : []);
  let queue = Promise.resolve();
  function transaction(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  return {
    current: () => leases.get(SESSION_COOKIE_LOCK) ?? null,
    acquire: (name, owner, nowMs, leaseMs) => transaction(() => {
      const lease = leases.get(name);
      const available = !lease || lease.expiresAt <= nowMs;
      if (available) leases.set(name, { owner, expiresAt: nowMs + leaseMs });
      attempted(owner, available);
      return available;
    }),
    touch: (name, owner, nowMs, leaseMs) => transaction(() => {
      if (leases.get(name)?.owner !== owner) return false;
      leases.set(name, { owner, expiresAt: nowMs + leaseMs });
      return true;
    }),
    release: (name, owner) => transaction(() => {
      if (leases.get(name)?.owner !== owner) return false;
      leases.delete(name);
      return true;
    }),
  };
}

test('two tabs sharing an atomic lease store serialize cookie requests', async () => {
  const acquired = deferred();
  const releaseFirst = deferred();
  const secondAttempted = deferred();
  const store = atomicLeaseStore({ attempted: (owner, available) => {
    if (owner === 'second' && !available) secondAttempted.resolve();
  } });
  const delay = () => new Promise(resolve => setImmediate(resolve));
  const firstLock = createSessionCookieLock({ leaseStore: store, delay, makeId: () => 'first' });
  const secondLock = createSessionCookieLock({ leaseStore: store, delay, makeId: () => 'second' });
  const order = [];
  let active = 0;
  let maximumActive = 0;
  const first = firstLock(async () => {
    maximumActive = Math.max(maximumActive, ++active);
    order.push('first started');
    acquired.resolve();
    await releaseFirst.promise;
    order.push('first finished');
    active--;
  }, { shared: true });
  await acquired.promise;
  const second = secondLock(async () => {
    maximumActive = Math.max(maximumActive, ++active);
    order.push('second started');
    active--;
  }, { shared: true });
  await secondAttempted.promise;
  assert.deepEqual(order, ['first started']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first started', 'first finished', 'second started']);
  assert.equal(maximumActive, 1);
  assert.equal(store.current(), null);
});

test('a failed cookie request releases its owner and does not poison the tab queue', async () => {
  const store = atomicLeaseStore();
  const firstLock = createSessionCookieLock({ leaseStore: store, makeId: () => 'failed-owner' });
  const secondLock = createSessionCookieLock({ leaseStore: store, makeId: () => 'next-tab' });
  await assert.rejects(firstLock(async () => { throw new Error('login request failed'); }), /login request failed/u);
  assert.equal(store.current(), null);
  assert.equal(await secondLock(async () => 'other tab succeeded', { shared: true }), 'other tab succeeded');
  assert.equal(await firstLock(async () => 'same tab recovered'), 'same tab recovered');
});

test('an expired lease from a closed tab can be replaced atomically', async () => {
  let time = 0;
  const store = atomicLeaseStore({ initial: { owner: 'closed-tab', expiresAt: 250 } });
  const lock = createSessionCookieLock({
    leaseStore: store, now: () => time, delay: async ms => { time += ms; }, makeId: () => 'live-tab',
  });
  const result = await lock(async () => {
    assert.deepEqual(store.current(), { owner: 'live-tab', expiresAt: 60_300 });
    return 'recovered';
  }, { shared: true });
  assert.equal(result, 'recovered');
  assert.equal(time, 300);
  assert.equal(store.current(), null);
});

test('a held lease bounds acquisition waits and never runs the unacquired action', async () => {
  let time = 0;
  let attempts = 0;
  const lock = createSessionCookieLock({
    leaseStore: {
      acquire: async () => { attempts++; return false; },
      touch: async () => assert.fail('unacquired leases cannot refresh'),
      release: async () => assert.fail('unacquired leases cannot release another owner'),
    },
    now: () => time, delay: async () => { time += 30_000; }, makeId: () => 'waiting-tab',
  });
  await assert.rejects(lock(() => assert.fail('the waiting action must not run'), { shared: true }), /timed out/u);
  assert.equal(attempts, 2);
  assert.equal(time, 60_000);
});

test('a failed release preserves the request result and permits recovery after expiry', async () => {
  let time = 0;
  const store = atomicLeaseStore();
  const release = store.release;
  store.release = async (name, owner) => {
    if (owner === 'unreleased-tab') throw new Error('database temporarily unavailable');
    return release(name, owner);
  };
  const firstLock = createSessionCookieLock({ leaseStore: store, now: () => time, makeId: () => 'unreleased-tab' });
  assert.equal(await firstLock(async () => 'login succeeded'), 'login succeeded');
  assert.equal(store.current().owner, 'unreleased-tab');
  time = 60_001;
  const secondLock = createSessionCookieLock({ leaseStore: store, now: () => time, makeId: () => 'recovered-tab' });
  assert.equal(await secondLock(async () => 'renewed', { shared: true }), 'renewed');
  assert.equal(store.current(), null);
});

test('without cross-tab mechanisms renewals fail while manual auth stays serialized', async () => {
  assert.equal(createIndexedSessionLeaseStore(undefined), undefined);
  const lock = createSessionCookieLock({});
  await assert.rejects(lock(() => assert.fail('automatic renewal must not run'), { shared: true }), /unavailable/u);
  const acquired = deferred();
  const releaseFirst = deferred();
  const order = [];
  const first = lock(async () => {
    order.push('first started');
    acquired.resolve();
    await releaseFirst.promise;
    order.push('first finished');
  });
  await acquired.promise;
  const second = lock(() => order.push('second started'));
  assert.deepEqual(order, ['first started']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first started', 'first finished', 'second started']);
});

test('Web Locks take precedence over the IndexedDB lease fallback', async () => {
  const calls = [];
  const lock = createSessionCookieLock({
    locks: { request: async (name, options, action) => {
      calls.push(name);
      assert.equal(options.signal, undefined);
      return action();
    } },
    leaseStore: { acquire: async () => assert.fail('fallback must not be used with Web Locks') },
  });
  assert.equal(await lock(() => 'renewed', { shared: true }), 'renewed');
  assert.deepEqual(calls, [SESSION_COOKIE_LOCK]);
});

test('lease owner generation works in LAN HTTP without crypto.randomUUID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues(values) { values.set([7, 8, 9, 10]); return values; },
  } });
  try {
    const store = atomicLeaseStore();
    const lock = createSessionCookieLock({ leaseStore: store });
    await lock(() => assert.equal(store.current().owner, '7-8-9-10'), { shared: true });
    assert.equal(store.current(), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('cancelling a queued tab request returns promptly and never executes its action', async () => {
  const lock = createSessionCookieLock({});
  const acquired = deferred();
  const releaseFirst = deferred();
  const order = [];
  const first = lock(async () => {
    acquired.resolve();
    await releaseFirst.promise;
    order.push('first');
  });
  await acquired.promise;
  const controller = new AbortController();
  const cancelled = lock(() => assert.fail('cancelled queued actions cannot run'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(order, []);
  const third = lock(() => order.push('third'));
  releaseFirst.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first', 'third']);
});

test('an already-cancelled request cannot execute an action', async () => {
  const controller = new AbortController();
  controller.abort();
  const lock = createSessionCookieLock({});
  await assert.rejects(lock(() => assert.fail('cancelled actions cannot run'), { signal: controller.signal }),
    { name: 'AbortError' });
  assert.equal(await lock(() => 'manual login remains usable'), 'manual login remains usable');
});

test('Web Locks receive the abort signal and cancelled waits do not poison the tab queue', async () => {
  const entered = deferred();
  const controller = new AbortController();
  const lock = createSessionCookieLock({ locks: {
    request(name, options, action) {
      assert.equal(name, SESSION_COOKIE_LOCK);
      if (!options.signal) return action();
      assert.equal(options.signal, controller.signal);
      entered.resolve();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  } });
  const cancelled = lock(() => assert.fail('a cancelled native waiter cannot run'), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(await lock(() => 'next request acquired the native lock'), 'next request acquired the native lock');
});

test('cancelling IDB lease polling preserves the other tab owner', async () => {
  const waiting = deferred();
  const held = { owner: 'another-tab', expiresAt: Date.now() + 60_000 };
  const store = atomicLeaseStore({ initial: held });
  let releases = 0;
  const release = store.release;
  store.release = async (...args) => { releases++; return release(...args); };
  const lock = createSessionCookieLock({
    leaseStore: store, makeId: () => 'cancelled-tab',
    delay: () => { waiting.resolve(); return new Promise(() => {}); },
  });
  const controller = new AbortController();
  const cancelled = lock(() => assert.fail('a cancelled IDB waiter cannot run'), { shared: true, signal: controller.signal });
  await waiting.promise;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(store.current(), held);
  assert.equal(releases, 0);
});

test('a lease transaction committing after cancellation releases only its own acquired lease', async () => {
  const entered = deferred();
  const commit = deferred();
  const released = deferred();
  const store = atomicLeaseStore();
  const acquire = store.acquire;
  const release = store.release;
  store.acquire = async (...args) => {
    entered.resolve();
    await commit.promise;
    return acquire(...args);
  };
  store.release = async (name, owner) => {
    assert.equal(owner, 'cancelled-owner');
    const result = await release(name, owner);
    released.resolve();
    return result;
  };
  const lock = createSessionCookieLock({ leaseStore: store, makeId: () => 'cancelled-owner' });
  const controller = new AbortController();
  const cancelled = lock(() => assert.fail('a late acquired cancelled action cannot run'), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  commit.resolve();
  await released.promise;
  assert.equal(store.current(), null);
});

for (const name of ['SecurityError', 'NotAllowedError']) {
  test(`initial IDB open ${name} disables renewals but keeps manual auth usable`, async () => {
    let opens = 0;
    const store = createIndexedSessionLeaseStore({ open() {
      opens++;
      throw new DOMException('browser permanently prohibits indexedDB', name);
    } });
    await assert.rejects(store.acquire(SESSION_COOKIE_LOCK, 'probe', Date.now(), 60_000),
      { code: 'SESSION_LOCK_UNAVAILABLE' });
    const lock = createSessionCookieLock({ leaseStore: store });
    await assert.rejects(lock(() => assert.fail('renewal cannot bypass unavailable coordination'), { shared: true }),
      /unavailable/u);
    assert.equal(await lock(() => 'manual login succeeded'), 'manual login succeeded');
    assert.equal(await lock(() => 'manual logout succeeded'), 'manual logout succeeded');
    await assert.rejects(lock(() => assert.fail('later renewals remain disabled'), { shared: true }), /unavailable/u);
    assert.equal(opens, 1);
  });
}

test('asynchronous initial IDB permission failures carry the unavailable marker', async () => {
  const store = createIndexedSessionLeaseStore({ open() {
    const request = { error: new DOMException('indexedDB access denied', 'SecurityError') };
    queueMicrotask(() => request.onerror());
    return request;
  } });
  await assert.rejects(store.acquire(SESSION_COOKIE_LOCK, 'owner', Date.now(), 60_000),
    { code: 'SESSION_LOCK_UNAVAILABLE' });
});

test('temporary IDB open failures never bypass cookie coordination', async () => {
  let opens = 0;
  const store = createIndexedSessionLeaseStore({ open() {
    opens++;
    throw new Error('temporary database error');
  } });
  const lock = createSessionCookieLock({ leaseStore: store });
  await assert.rejects(lock(() => assert.fail('manual auth cannot bypass a temporary failure')), /temporary database error/u);
  await assert.rejects(lock(() => assert.fail('renewal cannot bypass a temporary failure'), { shared: true }),
    /temporary database error/u);
  assert.equal(opens, 2);
});

test('a permission failure after successfully opening IDB is not treated as initially unavailable', async () => {
  const store = createIndexedSessionLeaseStore({ open() {
    const request = { result: {
      close() {},
      transaction() { throw new DOMException('transaction access denied', 'SecurityError'); },
    } };
    queueMicrotask(() => request.onsuccess());
    return request;
  } });
  const lock = createSessionCookieLock({ leaseStore: store });
  await assert.rejects(lock(() => assert.fail('transaction failures cannot allow uncoordinated login')),
    { name: 'SecurityError' });
});

test('a lock that previously acquired a lease never drops its protection on an unavailable marker', async () => {
  const store = atomicLeaseStore();
  const lock = createSessionCookieLock({ leaseStore: store });
  assert.equal(await lock(() => 'first coordinated request'), 'first coordinated request');
  store.acquire = async () => { throw Object.assign(new Error('unavailable'), { code: 'SESSION_LOCK_UNAVAILABLE' }); };
  await assert.rejects(lock(() => assert.fail('previously coordinated tabs cannot silently drop protection')),
    { code: 'SESSION_LOCK_UNAVAILABLE' });
});
