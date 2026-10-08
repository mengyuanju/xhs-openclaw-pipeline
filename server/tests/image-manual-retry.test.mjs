import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const executionId = '55555555-5555-4555-8555-555555555555';

function taskRow(state, {
  approved = true, running = false, currentStage = state,
  releasedRevisionId = currentStage === 'IMAGE_RETRY_EXHAUSTED' ? 12 : null,
  mandatoryCopyQc = currentStage === 'IMAGE_RETRY_EXHAUSTED',
  mandatoryCopyQcOrigin = currentStage === 'IMAGE_RETRY_EXHAUSTED' ? 'IMAGE_RETRY_REVIEW' : null,
  copyQaReworkPending = false,
} = {}) {
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
    copy_qc_released_revision_id: releasedRevisionId,
    mandatory_copy_qc: mandatoryCopyQc,
    mandatory_copy_qc_origin: mandatoryCopyQcOrigin,
    copy_qa_rework_pending: copyQaReworkPending,
    current_image_run_id: 'old-run',
    current_execution_id: running ? executionId : null,
    current_stage: currentStage,
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
      if (sql.includes('SELECT copy_quality_image_eligible(')) {
        return { rows: [{ eligible: options.qualityEligible !== false }] };
      }
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
          mandatory_copy_qc: values[1] ? false : task.mandatory_copy_qc,
          mandatory_copy_qc_origin: values[1] ? null : task.mandatory_copy_qc_origin,
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

test('exhausted image retries can restart the previously released copy without a new QA round', async () => {
  const { calls, repository } = fixture('COPY_REVIEW_PENDING', {
    currentStage: 'IMAGE_RETRY_EXHAUSTED',
  });
  const task = await repository.requeueImageTask(51);
  assert.equal(task.state, 'IMAGE_QUEUED');
  assert.equal(task.currentCopyRevisionId, 12);
  assert.equal(task.currentImageRunId, null);
  assert.equal(task.mandatoryCopyQc, false);
  assert.equal(task.mandatoryCopyQcOrigin, null);
  assert.deepEqual(calls.find(({ sql }) => sql.includes('SELECT copy_quality_image_eligible('))?.values,
    [51, 12]);
  const update = calls.find(({ sql }) => sql.includes('UPDATE tasks SET'));
  assert.deepEqual(update.values, [51, true]);
  assert.match(update.sql, /pending_snapshot = NULL/u);
  assert.match(update.sql, /image_production_chain_id = NULL/u);
  assert.match(update.sql, /mandatory_copy_qc = CASE WHEN \$2 THEN false/u);
  assert.match(update.sql, /mandatory_copy_qc_origin = CASE WHEN \$2 THEN NULL/u);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO copy_revisions')), false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('exhausted image retry does not bypass unreleased copy or active QA requirements', async () => {
  for (const options of [
    { releasedRevisionId: null },
    { qualityEligible: false },
    { mandatoryCopyQcOrigin: 'QA_RETURN' },
    { copyQaReworkPending: true },
    { approved: false },
  ]) {
    const { calls, repository } = fixture('COPY_REVIEW_PENDING', {
      currentStage: 'IMAGE_RETRY_EXHAUSTED', ...options,
    });
    await assert.rejects(repository.requeueImageTask(51), {
      code: options.mandatoryCopyQcOrigin === 'QA_RETURN' || options.copyQaReworkPending
        ? 'IMAGE_RETRY_REVIEW_REQUIRED' : 'IMAGE_RETRY_UNAVAILABLE',
    });
    assert.equal(calls.some(({ sql }) => sql.includes('UPDATE tasks SET')), false);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
  }
});

test('copy-only and cancelled tasks cannot be sent to image generation', async () => {
  for (const state of ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED', 'CANCELLED']) {
    const { repository } = fixture(state);
    await assert.rejects(repository.requeueImageTask(51), { code: 'INVALID_TASK_STATE' });
  }
});

test('bulk retry cannot use the broader manual image requeue states', async () => {
  for (const state of ['IMAGE_QUEUED', 'MANUAL_ARCHIVE', 'COPY_REVIEW_PENDING']) {
    const { repository } = fixture(state);
    await assert.rejects(repository.requeueImageTask(51, { retryOnly: true }), { code: 'INVALID_TASK_STATE' });
  }
  const exhausted = fixture('COPY_REVIEW_PENDING', { currentStage: 'IMAGE_RETRY_EXHAUSTED' });
  await assert.rejects(exhausted.repository.requeueImageTask(51, { retryOnly: true }), {
    code: 'IMAGE_RETRY_REVIEW_REQUIRED',
  });
});
