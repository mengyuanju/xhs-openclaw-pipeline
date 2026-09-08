import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const executionId = '44444444-4444-4444-8444-444444444444';

function retryFixture({ state = 'COPY_RUNNING' } = {}) {
  const snapshot = { task: { id: 41, query: '文案重试' }, prompts: { TEXT_SYSTEM: { version: 2 } } };
  const task = {
    id: 41, query: '文案重试', state, input: {}, requested_image_count: 'auto',
    copy_executor_node_id: 'copy-old', created_by_node_id: 'creator-node', created_by_user_id: 'alice',
    current_execution_id: state === 'COPY_RUNNING' ? executionId : null,
    current_stage: 'ORIGINAL_GENERATION', progress_percent: 70,
    execution_started_at: '2026-09-05T01:00:00Z', finished_at: null,
    created_at: '2026-09-04T01:00:00Z', error: state === 'COPY_FAILED' ? 'failure' : null,
  };
  const execution = {
    id: executionId, task_id: 41, kind: 'COPY', node_id: 'copy-old', snapshot,
    status: state === 'COPY_RUNNING' ? 'RUNNING' : 'FAILED',
  };
  const queries = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('SELECT * FROM tasks WHERE id')) return { rows: [{ ...task }] };
      if (sql.includes('FROM task_executions e')) {
        return { rows: [{ ...execution, current_execution_id: task.current_execution_id, task_state: task.state }] };
      }
      if (sql.includes('FROM task_executions')) return { rows: [{ ...execution }] };
      if (sql.includes('UPDATE task_executions SET')) {
        assert.match(sql, /status = 'ABANDONED'/u);
        assert.deepEqual(values, [executionId]);
        execution.status = 'ABANDONED';
        return { rows: [] };
      }
      if (sql.includes('UPDATE tasks SET')) {
        assert.match(sql, /copy_executor_node_id = NULL/u);
        assert.match(sql, /current_execution_id = NULL/u);
        assert.match(sql, /execution_started_at = NULL/u);
        assert.match(sql, /finished_at = NULL, error = NULL/u);
        assert.equal(values[0], task.id);
        Object.assign(task, {
          state: values[1], current_stage: values[1], pending_snapshot: values[2],
          copy_executor_node_id: null, current_execution_id: null,
          progress_percent: 0, execution_started_at: null, finished_at: null, error: null,
        });
        return { rows: [{ ...task }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return {
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
    task, execution, snapshot, queries,
  };
}

for (const state of ['COPY_RUNNING', 'COPY_FAILED']) {
  for (const useLatestConfig of [false, true]) {
    test(`${state} retry returns to the shared queue with ${useLatestConfig ? 'latest' : 'original'} configuration`, async () => {
      const { repository, execution, snapshot, queries } = retryFixture({ state });
      const result = await repository.retryTask(41, { useLatestConfig });
      assert.equal(result.state, 'COPY_QUEUED');
      assert.equal(result.copyExecutorNodeId, null);
      assert.equal(result.createdByNodeId, 'creator-node');
      assert.equal(result.createdByUserId, 'alice');
      assert.equal(result.createdAt, '2026-09-04T01:00:00Z');
      assert.equal(result.currentExecutionId, null);
      assert.equal(result.progressPercent, 0);
      assert.equal(result.executionStartedAt, null);
      assert.equal(result.finishedAt, null);
      assert.equal(result.error, null);
      assert.deepEqual(queries.find(({ sql }) => sql.includes('UPDATE tasks SET')).values,
        [41, 'COPY_QUEUED', useLatestConfig ? null : snapshot]);
      assert.equal(execution.status, state === 'COPY_RUNNING' ? 'ABANDONED' : 'FAILED');
      assert.equal(queries.at(-1).sql, 'COMMIT');
      await assert.rejects(repository.retryTask(41), { code: 'INVALID_TASK_STATE' });
    });
  }

}

test('a replaced copy execution cannot report progress, success or failure over the new queue', async () => {
  const { repository, task, queries } = retryFixture();
  await repository.retryTask(41);
  const queued = structuredClone(task);
  const writesBefore = queries.filter(({ sql }) => /^\s*UPDATE /u.test(sql)).length;
  await assert.rejects(repository.updateProgress(executionId, {
    stage: 'ORIGINAL_GENERATION', progressPercent: 80, message: '迟到进度',
  }), { code: 'STALE_EXECUTION' });
  await assert.rejects(repository.completeCopy(executionId, { title: '迟到文案' }), { code: 'STALE_EXECUTION' });
  await assert.rejects(repository.failExecution(executionId, '迟到错误'), { code: 'STALE_EXECUTION' });
  assert.deepEqual(task, queued);
  assert.equal(queries.filter(({ sql }) => /^\s*UPDATE /u.test(sql)).length, writesBefore);
});

test('executor mutations lock the task before its execution to share one deadlock-safe order', async () => {
  const calls = [];
  const execution = {
    id: executionId, task_id: 41, kind: 'COPY', node_id: 'copy-node', status: 'RUNNING',
    stage: 'ORIGINAL_GENERATION', progress_percent: 10, progress_message: '生成中',
    progress_details: null, snapshot: {}, current_execution_id: executionId,
  };
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql);
      calls.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
      if (source.includes('SELECT t.id') && source.includes('SELECT e.task_id')) {
        return { rows: [{ id: 41 }] };
      }
      if (source.includes('JOIN tasks t ON t.id = e.task_id')) return { rows: [{ ...execution }] };
      if (source.includes('UPDATE task_executions SET')) {
        Object.assign(execution, {
          stage: values[1], progress_percent: values[2], progress_message: values[3],
          progress_details: values[4],
        });
        return { rows: [{ ...execution }] };
      }
      if (source.includes('UPDATE tasks SET') || source.includes('UPDATE executor_nodes SET')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${source}`);
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.updateProgress(executionId, {
    stage: 'ORIGINAL_GENERATION', progressPercent: 25, message: '继续生成',
  });

  const taskLock = calls.findIndex(({ sql }) => sql.includes('SELECT t.id') && sql.includes('FOR UPDATE OF t'));
  const executionLock = calls.findIndex(({ sql }) => sql.includes('JOIN tasks t ON t.id = e.task_id'));
  assert.ok(taskLock > 0);
  assert.ok(executionLock > taskLock);
  assert.match(calls[executionLock].sql, /FOR UPDATE OF e/u);
  assert.doesNotMatch(calls[executionLock].sql, /FOR UPDATE OF e,\s*t/u);
});

test('copy claims select the shared queue without executor ownership filtering', async () => {
  const selections = [];
  const client = {
    release() {},
    async query(sql, values) {
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ id: values[0] }] };
      if (sql.includes('SELECT last_assignee_user_id FROM execution_claim_cursors')) {
        return { rows: [{ last_assignee_user_id: null }] };
      }
      if (sql.includes('FOR UPDATE OF task SKIP LOCKED')) selections.push({ sql, values });
      return { rows: [] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.claimCopy('copy-old');
  await repository.claimCopy('copy-new');
  assert.deepEqual(selections.map(({ values }) => values), [
    ['COPY_QUEUED', 1], ['COPY_QUEUED', 1],
  ]);
  for (const { sql } of selections) {
    assert.doesNotMatch(sql, /copy_executor_node_id/u);
    assert.doesNotMatch(sql, /assigned_to_user_id/u);
    assert.match(sql, /ORDER BY task\.id/u);
  }
});

test('copy retries reject tasks outside running and failed states before changing the queue', async () => {
  for (const state of ['COPY_QUEUED', 'COPY_REVIEW_PENDING', 'IMAGE_QUEUED', 'MANUAL_ARCHIVE', 'CANCELLED']) {
    const { repository, queries } = retryFixture({ state });
    await assert.rejects(repository.retryTask(41), { code: 'INVALID_TASK_STATE' });
    assert.equal(queries.some(({ sql }) => sql.includes('executor_nodes')), false);
  }
});
