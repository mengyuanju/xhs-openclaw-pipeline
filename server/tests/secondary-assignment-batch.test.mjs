import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchReassignmentCases } from '../src/secondary-assignment.mjs';

const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 2 };
const target = { id: 9, username: 'worker', role: 'USER', status: 'ACTIVE', copy_review_enabled: true };
const resultOf = rows => ({ rows, rowCount: rows.length });
const empty = resultOf([]);
const itemOf = (id, expectedVersion = 1) => ({ id, expectedVersion, requestId: randomUUID() });
const requestOf = (operation, items, extra = {}) => ({ operation, items,
  ...(operation === 'RESET' ? {} : { note: '批量处理原因' }),
  ...(operation === 'REASSIGN' ? { targetAccountId: target.id } : {}), ...extra });

function fixture({ blocked = [], closed = [], taskErrors = {}, onCommit } = {}) {
  const cases = [1, 2, 3].map(id => ({ id, task_id: id + 10, stage: 'COPY', version: 1,
    status: closed.includes(id) ? 'DISCARDED' : 'PENDING',
    reset_status: blocked.includes(id) ? 'BLOCKED' : 'READY', cleanup_status: 'COMPLETE',
    operator_account_id: 5, reviewer_account_id: 6, assignment_record_id: 2,
    note: '质检退回原因', reason_codes: [], query: `query-${id}`, baseline_source: 'CODEX' }));
  const state = { cases, tasks: cases.map(row => ({ id: row.task_id, state: 'PENDING_SECOND_ASSIGNMENT' })),
    requests: [], files: [], events: [], activeActor: true, activeTarget: true };
  const calls = [], commits = [], rollbacks = [];
  let connections = 0;
  async function query(current, sql, values = []) {
    const q = sql.replace(/\s+/gu, ' ').trim();
    calls.push({ sql: q, values });
    if (q.startsWith('SELECT set_config') || q.startsWith('SELECT pg_advisory_xact_lock')) return empty;
    if (q.startsWith('SELECT * FROM app_users WHERE id=$1 AND username=$2')) {
      return resultOf(current.activeActor && values[0] === actor.userId && values[1] === actor.username
        && values[2] === actor.role && values[3] === actor.credentialVersion ? [{ id: actor.userId, role: actor.role }] : []);
    }
    if (q.startsWith('SELECT * FROM app_users WHERE id=$1 AND status=')) {
      return resultOf(current.activeTarget && values[0] === target.id ? [target] : []);
    }
    if (q.startsWith('SELECT * FROM task_reassignment_requests')) {
      return resultOf(current.requests.filter(row => row.actor_account_id === values[0] && row.request_id === values[1]));
    }
    if (q.startsWith('INSERT INTO task_reassignment_requests')) {
      current.requests.push({ actor_account_id: values[0], request_id: values[1], operation: values[2],
        fingerprint: values[3], response: values[4] }); return empty;
    }
    if (q.startsWith('SELECT task_id FROM task_reassignment_cases')) {
      const row = current.cases.find(row => row.id === values[0]);
      return resultOf(row ? [{ task_id: row.task_id }] : []);
    }
    if (q.startsWith('SELECT * FROM tasks WHERE id=$1')) {
      if (taskErrors[values[0]]) throw taskErrors[values[0]];
      return resultOf(current.tasks.filter(row => row.id === values[0]));
    }
    if (q.startsWith('SELECT * FROM task_reassignment_cases WHERE id=$1') || q.startsWith('SELECT r.*,t.query,b.source')) {
      return resultOf(current.cases.filter(row => row.id === values[0]));
    }
    if (q.startsWith('UPDATE tasks SET assigned_to_user_id=')) {
      const row = current.tasks.find(row => row.id === values[0]);
      row.state = 'COPY_REVIEW_PENDING'; row.assigned_to_user_id = values[1]; return empty;
    }
    if (q.startsWith("UPDATE tasks SET state='CANCELLED'")) {
      current.tasks.find(row => row.id === values[0]).state = 'CANCELLED'; return empty;
    }
    if (q.startsWith('INSERT INTO task_assignment_events') || q.startsWith('INSERT INTO account_quality_events')) {
      current.events.push({ sql: q, values }); return empty;
    }
    if (q.startsWith('UPDATE task_assignment_records')) return empty;
    if (q.startsWith('UPDATE task_reassignment_cases SET status=$2')) {
      const row = current.cases.find(row => row.id === values[0]);
      row.status = values[1]; row.target_account_id = values[3]; row.version += 1;
      return resultOf([row]);
    }
    if (q.startsWith('SELECT * FROM task_initial_baselines')) return empty;
    if (q.startsWith("UPDATE task_reassignment_cases SET reset_status='BLOCKED'")) {
      const row = current.cases.find(row => row.id === values[0]);
      row.reset_status = 'BLOCKED'; row.reset_error = '缺少可信机器初稿；请重新生成初始数据后重试'; return empty;
    }
    if (q.startsWith('SELECT DISTINCT a.id,a.task_id,a.sha256')) return empty;
    if (q.startsWith('SELECT * FROM task_reassignment_cleanup')) {
      return resultOf(current.files.filter(row => row.case_id === values[0] && !row.cleaned_at));
    }
    if (q.startsWith('UPDATE task_reassignment_cleanup')) {
      const file = current.files.find(row => row.id === values[0]);
      if (q.includes('cleaned_at=')) { file.cleaned_at = new Date().toISOString(); file.error = null; }
      else file.error = values[1];
      return empty;
    }
    if (q.startsWith('UPDATE task_reassignment_cases SET cleanup_status=')) {
      const row = current.cases.find(row => row.id === values[0]);
      if (row.reset_status === 'READY') row.cleanup_status = current.files.some(file => file.case_id === row.id && !file.cleaned_at) ? 'FAILED' : 'COMPLETE';
      return empty;
    }
    if (q.startsWith('SELECT id,assignee_account_id')) return empty;
    throw new Error(`Unexpected query: ${q}`);
  }
  const pool = {
    query: (sql, values) => query(state, sql, values),
    async connect() {
      connections += 1;
      let current;
      return {
        async query(sql, values) {
          if (sql === 'BEGIN') { current = structuredClone(state); return empty; }
          if (sql === 'COMMIT') {
            Object.assign(state, current); commits.push(current);
            onCommit?.(state, commits.length); return empty;
          }
          if (sql === 'ROLLBACK') { rollbacks.push(current); return empty; }
          return query(current, sql, values);
        },
        release() {},
      };
    },
  };
  return { pool, state, calls, commits, rollbacks, connections: () => connections };
}

test('batch validation checks every item and shared input before starting any transaction', async () => {
  const valid = requestOf('REASSIGN', [itemOf(1), itemOf(2)]);
  const duplicateRequest = { ...valid.items[1], requestId: valid.items[0].requestId.toUpperCase() };
  const invalid = [null, [], {}, { ...valid, operation: 'RESTORE' }, { ...valid, items: [] },
    { ...valid, items: Array.from({ length: 101 }, (_, index) => itemOf(index + 1)) },
    { ...valid, targetAccountId: '9' }, { ...valid, targetAccountId: 0 },
    { ...valid, note: '' }, { ...valid, note: '长'.repeat(1001) },
    { ...valid, items: [valid.items[0], { ...valid.items[1], id: '2' }] },
    { ...valid, items: [valid.items[0], { ...valid.items[1], expectedVersion: 0 }] },
    { ...valid, items: [valid.items[0], { ...valid.items[1], expectedVersion: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...valid, items: [valid.items[0], { ...valid.items[1], requestId: 'invalid' }] },
    { ...valid, items: [valid.items[0], { ...valid.items[1], id: 1 }] },
    { ...valid, items: [valid.items[0], duplicateRequest] },
    requestOf('DISCARD', [itemOf(1)], { targetAccountId: target.id })];
  for (const input of invalid) {
    const f = fixture();
    await assert.rejects(batchReassignmentCases(f.pool, input, actor), TypeError);
    assert.equal(f.connections(), 0);
    assert.equal(f.state.requests.length, 0);
  }
});

test('batch reassignment commits successful items independently, keeps order and rolls back conflicts', async () => {
  const f = fixture({ blocked: [2] });
  const input = requestOf('REASSIGN', [itemOf(1), itemOf(2), itemOf(99), itemOf(3, 2)]);
  const result = await batchReassignmentCases(f.pool, input, actor);
  assert.deepEqual({ ...result, results: undefined }, {
    operation: 'REASSIGN', total: 4, succeeded: 1, failed: 3, results: undefined,
  });
  assert.deepEqual(result.results.map(row => [row.id, row.success, row.error?.code]),
    [[1, true, undefined], [2, false, 'RESET_INCOMPLETE'], [99, false, 'NOT_FOUND'], [3, false, 'REASSIGNMENT_CHANGED']]);
  assert.equal(result.results[0].item.status, 'REASSIGNED');
  assert.equal(result.results[0].item.targetAccountId, target.id);
  assert.equal(f.state.tasks[0].state, 'COPY_REVIEW_PENDING');
  assert.equal(f.state.tasks[1].state, 'PENDING_SECOND_ASSIGNMENT');
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.rollbacks.length, 3);
});

test('the batch accepts the maximum 100 distinct cases and reports a closed case independently', async () => {
  const f = fixture({ closed: [2] });
  const result = await batchReassignmentCases(f.pool,
    requestOf('DISCARD', Array.from({ length: 100 }, (_, index) => itemOf(index + 1))), actor);
  assert.equal(result.total, 100);
  assert.equal(result.results.length, 100);
  assert.equal(result.succeeded, 2);
  assert.equal(result.results[1].error.code, 'REASSIGNMENT_CLOSED');
  assert.equal(f.state.requests.length, 2);
});

test('batch discard retains single-item idempotency and refuses reuse for changed intent', async () => {
  const f = fixture();
  const input = requestOf('DISCARD', [itemOf(1), itemOf(2)]);
  const first = await batchReassignmentCases(f.pool, input, actor);
  const eventCount = f.state.events.length;
  assert.equal(first.succeeded, 2);
  assert.ok(f.state.tasks.slice(0, 2).every(row => row.state === 'CANCELLED'));
  assert.deepEqual(await batchReassignmentCases(f.pool, input, actor), first);
  assert.equal(f.state.events.length, eventCount);
  assert.equal(f.state.requests.length, 2);
  const changed = await batchReassignmentCases(f.pool, { ...input, note: '另一个处理原因' }, actor);
  assert.equal(changed.failed, 2);
  assert.ok(changed.results.every(row => row.error.code === 'REQUEST_ID_REUSED'));
  assert.equal(f.state.events.length, eventCount);
});

test('a target-account permission error stays an item failure; an invalid actor stops before mutations', async () => {
  const f = fixture(); f.state.activeTarget = false;
  const result = await batchReassignmentCases(f.pool, requestOf('REASSIGN', [itemOf(1), itemOf(2)]), actor);
  assert.equal(result.failed, 2);
  assert.ok(result.results.every(row => row.error.code === 'FORBIDDEN'));
  assert.equal(f.state.requests.length, 0);
  for (const currentActor of [undefined, { ...actor, role: 'USER' }, { ...actor, credentialVersion: 1 }]) {
    await assert.rejects(batchReassignmentCases(f.pool, requestOf('DISCARD', [itemOf(1)]), currentActor), { code: 'FORBIDDEN' });
    assert.equal(f.state.tasks[0].state, 'PENDING_SECOND_ASSIGNMENT');
  }
});

test('administrator identity changes stop the batch after previously committed items', async () => {
  const f = fixture({ onCommit(state, count) { if (count === 2) state.activeActor = false; } });
  await assert.rejects(batchReassignmentCases(f.pool, requestOf('DISCARD', [itemOf(1), itemOf(2), itemOf(3)]), actor), { code: 'FORBIDDEN' });
  assert.equal(f.state.tasks[0].state, 'CANCELLED');
  assert.equal(f.state.tasks[1].state, 'PENDING_SECOND_ASSIGNMENT');
  assert.equal(f.state.requests.length, 1);
  assert.ok(!f.calls.some(call => call.sql.startsWith('SELECT task_id FROM') && call.values[0] === 3));
});

test('unexpected server failures stop the batch, while known lock conflicts are reported per item', async () => {
  const fatal = new Error('database offline');
  const f = fixture({ taskErrors: { 12: fatal } });
  await assert.rejects(batchReassignmentCases(f.pool, requestOf('DISCARD', [itemOf(1), itemOf(2), itemOf(3)]), actor), error => error === fatal);
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.tasks[2].state, 'PENDING_SECOND_ASSIGNMENT');
  const busy = fixture({ taskErrors: { 12: Object.assign(new Error('lock unavailable'), { code: '55P03' }) } });
  const result = await batchReassignmentCases(busy.pool, requestOf('DISCARD', [itemOf(1), itemOf(2), itemOf(3)]), actor);
  assert.equal(result.succeeded, 2);
  assert.equal(result.results[1].error.code, 'REASSIGNMENT_BUSY');
});

test('batch reset reuses trusted cleanup and reports the resulting assignability without model calls', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'secondary-batch-'));
  try {
    const path = join(storageRoot, 'old-image.png');
    await writeFile(path, 'old payload');
    const f = fixture({ blocked: [2] });
    f.state.cases[0].cleanup_status = 'PENDING';
    f.state.files.push({ id: 1, task_id: 11, case_id: 1, storage_path: path });
    const input = requestOf('RESET', [itemOf(1), itemOf(2)]);
    const result = await batchReassignmentCases(f.pool, input, actor, { storageRoot });
    assert.equal(result.succeeded, 2);
    assert.equal(result.results[0].item.cleanupStatus, 'COMPLETE');
    assert.equal(result.results[0].item.canAssign, true);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.equal(result.results[1].item.resetStatus, 'BLOCKED');
    assert.equal(result.results[1].item.canAssign, false);
    assert.equal(f.state.requests.length, 2);
    assert.equal((await batchReassignmentCases(f.pool, input, actor, { storageRoot })).succeeded, 2);
    assert.equal(f.state.requests.length, 2);
  } finally { await rm(storageRoot, { recursive: true, force: true }); }
});
