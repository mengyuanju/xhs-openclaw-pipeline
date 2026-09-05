import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { normalizeConcurrency } from '../src/domain.mjs';

test('center capacities require bounded JSON integers', () => {
  assert.equal(normalizeConcurrency(3), 3);
  for (const value of [undefined, null, '3', 0, -1, 1.5, 33]) {
    assert.throws(() => normalizeConcurrency(value), /integer/);
  }
});

function fixture({ capacity = 3, running = 1, receipt, enabled = true } = {}) {
  const calls = [];
  const executions = new Map();
  const node = { id: 'node-a', copy_concurrency: capacity, image_concurrency: capacity, image_worker_enabled: enabled };
  const client = {
    release() {},
    async query(sql, args = []) {
      sql = String(sql); calls.push({ sql, args });
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [node] };
      if (sql.includes('SELECT * FROM execution_claim_requests')) return { rows: receipt ? [receipt] : [] };
      if (sql.includes('COUNT(*)') && sql.includes('task_executions')) return { rows: [{ count: running }] };
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [1, 2, 3].slice(0, args[2]).map(id => ({ id,
        pending_snapshot: { task: { id } } })) };
      if (sql.includes('INSERT INTO task_executions')) executions.set(args[0], { id: args[0], task_id: args[1], kind: args[2], status: 'RUNNING', snapshot: args[6] });
      if (sql.includes('UPDATE tasks SET')) return { rows: [{ id: args[4], state: args[0] }] };
      if (sql.includes('SELECT * FROM task_executions WHERE id =')) return { rows: [executions.get(args[0])] };
      return { rows: [] };
    },
  };
  return { calls, repo: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

test('batch claims use remaining center capacity and save an atomic receipt', async () => {
  const { repo, calls } = fixture();
  const requestId = randomUUID();
  const result = await repo.claimCopyBatch({ nodeId: 'node-a', limit: 3, requestId });
  assert.equal(result.requestId, requestId);
  assert.equal(result.claims.length, 2);
  assert.equal(new Set(result.claims.map(c => c.execution.id)).size, 2);
  assert.deepEqual(calls.find(c => c.sql.includes('FOR UPDATE SKIP LOCKED')).args, ['COPY_QUEUED', 'node-a', 2]);
  assert.ok(calls.find(c => c.sql.includes('INSERT INTO execution_claim_requests')));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('full nodes receive an empty receipt without selecting tasks', async () => {
  const { repo, calls } = fixture({ capacity: 2, running: 3 });
  assert.equal((await repo.claimCopyBatch({ nodeId: 'node-a', limit: 2, requestId: randomUUID() })).claims.length, 0);
  assert.ok(!calls.some(c => c.sql.includes('FOR UPDATE SKIP LOCKED')));
});

test('repeated empty claims stay empty and conflicting idempotency parameters are rejected', async () => {
  const { repo, calls } = fixture({ receipt: { requested_limit: 2, execution_ids: [] } });
  const requestId = randomUUID();
  assert.deepEqual(await repo.claimCopyBatch({ nodeId: 'node-a', limit: 2, requestId }), { requestId, claims: [] });
  assert.ok(!calls.some(c => c.sql.includes('FOR UPDATE SKIP LOCKED')));
  await assert.rejects(repo.claimCopyBatch({ nodeId: 'node-a', limit: 3, requestId }), { code: 'CLAIM_REQUEST_MISMATCH' });
});

test('disabled image capacity and invalid batch sizes never claim work', async () => {
  const { repo } = fixture({ enabled: false });
  await assert.rejects(repo.claimImageBatch({ nodeId: 'node-a', limit: 1, requestId: randomUUID() }), { code: 'IMAGE_WORKER_DISABLED' });
  await assert.rejects(repo.claimCopyBatch({ nodeId: 'node-a', limit: 0, requestId: randomUUID() }), /integer/);
});
