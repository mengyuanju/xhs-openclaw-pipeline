import assert from 'node:assert/strict';
import test from 'node:test';
import { drainExpiredClaimReceipts } from '../src/claim-receipt-cleanup.mjs';

function fixture({ fail = false } = {}) {
  const calls = [];
  const pool = { connect: async () => ({
    release() { calls.push({ sql: 'RELEASE' }); },
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (String(sql).includes('SELECT node.id')) {
        return { rows: [{ id: values[0] ? 'node-b' : 'node-a' }] };
      }
      if (String(sql).startsWith('DELETE')) {
        if (fail) throw new Error('injected deletion failure');
        return { rowCount: 2, rows: [] };
      }
      return { rows: [] };
    },
  }) };
  return { pool, calls };
}

test('receipt maintenance locks the node, bounds each batch and rotates between invocations', async () => {
  const { pool, calls } = fixture();
  assert.deepEqual(await drainExpiredClaimReceipts(pool, { limit: 1, batchSize: 3 }), { processed: 1, deleted: 2 });
  assert.deepEqual(await drainExpiredClaimReceipts(pool, { limit: 1, batchSize: 3 }), { processed: 1, deleted: 2 });
  const candidates = calls.filter(call => call.sql.includes('SELECT node.id'));
  assert.deepEqual(candidates.map(call => call.values[0]), ['', 'node-a']);
  assert.match(candidates[0].sql, /FOR UPDATE OF node SKIP LOCKED/u);
  assert.doesNotMatch(candidates[0].sql, /retired_at/u);
  const deletion = calls.find(call => call.sql.startsWith('DELETE'));
  assert.deepEqual(deletion.values.slice(0, 2), ['node-a', 3]);
  assert.match(deletion.sql, /expires_at<=\$3/u);
  assert.ok(deletion.values[2] instanceof Date);
  assert.equal(deletion.values[2], candidates[0].values[2], 'selection and deletion use one fixed indexed expiry boundary');
  assert.match(deletion.sql, /execution\.status='RUNNING'/u);
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.equal(calls.filter(call => call.sql === 'RELEASE').length, 2);
});

test('a failed receipt batch rolls back, releases the connection and preserves its cursor', async () => {
  const { pool, calls } = fixture({ fail: true });
  await assert.rejects(drainExpiredClaimReceipts(pool, { limit: 1 }), /injected deletion failure/u);
  await assert.rejects(drainExpiredClaimReceipts(pool, { limit: 1 }), /injected deletion failure/u);
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 2);
  assert.equal(calls.filter(call => call.sql === 'RELEASE').length, 2);
  assert.deepEqual(calls.filter(call => call.sql.includes('SELECT node.id')).map(call => call.values[0]), ['', '']);
  assert.ok(calls.some(call => call.sql === "SET LOCAL statement_timeout='2s'"));
  assert.ok(calls.some(call => call.sql === "SET LOCAL lock_timeout='250ms'"));
});
