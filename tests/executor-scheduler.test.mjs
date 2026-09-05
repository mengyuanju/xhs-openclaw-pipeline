import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutorScheduler } from '../src/executor/scheduler.mjs';

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
  const f = fixture({ imageWorkerEnabled: false, copyConcurrency: 2 });
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
