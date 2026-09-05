import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const executionId = '55555555-5555-4555-8555-555555555555';

function taskRow(state, { approved = true, running = false } = {}) {
  return {
    id: 51,
    query: '重新生图',
    input: {},
    requested_image_count: 'auto',
    ai_disclosure_enabled: true,
    state,
    created_by_node_id: 'creator',
    created_by_user_id: 'alice',
    copy_executor_node_id: 'copy-a',
    current_copy_revision_id: 12,
    current_image_run_id: 'old-run',
    current_execution_id: running ? executionId : null,
    current_stage: state,
    progress_percent: running ? 40 : 0,
    progress_message: '旧状态',
    execution_started_at: running ? '2026-09-05T01:00:00Z' : null,
    last_activity_at: '2026-09-05T01:01:00Z',
    finished_at: null,
    error: null,
    created_at: '2026-09-05T00:00:00Z',
    updated_at: '2026-09-05T01:01:00Z',
    approved,
  };
}

function fixture(state, options = {}) {
  const task = taskRow(state, options);
  const calls = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      sql = String(sql);
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM tasks WHERE id')) return { rows: [{ ...task }] };
      if (sql.includes('SELECT id FROM copy_revisions')) return { rows: task.approved ? [{ id: 12 }] : [] };
      if (sql.includes('SELECT * FROM task_executions')) {
        return { rows: [{ id: executionId, kind: 'IMAGE', status: 'RUNNING' }] };
      }
      if (sql.includes('UPDATE task_executions SET')) return { rows: [] };
      if (sql.includes('UPDATE image_runs SET')) return { rows: [] };
      if (sql.includes('UPDATE tasks SET')) {
        Object.assign(task, {
          state: 'IMAGE_QUEUED',
          current_execution_id: null,
          current_image_run_id: null,
          current_stage: 'IMAGE_QUEUED',
          progress_percent: 0,
          progress_message: '已人工重试，等待图片执行机领取',
          pending_snapshot: null,
          execution_started_at: null,
          finished_at: null,
          error: null,
        });
        return { rows: [{ ...task }] };
      }
      return { rows: [] };
    },
  };
  return {
    calls,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
  };
}

for (const state of ['IMAGE_QUEUED', 'IMAGE_FAILED', 'COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE']) {
  test(`${state} can be manually returned to the global image queue`, async () => {
    const { calls, repository } = fixture(state);
    const result = await repository.requeueImageTask(51);
    assert.equal(result.state, 'IMAGE_QUEUED');
    assert.equal(result.currentImageRunId, null);
    assert.equal(result.currentStage, 'IMAGE_QUEUED');
    const update = calls.find(({ sql }) => sql.includes('UPDATE tasks SET'));
    assert.match(update.sql, /pending_snapshot = NULL/u);
    assert.match(update.sql, /progress_message = '已人工重试，等待图片执行机领取'/u);
    assert.equal(calls.at(-1).sql, 'COMMIT');
  });
}

test('manual image retry abandons an active image execution and run', async () => {
  const { calls, repository } = fixture('IMAGE_RUNNING', { running: true });
  const result = await repository.requeueImageTask(51);
  assert.equal(result.state, 'IMAGE_QUEUED');
  assert.ok(calls.some(({ sql }) => sql.includes("status = 'ABANDONED'") && sql.includes('UPDATE task_executions')));
  assert.ok(calls.some(({ sql }) => sql.includes('UPDATE image_runs SET')));
});

test('copy awaiting first approval cannot bypass review through image retry', async () => {
  const { calls, repository } = fixture('COPY_REVIEW_PENDING', { approved: false });
  await assert.rejects(repository.requeueImageTask(51), { code: 'IMAGE_RETRY_UNAVAILABLE' });
  assert.equal(calls.some(({ sql }) => sql.includes('UPDATE tasks SET')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('copy-only and cancelled tasks cannot be sent to image generation', async () => {
  for (const state of ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED', 'CANCELLED']) {
    const { repository } = fixture(state);
    await assert.rejects(repository.requeueImageTask(51), { code: 'INVALID_TASK_STATE' });
  }
});
