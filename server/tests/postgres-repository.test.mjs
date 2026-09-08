import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { hashUserPassword } from '../src/user-auth.mjs';

function taskRow(overrides = {}) {
  return {
    id: 41,
    query: '指定远端执行机',
    input: {},
    requested_image_count: 'auto',
    ai_disclosure_enabled: true,
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

test('creator role filters apply equally to pages and totals and expose the current role', async () => {
  for (const role of ['ADMIN', 'REVIEWER', 'USER', 'UNKNOWN']) {
    const queries = [];
    const repository = new PostgresControlPlaneRepository({ pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        return { rows: sql.includes('COUNT(*) AS total') ? [{ total: '251' }]
          : [taskRow({ state: 'IMAGE_FAILED', creator_role: role === 'UNKNOWN' ? null : role })] };
      },
    } });
    const page = await repository.listTasks({ createdByRole: role, state: 'IMAGE_FAILED',
      limit: 20, offset: 240, includeTotal: true });
    assert.equal(page.total, 251);
    assert.equal(page.offset, 240);
    assert.equal(page.items[0].createdByRole, role === 'UNKNOWN' ? null : role);
    for (const { sql, values } of queries) {
      assert.match(sql, /EXISTS\s*\([\s\S]*app_users[\s\S]*created_by_user_id/u);
      if (role === 'UNKNOWN') assert.match(sql, /NOT EXISTS/u);
      else assert.equal(values.includes(role), true);
    }
  }
});

test('invalid creator role never reaches the database', async () => {
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query() { assert.fail('invalid filter reached SQL'); },
  } });
  for (const role of ['', 'owner', "ADMIN' OR 1=1--", ['ADMIN', 'USER']]) {
    await assert.rejects(repository.listTasks({ createdByRole: role }), /role.*invalid/u);
  }
});

test('task creation keeps ownership but leaves copy execution unassigned', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes('INSERT INTO tasks')) return { rows: [taskRow({
        copy_executor_node_id: null,
        current_stage: 'COPY_QUEUED',
        progress_message: '等待文案执行机领取',
      })] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => client },
  });

  const created = await repository.createTasks({
    nodeId: 'node-a',
    createdByUserId: 'admin',
    tasks: [{ query: '指定远端执行机' }],
  });
  const insert = queries.find((query) => query.sql.includes('INSERT INTO tasks'));

  assert.equal(created[0].createdByNodeId, 'node-a');
  assert.equal(created[0].copyExecutorNodeId, null);
  assert.equal(created[0].createdByUserId, 'admin');
  assert.deepEqual(insert.values.slice(3), ['node-a', 'admin', false]);
  assert.doesNotMatch(insert.sql, /copy_executor_node_id/u);
  assert.match(insert.sql, /'COPY_QUEUED', '等待文案执行机领取'/u);
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
  assert.deepEqual(taskUpdate.values, [41, 'COPY_FAILED', 'simulated failure', 'simulated failure', executionId, 'QUERY_REVIEW']);
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
        ...(kind === 'IMAGE' ? [{ ...snapshot, imageRetry: { failedAttempts: 1, nodeId: 'node-b' } }, 'IMAGE_QUEUED', 0, null] : ['FAILED'])]);
      assert.equal(failed.state, nextState);
      assert.equal(failed.progressMessage, taskMessage);
      if (kind === 'IMAGE') {
        assert.match(taskUpdate.sql, /current_stage = \$7, progress_percent = \$8/u);
        assert.match(taskUpdate.sql, /current_image_run_id = NULL, pending_snapshot = \$6/u);
        assert.match(taskUpdate.sql, /execution_started_at = \$9, finished_at = NULL/u);
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
  assert.match(pageQuery.sql, /WHEN state = 'COPY_REVIEW_PENDING' THEN 1[\s\S]*WHEN state = 'MANUAL_ARCHIVE' THEN 2[\s\S]*WHEN state = 'COPY_RUNNING' THEN 3[\s\S]*WHEN state = 'IMAGE_RUNNING' THEN 4/u);
  assert.match(pageQuery.sql, /WHEN state IN \('COPY_FAILED', 'IMAGE_FAILED'\) THEN 5[\s\S]*WHEN state IN \('COPY_QUEUED', 'IMAGE_QUEUED'\) THEN 6/u);
  assert.match(pageQuery.sql, /ORDER BY CASE[\s\S]*created_at DESC, id DESC/u);
  assert.match(pageQuery.sql, /ORDER BY CASE[\s\S]*page\.created_at DESC, page\.id DESC/u);
});

test('task pages can de-duplicate normalized Query values before pagination', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({
    pool: {
      async query(sql, values) {
        queries.push({ sql: String(sql), values });
        return { rows: String(sql).includes('COUNT(DISTINCT') ? [{ total: '3' }] : [taskRow()] };
      },
    },
  });

  const page = await repository.listTasks({ deduplicateQuery: true, includeTotal: true });
  assert.equal(page.total, 3);
  const pageQuery = queries.find((item) => item.sql.includes('SELECT DISTINCT ON'));
  assert.match(pageQuery.sql, /DISTINCT ON \(lower\(regexp_replace\(btrim\(query\), '\\s\+', ' ', 'g'\)\)\)/u);
  assert.match(pageQuery.sql, /ORDER BY lower\(regexp_replace\(btrim\(query\), '\\s\+', ' ', 'g'\)\), created_at DESC, id DESC/u);
  assert.match(queries.find((item) => item.sql.includes('COUNT(DISTINCT')).sql, /COUNT\(DISTINCT lower\(regexp_replace/u);
  await assert.rejects(repository.listTasks({ deduplicateQuery: 'true' }), /deduplicateQuery/u);
});

test('task pages sort by creation time or Query ID and can locate an exact ID', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({
    pool: {
      async query(sql, values) {
        queries.push({ sql: String(sql), values });
        return { rows: [] };
      },
    },
  });

  await repository.listTasks({ taskId: '42', sortBy: 'createdAt', sortOrder: 'asc' });
  assert.match(queries[0].sql, /WHERE id = \$1/u);
  assert.match(queries[0].sql, /ORDER BY created_at ASC, id ASC/u);
  assert.match(queries[0].sql, /ORDER BY page\.created_at ASC, page\.id ASC/u);
  assert.deepEqual(queries[0].values, [42, 50, 0]);

  queries.length = 0;
  await repository.listTasks({ sortBy: 'id', sortOrder: 'desc' });
  assert.match(queries[0].sql, /ORDER BY id DESC/u);
  assert.match(queries[0].sql, /ORDER BY page\.id DESC/u);

  await assert.rejects(repository.listTasks({ sortBy: 'query' }), /sort field/u);
  await assert.rejects(repository.listTasks({ sortOrder: 'sideways' }), /sort order/u);
});

test('administrator attention filters use fixed SQL for stale and failed work', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql, values) { queries.push({ sql: String(sql), values }); return { rows: [] }; },
  } });
  await repository.listTasks({ attention: 'ANOMALY' });
  assert.match(queries[0].sql, /COALESCE\(last_activity_at, execution_started_at, updated_at, created_at\) <= now\(\) - interval '30 minutes'/u);
  assert.match(queries[0].sql, /current_stage = 'IMAGE_RETRY_EXHAUSTED'/u);
  assert.deepEqual(queries[0].values, [50, 0]);
  await assert.rejects(repository.listTasks({ attention: 'ALL' }), /attention/u);
});

test('saved task views are owner-scoped and upsert a validated filter document', async () => {
  const queries = [];
  const pool = { async query(sql, values) {
    const source = String(sql);
    queries.push({ sql: source, values });
    if (source.includes('INSERT INTO saved_task_views')) return { rows: [{
      id: 8, owner_username: values[0], name: values[1], view_key: values[2], filters: values[3],
      created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z',
    }] };
    if (source.includes('DELETE FROM saved_task_views')) return { rows: [{ id: values[0] }] };
    return { rows: [] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool });
  const saved = await repository.saveTaskView('admin', {
    name: '我的失败任务', viewKey: 'ALL_JOBS', filters: { attention: 'FAILED', createdByUserId: 'admin' },
  });
  assert.equal(saved.id, 8);
  assert.equal(saved.ownerUsername, 'admin');
  assert.deepEqual(queries[0].values[3], {
    query: '', deduplicateQuery: false, createdByUserId: 'admin', createdByRole: 'ALL', state: 'ALL',
    sort: 'priority:desc', attention: 'FAILED', pageSize: 20,
  });
  assert.match(queries[0].sql, /ON CONFLICT\(owner_username, name\) DO UPDATE/u);
  await repository.listSavedTaskViews('admin');
  assert.match(queries[1].sql, /WHERE owner_username = \$1/u);
  assert.deepEqual(await repository.deleteSavedTaskView('admin', 8), { id: 8, deleted: true });
  assert.deepEqual(queries[2].values, [8, 'admin']);
});

test('personal task pagination and totals filter the creator independently of execution nodes', async () => {
  const queries = [];
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: sql.includes('COUNT(*) AS total')
        ? [{ total: '2' }]
        : [taskRow(), taskRow({ id: 42, state: 'MANUAL_ARCHIVE', copy_executor_node_id: 'node-c' })] };
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

test('manual archive resolves the successful executor of the current image run', async () => {
  let selection;
  const repository = new PostgresControlPlaneRepository({ pool: {
    async query(sql) {
      selection = sql;
      return { rows: [taskRow({ state: 'MANUAL_ARCHIVE', current_execution_id: null,
        copy_executor_node_id: 'copy-a', image_executor_node_id: 'successful-b',
        image_executor_node_name: '最后成功生图机器' })] };
    },
  } });
  const [task] = await repository.listTasks({ state: 'MANUAL_ARCHIVE' });
  assert.equal(task.imageExecutorNodeId, 'successful-b');
  assert.equal(task.imageExecutorNodeName, '最后成功生图机器');
  assert.equal(task.currentExecutionId, null);
  assert.match(selection, /delivered_run.id = page.current_image_run_id/u);
  assert.match(selection, /delivered_run.status = 'COMPLETED'/u);
  assert.match(selection, /successful_image.id = delivered_run.execution_id/u);
  assert.match(selection, /successful_image.task_id = page.id/u);
  assert.match(selection, /successful_image.kind = 'IMAGE' AND successful_image.status = 'SUCCEEDED'/u);
});

test('successful image execution moves the task directly to manual archive', async () => {
  const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
  const queries = [];
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source.includes('FROM task_executions e')) return { rows: [{
        id: executionId,
        task_id: 41,
        kind: 'IMAGE',
        status: 'RUNNING',
        current_execution_id: executionId,
      }] };
      if (source.includes('UPDATE tasks SET')) return { rows: [taskRow({
        state: 'MANUAL_ARCHIVE',
        current_execution_id: null,
        current_stage: 'MANUAL_ARCHIVE',
        progress_percent: 100,
        progress_message: '图片生成完成，等待人工归档',
      })] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  const task = await repository.completeImage(executionId, { images: [] });
  const taskUpdate = queries.find((query) => query.sql.includes('UPDATE tasks SET'));

  assert.equal(task.state, 'MANUAL_ARCHIVE');
  assert.match(taskUpdate.sql, /state = 'MANUAL_ARCHIVE'/u);
  assert.match(taskUpdate.sql, /current_stage = 'MANUAL_ARCHIVE'/u);
  assert.match(taskUpdate.sql, /等待人工归档/u);
  assert.equal(queries.at(-1).sql, 'COMMIT');
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
    aiDisclosureEnabled: false,
  });

  assert.equal(approved.state, 'IMAGE_QUEUED');
  const taskUpdate = queries.find((item) => item.sql.includes("state = 'IMAGE_QUEUED'"));
  assert.ok(taskUpdate);
  assert.match(taskUpdate.sql, /ai_disclosure_enabled = \$3/u);
  assert.equal(taskUpdate.values[2], false);
});

test('non-admin approval without edits creates an automatic-layout revision instead of preserving manual layouts', async () => {
  const queries = [];
  const sourceContent = {
    copy: { title: '标题', body: '正文', tags: ['#标签'] },
    imagePlan: [
      { kind: 'hero', layout: { mode: 'TEMPLATE', template: 'HERO_LEFT' } },
      { kind: 'steps', layout: { mode: 'CUSTOM' } },
      { kind: 'summary' },
    ],
  };
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT') return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) return { rows: [taskRow({ state: 'COPY_REVIEW_PENDING', current_copy_revision_id: 12 })] };
      if (source.includes('SELECT * FROM copy_revisions')) return { rows: [{ id: 12, task_id: 41, revision: 2, content: sourceContent }] };
      if (source.includes('SELECT id FROM executor_nodes')) return { rows: [{ id: 'node-b' }] };
      if (source.includes('MAX(revision)')) return { rows: [{ revision: 3 }] };
      if (source.includes('INSERT INTO copy_revisions')) return { rows: [{ id: 13 }] };
      if (source.includes('UPDATE tasks SET')) return { rows: [taskRow({ state: 'IMAGE_QUEUED', current_copy_revision_id: 13 })] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await repository.approveCopy(41, { revisionId: 12, nodeId: 'node-b' }, { actorRole: 'USER' });
  const saved = queries.find(item => item.sql.includes('INSERT INTO copy_revisions')).values[2];
  assert.deepEqual(saved.imagePlan.map(page => page.layout), [{ mode: 'AUTO' }, { mode: 'AUTO' }, { mode: 'AUTO' }]);
  assert.equal(saved.manualReview.layoutsForcedAutomatic, true);
});

test('executor inventory reports independent copy and image running capacity', async () => {
  let selection;
  const repository = new PostgresControlPlaneRepository({
    pool: {
      async query(sql) {
        selection = String(sql);
        return { rows: [{
          id: 'node-a', name: '执行机 A', image_worker_enabled: true,
          copy_concurrency: 4, image_concurrency: 2, online: true,
          copy_queued_count: 0, copy_running_count: 3, image_running_count: 1,
          last_seen_at: '2026-09-05T01:00:00Z',
        }] };
      },
    },
  });
  const nodes = await repository.listNodes();
  assert.equal(nodes[0].copyRunningCount, 3);
  assert.equal(nodes[0].imageRunningCount, 1);
  assert.equal(nodes[0].copyConcurrency, 4);
  assert.equal(nodes[0].imageConcurrency, 2);
  assert.match(selection, /e\.kind = 'IMAGE' AND e\.status = 'RUNNING'/u);
  assert.match(selection, /t\.state = 'IMAGE_RUNNING'/u);
});

test('copy approval rejects a non-boolean AI disclosure setting before opening a transaction', async () => {
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => { throw new Error('must not connect'); } },
  });
  await assert.rejects(repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-b',
    aiDisclosureEnabled: 'false',
  }), /aiDisclosureEnabled must be a boolean/u);
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
  assert.deepEqual(candidate.values, ['IMAGE_QUEUED', 'node-b', 1]);
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
    return { rows: [{ local_copy: '0', all_copy: '0', copy_review: '2', image_work: '3', manual_archive: '1' }] };
  } } });
  const counts = await repository.taskCounts({ nodeId: 'node-b' });
  assert.equal(counts.copyReview, 2);
  assert.equal(counts.imageWork, 3);
  assert.equal(counts.manualArchive, 1);
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
        return { rows: [taskRow({
          state: 'CANCELLED',
          cancelled_from_state: 'IMAGE_RUNNING',
          current_execution_id: null,
        })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

  const cancelled = await repository.cancelTask(41);

  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.cancelledFromState, 'IMAGE_RUNNING');
  assert.ok(queries.some((item) => item.sql.includes("status = 'ABANDONED'")));
  assert.ok(queries.some((item) => item.sql.includes('UPDATE image_runs SET')));
  assert.ok(queries.some((item) => item.sql.includes('cancelled_from_state = state')));
  assert.ok(queries.some((item) => item.sql.includes("THEN '排队任务已废弃，可由管理员重新加入队列'")));
  assert.equal(queries.some((item) => item.sql.includes('DELETE FROM')), false);
});

test('bulk queue cancellation rechecks queued state inside the task lock', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const source = String(sql);
      queries.push(source);
      if (source.includes('SELECT * FROM tasks WHERE id')) return { rows: [taskRow({ state: 'COPY_RUNNING' })] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  await assert.rejects(repository.cancelTask(41, { queuedOnly: true }), { code: 'INVALID_TASK_STATE' });
  assert.equal(queries.some((sql) => sql.includes('UPDATE tasks SET')), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('a cancelled queued task returns to its original queue exactly once', async () => {
  const queries = [];
  let state = 'CANCELLED';
  let cancelledFromState = 'COPY_QUEUED';
  const client = {
    async query(sql, values) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT') return { rows: [] };
      if (source === 'ROLLBACK') return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        return { rows: [taskRow({ state, cancelled_from_state: cancelledFromState })] };
      }
      if (source.includes('UPDATE tasks SET state = $2')) {
        state = 'COPY_QUEUED';
        cancelledFromState = null;
        return { rows: [taskRow({ state, cancelled_from_state: cancelledFromState })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });

  const task = await repository.requeueCancelledTask(41);

  assert.equal(task.state, 'COPY_QUEUED');
  assert.equal(task.cancelledFromState, null);
  assert.ok(queries.some(({ sql }) => sql.includes('cancelled_from_state = NULL')));
  await assert.rejects(() => repository.requeueCancelledTask(41), { code: 'REQUEUE_UNAVAILABLE' });
});

test('permanent deletion rejects active work and only deletes inactive tasks after preparation', async () => {
  const passwordHash = await hashUserPassword('delete-secret');
  async function run(state, { cancelledFromState = null, cancellationReady = true } = {}) {
    const queries = [];
    const client = {
      async query(sql) {
        const source = String(sql);
        queries.push(source);
        if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
        if (source.includes('SELECT * FROM app_users')) return { rows: [{ username: 'admin', role: 'ADMIN', status: 'ACTIVE', deletion_password_hash: passwordHash }] };
        if (source.includes('SELECT * FROM tasks WHERE id')) {
          return { rows: [taskRow({ state, cancelled_from_state: cancelledFromState })] };
        }
        if (source.includes("updated_at <= now() - interval '3 minutes'")) {
          return { rows: [{ ready: cancellationReady }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
    let prepared = false;
    const operation = repository.permanentlyDeleteTask(41, {
      actorUsername: 'admin', deletionPassword: 'delete-secret', beforeDelete: async () => { prepared = true; },
    });
    return { operation, queries, prepared: () => prepared };
  }

  const running = await run('IMAGE_RUNNING');
  await assert.rejects(running.operation, { code: 'TASK_MUST_BE_INACTIVE' });
  assert.equal(running.prepared(), false);
  assert.equal(running.queries.some(sql => sql.includes('DELETE FROM tasks')), false);

  const settling = await run('CANCELLED', {
    cancelledFromState: 'IMAGE_RUNNING',
    cancellationReady: false,
  });
  await assert.rejects(settling.operation, { code: 'TASK_CANCELLATION_SETTLING' });
  assert.equal(settling.prepared(), false);
  assert.equal(settling.queries.some(sql => sql.includes('DELETE FROM tasks')), false);

  const settled = await run('CANCELLED', {
    cancelledFromState: 'COPY_RUNNING',
    cancellationReady: true,
  });
  assert.deepEqual(await settled.operation, { id: 41 });
  assert.equal(settled.prepared(), true);
  assert.equal(settled.queries.some(sql => sql.includes('DELETE FROM tasks')), true);

  const cancelled = await run('CANCELLED');
  assert.deepEqual(await cancelled.operation, { id: 41 });
  assert.equal(cancelled.prepared(), true);
  assert.equal(cancelled.queries.some(sql => sql.includes('DELETE FROM tasks')), true);
});

test('batch permanent deletion verifies the administrator once and deletes eligible tasks atomically', async () => {
  const passwordHash = await hashUserPassword('delete-secret');
  const queries = [];
  const deleted = [];
  const tasks = new Map([
    [41, taskRow({ state: 'REVIEWED' })],
    [42, taskRow({ state: 'IMAGE_RUNNING' })],
    [44, taskRow({ state: 'CANCELLED', cancelled_from_state: 'COPY_RUNNING' })],
  ]);
  const client = {
    async query(sql, values = []) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (source === 'BEGIN' || source === 'COMMIT' || source === 'ROLLBACK') return { rows: [] };
      if (source.includes('SELECT * FROM app_users')) {
        return { rows: [{ username: 'admin', role: 'ADMIN', status: 'ACTIVE', deletion_password_hash: passwordHash }] };
      }
      if (source.includes('SELECT * FROM tasks WHERE id')) {
        const task = tasks.get(Number(values[0]));
        return { rows: task ? [task] : [] };
      }
      if (source.includes("updated_at <= now() - interval '3 minutes'")) return { rows: [{ ready: false }] };
      if (source.includes('DELETE FROM tasks WHERE id')) {
        deleted.push(Number(values[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  const prepared = [];

  const result = await repository.permanentlyDeleteTasks([41, 42, 43, 44, 41], {
    actorUsername: 'admin',
    deletionPassword: 'delete-secret',
    beforeDelete: async (taskId) => { prepared.push(taskId); },
  });

  assert.deepEqual(result, {
    succeeded: [41],
    failed: [
      { id: 42, code: 'TASK_MUST_BE_INACTIVE', message: '请先废弃排队任务或等待任务结束，再永久删除' },
      { id: 43, code: 'NOT_FOUND', message: 'task not found' },
      { id: 44, code: 'TASK_CANCELLATION_SETTLING', message: '执行机仍在确认取消，请在取消后等待3分钟再永久删除' },
    ],
  });
  assert.equal(queries.filter(({ sql }) => sql.includes('SELECT * FROM app_users')).length, 1);
  assert.deepEqual(prepared, [41]);
  assert.deepEqual(deleted, [41]);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});
