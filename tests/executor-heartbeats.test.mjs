import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createExecutorAgent } from '../src/executor/agent.mjs';

function fixture({ work, heartbeat, enabled = true, now = Date.now } = {}) {
  const calls = [], failures = [], claims = [1, 2].map(id => ({ task: { id }, execution: { id: randomUUID(), status: 'RUNNING' } }));
  const controlPlane = {
    registerNode: async () => {},
    heartbeatExecutions: async input => { calls.push(input); return heartbeat ? heartbeat(input) : { activeExecutionIds: input.executionIds, staleExecutionIds: [] }; },
    failExecution: async (...args) => { failures.push(args); },
    completeCopy: async () => assert.fail('late completion must never reach the center'),
  };
  const agent = createExecutorAgent({ nodeId: 'a', controlPlane, now,
    readinessCheck: async () => ({ health: { capabilities: { executionHeartbeats: enabled } } }),
    executeCopy: work, availabilityCheck: async () => {} });
  return { agent, calls, failures, claims };
}

test('task heartbeats include active execution IDs and remove completed work', async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = fixture({ work: async () => { entered.resolve(); await gate.promise; } });
  await f.agent.prepare();
  const running = f.agent.executeClaim('COPY', f.claims[0]);
  await entered.promise;
  await f.agent.heartbeat();
  assert.deepEqual(f.calls.at(-1).executionIds, [f.claims[0].execution.id]);
  gate.resolve(); await running;
  const count = f.calls.length;
  await f.agent.heartbeat();
  assert.equal(f.calls.length, count);
});

test('a recovered task aborts in-flight work and fences late writes without replay', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), late = Promise.withResolvers();
  let revoke = false, signal, generations = 0;
  const f = fixture({ heartbeat: input => ({ activeExecutionIds: revoke ? [] : input.executionIds,
    staleExecutionIds: revoke ? input.executionIds : [] }),
    work: async input => {
      generations++; signal = input.signal; entered.resolve();
      await release.promise;
      try { await input.controlPlane.completeCopy(input.claim.execution.id, {}); } catch (error) { late.resolve(error); throw error; }
    } });
  await f.agent.prepare();
  const running = f.agent.executeClaim('COPY', f.claims[0]);
  await entered.promise;
  revoke = true;
  await f.agent.heartbeat();
  assert.equal(signal.aborted, true);
  assert.equal((await running).status, 'ABANDONED');
  release.resolve();
  assert.equal((await late.promise).code, 'STALE_EXECUTION');
  assert.equal(generations, 1);
  assert.deepEqual(f.failures[0][2], { autoRetry: false });
});

test('an executor stops work after losing task heartbeat acknowledgement for two minutes', async () => {
  let clock = 0, offline = false;
  const entered = Promise.withResolvers();
  const f = fixture({ now: () => clock, heartbeat: input => {
    if (offline) throw new Error('network unavailable');
    return { activeExecutionIds: input.executionIds, staleExecutionIds: [] };
  }, work: async ({ signal }) => { entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await f.agent.prepare();
  const running = f.agent.executeClaim('COPY', f.claims[0]);
  await entered.promise;
  offline = true; clock = 120001;
  await assert.rejects(f.agent.heartbeat(), /network unavailable/);
  assert.equal((await running).error.code, 'EXECUTION_HEARTBEAT_LOST');
  assert.deepEqual(f.failures[0][2], { autoRetry: false });
});

test('old centers remain compatible and never receive the new heartbeat endpoint', async () => {
  const f = fixture({ enabled: false, work: async () => {} });
  await f.agent.prepare();
  await f.agent.executeClaim('COPY', f.claims[0]); await f.agent.heartbeat();
  assert.equal(f.calls.length, 0);
});
