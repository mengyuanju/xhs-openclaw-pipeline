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
    created_by_user_id: 'admin',
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
    createdByUserId: 'admin',
    tasks: [{ query: '指定远端执行机' }],
  });
  const insert = queries.find((query) => query.sql.includes('INSERT INTO tasks'));

  assert.equal(created[0].createdByNodeId, 'node-a');
  assert.equal(created[0].copyExecutorNodeId, 'node-b');
  assert.equal(created[0].createdByUserId, 'admin');
  assert.deepEqual(insert.values.slice(3), ['node-a', 'node-b', 'admin']);
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)/u);
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

for (const kind of ['COPY', 'IMAGE']) {
  test(`${kind} failure bounds both progress columns while retaining redacted error details`, async () => {
    const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
    const snapshot = { copyRevision: { id: 12, content: { reviewed: true } } };
    const cases = [
      { raw: '错'.repeat(500), detail: '错'.repeat(500) },
      { raw: '错'.repeat(501), detail: '错'.repeat(501) },
      { raw: '错'.repeat(2500), detail: '错'.repeat(2000) },
      { raw: '错'.repeat(499) + '🖼️'.repeat(800), detail: [...('错'.repeat(499) + '🖼️'.repeat(800))].slice(0, 2000).join('') },
      { raw: 'Bearer abcdefghijklmnop sk-abcdefghijklmnop ' + '错'.repeat(800),
        detail: 'Bearer [REDACTED_TOKEN] [REDACTED_API_KEY] ' + '错'.repeat(800) },
    ];
    for (const { raw, detail } of cases) {
      const queries = [];
      let released = false;
      const client = {
        async query(sql, values) {
          const source = String(sql);
          queries.push({ sql: source, values });
          if (source.includes('FROM task_executions e')) return { rows: [{
            id: executionId, task_id: 41, kind, status: 'RUNNING', node_id: 'node-b',
            current_execution_id: executionId, task_state: `${kind}_RUNNING`, snapshot,
          }] };
          // Model PostgreSQL's varchar(500) constraint for both writes.
          if (source.includes('UPDATE task_executions SET')) {
            assert.ok([...values[1]].length <= 500, 'execution progress exceeds varchar(500)');
          }
          if (source.includes('UPDATE tasks SET')) {
            assert.ok([...values[2]].length <= 500, 'task progress exceeds varchar(500)');
            return { rows: [taskRow({ state: values[1], progress_message: values[2], error: values[3] })] };
          }
          return { rows: [] };
        },
        release() { released = true; },
      };
      const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
      const failed = await repository.failExecution(executionId, new Error(raw));
      const summary = [...detail].slice(0, 500).join('');
      const executionUpdate = queries.find((query) => query.sql.includes('UPDATE task_executions SET'));
      const taskUpdate = queries.find((query) => query.sql.includes('UPDATE tasks SET'));
      const nextState = kind === 'IMAGE' ? 'IMAGE_QUEUED' : 'COPY_FAILED';
      const taskMessage = kind === 'IMAGE' ? '生图第1次失败，等待原执行机重试（最多3次）' : summary;
      assert.deepEqual(executionUpdate.values, [executionId, summary, detail]);
      assert.deepEqual(taskUpdate.values, [41, nextState, taskMessage, detail, executionId,
        ...(kind === 'IMAGE' ? [{ ...snapshot, imageRetry: { failedAttempts: 1, nodeId: 'node-b' } }] : [])]);
      assert.equal(failed.state, nextState);
      assert.equal(failed.progressMessage, taskMessage);
      if (kind === 'IMAGE') {
        assert.match(taskUpdate.sql, /current_stage = 'IMAGE_QUEUED', progress_percent = 0/u);
        assert.match(taskUpdate.sql, /current_image_run_id = NULL, pending_snapshot = \$6/u);
        assert.match(taskUpdate.sql, /execution_started_at = NULL, finished_at = NULL/u);
      }
      assert.equal(failed.error, detail);
      assert.ok(summary.isWellFormed());
      assert.ok(detail.isWellFormed());
      assert.equal(queries.some((query) => query.sql.includes('UPDATE image_runs SET')), kind === 'IMAGE');
      assert.match(taskUpdate.sql, /current_execution_id = NULL/u);
      assert.equal(queries.at(-1).sql, 'COMMIT');
      assert.equal(released, true);
    }
  });
}

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

test('personal task pagination and totals filter the creator independently of execution nodes', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: sql.includes('COUNT(*) AS total')
        ? [{ total: '2' }]
        : [taskRow(), taskRow({ id: 42, state: 'COMPLETED', copy_executor_node_id: 'node-c' })] };
    },
  } });
  const page = await repository.listTasks({ createdByUserId: 'admin', query: '远端', includeTotal: true });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((task) => task.createdByUserId), ['admin', 'admin']);
  assert.deepEqual(page.items.map((task) => task.copyExecutorNodeId), ['node-b', 'node-c']);
  for (const { sql, values } of queries) {
    assert.match(sql, /created_by_user_id = \$1/u);
    assert.doesNotMatch(sql, /copy_executor_node_id =/u);
    assert.deepEqual(values.slice(0, 2), ['admin', '远端']);
  }
  await assert.rejects(repository.listTasks({ createdByUserId: '' }), /createdByUserId/u);
});

test('task pages expose the current running image executor independently of copy ownership', async () => {
  let selection;
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql) {
      selection = sql;
      return { rows: [
        taskRow({ state: 'IMAGE_RUNNING', copy_executor_node_id: 'copy-a',
          image_executor_node_id: 'image-b', image_executor_node_name: '生图工作站 B' }),
        taskRow({ id: 42, state: 'IMAGE_QUEUED', image_executor_node_id: null,
          image_executor_node_name: null }),
      ] };
    },
  } });
  const tasks = await repository.listTasks({ states: ['IMAGE_RUNNING', 'IMAGE_QUEUED'] });
  assert.equal(tasks[0].copyExecutorNodeId, 'copy-a');
  assert.equal(tasks[0].imageExecutorNodeId, 'image-b');
  assert.equal(tasks[0].imageExecutorNodeName, '生图工作站 B');
  assert.equal(tasks[1].imageExecutorNodeId, null);
  assert.equal(tasks[1].imageExecutorNodeName, null);
  assert.match(selection, /e.id = page.current_execution_id/u);
  assert.match(selection, /e.kind = 'IMAGE' AND e.status = 'RUNNING' AND page.state = 'IMAGE_RUNNING'/u);
  assert.match(selection, /n.id = COALESCE\(e.node_id, successful_image.node_id\)/u);
  assert.doesNotMatch(selection, /n.id = .*copy_executor_node_id/u);
});

test('delivery review resolves the successful executor of the current image run', async () => {
  let selection;
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql) {
      selection = sql;
      return { rows: [taskRow({ state: 'DELIVERY_REVIEW_PENDING', current_execution_id: null,
        copy_executor_node_id: 'copy-a', image_executor_node_id: 'successful-b',
        image_executor_node_name: '最后成功生图机器' })] };
    },
  } });
  const [task] = await repository.listTasks({ state: 'DELIVERY_REVIEW_PENDING' });
  assert.equal(task.imageExecutorNodeId, 'successful-b');
  assert.equal(task.imageExecutorNodeName, '最后成功生图机器');
  assert.equal(task.currentExecutionId, null);
  assert.match(selection, /delivered_run.id = page.current_image_run_id/u);
  assert.match(selection, /delivered_run.status = 'COMPLETED'/u);
  assert.match(selection, /successful_image.id = delivered_run.execution_id/u);
  assert.match(selection, /successful_image.task_id = page.id/u);
  assert.match(selection, /successful_image.kind = 'IMAGE' AND successful_image.status = 'SUCCEEDED'/u);
});

test('copy approval submits reviewed copy to the image queue', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT') return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [taskRow({
          state: 'COPY_REVIEW_PENDING',
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

test('requeued images cannot be edited through copy approval', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: sql.includes('SELECT * FROM tasks') ? [taskRow({ state: 'IMAGE_QUEUED' })] : [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.approveCopy(41, { revisionId: 12, nodeId: 'node-b' }),
    (error) => error.code === 'INVALID_TASK_STATE');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some((sql) => /^\s*UPDATE\b/u.test(sql)), false);
});

test('image claims apply a shared retry cooldown and reuse the approved snapshot in a new execution', async () => {
  const queries = [];
  const previousId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
  const snapshot = { copyRevision: { id: 12, content: { reviewed: true } },
    imageRetry: { failedAttempts: 2, nodeId: 'node-b' } };
  let execution;
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT * FROM executor_nodes')) return { rows: [{ id: 'node-b', image_worker_enabled: true }] };
      if (sql.includes('SELECT * FROM tasks')) return { rows: [taskRow({
        state: 'IMAGE_QUEUED', current_copy_revision_id: 12, pending_snapshot: snapshot,
      })] };
      if (sql.includes('INSERT INTO task_executions')) {
        execution = { id: values[0], task_id: values[1], kind: values[2], snapshot: values[6], status: 'RUNNING' };
      }
      if (sql.includes('UPDATE tasks SET')) return { rows: [taskRow({
        state: values[0], current_execution_id: values[1], current_copy_revision_id: 12,
      })] };
      if (sql.includes('SELECT * FROM task_executions')) return { rows: [execution] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  const claim = await repository.claimImage('node-b');
  const candidate = queries.find((query) => query.sql.includes('SELECT * FROM tasks'));
  assert.deepEqual(candidate.values, ['IMAGE_QUEUED', 'node-b']);
  assert.match(candidate.sql, /error IS NULL OR last_activity_at <= now\(\) - interval '5 seconds'/u);
  assert.match(candidate.sql, /ORDER BY last_activity_at NULLS FIRST, id/u);
  assert.match(candidate.sql, /FOR UPDATE SKIP LOCKED/u);
  assert.doesNotMatch(candidate.sql, /copy_executor_node_id/u);
  assert.notEqual(claim.execution.id, previousId);
  assert.deepEqual(claim.execution.snapshot, snapshot);
  assert.equal(claim.task.state, 'IMAGE_RUNNING');
  assert.equal(queries.find((query) => query.sql.includes('INSERT INTO image_runs')).values[2], 12);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('task counts no longer classify failed images as pending copy review', async () => {
  let source;
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql) {
    source = sql;
    return { rows: [{ local_copy: '0', all_copy: '0', copy_review: '2', image_work: '3', delivery_review: '0', completed: '1' }] };
  } } });
  const counts = await repository.taskCounts({ nodeId: 'node-b' });
  assert.equal(counts.copyReview, 2);
  assert.equal(counts.imageWork, 3);
  assert.match(source, /WHERE state = 'COPY_REVIEW_PENDING'/u);
  assert.match(source, /WHERE state IN \('IMAGE_QUEUED', 'IMAGE_RUNNING'\)/u);
  assert.doesNotMatch(source, /IMAGE_FAILED/u);
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
