import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTaskRecovery } from '../src/task-recovery.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';

test('executor reports typed Codex failures as non-retryable without losing wrapped diagnostics', async () => {
  const claim = { task: { id: 1 }, execution: { id: 'failure-test' } };
  const cause = Object.assign(new Error('outcome unknown'), { code: 'CODEX_EXEC_TIMEOUT' });
  const failure = new Error('image stage failed', { cause });
  let reported;
  const agent = createExecutorAgent({ nodeId: 'codex-node', imageWorkerEnabled: true,
    controlPlane: { claimImage: async () => claim, failExecution: async (...args) => { reported = args; } },
    readinessCheck: async () => {}, availabilityCheck: async () => {},
    executeImage: async () => { throw failure; } });
  await agent.prepare();
  assert.equal((await agent.runImageOnce()).status, 'FAILED');
  assert.equal(reported[1], failure);
  assert.deepEqual(reported[2], { autoRetry: false });
});

test('wrapped quota errors halt new tasks without being retried as transient failures', () => {
  const error = new Error('generation failed', { cause: Object.assign(new Error('quota reached'), { code: 'CODEX_QUOTA_EXHAUSTED' }) });
  const recovery = planTaskRecovery({ error });
  assert.equal(recovery.haltWorker, true);
  assert.equal(recovery.action, 'MANUAL');
  assert.equal(recovery.reason, 'quota_exhausted');
});

test('Codex rate limits schedule recovery after the shared cooldown', () => {
  const recovery = planTaskRecovery({ error: Object.assign(new Error('rate limited'), { code: 'CODEX_RATE_LIMITED' }) });
  assert.equal(recovery.action, 'RETRY');
  assert.ok(recovery.delayMs >= 65_000);
});

test('executor checks shared availability before claiming any task and resumes after reset', async () => {
  let blocked = true; let claims = 0;
  const agent = createExecutorAgent({ nodeId: 'codex-node', controlPlane: {
    claimCopy: async () => { claims++; return null; },
  }, readinessCheck: async () => {}, availabilityCheck: () => {
    if (blocked) throw Object.assign(new Error('paused'), { code: 'CODEX_QUOTA_EXHAUSTED' });
  } });
  await agent.prepare();
  assert.equal((await agent.runCopyOnce()).status, 'PAUSED');
  assert.equal(claims, 0);
  blocked = false;
  assert.equal(await agent.runCopyOnce(), null);
  assert.equal(claims, 1);
});
