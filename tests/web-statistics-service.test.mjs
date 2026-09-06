import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatisticsService } from '../src/web-statistics/service.mjs';
import { createReadScheduler } from '../src/web-statistics/read-scheduler.mjs';
const root = 'http://center.test';
const session = (username = 'alice', role = 'USER', credentialVersion = 1) => ({ subject: 'user', username, roles: [role], credentialVersion });
const row = (id, patch = {}) => ({ id, state: 'COPY_QUEUED', createdByUserId: 'alice',
  createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', ...patch });
function fixture(rows, options = {}) {
  let time = Date.parse('2026-09-06T08:00:00Z');
  const calls = [];
  const service = createStatisticsService({ now: () => time, sleep: async ms => { time += ms; },
    fetchImpl: async (rawUrl, init) => {
      calls.push({ url: rawUrl.toString(), init, time });
      const url = new URL(rawUrl);
      const id = Number(url.pathname.split('/').at(-1));
      if (id) return Response.json({ data: { id, executions: [], imageRuns: [], assets: [] } });
      const selected = rows.filter(task => !url.searchParams.has('createdByUserId')
        || task.createdByUserId === url.searchParams.get('createdByUserId'));
      const offset = Number(url.searchParams.get('offset'));
      return Response.json({ data: { items: selected.slice(offset, offset + 200), total: selected.length, offset, limit: 200 } });
    }, ...options });
  return { service, calls, advance: ms => { time += ms; } };
}
test('statistics identity is session-bound and admin analysis cannot be requested by other roles', async () => {
  const { service, calls } = fixture([row(1), row(2, { createdByUserId: 'bob' })]);
  for (const role of ['USER', 'REVIEWER']) {
    await assert.rejects(service.read({ root, session: session('alice', role), scope: 'admin' }), e => e.status === 403);
    await assert.rejects(service.read({ root, session: session('alice', role), details: true }), e => e.status === 403);
  }
  assert.equal(calls.length, 0);
  const result = await service.read({ root, session: session(), username: 'bob' });
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.people, undefined);
  assert.equal(result.creators, undefined);
  assert.equal(result.details, null);
  assert.match(calls[0].url, /createdByUserId=alice/);
  assert.equal(calls[0].init.method, 'GET');
});

test('200-row pages are collected completely; filter changes and warm refreshes reuse shared facts', async () => {
  const { service, calls } = fixture(Array.from({ length: 201 }, (_, i) => row(i + 1)));
  const input = { root, session: session() };
  const first = await service.read(input);
  assert.equal(first.summary, null);
  assert.equal(first.state, 'loading');
  assert.equal(first.progress.loaded, 200);
  const second = await service.read(input);
  assert.equal(second.summary.total, 201);
  await service.read({ ...input, period: '7d' });
  await service.read({ ...input, refresh: true });
  assert.equal(calls.length, 2, 'fresh manual refresh cannot bypass cooldown');
});

test('concurrent reads coalesce and the per-instance scheduler spaces all upstream requests', async () => {
  const { service, calls } = fixture([row(1), row(2, { createdByUserId: 'bob' })]);
  await Promise.all(Array.from({ length: 10 }, () => service.read({ root, session: session() })));
  assert.equal(calls.length, 1);
  await service.read({ root, session: session('bob') });
  await service.read({ root, session: session('admin', 'ADMIN'), scope: 'admin' });
  assert.equal(calls.length, 3);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].time - calls[i - 1].time >= 1000);
});

test('details are on-demand, incremental, and not fetched for a period preceding no possible activity', async () => {
  const rows = [row(1, { updatedAt: '2026-08-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' }), row(2)];
  const { service, calls, advance } = fixture(rows);
  const input = { root, session: session('admin', 'ADMIN'), scope: 'admin' };
  await service.read(input);
  assert.equal(calls.length, 1);
  const result = await service.read({ ...input, details: true });
  assert.equal(result.details.total, 1);
  assert.equal(result.details.loaded, 1);
  assert.equal(calls.length, 2);
  advance(61_000);
  await service.read({ ...input, details: true });
  await service.read({ ...input, details: true });
  assert.equal(calls.filter(call => call.url.endsWith('/2')).length, 1);
  rows[1].updatedAt = '2026-09-06T09:00:00Z';
  advance(300_000);
  await service.read({ ...input, details: true });
  await service.read({ ...input, details: true });
  assert.equal(calls.filter(call => call.url.endsWith('/2')).length, 2);
});

test('incomplete legacy data and oversized scans do not become fake totals', async () => {
  const legacy = fixture([], { fetchImpl: async () => Response.json({ data: [row(1)] }) });
  const result = await legacy.service.read({ root, session: session() });
  assert.equal(result.summary, null);
  assert.equal(result.state, 'error');
  const capped = fixture([row(1), row(2)], { maxTasks: 1 });
  assert.equal((await capped.service.read({ root, session: session() })).summary, null);
});

test('expired identities never receive stale cached data after an upstream denial', async () => {
  let denied = false;
  const data = fixture([row(1)], { fetchImpl: async () => denied ? Response.json({}, { status: 401 })
    : Response.json({ data: { items: [row(1)], total: 1, offset: 0, limit: 200 } }) });
  await data.service.read({ root, session: session() });
  denied = true;
  data.advance(61_000);
  await assert.rejects(data.service.read({ root, session: session() }), e => e.status === 401);
  await assert.rejects(data.service.read({ root, session: session() }), e => e.status === 401);
});

test('stale complete snapshots survive availability errors with a retry cooldown', async () => {
  let fail = false;
  const data = fixture([], { fetchImpl: async () => fail ? Response.json({}, { status: 503 })
    : Response.json({ data: { items: [row(1)], total: 1, offset: 0 } }) });
  const input = { root, session: session() };
  const initial = await data.service.read(input);
  fail = true; data.advance(61_000);
  const stale = await data.service.read(input);
  assert.equal(stale.state, 'error');
  assert.equal(stale.summary.total, 1);
  assert.equal(stale.updatedAt, initial.updatedAt);
  assert.equal(stale.retryAfterMs, 30_000);
  assert.equal((await data.service.read({ ...input, refresh: true })).updatedAt, initial.updatedAt);
});

test('mutable pagination restarts are bounded and never publish missing or duplicate rows', async () => {
  let calls = 0;
  const data = fixture([], { fetchImpl: async url => {
    calls++;
    const offset = Number(new URL(url).searchParams.get('offset'));
    return Response.json({ data: { items: offset ? [row(1)] : Array.from({ length: 200 }, (_, i) => row(i + 1)), total: 201, offset } });
  } });
  let result;
  for (let i = 0; i < 6; i++) result = await data.service.read({ root, session: session() });
  assert.equal(result.state, 'error');
  assert.equal(result.summary, null);
  assert.equal(calls, 6);
  await data.service.read({ root, session: session(), refresh: true });
  assert.equal(calls, 6);
});

test('caches isolate center roots and credential versions, while admin filters reuse the same scan', async () => {
  const data = fixture([row(1, { createdByRole: 'USER' }), row(2, { createdByUserId: 'bob', createdByRole: 'REVIEWER' })]);
  const input = { root, session: session('admin', 'ADMIN'), scope: 'admin' };
  assert.equal((await data.service.read(input)).summary.total, 2);
  assert.equal((await data.service.read({ ...input, username: 'bob' })).summary.total, 1);
  assert.equal((await data.service.read({ ...input, role: 'USER' })).summary.total, 1);
  assert.equal(data.calls.length, 1);
  await data.service.read({ ...input, root: 'http://other-center.test' });
  await data.service.read({ ...input, session: session('admin', 'ADMIN', 2) });
  assert.equal(data.calls.length, 3);
});

test('identity-changing task transitions invalidate details before the five-minute timestamp grace', async () => {
  const rows = [row(1)];
  const data = fixture(rows);
  const input = { root, session: session('admin', 'ADMIN'), scope: 'admin', details: true };
  await data.service.read(input);
  await data.service.read(input);
  rows[0].state = 'COPY_REVIEW_PENDING';
  rows[0].currentCopyRevisionId = 2;
  data.advance(61_000);
  await data.service.read(input);
  await data.service.read(input);
  assert.equal(data.calls.filter(call => call.url.endsWith('/1')).length, 2);
});

test('a revoked admin identity clears both cached counts and detail facts', async () => {
  const data = fixture([], { fetchImpl: async url => new URL(url).pathname.endsWith('/1')
    ? Response.json({}, { status: 403 })
    : Response.json({ data: { items: [row(1)], total: 1, offset: 0 } }) });
  const input = { root, session: session('admin', 'ADMIN'), scope: 'admin', details: true };
  await data.service.read(input);
  await assert.rejects(data.service.read(input), error => error.status === 403);
  const next = await data.service.read(input);
  assert.equal(next.details.loaded, 0);
});

test('scheduler bounds pending work, serializes active reads, and releases the queue after rejection', async () => {
  let time = 0, active = 0, peak = 0, release;
  const starts = [];
  const gate = new Promise(resolve => { release = resolve; });
  const schedule = createReadScheduler({ now: () => time, sleep: async ms => { time += ms; }, maxQueued: 2 });
  const first = schedule(async () => { active++; peak = Math.max(peak, active); starts.push(time); await gate; active--; throw new Error('failed'); });
  const second = schedule(async () => { active++; peak = Math.max(peak, active); starts.push(time); active--; return 2; });
  await assert.rejects(schedule(async () => 3), /繁忙/);
  release();
  await assert.rejects(first, /failed/);
  assert.equal(await second, 2);
  assert.equal(peak, 1);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.equal(await schedule(async () => 4), 4);
});
