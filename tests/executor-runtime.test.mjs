import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { executorOutcomeLine, runExecutor } from '../src/executor/runtime.mjs';

test('executor outcome logs include a bounded redacted failure reason', () => {
  assert.equal(executorOutcomeLine({ kind: 'COPY', taskId: 729, status: 'SUCCEEDED' }),
    'COPY task 729: SUCCEEDED');
  assert.equal(executorOutcomeLine({ kind: 'COPY', taskId: 729, status: 'FAILED',
    error: new Error('DeepSeek failed with api_key=sk-secret-value') }),
  'COPY task 729: FAILED; DeepSeek failed with api_key=[REDACTED]');
  assert.equal(executorOutcomeLine({ kind: 'IMAGE', taskId: 1, status: 'FAILED',
    error: 'x'.repeat(2_000) }).length, 'IMAGE task 1: FAILED; '.length + 1_000);
});

test('shared executor runtime registers before claiming and drains on signals while heartbeats continue', async () => {
  const calls = [];
  const host = new EventEmitter();
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const execution = runExecutor({ configuration: { copyConcurrency: 2, imageConcurrency: 1,
    imageWorkerEnabled: false, once: false, pollMs: 10, nodeId: 'test' }, host,
    heartbeatMs: 5, log: { log() {}, error() {} }, agent: {
      prepare: async () => { calls.push('prepare'); },
      register: async () => { calls.push('register'); },
      heartbeat: async () => { calls.push('heartbeat'); },
      claimBatch: async (_kind, request) => {
        calls.push('claim');
        return { requestId: request.requestId, claims: [{ task: { id: 1 }, execution: { id: 'a', status: 'RUNNING' } }] };
      },
      executeClaim: async () => { started.resolve(); await finish.promise; return { status: 'SUCCEEDED', kind: 'COPY', taskId: 1 }; },
    } });
  await started.promise;
  host.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls.slice(0, 3), ['prepare', 'register', 'claim']);
  assert.equal(calls.filter(c => c === 'claim').length, 1);
  assert.ok(calls.includes('heartbeat'));
  finish.resolve();
  await execution;
  assert.equal(host.listenerCount('SIGTERM'), 0);
  assert.equal(host.listenerCount('SIGINT'), 0);
});

test('readiness errors prevent registration, polling and leaked signal handlers', async () => {
  const host = new EventEmitter();
  await assert.rejects(runExecutor({ configuration: {}, host, log: { log() {}, error() {} },
    agent: { prepare: async () => { throw new Error('old center'); }, register: () => assert.fail() } }), /old center/);
  assert.equal(host.listenerCount('SIGTERM'), 0);
});
