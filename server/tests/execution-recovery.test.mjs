import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatExecutions, recoverStaleExecutions, startExecutionRecovery } from '../src/execution-recovery.mjs';

test('heartbeat input is bounded, unique and validated before any database write', async () => {
  const pool = { query: () => assert.fail('invalid heartbeat reached database') };
  const id = '11111111-1111-4111-8111-111111111111';
  for (const executionIds of [null, 'x', [id, id], ['invalid'], Array(65).fill(id)]) {
    await assert.rejects(heartbeatExecutions(pool, { nodeId: 'a', executionIds }), TypeError);
  }
});

test('stale image-edit recovery uses one explicit text type for its shared error parameter', async () => {
  const editId = '11111111-1111-4111-8111-111111111111';
  const executionId = '22222222-2222-4222-8222-222222222222';
  const queries = [];
  const client = {
    async query(sql) {
      const source = String(sql);
      queries.push(source);
      if (source.includes('JOIN tasks t ON t.id = e.task_id')) return { rows: [] };
      if (source.includes('JOIN image_edit_requests edit ON edit.execution_id=e.id')) {
        return { rows: [{ id: executionId, task_id: 52, kind: 'IMAGE', edit_id: editId, progress_expired: false }] };
      }
      if (source.includes("UPDATE image_edit_requests SET status='FAILED'")) {
        return { rows: [{ id: editId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const recovered = await recoverStaleExecutions({ connect: async () => client });
  assert.deepEqual(recovered, [{ id: executionId, taskId: 52, kind: 'IMAGE' }]);
  const executionUpdate = queries.find(source => source.includes("UPDATE task_executions SET status='FAILED'"));
  assert.match(executionUpdate, /progress_message=\$2::text,error=\$2::text/u);
  assert.ok(queries.includes('COMMIT'));
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
