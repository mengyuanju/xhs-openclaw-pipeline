import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatExecutions, startExecutionRecovery } from '../src/execution-recovery.mjs';

test('heartbeat input is bounded, unique and validated before any database write', async () => {
  const pool = { query: () => assert.fail('invalid heartbeat reached database') };
  const id = '11111111-1111-4111-8111-111111111111';
  for (const executionIds of [null, 'x', [id, id], ['invalid'], Array(65).fill(id)]) {
    await assert.rejects(heartbeatExecutions(pool, { nodeId: 'a', executionIds }), TypeError);
  }
});

test('recovery housekeeping does not overlap scans and shutdown waits for its current scan', async () => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let calls = 0, stopped = false;
  const stop = startExecutionRecovery({ recoverStaleExecutions: async () => {
    calls++; entered.resolve(); await finish.promise; return [];
  } }, { intervalMs: 5 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    const stopping = stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    finish.resolve(); await stopping;
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(calls, 1);
  } finally { finish.resolve(); await stop(); clearTimeout(keepAlive); }
});
