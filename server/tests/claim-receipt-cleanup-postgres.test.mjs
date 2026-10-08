import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { requestIdAt } from './fixtures/claim-request-id.mjs';
import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { drainExpiredClaimReceipts } from '../src/claim-receipt-cleanup.mjs';

function expiryIndexConditions(plan) {
  const matches = [];
  if (plan['Index Name'] === 'execution_claim_requests_expiry_idx' && plan['Index Cond']?.includes('expires_at')) {
    matches.push(plan['Index Cond']);
  }
  for (const child of plan.Plans ?? []) matches.push(...expiryIndexConditions(child));
  return matches;
}

test('isolated PostgreSQL receipt cleanup preserves 30 concurrent claims, running/legacy receipts and retired-node fairness', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 150_000,
}, async () => {
  const database = await startTemporaryPostgres18('claim-receipt-cleanup-');
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 12 });
  try {
    await migrateDatabase(pool);
    const repository = new PostgresControlPlaneRepository({ pool });
    const nodes = Array.from({ length: 30 }, (_, index) => `claim-user-${String(index).padStart(2, '0')}`);
    for (const node of ['00-retired', ...nodes, 'zz-retired']) {
      await pool.query('INSERT INTO codex_concurrency_pools(id,total_concurrency,image_concurrency) VALUES($1,1,1)', [node]);
      await pool.query('INSERT INTO executor_nodes(id,name,codex_pool_id) VALUES($1,$1,$1)', [node]);
    }
    await pool.query("UPDATE executor_nodes SET retired_at=clock_timestamp() WHERE id IN ('00-retired','zz-retired')");
    const expired = new Date(Date.now() - 1000), future = new Date(Date.now() + 86_400_000);
    const add = async (node, id, expiry, executions = []) => pool.query(`INSERT INTO execution_claim_requests
      (node_id,kind,request_id,requested_limit,execution_ids,expires_at) VALUES($1,'COPY',$2,1,$3,$4)`, [node, id, executions, expiry]);
    for (let index = 0; index < 301; index++) await add('00-retired', requestIdAt(Date.now() - 86_401_000), expired);
    await add('zz-retired', requestIdAt(Date.now() - 86_401_000), expired);
    const oldIds = nodes.map(() => requestIdAt(Date.now() - 86_401_000));
    for (let index = 0; index < nodes.length; index++) await add(nodes[index], oldIds[index], expired);
    const legacy = randomUUID(); await add(nodes[0], legacy, null);
    const unexpired = requestIdAt(); await add(nodes[0], unexpired, future);
    const task = Number((await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id)
      VALUES('synthetic receipt running guard','COPY_RUNNING',$1,$1) RETURNING id`, [nodes[0]])).rows[0].id);
    const execution = randomUUID();
    await pool.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot)
      VALUES($1,$2,'COPY',$3,'RUNNING','TEXT_GENERATION','{}')`, [execution, task, nodes[0]]);
    const protectedId = requestIdAt(Date.now() - 86_401_000); await add(nodes[0], protectedId, expired, [execution]);
    // Explain the module's actual prepared SQL against many future receipts,
    // without executing the explained DELETE or changing planner settings.
    await pool.query(`INSERT INTO execution_claim_requests(node_id,kind,request_id,requested_limit,execution_ids,expires_at)
      SELECT '00-retired','COPY',gen_random_uuid(),1,'{}'::uuid[],clock_timestamp()+interval '1 day'
      FROM generate_series(1,20000)`);
    await pool.query('ANALYZE execution_claim_requests');
    const explanations = new Map();
    const instrumentedPool = { connect: async () => {
      const connection = await pool.connect();
      return { release: () => connection.release(), async query(sql, values) {
        const kind = String(sql).startsWith('DELETE') ? 'delete' : String(sql).includes('SELECT node.id') ? 'candidate' : null;
        if (kind && !explanations.has(kind)) {
          const plan = (await connection.query('EXPLAIN (FORMAT JSON) ' + sql, values)).rows[0]['QUERY PLAN'][0].Plan;
          explanations.set(kind, expiryIndexConditions(plan));
        }
        return connection.query(sql, values);
      } };
    } };
    const first = await drainExpiredClaimReceipts(instrumentedPool, { limit: 1, batchSize: 100 });
    assert.deepEqual(first, { processed: 1, deleted: 100 });
    assert.ok(explanations.get('candidate')?.length, 'candidate expiry must be an indexed range condition');
    assert.ok(explanations.get('delete')?.length, 'delete expiry must be an indexed range condition');
    console.log('Actual cleanup SQL uses indexed expiry ranges:', JSON.stringify(Object.fromEntries(explanations)));
    const second = await drainExpiredClaimReceipts(instrumentedPool, { limit: 100, batchSize: 100, maxDurationMs: 5000 });
    assert.ok(second.deleted >= 31, 'rotation reaches other nodes despite the retired node backlog');
    assert.equal(Number((await pool.query("SELECT count(*) FROM execution_claim_requests WHERE node_id='zz-retired'")).rows[0].count), 0);
    await pool.query(`INSERT INTO tasks(query,state,created_by_node_id,copy_executor_node_id)
      SELECT 'synthetic claim '||i,'COPY_QUEUED',$1,$1 FROM generate_series(1,29) i`, [nodes[1]]);
    const freshIds = nodes.map(() => requestIdAt());
    const concurrent = await Promise.all([
      ...nodes.map((nodeId, index) => repository.claimCopyBatch({ nodeId, limit: 1, requestId: freshIds[index] })),
      ...Array.from({ length: 30 }, () => drainExpiredClaimReceipts(pool, { limit: 5, batchSize: 10 })),
    ]);
    assert.equal(concurrent[0].claims.length, 0, 'the running node cannot exceed its capacity');
    const allocations = concurrent.slice(1, 30).flatMap(claim => claim.claims);
    assert.equal(allocations.length, 29);
    assert.equal(new Set(allocations.map(claim => claim.execution.id)).size, 29);
    assert.equal(new Set(allocations.map(claim => claim.task.id)).size, 29);
    for (let index = 0; index < nodes.length; index++) {
      const repeated = await repository.claimCopyBatch({ nodeId: nodes[index], limit: 1, requestId: freshIds[index] });
      assert.deepEqual(repeated.claims.map(claim => claim.execution.id), concurrent[index].claims.map(claim => claim.execution.id));
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_claim_requests WHERE node_id=$1 AND request_id=$2', [nodes[index], freshIds[index]])).rows[0].count), 1);
      await assert.rejects(repository.claimCopyBatch({ nodeId: nodes[index], limit: 1, requestId: oldIds[index] }), { code: 'CLAIM_REQUEST_EXPIRED' });
    }
    assert.deepEqual((await repository.claimCopyBatch({ nodeId: nodes[0], limit: 1, requestId: legacy })).claims, []);
    assert.deepEqual((await repository.claimCopyBatch({ nodeId: nodes[0], limit: 1, requestId: unexpired })).claims, []);
    const replay = await repository.claimCopyBatch({ nodeId: nodes[0], limit: 1, requestId: protectedId });
    assert.equal(replay.claims[0].execution.id, execution, 'expired running receipt still replays its exact execution');
    await pool.query("UPDATE task_executions SET status='SUCCEEDED',finished_at=clock_timestamp() WHERE id=$1", [execution]);
    await drainExpiredClaimReceipts(pool, { limit: 100, batchSize: 1000, maxDurationMs: 5000 });
    assert.equal(Number((await pool.query('SELECT count(*) FROM execution_claim_requests WHERE request_id=$1', [protectedId])).rows[0].count), 0);
    await assert.rejects(repository.claimCopyBatch({ nodeId: nodes[0], limit: 1, requestId: protectedId }), { code: 'CLAIM_REQUEST_EXPIRED' });
    // A claim holding the node lock is never blocked or raced by maintenance.
    const locker = await pool.connect();
    const blockedExpired = requestIdAt(Date.now() - 86_401_000); await add(nodes[1], blockedExpired, expired);
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM executor_nodes WHERE id=$1 FOR UPDATE', [nodes[1]]);
      await drainExpiredClaimReceipts(pool, { limit: 100, maxDurationMs: 1000 });
      assert.equal(Number((await pool.query('SELECT count(*) FROM execution_claim_requests WHERE request_id=$1', [blockedExpired])).rows[0].count), 1);
      await locker.query('ROLLBACK');
    } finally { locker.release(); }
    await drainExpiredClaimReceipts(pool, { limit: 100 });
    assert.equal(Number((await pool.query('SELECT count(*) FROM execution_claim_requests WHERE request_id=$1', [blockedExpired])).rows[0].count), 0);
    // Partial deletion and cursor advancement must roll back together.
    const retryId = requestIdAt(Date.now() - 86_401_000); await add(nodes[2], retryId, expired);
    await pool.query(`CREATE FUNCTION reject_receipt_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected receipt deletion failure'; END $$;
      CREATE TRIGGER reject_receipt_cleanup BEFORE DELETE ON execution_claim_requests
      FOR EACH ROW EXECUTE FUNCTION reject_receipt_cleanup()`);
    await assert.rejects(drainExpiredClaimReceipts(pool, { limit: 100 }), /injected receipt deletion failure/u);
    assert.equal(Number((await pool.query('SELECT count(*) FROM execution_claim_requests WHERE request_id=$1', [retryId])).rows[0].count), 1);
    await pool.query('DROP TRIGGER reject_receipt_cleanup ON execution_claim_requests; DROP FUNCTION reject_receipt_cleanup()');
    assert.equal((await drainExpiredClaimReceipts(pool, { limit: 100 })).deleted, 1);
    assert.deepEqual(await drainExpiredClaimReceipts(pool), { processed: 0, deleted: 0 });
  } finally { await pool.end(); await database.stop(); }
});
