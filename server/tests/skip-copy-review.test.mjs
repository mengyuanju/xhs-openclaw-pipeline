import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

async function withServer(action) {
  const calls = [];
  const roles = { admin: 'ADMIN', reviewer: 'REVIEWER', user: 'USER' };
  const repository = {
    getUserByUsername: async username => ({ username, role: roles[username], status: 'ACTIVE', credentialVersion: 1 }),
    createTasks: async input => { calls.push(input); return [{ id: 1 }]; },
  };
  const server = createControlPlaneApp({ repository, storageRoot: 'test-storage' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const create = (username, fields, role = roles[username]) => fetch(`http://127.0.0.1:${server.address().port}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Actor-Username': username,
      'X-Actor-Role': role, 'X-Actor-Credential-Version': '1' },
    body: JSON.stringify({ nodeId: 'node-a', tasks: [{ query: '桌面收纳' }, { query: '书架收纳' }], ...fields }),
  });
  try { await action(create, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('only authenticated administrators can enable copy review bypass for a batch', async () => {
  await withServer(async (create, calls) => {
    for (const username of ['user', 'reviewer']) {
      assert.equal((await create(username, { skipCopyReview: true })).status, 403);
    }
    assert.equal((await create('user', { skipCopyReview: true }, 'ADMIN')).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await create('admin', { skipCopyReview: true, createdByUserId: 'someone-else' })).status, 201);
    assert.equal(calls[0].skipCopyReview, true);
    assert.equal(calls[0].createdByUserId, 'admin');
    assert.equal(calls[0].tasks.length, 2);
  });
});

test('omitted or disabled bypass preserves manual review for every role', async () => {
  await withServer(async (create, calls) => {
    for (const username of ['admin', 'reviewer', 'user']) {
      for (const fields of [{}, { skipCopyReview: false }]) {
        assert.equal((await create(username, fields)).status, 201);
        assert.equal(calls.at(-1).skipCopyReview, false);
      }
    }
  });
});

test('copy review bypass accepts only a boolean', async () => {
  await withServer(async (create, calls) => {
    for (const skipCopyReview of ['true', 'false', 1, null, {}]) {
      assert.equal((await create('admin', { skipCopyReview })).status, 400);
    }
    assert.equal(calls.length, 0);
  });
});

test('task creation persists the batch policy separately from untrusted task input', async () => {
  for (const skipCopyReview of [true, false]) {
    const inserts = [];
    const client = {
      async query(sql, values) {
        if (sql.includes('SELECT username FROM app_users')) return { rows: [{ username: 'admin' }] };
        if (!sql.includes('INSERT INTO tasks')) return { rows: [] };
        inserts.push(values);
        return { rows: [{ id: inserts.length, query: values[0], input: values[1],
          requested_image_count: values[2], created_by_node_id: values[3], created_by_user_id: values[4],
          skip_copy_review: values[5], state: 'COPY_QUEUED', current_copy_revision_id: null }] };
      },
      release() {},
    };
    const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
    const tasks = await repository.createTasks({ nodeId: 'node-a', createdByUserId: 'admin', skipCopyReview,
      tasks: [{ query: '一', input: { skipCopyReview: !skipCopyReview } }, { query: '二' }] });
    assert.deepEqual(tasks.map(task => task.skipCopyReview), [skipCopyReview, skipCopyReview]);
    assert.equal(inserts[0][1].skipCopyReview, !skipCopyReview);
  }
});

test('repository rejects malformed bypass flags before writing tasks', async () => {
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => assert.fail('must not connect') } });
  await assert.rejects(repository.createTasks({ nodeId: 'node-a', tasks: [{ query: '一' }], skipCopyReview: 'true' }),
    /skipCopyReview must be a boolean/u);
});

const executionId = '47d841f5-3808-46f0-9f2a-fa9781379b38';
const validCopy = {
  reviewed: {
    copy: { title: '桌面整理', body: '整理桌面。'.repeat(90), tags: ['#收纳', '#桌面', '#整理'] },
    imagePlan: Array.from({ length: 3 }, (_, index) => ({ kind: index ? 'steps' : 'hero',
      headline: '整理桌面', subtitle: '物品分区摆放', bullets: ['清理杂物', '整理线材'], prompt: '明亮整洁的桌面，展示物品分区收纳。' })),
  },
};

function completionRepository({ skipCopyReview = false, failQueue = false, stale = false } = {}) {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM task_executions e')) return { rows: [{ id: executionId, task_id: 41, kind: 'COPY',
        status: stale ? 'SUCCEEDED' : 'RUNNING', current_execution_id: executionId, task_state: 'COPY_RUNNING',
        skip_copy_review: skipCopyReview, created_by_node_id: 'node-a', ai_disclosure_enabled: true }] };
      if (sql.includes('MAX(revision)')) return { rows: [{ revision: 1 }] };
      if (sql.includes('INSERT INTO copy_revisions')) return { rows: [{ id: 12, task_id: 41, execution_id: executionId,
        revision: 1, content: values[3], approved_at: values[4] ? new Date() : null,
        approved_by_node_id: values[4] ? values[5] : null, approval_mode: values[4] ? 'ADMIN_BYPASS' : null }] };
      if (sql.includes('UPDATE tasks SET')) {
        const queued = sql.includes("state = 'IMAGE_QUEUED'");
        if (queued && failQueue) throw new Error('simulated queue write failure');
        return { rows: [{ id: 41, state: queued ? 'IMAGE_QUEUED' : 'COPY_REVIEW_PENDING',
          skip_copy_review: skipCopyReview, current_copy_revision_id: 12 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { queries, repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

test('bypassed copy is approved and queued atomically using its creator node', async () => {
  const { repository, queries } = completionRepository({ skipCopyReview: true });
  const { task, revision } = await repository.completeCopy(executionId, validCopy);
  assert.equal(task.state, 'IMAGE_QUEUED');
  assert.equal(revision.approvalMode, 'ADMIN_BYPASS');
  assert.ok(revision.approvedAt);
  assert.equal(revision.approvedByNodeId, 'node-a');
  assert.deepEqual(revision.content, validCopy);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.ok(queries.some(({ values }) => values?.includes('管理员免审核，等待图片执行机领取')));
});

test('model-supplied bypass flags cannot bypass manual review', async () => {
  const { repository } = completionRepository();
  const { task, revision } = await repository.completeCopy(executionId, { ...validCopy,
    skipCopyReview: true, approvalMode: 'ADMIN_BYPASS', input: { skipCopyReview: true } });
  assert.equal(task.state, 'COPY_REVIEW_PENDING');
  assert.equal(revision.approvedAt, null);
  assert.equal(revision.approvalMode, null);
});

test('invalid copy stays available for manual review even when bypass was selected', async () => {
  const { repository, queries } = completionRepository({ skipCopyReview: true });
  const { task, revision } = await repository.completeCopy(executionId, { reviewed: { copy: { title: '不完整' } } });
  assert.equal(task.state, 'COPY_REVIEW_PENDING');
  assert.equal(revision.approvedAt, null);
  assert.ok(queries.some(({ values }) => values?.some(value => typeof value === 'string' && value.includes('文案格式校验未通过'))));
});

test('queue failure rolls back the bypass approval and completion', async () => {
  const { repository, queries } = completionRepository({ skipCopyReview: true, failQueue: true });
  await assert.rejects(repository.completeCopy(executionId, validCopy), /simulated queue write failure/u);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(queries.some(({ sql }) => sql === 'COMMIT'), false);
});

test('duplicate or stale copy completion cannot enqueue another image job', async () => {
  const { repository, queries } = completionRepository({ skipCopyReview: true, stale: true });
  await assert.rejects(repository.completeCopy(executionId, validCopy), error => error.code === 'STALE_EXECUTION');
  assert.equal(queries.some(({ sql }) => /\b(?:INSERT|UPDATE)\b/u.test(sql) && !sql.includes('FOR UPDATE')), false);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});
