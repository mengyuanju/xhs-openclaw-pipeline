import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutorScheduler, executorIdlePollMs } from '../src/executor/scheduler.mjs';

const deferred = () => Promise.withResolvers();
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('scheduler did not reach the expected state');
}
function fixture(options = {}) {
  const requests = [], started = [], work = new Map();
  let id = 0;
  const agent = {
    async claimBatch(kind, request) {
      requests.push({ kind, ...request });
      return { requestId: request.requestId, claims: Array.from({ length: request.limit }, () => {
        const executionId = String(++id);
        return { task: { id }, execution: { id: executionId, status: 'RUNNING' } };
      }) };
    },
    async executeClaim(kind, claim) {
      started.push({ kind, id: claim.execution.id });
      const pending = deferred();
      work.set(claim.execution.id, pending);
      await pending.promise;
      return { kind, taskId: claim.task.id, status: 'SUCCEEDED' };
    },
  };
  const scheduler = createExecutorScheduler({ agent, copyConcurrency: 3, imageConcurrency: 2,
    imageWorkerEnabled: true, pollMs: 10, ...options });
  return { agent, scheduler, requests, started, work };
}

test('independent 3/2 pools fill capacity and replace a fast task without waiting for the batch', async () => {
  const f = fixture();
  const running = f.scheduler.start();
  await until(() => f.started.length === 5);
  assert.deepEqual(f.scheduler.status(), { COPY: { active: 3, reserved: 0 }, IMAGE: { active: 2, reserved: 0 } });
  const finished = f.started.find(s => s.kind === 'COPY');
  f.work.get(finished.id).resolve();
  await until(() => f.started.length === 6);
  assert.equal(f.requests.filter(r => r.kind === 'COPY').at(-1).limit, 1);
  assert.equal(f.scheduler.status().COPY.active, 3);
  f.scheduler.stop();
  for (const work of f.work.values()) work.resolve();
  await running;
  assert.equal(f.started.length, 6);
});

test('uncertain batch claims reserve slots and reuse the same request even during shutdown', async () => {
  const f = fixture({ imageWorkerEnabled: false });
  const original = f.agent.claimBatch;
  let first;
  f.agent.claimBatch = async (kind, request) => {
    if (!first) { first = request; throw new Error('response lost'); }
    assert.equal(request.requestId, first.requestId);
    assert.equal(request.limit, 3);
    assert.equal(request.reconcile, true);
    return original(kind, request);
  };
  const running = f.scheduler.start();
  await until(() => first);
  assert.equal(f.scheduler.status().COPY.reserved, 3);
  f.scheduler.stop();
  await until(() => f.started.length === 3);
  for (const work of f.work.values()) work.resolve();
  await running;
  assert.equal(f.requests.length, 1);
});

for (const code of ['CLAIM_REQUEST_EXPIRED', 'CLAIM_REQUEST_CLOCK_SKEW']) {
test(`${code} releases its reservation and shutdown does not claim again`, async () => {
  const f = fixture({ imageWorkerEnabled: false });
  let calls = 0;
  f.agent.claimBatch = async () => {
    calls++;
    f.scheduler.stop();
    throw Object.assign(new Error('claim not allocated'), { code });
  };
  await f.scheduler.start();
  assert.equal(calls, 1);
  assert.deepEqual(f.scheduler.status().COPY, { active: 0, reserved: 0 });
  assert.equal(f.started.length, 0);
});
}

test('empty capacity keeps polling while a slow task runs and paused responses do not spin', async () => {
  const f = fixture({ imageWorkerEnabled: false });
  const original = f.agent.claimBatch;
  let calls = 0;
  f.agent.claimBatch = async (kind, request) => {
    calls++;
    if (calls === 1) return { status: 'PAUSED' };
    if (calls === 2) return original(kind, { ...request, limit: 1 });
    if (calls === 3) return { requestId: request.requestId, claims: [] };
    return original(kind, request);
  };
  const running = f.scheduler.start();
  await until(() => f.started.length === 3);
  assert.equal(calls, 4);
  f.scheduler.stop();
  for (const work of f.work.values()) work.resolve();
  await running;
});

test('failure reports keep their slots and retry independently from other task completion', async () => {
  const errors = [];
  const f = fixture({ imageWorkerEnabled: false, copyConcurrency: 2, onError: (kind, error, context) => errors.push({ kind, context }) });
  const original = f.agent.executeClaim;
  let attempts = 0;
  f.agent.executeClaim = async (kind, claim) => {
    if (claim.task.id === 1 && ++attempts === 1) throw new Error('report offline');
    return original(kind, claim);
  };
  const running = f.scheduler.start();
  await until(() => f.started.length === 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.scheduler.status().COPY.active, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(errors, [{ kind: 'COPY', context: { taskId: 1, executionId: '1' } }]);
  f.scheduler.stop();
  for (const work of f.work.values()) work.resolve();
  await running;
});

test('once executes at most one task per enabled kind and terminal replays do not execute', async () => {
  const f = fixture({ once: true });
  const original = f.agent.claimBatch;
  f.agent.claimBatch = async (kind, request) => {
    assert.equal(request.limit, 1);
    const result = await original(kind, request);
    if (kind === 'IMAGE') result.claims[0].execution.status = 'SUCCEEDED';
    return result;
  };
  const running = f.scheduler.start();
  await until(() => f.started.length === 1);
  for (const work of f.work.values()) work.resolve();
  await running;
  assert.equal(f.requests.length, 2);
  assert.equal(f.started[0].kind, 'COPY');
});

test('confirmed empty responses back off within the jitter bound and wake restores fresh polling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const requests = [];
  const agent = { claimBatch: async (kind, request) => {
    requests.push({ ...request, at: Date.now() });
    return { requestId: request.requestId, claims: [] };
  } };
  const scheduler = createExecutorScheduler({ agent, pollMs: 5000, idleMaxPollMs: 20000, random: () => 0.5 });
  scheduler.setWorkNotificationsOnline(true);
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle();
  t.mock.timers.tick(5000); await settle();
  t.mock.timers.tick(10000); await settle();
  t.mock.timers.tick(19999); await settle();
  assert.deepEqual(requests.map(request => request.at), [1000, 6000, 16000]);
  scheduler.wake('COPY'); await settle();
  assert.equal(requests.at(-1).at, 35999);
  t.mock.timers.tick(5000); await settle();
  assert.equal(requests.at(-1).at, 40999);
  assert.equal(new Set(requests.map(request => request.requestId)).size, requests.length,
    'a confirmed empty response uses a new durable receipt identity next time');
  scheduler.stop(); await running;
  assert.equal(executorIdlePollMs(5000, 20000, 2, () => 0), 9000);
  assert.equal(executorIdlePollMs(5000, 20000, 2, () => 1), 11000);
  assert.equal(executorIdlePollMs(5000, 20000, 20, () => 1), 20000);
});

test('an uncertain response after idle uses the same receipt on normal cadence and reconciliation does not inherit idle delay', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const requests = [];
  const scheduler = createExecutorScheduler({ pollMs: 5000, idleMaxPollMs: 20000, random: () => 0.5, agent: {
    claimBatch: async (kind, request) => {
      requests.push({ ...request, at: Date.now() });
      if (requests.length === 3) throw new Error('response lost');
      return { requestId: request.requestId, claims: [] };
    },
  } });
  scheduler.setWorkNotificationsOnline(true);
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle();
  t.mock.timers.tick(5000); await settle();
  t.mock.timers.tick(10000); await settle();
  t.mock.timers.tick(5000); await settle();
  assert.equal(requests[3].requestId, requests[2].requestId);
  assert.equal(requests[3].reconcile, true);
  assert.equal(requests[3].at - requests[2].at, 5000);
  t.mock.timers.tick(5000); await settle();
  assert.equal(requests[4].at - requests[3].at, 5000);
  scheduler.stop(); await running;
});

test('failed preflight never turns the next fresh claim into a reconciliation that skips settings', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const requests = [];
  const scheduler = createExecutorScheduler({ pollMs: 5000, agent: {
    claimBatch: async (kind, request) => {
      requests.push({ ...request });
      if (requests.length < 3) throw Object.assign(new Error('settings unavailable before claim'), { claimRequestNotSent: true });
      return { requestId: request.requestId, claims: [] };
    },
  } });
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle();
  assert.equal(scheduler.status().COPY.reserved, 0);
  t.mock.timers.tick(5000); await settle();
  t.mock.timers.tick(5000); await settle();
  assert.ok(requests.every(request => request.reconcile === false));
  assert.equal(new Set(requests.map(request => request.requestId)).size, 3);
  scheduler.stop(); await running;
});

test('task completion during a slow empty claim wakes free capacity immediately', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const work = Promise.withResolvers(), slowClaim = Promise.withResolvers();
  const requests = [];
  const scheduler = createExecutorScheduler({ pollMs: 5000, idleMaxPollMs: 20000, copyConcurrency: 2,
    agent: {
      claimBatch: async (kind, request) => {
        requests.push({ ...request, at: Date.now() });
        if (requests.length === 1) return { requestId: request.requestId,
          claims: [{ task: { id: 1 }, execution: { id: '1', status: 'RUNNING' } }] };
        if (requests.length === 2) await slowClaim.promise;
        if (requests.length === 3) scheduler.stop();
        return { requestId: request.requestId, claims: [] };
      },
      executeClaim: async () => { await work.promise; return { status: 'SUCCEEDED' }; },
    },
  });
  scheduler.setWorkNotificationsOnline(true);
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  await settle(); t.mock.timers.tick(5000); await settle();
  work.resolve(); await settle();
  slowClaim.resolve(); await settle();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].at, requests[1].at);
  assert.equal(requests[2].limit, 2);
  await running;
});

test('offline notifications disable idle backoff immediately and old centers keep the normal poll interval', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const calls = [];
  const scheduler = createExecutorScheduler({ pollMs: 5000, idleMaxPollMs: 20000, random: () => 0.5,
    agent: { claimBatch: async (kind, request) => {
      calls.push(Date.now()); return { requestId: request.requestId, claims: [] };
    } },
  });
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle(); t.mock.timers.tick(5000); await settle(); t.mock.timers.tick(5000); await settle();
  assert.deepEqual(calls, [1000, 6000, 11000]);
  scheduler.setWorkNotificationsOnline(true); await settle();
  t.mock.timers.tick(5000); await settle();
  t.mock.timers.tick(1000); await settle();
  scheduler.setWorkNotificationsOnline(false); await settle();
  assert.equal(calls.at(-1), 17000, 'offline state wakes an already backed-off pool');
  t.mock.timers.tick(5000); await settle();
  assert.equal(calls.at(-1), 22000);
  scheduler.stop(); await running;
});

test('online changes and remote wakes preserve an uncertain receipt and its normal reconciliation cadence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const calls = [];
  const scheduler = createExecutorScheduler({ pollMs: 5000, idleMaxPollMs: 20000,
    agent: { claimBatch: async (kind, request) => {
      calls.push({ ...request, at: Date.now() });
      if (calls.length === 1) throw new Error('response lost after commit');
      return { requestId: request.requestId, claims: [] };
    } },
  });
  scheduler.setWorkNotificationsOnline(true);
  const running = scheduler.start();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle();
  scheduler.setWorkNotificationsOnline(false); scheduler.wake('COPY'); await settle();
  assert.equal(scheduler.status().COPY.reserved, 1);
  t.mock.timers.tick(4999); await settle(); assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls[1].requestId, calls[0].requestId);
  assert.equal(calls[1].reconcile, true);
  assert.equal(calls[1].at, 6000);
  scheduler.stop(); await running;
});
