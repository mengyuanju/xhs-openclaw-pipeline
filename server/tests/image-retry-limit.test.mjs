import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';

function failureFixture(snapshot = {}) {
  const queries = [];
  let active = true;
  const client = {
    release() {},
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM task_executions e')) return { rows: [{
        id: executionId, task_id: 41, kind: 'IMAGE', node_id: 'image-node',
        status: active ? 'RUNNING' : 'FAILED',
        current_execution_id: active ? executionId : null, snapshot,
      }] };
      if (sql.includes('UPDATE tasks SET')) {
        active = false;
        return { rows: [{
          id: 41, state: values[1], current_stage: sql.match(/current_stage = '([^']+)'/u)?.[1],
          progress_message: values[2], error: values[3], current_copy_revision_id: 12,
          current_execution_id: null, pending_snapshot: values[5],
        }] };
      }
      return { rows: [] };
    },
  };
  return { queries, pool: { connect: async () => client } };
}

test('non-retryable executor failures keep image checkpoints and wait for manual continuation', async () => {
  const fixture = failureFixture();
  const repository = new PostgresControlPlaneRepository({ pool: fixture.pool });
  const task = await repository.failExecution(executionId, 'Codex execution outcome unknown', { autoRetry: false });
  assert.equal(task.state, 'IMAGE_FAILED');
  assert.equal(task.currentStage, 'FAILED');
  assert.match(task.progressMessage, /人工/u);
  const update = fixture.queries.find(({ sql }) => sql.includes('UPDATE tasks SET'));
  assert.match(update.sql, /current_image_run_id = current_image_run_id/u);
  assert.equal(update.values[5], null);
});

for (const priorFailures of [0, 1, 2, 3]) {
  test(`image failure after ${priorFailures} recorded failures enforces the three-attempt budget`, async () => {
    const snapshot = { copyRevision: { id: 12 },
      ...(priorFailures ? { imageRetry: { failedAttempts: priorFailures, nodeId: 'image-node' } } : {}) };
    const fixture = failureFixture(snapshot);
    const repository = new PostgresControlPlaneRepository({ pool: fixture.pool });
    const task = await repository.failExecution(executionId, 'OpenClaw exhausted its internal retries');
    const update = fixture.queries.find(({ sql }) => sql.includes('UPDATE tasks SET'));
    assert.equal(task.currentCopyRevisionId, 12);
    assert.equal(task.currentExecutionId, null);
    assert.equal(task.error, 'OpenClaw exhausted its internal retries');
    if (priorFailures < 2) {
      assert.equal(task.state, 'IMAGE_QUEUED');
      assert.equal(task.currentStage, 'IMAGE_QUEUED');
      assert.deepEqual(update.values[5].imageRetry, {
        failedAttempts: priorFailures + 1, nodeId: 'image-node',
      });
      assert.deepEqual(update.values[5].copyRevision, snapshot.copyRevision);
      assert.match(task.progressMessage, new RegExp(`生图第${priorFailures + 1}次失败`));
    } else {
      assert.equal(task.state, 'COPY_REVIEW_PENDING');
      assert.equal(task.currentStage, 'IMAGE_RETRY_EXHAUSTED');
      assert.match(task.progressMessage, /生图3次失败/u);
      assert.equal(update.values[5], null, 'human review must start a new retry cycle');
      assert.match(update.sql, /finished_at = now\(\)/u);
    }
    assert.equal(snapshot.imageRetry?.failedAttempts ?? 0, priorFailures, 'old snapshot stays immutable');
    assert.ok(fixture.queries.some(({ sql }) => sql.includes("UPDATE image_runs SET status = 'FAILED'")));
    assert.equal(fixture.queries.at(-1).sql, 'COMMIT');
    await assert.rejects(repository.failExecution(executionId, 'duplicate report'), { code: 'STALE_EXECUTION' });
    assert.equal(fixture.queries.filter(({ sql }) => sql.includes('UPDATE tasks SET')).length, 1);
  });
}

test('image retry claim is pinned to its previous executor while fresh work remains shared', async () => {
  let selection;
  const client = {
    release() {},
    async query(sql, values) {
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ id: 'other-node', image_worker_enabled: true }] };
      if (sql.includes('FOR UPDATE SKIP LOCKED')) selection = { sql, values };
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  assert.equal(await repository.claimImage('other-node'), null);
  assert.deepEqual(selection.values, ['IMAGE_QUEUED', 'other-node']);
  assert.match(selection.sql, /pending_snapshot->'imageRetry'->>'nodeId' IS NULL/u);
  assert.match(selection.sql, /pending_snapshot->'imageRetry'->>'nodeId' = \$2/u);
  assert.match(selection.sql, /interval '5 seconds'/u);
});

test('failure budget survives fresh repository instances and reaches review on the third full execution', async () => {
  let snapshot = { copyRevision: { id: 12 }, prompts: { IMAGE_SYSTEM: { content: 'fixed prompt' } } };
  const states = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const fixture = failureFixture(snapshot);
    const repository = new PostgresControlPlaneRepository({ pool: fixture.pool });
    const task = await repository.failExecution(executionId, `attempt ${attempt} failed`);
    states.push(task.state);
    snapshot = fixture.queries.find(({ sql }) => sql.includes('UPDATE tasks SET')).values[5];
    if (attempt < 3) {
      assert.equal(snapshot.imageRetry.failedAttempts, attempt);
      assert.equal(snapshot.prompts.IMAGE_SYSTEM.content, 'fixed prompt');
    }
  }
  assert.deepEqual(states, ['IMAGE_QUEUED', 'IMAGE_QUEUED', 'COPY_REVIEW_PENDING']);
  assert.equal(snapshot, null);
});

test('exhausted image work cannot bypass human review through the retry endpoint', async () => {
  let mutated = false;
  const client = {
    release() {},
    async query(sql) {
      if (/^\s*(UPDATE|INSERT|DELETE)\b/u.test(sql)) mutated = true;
      return { rows: sql.includes('SELECT * FROM tasks')
        ? [{ id: 41, state: 'COPY_REVIEW_PENDING', current_stage: 'IMAGE_RETRY_EXHAUSTED' }] : [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  for (const useLatestConfig of [false, true]) {
    await assert.rejects(repository.retryTask(41, { useLatestConfig }), { code: 'INVALID_TASK_STATE' });
  }
  assert.equal(mutated, false);
});

test('re-approving an exhausted task clears its failure budget and queues reviewed copy', async () => {
  let update;
  const client = {
    release() {},
    async query(sql, values) {
      if (sql.includes('SELECT * FROM tasks WHERE id')) return { rows: [{
        id: 41, state: 'COPY_REVIEW_PENDING', current_stage: 'IMAGE_RETRY_EXHAUSTED', current_copy_revision_id: 12,
      }] };
      if (sql.includes('SELECT * FROM copy_revisions')) return { rows: [{ id: 12, content: {} }] };
      if (sql.includes('SELECT id FROM executor_nodes')) return { rows: [{ id: 'reviewer' }] };
      if (sql.includes('UPDATE tasks SET')) {
        update = { sql, values };
        return { rows: [{ id: 41, state: 'IMAGE_QUEUED', current_copy_revision_id: 12 }] };
      }
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  const task = await repository.approveCopy(41, { revisionId: 12, nodeId: 'reviewer' });
  assert.equal(task.state, 'IMAGE_QUEUED');
  assert.match(update.sql, /pending_snapshot = NULL/u);
  assert.match(update.sql, /current_stage = 'IMAGE_QUEUED'/u);
});
