import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { requestIdAt } from './fixtures/claim-request-id.mjs';

function queuedTask(id, assignee, patch = {}) {
  return {
    id,
    query: `任务${id}`,
    input: {},
    requested_image_count: 'auto',
    state: 'COPY_QUEUED',
    created_by_node_id: 'node-a',
    created_by_user_id: assignee,
    assigned_to_user_id: assignee,
    assignment_source: 'SELF',
    assigned_at: new Date(),
    pending_snapshot: { task: { id } },
    ...patch,
  };
}

function unassignedTask(id, patch = {}) {
  return queuedTask(id, null, {
    created_by_user_id: 'admin',
    assignment_source: null,
    assigned_at: null,
    ...patch,
  });
}

function claimFixture({
  kind = 'COPY',
  capacity = 3,
  running = 0,
  cursor = 'bob',
  cursorPresent = true,
  candidates = [],
  receipt = null,
  receiptRecords = [],
  cursorUpdateResult = null,
  failAfterCandidate = null,
} = {}) {
  const calls = [];
  const executions = new Map();
  const node = {
    id: 'node-a',
    copy_concurrency: capacity,
    image_concurrency: capacity,
    image_worker_enabled: true,
  };
  const client = {
    release() {},
    async query(rawSql, values = []) {
      const sql = String(rawSql);
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [node] };
      if (sql.includes('SELECT * FROM execution_claim_requests')) return { rows: receipt ? [receipt] : [] };
      if (sql.includes('JOIN tasks t ON t.id = e.task_id')) return { rows: receiptRecords };
      if (sql.includes('COUNT(*)') && sql.includes('task_executions')) return { rows: [{ count: running }] };
      if (sql.includes('SELECT last_assignee_user_id FROM execution_claim_cursors')) {
        return { rows: cursorPresent ? [{ last_assignee_user_id: cursor }] : [] };
      }
      if (sql.includes('FOR UPDATE OF task SKIP LOCKED')) return { rows: candidates };
      if (failAfterCandidate && sql.includes(failAfterCandidate)) throw new Error('simulated claim failure');
      if (sql.includes('INSERT INTO task_executions')) {
        executions.set(values[0], {
          id: values[0], task_id: values[1], kind: values[2], node_id: values[3],
          stage: values[4], status: 'RUNNING', snapshot: values[6],
        });
        return { rows: [] };
      }
      if (sql.includes('UPDATE tasks SET')) {
        const original = candidates.find(({ id }) => id === values[4]);
        return { rows: [{ ...original, state: values[0], current_execution_id: values[1] }] };
      }
      if (sql.includes('SELECT * FROM task_executions WHERE id =')) {
        return { rows: [executions.get(values[0])] };
      }
      if (sql.includes('UPDATE execution_claim_cursors')) {
        return cursorUpdateResult ?? { rowCount: 1, rows: [{ kind: values[0] }] };
      }
      return { rows: [] };
    },
  };
  return {
    calls,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
    kind,
  };
}

test('0020 creates and safely seeds only COPY and IMAGE cursors without touching tasks or referencing users', async () => {
  const migration = (await loadMigrations()).find(({ id }) => id === '0020_execution_claim_fairness');
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS execution_claim_cursors/u);
  assert.match(migration.sql, /CHECK \(kind IN \('COPY', 'IMAGE'\)\)/u);
  assert.match(migration.sql, /VALUES \('COPY', NULL\), \('IMAGE', NULL\)/u);
  assert.match(migration.sql, /ON CONFLICT\(kind\) DO NOTHING/u);
  assert.doesNotMatch(migration.sql, /REFERENCES/u);
  assert.doesNotMatch(migration.sql, /UPDATE\s+tasks/u);
});

test('COPY claims use a global FIFO that accepts unassigned work without touching owner cursors', async () => {
  const candidates = [unassignedTask(11), queuedTask(12, 'alice')];
  const { repository, calls } = claimFixture({ candidates });
  const requestId = requestIdAt();

  const result = await repository.claimCopyBatch({ nodeId: 'node-a', limit: 2, requestId });
  assert.deepEqual(result.claims.map(({ task }) => task.id), [11, 12]);

  const activeIndex = calls.findIndex(({ sql }) => sql.includes('COUNT(*)') && sql.includes('task_executions'));
  const candidateIndex = calls.findIndex(({ sql }) => sql.includes('FOR UPDATE OF task SKIP LOCKED'));
  const receiptIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO execution_claim_requests'));
  assert.ok(activeIndex < candidateIndex && candidateIndex < receiptIndex);
  assert.equal(calls.some(({ sql }) => sql.includes('execution_claim_cursors')), false);

  const selection = calls[candidateIndex];
  assert.deepEqual(selection.values, ['COPY_QUEUED', 2]);
  assert.match(selection.sql, /FROM tasks AS task[\s\S]*WHERE task\.state = \$1[\s\S]*ORDER BY task\.id/u);
  assert.match(selection.sql, /FOR UPDATE OF task SKIP LOCKED[\s\S]*LIMIT \$2/u);
  assert.doesNotMatch(selection.sql, /assigned_to_user_id/u);
  assert.doesNotMatch(selection.sql, /ranked_candidates/u);
  assert.doesNotMatch(selection.sql, /copy_executor_node_id/u);
});

test('COPY can claim and persist unassigned work before its first human checkpoint', async () => {
  const fixture = claimFixture({ candidates: [unassignedTask(14)] });
  const result = await fixture.repository.claimCopyBatch({
    nodeId: 'node-a', limit: 1, requestId: requestIdAt(),
  });
  assert.equal(result.claims[0].task.id, 14);
  assert.equal(result.claims[0].task.assignedToUserId, null);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);
  assert.equal(fixture.calls.at(-1).sql, 'COMMIT');
});

test('IMAGE fairness retains retry ownership, recovery affinity, cooldown and original age order', async () => {
  const { repository, calls } = claimFixture({ kind: 'IMAGE', cursor: 'alice' });
  assert.equal(await repository.claimImage('node-a'), null);

  const selection = calls.find(({ sql }) => sql.includes('FOR UPDATE OF task SKIP LOCKED'));
  assert.deepEqual(selection.values, ['IMAGE_QUEUED', 'node-a', 'alice', 1]);
  assert.match(selection.sql, /queued\.pending_snapshot->'imageRetry'->>'nodeId' IS NULL/u);
  assert.match(selection.sql, /queued\.pending_snapshot->'imageRetry'->>'nodeId' = \$2/u);
  assert.match(selection.sql, /queued\.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL/u);
  assert.match(selection.sql, /queued\.pending_snapshot->'imageRecovery'->>'nodeId' = \$2/u);
  assert.match(selection.sql, /queued\.error IS NULL OR queued\.last_activity_at <= now\(\) - interval '5 seconds'/u);
  assert.match(selection.sql, /task\.pending_snapshot->'imageRetry'->>'nodeId' IS NULL/u);
  assert.match(selection.sql, /task\.pending_snapshot->'imageRetry'->>'nodeId' = \$2/u);
  assert.match(selection.sql, /task\.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL/u);
  assert.match(selection.sql, /task\.pending_snapshot->'imageRecovery'->>'nodeId' = \$2/u);
  assert.match(selection.sql, /task\.error IS NULL OR task\.last_activity_at <= now\(\) - interval '5 seconds'/u);
  assert.match(selection.sql, /queued\.assigned_to_user_id IS NOT NULL/u);
  assert.match(selection.sql, /task\.assigned_to_user_id IS NOT NULL/u);
  assert.match(selection.sql, /task\.assigned_to_user_id IS NOT DISTINCT FROM ranked\.assigned_to_user_id/u);
  assert.match(selection.sql, /PARTITION BY queued\.assigned_to_user_id[\s\S]*ORDER BY queued\.last_activity_at NULLS FIRST, queued\.id/u);
  assert.match(selection.sql, /ranked\.last_activity_at NULLS FIRST, ranked\.task_id/u);
  assert.match(selection.sql, /LIMIT \$4/u);
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);
});

test('IMAGE keeps a runtime guard against accidentally returned unassigned work', async () => {
  const fixture = claimFixture({
    kind: 'IMAGE',
    candidates: [unassignedTask(16, { state: 'IMAGE_QUEUED', current_copy_revision_id: 7 })],
  });
  await assert.rejects(fixture.repository.claimImage('node-a'), /image task is missing its assignee/u);
  assert.equal(fixture.calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);
  assert.equal(fixture.calls.at(-1).sql, 'ROLLBACK');
});

test('a successful non-empty receipt replay and full capacity do not touch the fairness cursor', async () => {
  const requestId = requestIdAt();
  const executionId = '11111111-1111-4111-8111-111111111111';
  const replayTask = queuedTask(21, 'alice', { state: 'COPY_RUNNING' });
  const replay = claimFixture({
    receipt: { requested_limit: 2, execution_ids: [executionId] },
    receiptRecords: [{
      id: executionId, task_id: 21, kind: 'COPY', node_id: 'node-a', status: 'RUNNING',
      stage: 'STARTING_COPY', snapshot: { task: { id: 21 } }, task: replayTask,
    }],
  });
  const replayed = await replay.repository.claimCopyBatch({ nodeId: 'node-a', limit: 2, requestId });
  assert.equal(replayed.requestId, requestId);
  assert.deepEqual(replayed.claims.map(({ execution }) => execution.id), [executionId]);
  assert.equal(replay.calls.some(({ sql }) => sql.includes('execution_claim_cursors')), false);

  const full = claimFixture({ capacity: 1, running: 1 });
  assert.equal(await full.repository.claimCopy('node-a'), null);
  assert.equal(full.calls.some(({ sql }) => sql.includes('execution_claim_cursors')), false);
});

test('a receipt can replay an already-running unassigned COPY without selecting it again', async () => {
  const requestId = requestIdAt();
  const executionId = '22222222-2222-4222-8222-222222222222';
  const legacyTask = unassignedTask(22, { state: 'COPY_RUNNING' });
  const replay = claimFixture({
    receipt: { requested_limit: 1, execution_ids: [executionId] },
    receiptRecords: [{
      id: executionId, task_id: 22, kind: 'COPY', node_id: 'node-a', status: 'RUNNING',
      stage: 'STARTING_COPY', snapshot: { task: { id: 22 } }, task: legacyTask,
    }],
  });

  const result = await replay.repository.claimCopyBatch({ nodeId: 'node-a', limit: 1, requestId });
  assert.equal(result.claims[0].execution.id, executionId);
  assert.equal(result.claims[0].task.assignedToUserId, null);
  assert.equal(replay.calls.some(({ sql }) => sql.includes('FOR UPDATE OF task SKIP LOCKED')), false);
  assert.equal(replay.calls.some(({ sql }) => sql.includes('execution_claim_cursors')), false);
});

test('only IMAGE claims lock and advance the assignee fairness cursor', async () => {
  const copy = claimFixture({ candidates: [queuedTask(41, 'copy.owner')] });
  await copy.repository.claimCopy('node-a');
  assert.equal(copy.calls.some(({ sql }) => sql.includes('execution_claim_cursors')), false);

  const imageTask = queuedTask(42, 'image.owner', {
    state: 'IMAGE_QUEUED', current_copy_revision_id: 7,
  });
  const image = claimFixture({ kind: 'IMAGE', candidates: [imageTask] });
  await image.repository.claimImage('node-a');
  assert.deepEqual(image.calls.find(({ sql }) => sql.includes('SELECT last_assignee_user_id')).values, ['IMAGE']);
  assert.deepEqual(image.calls.find(({ sql }) => sql.includes('UPDATE execution_claim_cursors')).values,
    ['IMAGE', 'image.owner']);
});

test('a missing IMAGE cursor row or failed IMAGE cursor update aborts the claim transaction', async () => {
  const missing = claimFixture({ kind: 'IMAGE', cursorPresent: false });
  await assert.rejects(missing.repository.claimImage('node-a'), /cursor is missing for IMAGE/u);
  assert.equal(missing.calls.some(({ sql }) => sql.includes('FOR UPDATE OF task SKIP LOCKED')), false);
  assert.equal(missing.calls.at(-1).sql, 'ROLLBACK');

  const stale = claimFixture({
    kind: 'IMAGE',
    candidates: [queuedTask(43, 'alice', { state: 'IMAGE_QUEUED', current_copy_revision_id: 7 })],
    cursorUpdateResult: { rowCount: 0, rows: [] },
  });
  await assert.rejects(stale.repository.claimImage('node-a'), /cursor could not be advanced for IMAGE/u);
  assert.equal(stale.calls.at(-1).sql, 'ROLLBACK');
});

test('COPY failures and empty queues never touch an assignee cursor', async () => {
  const empty = claimFixture();
  assert.equal(await empty.repository.claimCopy('node-a'), null);
  assert.equal(empty.calls.some(({ sql }) => sql.includes('SELECT last_assignee_user_id')), false);
  assert.equal(empty.calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);

  const candidate = queuedTask(31, 'carol');
  const failed = claimFixture({ candidates: [candidate], failAfterCandidate: 'INSERT INTO task_executions' });
  await assert.rejects(failed.repository.claimCopy('node-a'), /simulated claim failure/u);
  assert.equal(failed.calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK');

  const receiptFailure = claimFixture({
    candidates: [queuedTask(32, 'dora')],
    failAfterCandidate: 'INSERT INTO execution_claim_requests',
  });
  await assert.rejects(receiptFailure.repository.claimCopyBatch({
    nodeId: 'node-a', limit: 1, requestId: requestIdAt(),
  }), /simulated claim failure/u);
  assert.equal(receiptFailure.calls.some(({ sql }) => sql.includes('UPDATE execution_claim_cursors')), false);
  assert.equal(receiptFailure.calls.at(-1).sql, 'ROLLBACK');
});
