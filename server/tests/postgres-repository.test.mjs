import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

function taskRow(overrides = {}) {
  return {
    id: 41,
    query: '指定远端执行机',
    input: {},
    requested_image_count: 'auto',
    state: 'COPY_QUEUED',
    created_by_node_id: 'node-a',
    copy_executor_node_id: 'node-b',
    current_copy_revision_id: null,
    current_image_run_id: null,
    current_execution_id: null,
    current_stage: null,
    progress_percent: 0,
    progress_message: '',
    execution_started_at: null,
    last_activity_at: null,
    finished_at: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

test('task creation keeps creator and selected copy executor separate', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes('SELECT id, last_seen_at')) {
        return { rows: [{ id: 'node-b', online: true }] };
      }
      if (String(sql).includes('INSERT INTO tasks')) return { rows: [taskRow()] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => client },
  });

  const created = await repository.createTasks({
    nodeId: 'node-a',
    copyExecutorNodeId: 'node-b',
    tasks: [{ query: '指定远端执行机' }],
  });
  const insert = queries.find((query) => query.sql.includes('INSERT INTO tasks'));

  assert.equal(created[0].createdByNodeId, 'node-a');
  assert.equal(created[0].copyExecutorNodeId, 'node-b');
  assert.deepEqual(insert.values.slice(3), ['node-a', 'node-b']);
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5\)/u);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('execution failure uses separate PostgreSQL parameters for varchar and text columns', async () => {
  const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
  const queries = [];
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source.includes('FROM task_executions e')) {
        return { rows: [{
          id: executionId,
          task_id: 41,
          kind: 'COPY',
          node_id: 'node-b',
          status: 'RUNNING',
          stage: 'QUERY_REVIEW',
          progress_percent: 5,
          progress_message: '',
          progress_details: {},
          snapshot: {},
          error: null,
          started_at: new Date(),
          last_activity_at: new Date(),
          finished_at: null,
          current_execution_id: executionId,
          task_state: 'COPY_RUNNING',
        }] };
      }
      if (source.includes('UPDATE tasks SET')) {
        return { rows: [{ ...taskRow(), state: 'COPY_FAILED', error: 'simulated failure' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => client },
  });

  const failed = await repository.failExecution(executionId, 'simulated failure');
  const executionUpdate = queries.find((query) => query.sql.includes('UPDATE task_executions SET'));
  const taskUpdate = queries.find((query) => query.sql.includes('UPDATE tasks SET'));

  assert.equal(failed.state, 'COPY_FAILED');
  assert.deepEqual(executionUpdate.values, [executionId, 'simulated failure', 'simulated failure']);
  assert.deepEqual(taskUpdate.values, [41, 'COPY_FAILED', 'simulated failure', 'simulated failure', executionId]);
  assert.match(executionUpdate.sql, /progress_message = \$2[\s\S]*error = \$3/u);
  assert.match(taskUpdate.sql, /progress_message = \$3, error = \$4/u);
});

test('task pages filter multiple states and Query text while returning a total', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({
    pool: {
      async query(sql, values) {
        const source = String(sql);
        queries.push({ sql: source, values });
        if (source.includes('COUNT(*) AS total')) return { rows: [{ total: '31' }] };
        return { rows: [taskRow({ state: 'COPY_FAILED' })] };
      },
    },
  });

  const page = await repository.listTasks({
    states: 'COPY_QUEUED,COPY_FAILED',
    nodeId: 'node-b',
    query: '远端',
    limit: 20,
    offset: 20,
    includeTotal: true,
  });

  assert.equal(page.total, 31);
  assert.equal(page.items[0].state, 'COPY_FAILED');
  const pageQuery = queries.find((item) => item.sql.includes('SELECT * FROM tasks'));
  assert.deepEqual(pageQuery.values, [
    ['COPY_QUEUED', 'COPY_FAILED'],
    'node-b',
    '远端',
    20,
    20,
  ]);
  assert.match(pageQuery.sql, /state = ANY\(\$1::varchar\[\]\)/u);
  assert.match(pageQuery.sql, /strpos\(lower\(query\), lower\(\$3\)\) > 0/u);
});

test('image failure can be edited and submitted back to the image queue', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT') return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [taskRow({
          state: 'IMAGE_FAILED',
          current_copy_revision_id: 12,
          current_image_run_id: '47d841f5-3808-46f0-9f2a-fa9781379b38',
        })] };
      }
      if (source.includes('SELECT * FROM copy_revisions')) {
        return { rows: [{
          id: 12,
          task_id: 41,
          execution_id: null,
          revision: 2,
          content: {},
          approved_at: new Date(),
          approved_by_node_id: 'node-b',
          created_at: new Date(),
        }] };
      }
      if (source.includes('SELECT id FROM executor_nodes')) return { rows: [{ id: 'node-b' }] };
      if (source.includes('UPDATE copy_revisions')) return { rows: [] };
      if (source.includes('UPDATE tasks SET')) {
        return { rows: [taskRow({ state: 'IMAGE_QUEUED', current_copy_revision_id: 12 })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

  const approved = await repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-b',
  });

  assert.equal(approved.state, 'IMAGE_QUEUED');
  assert.ok(queries.some((item) => item.sql.includes("state = 'IMAGE_QUEUED'")));
});

test('logical task cancellation abandons an active image execution and keeps task history', async () => {
  const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
  const queries = [];
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT') return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [taskRow({
          state: 'IMAGE_RUNNING',
          current_execution_id: executionId,
          current_image_run_id: executionId,
        })] };
      }
      if (source.includes('SELECT * FROM task_executions')) {
        return { rows: [{ id: executionId, kind: 'IMAGE', status: 'RUNNING' }] };
      }
      if (source.includes('UPDATE tasks SET')) {
        return { rows: [taskRow({ state: 'CANCELLED', current_execution_id: null })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

  const cancelled = await repository.cancelTask(41);

  assert.equal(cancelled.state, 'CANCELLED');
  assert.ok(queries.some((item) => item.sql.includes("status = 'ABANDONED'")));
  assert.ok(queries.some((item) => item.sql.includes('UPDATE image_runs SET')));
  assert.equal(queries.some((item) => item.sql.includes('DELETE FROM')), false);
});
