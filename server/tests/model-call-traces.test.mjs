import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelCall, listModelCalls, getModelCall, saveModelCall } from '../src/model-call-traces.mjs';
import { loadMigrations } from '../src/database-migrations.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const record = { sequence: 1, stage: 'QUERY_REVIEW', provider: 'fake', operation: 'TEXT', model: 'fake',
  status: 'RUNNING', prompt: '提示词', request: '{}', startedAt: '2026-09-04T00:00:00Z' };

test('model call validation redacts, bounds and rejects malformed input', () => {
  assert.equal(normalizeModelCall(record).finishedAt, null);
  assert.throws(() => normalizeModelCall({ ...record, sequence: 0 }), /sequence/);
  assert.throws(() => normalizeModelCall({ ...record, status: 'DONE' }), /status/);
  assert.throws(() => normalizeModelCall({ ...record, status: 'SUCCEEDED' }), /finishedAt/);
  const parsed = normalizeModelCall({ ...record, prompt: 'password: "hidden" sk-fakekey123456', response: 'a'.repeat(200_001) });
  assert.doesNotMatch(parsed.prompt, /hidden|fakekey/); assert.equal(parsed.truncated, true);
  assert.equal(parsed.response.length, 200_000);
});

test('model calls derive task ownership from execution and final records cannot be overwritten by late starts', async () => {
  let captured;
  const pool = { query: async (sql, params) => { captured = { sql, params }; return { rows: [{ id }] }; } };
  await saveModelCall(pool, id, id, { ...record, taskId: 999 });
  assert.match(captured.sql, /e\.task_id, e\.id/);
  assert.match(captured.sql, /model_call_traces\.status = 'RUNNING'/);
  assert.ok(!captured.params.includes(999));
  await assert.rejects(saveModelCall(pool, 'invalid', id, record), /UUID/);
});

test('trace list is paginated metadata only; detail lookup is scoped to task', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params }); return { rows: sql.includes('count(*)') ? [{ total: 3 }] : [{ id }] };
  } };
  assert.equal((await listModelCalls(pool, 5, { limit: '2', offset: '1' })).total, 3);
  assert.doesNotMatch(queries[0].sql, /c\.prompt|c\.response|c\.request/);
  assert.deepEqual(queries[0].params, [5, 2, 1]);
  await getModelCall(pool, 5, id);
  assert.match(queries[2].sql, /c\.task_id = \$1 AND c\.id = \$2/);
  await assert.rejects(listModelCalls(pool, 5, { limit: 1000 }), /pagination/);
  await assert.rejects(getModelCall({ query: async () => ({ rows: [] }) }, 5, id), /not found/);
});

test('new additive migration keeps historical tasks and existing schema intact', async () => {
  const migration = (await loadMigrations()).find((m) => m.id === '0004_model_call_traces');
  assert.match(migration.sql, /CREATE TABLE model_call_traces/);
  assert.doesNotMatch(migration.sql, /DROP TABLE|UPDATE tasks|DELETE FROM/);
});
