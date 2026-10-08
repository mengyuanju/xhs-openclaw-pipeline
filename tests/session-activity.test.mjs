import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionActivity, parseSessionMetadata } from '../src/admin/session-activity.mjs';
import { ADMIN_SESSION_SECONDS, SESSION_ABSOLUTE_SECONDS } from '../src/admin/session-policy.mjs';

const BASE = 1_800_000_000;
const metadata = (extra = {}) => ({
  sessionId: 'a'.repeat(22), userId: 42, expiresAt: BASE + 1800,
  absoluteExpiresAt: BASE + SESSION_ABSOLUTE_SECONDS, renewable: true,
  serverTime: BASE, ...extra,
});

function fixture(options = {}) {
  let clock = BASE * 1000;
  let visible = true;
  let renewals = 0;
  let unauthorized = 0;
  let changed = 0;
  const activity = createSessionActivity({
    initialSession: metadata(),
    now: () => clock,
    isVisible: () => visible,
    renew: async session => {
      renewals++;
      return { ...session, expiresAt: Math.floor(clock / 1000) + ADMIN_SESSION_SECONDS, serverTime: Math.floor(clock / 1000) };
    },
    onUnauthorized: () => { unauthorized++; },
    onChanged: () => { changed++; },
    ...options,
  });
  return {
    activity, setClock: seconds => { clock = seconds * 1000; },
    setVisible: value => { visible = value; },
    get renewals() { return renewals; }, get unauthorized() { return unauthorized; }, get changed() { return changed; },
  };
}

test('background checks, hidden interaction and synthetic interaction never keep a parked page signed in', async () => {
  const f = fixture();
  await f.activity.check();
  await f.activity.recordActivity(false);
  f.setVisible(false);
  await f.activity.recordActivity();
  for (let hour = 1; hour <= 8; hour++) {
    f.setClock(BASE + hour * 3600);
    await f.activity.check();
  }
  assert.equal(f.renewals, 0);
});

test('real foreground activity renews once and the new expiry prevents repeated requests', async () => {
  const f = fixture();
  await Promise.all([f.activity.recordActivity(), f.activity.recordActivity(), f.activity.check()]);
  assert.equal(f.renewals, 1);
  f.setClock(BASE + 4 * 3600);
  await f.activity.recordActivity();
  assert.equal(f.renewals, 1);
  f.setClock(BASE + 7 * 3600 + 60);
  await f.activity.recordActivity();
  assert.equal(f.renewals, 2, 'a continuously used session can pass its original eight-hour deadline');
});

test('activity older than fifteen minutes cannot trigger a periodic renewal', async () => {
  const f = fixture({ initialSession: metadata({ expiresAt: BASE + 2 * 3600 }) });
  await f.activity.recordActivity();
  f.setClock(BASE + 3600);
  await f.activity.check();
  assert.equal(f.renewals, 0);
  await f.activity.recordActivity();
  assert.equal(f.renewals, 1);
});

test('another tab extending this session avoids a duplicate renewal', async () => {
  const f = fixture();
  f.activity.update(metadata({ expiresAt: BASE + ADMIN_SESSION_SECONDS }));
  await f.activity.recordActivity();
  assert.equal(f.renewals, 0);
});

test('changing accounts stops the old activity controller', async () => {
  const f = fixture();
  f.activity.update(metadata({ sessionId: 'b'.repeat(22), userId: 43 }));
  await f.activity.recordActivity();
  assert.equal(f.changed, 1);
  assert.equal(f.renewals, 0);
});

test('temporary failures preserve activity and retry after backoff; stale sessions stop', async () => {
  let calls = 0;
  let status = 503;
  const f = fixture({ renew: async () => { calls++; throw Object.assign(new Error('fixture'), { status }); } });
  await f.activity.recordActivity();
  await f.activity.recordActivity();
  assert.equal(calls, 1);
  assert.equal(f.unauthorized, 0);
  f.setClock(BASE + 31);
  status = 401;
  await f.activity.recordActivity();
  await f.activity.check();
  assert.equal(calls, 2);
  assert.equal(f.unauthorized, 1);
});

test('a queued renewal receives a fresh visibility predicate and stopped controllers ignore late results', async () => {
  let complete;
  let active;
  const f = fixture({ renew: (_, predicate) => {
    active = predicate;
    return new Promise(resolve => { complete = resolve; });
  } });
  const pending = f.activity.recordActivity();
  await Promise.resolve();
  f.setVisible(false);
  assert.equal(active(), false);
  f.activity.stop();
  complete(metadata({ sessionId: 'b'.repeat(22) }));
  await pending;
  assert.equal(f.changed, 0);
});

test('the initial server clock corrects a browser two hours ahead or behind', async () => {
  for (const offset of [-7200, 7200]) {
    let calls = 0;
    const activity = createSessionActivity({
      initialSession: metadata(), now: () => (BASE + offset) * 1000, isVisible: () => true,
      renew: async () => { calls++; return metadata({ expiresAt: BASE + ADMIN_SESSION_SECONDS }); },
    });
    await activity.recordActivity();
    assert.equal(calls, 1, `clock offset ${offset}`);
  }
});

test('the final absolute deadline and legacy nonrenewable sessions never spin on activity', async () => {
  for (const initialSession of [metadata({ absoluteExpiresAt: BASE + 1800 }), metadata({ renewable: false, userId: null })]) {
    const f = fixture({ initialSession });
    for (let i = 0; i < 10; i++) await f.activity.recordActivity();
    assert.equal(f.renewals, 0);
  }
});

test('browser metadata drops credentials and rejects malformed cross-tab timing data', () => {
  assert.deepEqual(parseSessionMetadata({ ...metadata(), token: 'never-expose', credentialVersion: 7 }), metadata());
  for (const value of [null, { ...metadata(), sessionId: '../bad' }, { ...metadata(), expiresAt: Infinity },
    { ...metadata(), userId: 0 }, { ...metadata(), expiresAt: BASE + SESSION_ABSOLUTE_SECONDS + 1 }]) {
    assert.equal(parseSessionMetadata(value), null);
  }
});
