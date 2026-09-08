import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { ControlPlaneAuthenticationError, ControlPlaneConflictError } from '../src/domain.mjs';

async function withServer(repository, action, { storageRoot = 'test-storage', enforceUserAuth = false } = {}) {
  const app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth });
  let server;
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('batch claim routes forward request identity and return independent claims', async () => {
  for (const kind of ['copy', 'image']) {
    const input = { nodeId: 'node-a', limit: 3, requestId: 'request' };
    const method = kind === 'copy' ? 'claimCopyBatch' : 'claimImageBatch';
    await withServer({ [method]: async (body) => {
      assert.deepEqual(body, input);
      return { requestId: body.requestId, claims: [] };
    } }, async (root) => {
      const response = await fetch(`${root}/v1/executions/claim-${kind}-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { requestId: 'request', claims: [] });
    });
  }
});

test('failure HTTP route forwards optional retry control without changing legacy calls', async () => {
  const calls = [];
  await withServer({ failExecution: async (...args) => { calls.push(args); return { state: 'IMAGE_FAILED' }; } }, async (root) => {
    const response = await fetch(`${root}/v1/executions/test/fail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'outcome unknown', autoRetry: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['test', 'outcome unknown', { autoRetry: false }]]);
  });
});

test('model trace HTTP routes forward execution uploads and task-scoped lazy reads', async () => {
  const calls = [];
  const repository = {
    recordModelCall: async (...args) => { calls.push(args); return { id: args[1] }; },
    listModelCalls: async (...args) => { calls.push(args); return { items: [], total: 0 }; },
    getModelCall: async (...args) => { calls.push(args); return { prompt: 'actual prompt', response: 'raw result' }; },
  };
  await withServer(repository, async (root) => {
    const upload = await fetch(`${root}/v1/executions/exec/model-calls/call`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence: 1 }),
    });
    assert.equal(upload.status, 200);
    const page = await fetch(`${root}/v1/tasks/1/model-calls?limit=20&offset=40`);
    assert.deepEqual((await page.json()).data, { items: [], total: 0 });
    const detail = await fetch(`${root}/v1/tasks/1/model-calls/call`);
    assert.equal((await detail.json()).data.response, 'raw result');
  });
  assert.deepEqual(calls, [['exec', 'call', { sequence: 1 }], ['1', { limit: '20', offset: '40' }], ['1', 'call']]);
});

test('only administrators can read model traces, including traces of a users own task', async () => {
  const roles = { admin: 'ADMIN', reviewer: 'REVIEWER', user: 'USER' };
  const ids = { admin: 1, reviewer: 2, user: 3 };
  let traceReads = 0;
  const repository = {
    getUserByUsername: async (username) => ({ id: ids[username], username, role: roles[username], status: 'ACTIVE', credentialVersion: 1 }),
    getTaskAccess: async () => ({ id: 1, state: 'COPY_REVIEW_PENDING', createdByUserId: 'user',
      createdByAccountId: 3, assignedToUserId: 'user', assignedToAccountId: 3 }),
    getTask: async () => ({ id: 1, createdByUserId: 'user', query: 'reviewable task',
      executions: [{ id: 'exec', snapshot: { prompts: 'private execution configuration' } }] }),
    listModelCalls: async () => { traceReads++; return { items: [{ id: 'call' }], total: 1 }; },
    getModelCall: async () => { traceReads++; return { id: 'call', prompt: 'private prompt', response: 'private response' }; },
  };
  await withServer(repository, async (root) => {
    for (const [username, role] of Object.entries(roles)) {
      const response = await fetch(`${root}/v1/tasks/1`, { headers: {
        'X-Actor-User-Id': String(ids[username]), 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1',
      } });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.equal(data.query, 'reviewable task');
      assert.equal('executions' in data, role === 'ADMIN', 'task details must also protect execution snapshots');
    }
    for (const suffix of ['', '/call']) {
      for (const [username, role] of Object.entries(roles)) {
        const response = await fetch(`${root}/v1/tasks/1/model-calls${suffix}`, { headers: {
          'X-Actor-User-Id': String(ids[username]), 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1',
        } });
        assert.equal(response.status, role === 'ADMIN' ? 200 : 403, `${role} ${suffix || 'list'}`);
        const body = await response.json();
        if (role !== 'ADMIN') {
          assert.equal(body.error.code, 'FORBIDDEN');
          assert.equal(body.data, undefined);
        }
      }
      const anonymous = await fetch(`${root}/v1/tasks/1/model-calls${suffix}`);
      assert.equal(anonymous.status, 401);
    }
  }, { enforceUserAuth: true });
  assert.equal(traceReads, 2, 'denied requests must not read model trace data');
});

test('control plane HTTP exposes node registration and batched task creation', async () => {
  const calls = [];
  const repository = {
    registerNode: async (input) => { calls.push(['node', input]); return { id: input.nodeId }; },
    listNodes: async () => [{ id: 'node-b', name: 'Node B', online: true }],
    createTasks: async (input) => { calls.push(['tasks', input]); return [{ id: 1, state: 'COPY_QUEUED' }]; },
  };
  await withServer(repository, async (root) => {
    const registered = await fetch(`${root}/v1/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-a', imageWorkerEnabled: false }),
    });
    assert.equal(registered.status, 200);
    const nodes = await fetch(`${root}/v1/nodes`);
    assert.deepEqual((await nodes.json()).data, [{ id: 'node-b', name: 'Node B', online: true }]);
    const created = await fetch(`${root}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-a',
        tasks: [{ query: '选题' }],
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).data, [{ id: 1, state: 'COPY_QUEUED' }]);
  });
  assert.deepEqual(calls.map(([name]) => name), ['node', 'tasks']);
  assert.equal('copyExecutorNodeId' in calls[1][1], false);
  assert.equal(calls[1][1].assignedToUserId, null);
  assert.equal(calls[1][1].assignedToAccountId, null);
  assert.equal(calls[1][1].assignmentSource, null);
});

test('normal task creation delays assignment while copy-review bypass requires an explicit owner', async () => {
  const calls = [];
  const users = {
    admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  };
  const repository = {
    getUserByUsername: async (username) => users[username] ?? null,
    createTasks: async (input) => { calls.push(input); return [{ id: calls.length, ...input }]; },
  };
  const headers = (username, role) => ({
    'Content-Type': 'application/json',
    'X-Actor-User-Id': String(users[username].id),
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': '1',
  });
  await withServer(repository, async (root) => {
    const userCreated = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: headers('alice', 'USER'),
      body: JSON.stringify({ nodeId: 'node-a', tasks: [{ query: '普通用户提交' }] }),
    });
    assert.equal(userCreated.status, 201);

    const earlyAssignment = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: headers('admin', 'ADMIN'),
      body: JSON.stringify({ nodeId: 'node-a', assignedToUserId: 'alice', assignedToAccountId: 2,
        tasks: [{ query: '不能提前派单' }] }),
    });
    assert.equal(earlyAssignment.status, 409);
    assert.equal((await earlyAssignment.json()).error.code, 'TASK_NOT_READY_FOR_ASSIGNMENT');

    const missingBypassOwner = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: headers('admin', 'ADMIN'),
      body: JSON.stringify({ nodeId: 'node-a', skipCopyReview: true, tasks: [{ query: '免审未指定' }] }),
    });
    assert.equal(missingBypassOwner.status, 409);
    assert.equal((await missingBypassOwner.json()).error.code, 'SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED');

    const bypass = await fetch(`${root}/v1/tasks`, {
      method: 'POST', headers: headers('admin', 'ADMIN'),
      body: JSON.stringify({ nodeId: 'node-a', skipCopyReview: true,
        assignedToUserId: 'admin', assignedToAccountId: 1, tasks: [{ query: '管理员自领免审' }] }),
    });
    assert.equal(bypass.status, 201);
  }, { enforceUserAuth: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].createdByUserId, 'alice');
  assert.equal(calls[0].assignedToUserId, null);
  assert.equal(calls[0].assignmentSource, null);
  assert.equal(calls[1].assignedToUserId, 'admin');
  assert.equal(calls[1].assignedToAccountId, 1);
  assert.equal(calls[1].assignmentSource, 'MANUAL');
  assert.equal(calls[1].skipCopyReview, true);
});

test('executor status inventory and retirement are restricted to administrators', async () => {
  const nodes = [{ id: 'node-a', online: true, imageRunningCount: 1 }];
  const retired = [];
  const repository = {
    listNodes: async () => nodes,
    retireNode: async (nodeId, actor) => {
      retired.push({ nodeId, actor });
      return { id: nodeId, name: '执行机 A', retiredAt: '2026-09-09T00:00:00Z' };
    },
    getUserByUsername: async (username) => ({
      id: username === 'admin' ? 1 : 2,
      username,
      role: username === 'admin' ? 'ADMIN' : 'REVIEWER',
      status: 'ACTIVE',
      credentialVersion: 1,
    }),
  };
  const headers = (username, role) => ({
    'X-Actor-User-Id': String(username === 'admin' ? 1 : 2),
    'X-Actor-Username': username,
    'X-Actor-Role': role,
    'X-Actor-Credential-Version': '1',
  });
  await withServer(repository, async (root) => {
    const admin = await fetch(`${root}/v1/executor-statuses`, { headers: headers('admin', 'ADMIN') });
    assert.equal(admin.status, 200);
    assert.deepEqual((await admin.json()).data, nodes);
    const reviewer = await fetch(`${root}/v1/executor-statuses`, { headers: headers('reviewer', 'REVIEWER') });
    assert.equal(reviewer.status, 403);
    assert.equal((await reviewer.json()).error.code, 'FORBIDDEN');

    const deniedDelete = await fetch(`${root}/v1/executor-statuses`, {
      method: 'DELETE', headers: headers('reviewer', 'REVIEWER'),
    });
    assert.equal(deniedDelete.status, 403);
    assert.deepEqual(retired, []);

    const deleted = await fetch(`${root}/v1/executor-statuses`, {
      method: 'DELETE',
      headers: { ...headers('admin', 'ADMIN'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: '..' }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).data.id, '..');
    assert.deepEqual(retired, [{
      nodeId: '..',
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
  }, { enforceUserAuth: true });
});

test('control plane HTTP returns a structured stale execution conflict', async () => {
  const repository = {
    updateProgress: async () => {
      throw new ControlPlaneConflictError('STALE_EXECUTION', 'execution was replaced');
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(
      `${root}/v1/executions/d9428888-122b-11e1-b85c-61cd3cbb3210/progress`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'RESEARCH', progressPercent: 20 }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: { code: 'STALE_EXECUTION', message: 'execution was replaced' },
    });
  });
});

test('copy approval forwards the editable review payload as one operation', async () => {
  let received;
  const repository = {
    approveCopy: async (taskId, input, actor) => {
      received = { taskId, input, actor };
      return { id: Number(taskId), state: 'IMAGE_QUEUED' };
    },
  };
  const edits = {
    copy: { title: '标题', body: '正文', tags: ['#标签'] },
    imagePlan: [{ kind: 'hero' }],
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/7/approve-copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionId: 12, nodeId: 'node-a', edits, aiDisclosureEnabled: false,
      decision: 'APPROVE', originalScore: 2, originalReasons: ['STRUCTURE'], score: 2.5,
      reasons: ['EXPRESSION'], reviewSessionId: '77777777-7777-4777-8777-777777777777' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.state, 'IMAGE_QUEUED');
  });
  assert.deepEqual(received, {
    taskId: '7',
    input: { revisionId: 12, nodeId: 'node-a', edits, aiDisclosureEnabled: false,
      decision: 'APPROVE', originalScore: 2, originalReasons: ['STRUCTURE'], score: 2.5,
      reasons: ['EXPRESSION'], reviewSessionId: '77777777-7777-4777-8777-777777777777' },
    actor: { actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } },
  });
});

test('session actor identity requires the current immutable positive user id', async () => {
  const current = {
    id: 9, username: 'reused-reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1,
  };
  const repository = {
    getUserByUsername: async (username) => username === current.username ? current : null,
    listTasks: async () => [],
  };
  const baseHeaders = {
    'X-Actor-Username': current.username,
    'X-Actor-Role': current.role,
    'X-Actor-Credential-Version': '1',
  };
  await withServer(repository, async (root) => {
    const accepted = await fetch(`${root}/v1/tasks`, {
      headers: { ...baseHeaders, 'X-Actor-User-Id': String(current.id) },
    });
    assert.equal(accepted.status, 200);

    for (const staleUserId of [undefined, '0', '1.5', '9007199254740992', '4']) {
      const headers = { ...baseHeaders };
      if (staleUserId !== undefined) headers['X-Actor-User-Id'] = staleUserId;
      const rejected = await fetch(`${root}/v1/tasks`, { headers });
      assert.equal(rejected.status, 401, `user id ${String(staleUserId)} must be rejected`);
      assert.equal((await rejected.json()).error.code, 'SESSION_STALE');
    }
  }, { enforceUserAuth: true });
});

test('an in-flight task read cannot cross into a same-name replacement account', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let current = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    getUserByUsername: async () => current,
    getUserByIdentity: async (actor) => current.id === actor.userId
      && current.username === actor.username
      && current.role === actor.role
      && current.credentialVersion === actor.credentialVersion
      ? current : null,
    listTasks: async () => {
      entered.resolve();
      await release.promise;
      return [{ id: 91, query: 'replacement account secret', assignedToUserId: 'alice' }];
    },
  };
  await withServer(repository, async (root) => {
    const pending = fetch(`${root}/v1/tasks`, {
      headers: {
        'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice',
        'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '1',
      },
    });
    await entered.promise;
    current = { ...current, id: 9 };
    release.resolve();
    const response = await pending;
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, 'SESSION_STALE');
    assert.doesNotMatch(JSON.stringify(payload), /replacement account secret/u);
  }, { enforceUserAuth: true });
});

test('an in-flight HEAD task read also rechecks the immutable account identity', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let current = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    getUserByUsername: async () => current,
    getUserByIdentity: async (actor) => current.id === actor.userId ? current : null,
    listTasks: async () => {
      entered.resolve();
      await release.promise;
      return [{ id: 92, query: 'replacement account secret', assignedToUserId: 'alice' }];
    },
  };
  await withServer(repository, async (root) => {
    const pending = fetch(`${root}/v1/tasks`, {
      method: 'HEAD',
      headers: {
        'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice',
        'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '1',
      },
    });
    await entered.promise;
    current = { ...current, id: 9 };
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }, { enforceUserAuth: true });
});

test('manual image retry route sends the task back to the image queue', async () => {
  let receivedTaskId;
  await withServer({
    requeueImageTask: async (taskId) => {
      receivedTaskId = taskId;
      return { id: Number(taskId), state: 'IMAGE_QUEUED' };
    },
  }, async (root) => {
    const response = await fetch(`${root}/v1/tasks/9/retry-image`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.state, 'IMAGE_QUEUED');
  });
  assert.equal(receivedTaskId, '9');
});

test('manual archive download returns one ZIP with copy text and original image names', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-task-archive-http-'));
  const storagePath = join(storageRoot, 'tasks', '12', 'image-runs', 'run-1', 'stored-hash.png');
  await mkdir(join(storageRoot, 'tasks', '12', 'image-runs', 'run-1'), { recursive: true });
  await writeFile(storagePath, Buffer.from('png-content'));
  const task = {
    id: 12,
    state: 'MANUAL_ARCHIVE',
    createdByUserId: 'admin',
    currentCopyRevisionId: 2,
    currentImageRunId: 'run-1',
    copyRevisions: [{ id: 2, content: { copy: { title: '归档任务', body: '文案正文', tags: ['#标签'] } } }],
    assets: [{ id: 7, taskId: 12, imageRunId: 'run-1', mediaType: 'image/png', originalName: '01-cover.png' }],
  };
  try {
    await withServer({
      getTask: async () => task,
      getAsset: async () => ({
        id: 7,
        taskId: 12,
        imageRunId: 'run-1',
        mediaType: 'image/png',
        originalName: '01-cover.png',
        storagePath,
      }),
    }, async (root) => {
      for (const state of ['MANUAL_ARCHIVE', 'REVIEWED']) {
        task.state = state;
        const response = await fetch(`${root}/v1/tasks/12/archive`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/zip');
        assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/u);
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        assert.ok(zip.file('归档任务.txt'));
        assert.equal(await zip.file('01-cover.png').async('string'), 'png-content');
      }
    }, { storageRoot });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('task listing forwards server-side pagination, states and Query search', async () => {
  const calls = [];
  const repository = {
    listTasks: async (input) => {
      calls.push(['list', input]);
      return { items: [], total: 0, limit: 20, offset: 20 };
    },
    taskCounts: async (input) => {
      calls.push(['counts', input]);
      return { allCopy: 3 };
    },
  };
  await withServer(repository, async (root) => {
    const listed = await fetch(`${root}/v1/tasks?states=COPY_QUEUED,COPY_FAILED&nodeId=node-a&taskId=42&query=%E9%BB%84%E5%B1%B1&deduplicateQuery=true&sortBy=createdAt&sortOrder=asc&limit=20&offset=20&includeTotal=true`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).data.total, 0);
    const counts = await fetch(`${root}/v1/task-counts?nodeId=node-a`);
    assert.equal((await counts.json()).data.allCopy, 3);
  });
  assert.deepEqual(calls, [
    ['list', {
      state: undefined,
      states: 'COPY_QUEUED,COPY_FAILED',
      nodeId: 'node-a',
      taskId: '42',
      query: '黄山',
      deduplicateQuery: true,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      createdByUserId: undefined,
      createdByAccountId: undefined,
      assignedToUserId: undefined,
      visibleToUserId: undefined,
      visibleToAccountId: undefined,
      unassignedOnly: false,
      excludeUnassigned: false,
      limit: '20',
      offset: '20',
      includeTotal: true,
    }],
    ['counts', { nodeId: 'node-a' }],
  ]);
});

test('personal task scope is bound to the authenticated account and includes submitted work', async () => {
  const calls = [];
  const user = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    getUserByUsername: async (username) => username === user.username ? user : null,
    listTasks: async (input) => { calls.push(input); return { items: [], total: 0, limit: 20, offset: 0 }; },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks?personal=true&states=COPY_QUEUED,COPY_REVIEW_PENDING&limit=20&includeTotal=true`, {
      headers: {
        'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice', 'X-Actor-Role': 'USER',
        'X-Actor-Credential-Version': '1',
      },
    });
    assert.equal(response.status, 200);
  }, { enforceUserAuth: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].assignedToUserId, undefined);
  assert.equal(calls[0].visibleToUserId, 'alice');
  assert.equal(calls[0].visibleToAccountId, 2);
  assert.equal(calls[0].excludeUnassigned, false);
});

test('an unassigned task creator can read and cancel machine work without gaining review access', async () => {
  const users = {
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    bob: { id: 3, username: 'bob', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  };
  let approvalCalls = 0;
  let cancellationCalls = 0;
  let retryCalls = 0;
  const access = {
    id: 41, state: 'COPY_QUEUED', createdByUserId: 'alice', createdByAccountId: 2, assignedToUserId: null,
  };
  const repository = {
    getUserByUsername: async (username) => users[username] ?? null,
    getTaskAccess: async () => access,
    getTask: async () => ({ ...access, query: '机器正在生成', executions: [{ snapshot: { private: true } }] }),
    approveCopy: async () => { approvalCalls++; return access; },
    cancelTask: async () => { cancellationCalls++; return { ...access, state: 'CANCELLED' }; },
    retryTask: async () => { retryCalls++; return { ...access, state: 'COPY_QUEUED' }; },
  };
  const headers = (username) => ({
    'X-Actor-User-Id': String(users[username].id), 'X-Actor-Username': username,
    'X-Actor-Role': 'USER', 'X-Actor-Credential-Version': '1',
  });
  await withServer(repository, async (root) => {
    const readable = await fetch(`${root}/v1/tasks/41`, { headers: headers('alice') });
    assert.equal(readable.status, 200);
    const body = await readable.json();
    assert.equal(body.data.query, '机器正在生成');
    assert.equal('executions' in body.data, false);

    const cancelled = await fetch(`${root}/v1/tasks/41/cancel`, {
      method: 'POST', headers: { ...headers('alice'), 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).data.state, 'CANCELLED');

    access.state = 'COPY_RUNNING';
    const retried = await fetch(`${root}/v1/tasks/41/retry`, {
      method: 'POST', headers: { ...headers('alice'), 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).data.state, 'COPY_QUEUED');

    access.state = 'COPY_REVIEW_PENDING';
    const cannotCancelReview = await fetch(`${root}/v1/tasks/41/cancel`, {
      method: 'POST', headers: { ...headers('alice'), 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(cannotCancelReview.status, 403);

    assert.equal((await fetch(`${root}/v1/tasks/41`, { headers: headers('bob') })).status, 403);
    const cannotReview = await fetch(`${root}/v1/tasks/41/approve-copy`, {
      method: 'POST', headers: { ...headers('alice'), 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(cannotReview.status, 403);
  }, { enforceUserAuth: true });
  assert.equal(approvalCalls, 0);
  assert.equal(cancellationCalls, 1);
  assert.equal(retryCalls, 1);
});

test('a same-name replacement account cannot inherit an existing task assignment', async () => {
  const user = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  let fullReads = 0;
  let cancellationCalls = 0;
  const repository = {
    getUserByUsername: async () => user,
    getTaskAccess: async () => ({
      id: 42,
      state: 'COPY_RUNNING',
      createdByUserId: 'bob',
      createdByAccountId: 3,
      assignedToUserId: 'alice',
      assignedToAccountId: 99,
    }),
    getTask: async () => { fullReads++; return null; },
    cancelTask: async () => { cancellationCalls++; return null; },
  };
  const headers = {
    'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice', 'X-Actor-Role': 'USER',
    'X-Actor-Credential-Version': '1',
  };
  await withServer(repository, async (root) => {
    assert.equal((await fetch(`${root}/v1/tasks/42`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/v1/tasks/42/cancel`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}',
    })).status, 403);
  }, { enforceUserAuth: true });
  assert.equal(fullReads, 0);
  assert.equal(cancellationCalls, 0);
});

test('task detail authorization is rechecked after a concurrent reassignment', async () => {
  const user = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  let accessReads = 0;
  const repository = {
    getUserByUsername: async () => user,
    getTaskAccess: async () => (++accessReads === 1
      ? { id: 43, state: 'COPY_REVIEW_PENDING', createdByUserId: 'admin', createdByAccountId: 1,
          assignedToUserId: 'alice', assignedToAccountId: 2 }
      : { id: 43, state: 'COPY_REVIEW_PENDING', createdByUserId: 'admin', createdByAccountId: 1,
          assignedToUserId: 'bob', assignedToAccountId: 3 }),
    getTask: async () => ({ id: 43, query: '改派期间的任务内容', assignedToUserId: 'bob', executions: [] }),
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/43`, { headers: {
      'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice', 'X-Actor-Role': 'USER',
      'X-Actor-Credential-Version': '1',
    } });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /改派期间的任务内容/u);
  }, { enforceUserAuth: true });
  assert.equal(accessReads, 2);
});

test('non-admin task access fails closed when immutable account ids are unavailable', async () => {
  const user = { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 };
  const repository = {
    getUserByUsername: async () => user,
    getTask: async () => ({ id: 44, state: 'COPY_REVIEW_PENDING', createdByUserId: 'alice',
      assignedToUserId: 'alice', query: '缺少稳定身份的任务', executions: [] }),
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/44`, { headers: {
      'X-Actor-User-Id': '2', 'X-Actor-Username': 'alice', 'X-Actor-Role': 'USER',
      'X-Actor-Credential-Version': '1',
    } });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /缺少稳定身份的任务/u);
  }, { enforceUserAuth: true });
});

test('task ownership comes from the UI server identity and is forwarded to task filtering', async () => {
  const calls = [];
  await withServer({
    createTasks: async (input) => { calls.push(input); return []; },
    listTasks: async (input) => { calls.push(input); return []; },
  }, async (root) => {
    const created = await fetch(`${root}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Task-Creator-Id': 'admin' },
      body: JSON.stringify({ nodeId: 'node-a', createdByUserId: 'forged', tasks: [{ query: '我的任务' }] }),
    });
    assert.equal(created.status, 201);
    const listed = await fetch(`${root}/v1/tasks?createdByUserId=admin&createdByAccountId=1&includeTotal=true`);
    assert.equal(listed.status, 200);
  });
  assert.equal(calls[0].createdByUserId, 'admin');
  assert.equal(calls[1].createdByUserId, 'admin');
  assert.equal(calls[1].createdByAccountId, '1');
  assert.equal(calls[1].nodeId, undefined);
});

test('task cancellation is exposed as a logical-delete operation', async () => {
  let cancelledTaskId;
  const repository = {
    cancelTask: async (taskId) => {
      cancelledTaskId = taskId;
      return { id: Number(taskId), state: 'CANCELLED' };
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/7/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.state, 'CANCELLED');
  });
  assert.equal(cancelledTaskId, '7');
});

test('administrator batch archive returns one outer ZIP for selected deliverables', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-task-batch-archive-http-'));
  const tasks = new Map();
  const assets = new Map();
  try {
    for (const id of [12, 13]) {
      const storagePath = join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`, 'image.png');
      await mkdir(join(storageRoot, 'tasks', String(id), 'image-runs', `run-${id}`), { recursive: true });
      await writeFile(storagePath, `image-${id}`);
      tasks.set(id, {
        id, state: 'REVIEWED', currentCopyRevisionId: 1, currentImageRunId: `run-${id}`,
        copyRevisions: [{ id: 1, content: { copy: { title: `任务${id}`, body: '正文', tags: [] } } }],
        imageRuns: [], assets: [{ id, taskId: id, imageRunId: `run-${id}`, mediaType: 'image/png', originalName: '图片.png' }],
      });
      assets.set(id, { id, taskId: id, mediaType: 'image/png', originalName: '图片.png', storagePath });
    }
    await withServer({
      getTask: async (id) => tasks.get(Number(id)),
      getAsset: async (id) => assets.get(Number(id)),
    }, async (root) => {
      const response = await fetch(`${root}/v1/tasks/batch-archive`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskIds: [12, 13] }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /task-resources-batch\.zip/u);
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      assert.deepEqual(Object.keys(zip.files).sort(), ['任务-12-资源包.zip', '任务-13-资源包.zip']);
    }, { storageRoot });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('administrator batch actions retry only retryable work and report per-task conflicts', async () => {
  const calls = [];
  const tasks = new Map([
    [1, { id: 1, state: 'COPY_FAILED' }],
    [2, { id: 2, state: 'IMAGE_RUNNING' }],
    [3, { id: 3, state: 'REVIEWED' }],
    [4, { id: 4, state: 'COPY_QUEUED' }],
  ]);
  const repository = {
    getTaskActionSummary: async (taskId) => tasks.get(taskId),
    retryTask: async (...args) => { calls.push(['copy', ...args]); },
    requeueImageTask: async (...args) => { calls.push(['image', ...args]); },
    cancelTask: async (...args) => { calls.push(['cancel', ...args]); },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/batch-actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'RETRY', taskIds: [1, 2, 3, 2] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      action: 'RETRY', succeeded: [1, 2],
      failed: [{ id: 3, code: 'INVALID_TASK_STATE', message: 'only running or failed work can be retried in bulk' }],
    });
    const cancel = await fetch(`${root}/v1/tasks/batch-actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'CANCEL_QUEUE', taskIds: [4, 1] }),
    });
    assert.deepEqual((await cancel.json()).data, {
      action: 'CANCEL_QUEUE', succeeded: [4],
      failed: [{ id: 1, code: 'INVALID_TASK_STATE', message: 'only queued work can be cancelled in bulk' }],
    });
  });
  assert.deepEqual(calls, [
    ['copy', 1, { useLatestConfig: true,
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
    ['image', 2, { retryOnly: true,
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
    ['cancel', 4, { queuedOnly: true,
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
  ]);
});

test('batch actions stop and return 401 when the actor becomes stale', async () => {
  const calls = [];
  const repository = {
    getTaskActionSummary: async (taskId) => {
      calls.push(['read', taskId]);
      return { id: taskId, state: 'COPY_FAILED' };
    },
    retryTask: async (taskId) => {
      calls.push(['retry', taskId]);
      throw new ControlPlaneAuthenticationError();
    },
  };
  await withServer(repository, async (root) => {
    const response = await fetch(`${root}/v1/tasks/batch-actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'RETRY', taskIds: [1, 2] }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual((await response.json()).error, {
      code: 'SESSION_STALE', message: '账号状态已变化，请重新登录',
    });
  });
  assert.deepEqual(calls, [['read', 1], ['retry', 1]]);
});

test('administrator batch permanent deletion removes eligible task storage and reports skipped tasks', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-batch-permanent-delete-'));
  const deletedFile = join(storageRoot, 'tasks', '7', 'image.png');
  const retainedFile = join(storageRoot, 'tasks', '8', 'image.png');
  await mkdir(join(storageRoot, 'tasks', '7'), { recursive: true });
  await mkdir(join(storageRoot, 'tasks', '8'), { recursive: true });
  await writeFile(deletedFile, 'delete-me');
  await writeFile(retainedFile, 'keep-me');
  const repository = {
    permanentlyDeleteTasks: async (taskIds, input) => {
      assert.deepEqual(taskIds, [7, 8]);
      assert.deepEqual(input.actor, {
        userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1,
      });
      assert.equal(input.deletionPassword, 'delete-secret');
      await input.beforeDelete(7);
      return {
        succeeded: [7],
        failed: [{ id: 8, code: 'TASK_MUST_BE_INACTIVE', message: '请先废弃排队任务或等待任务结束，再永久删除' }],
      };
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/tasks/batch-permanent-delete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskIds: [7, 8, 7], deletionPassword: 'delete-secret' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, {
        action: 'PERMANENT_DELETE', succeeded: [7],
        failed: [{ id: 8, code: 'TASK_MUST_BE_INACTIVE', message: '请先废弃排队任务或等待任务结束，再永久删除' }],
        cleanupPending: [],
      });
    }, { storageRoot });
    await assert.rejects(() => readFile(deletedFile), { code: 'ENOENT' });
    assert.equal(await readFile(retainedFile, 'utf8'), 'keep-me');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('an in-flight batch archive is rejected when the administrator account is replaced', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-task-batch-archive-stale-'));
  const directory = join(storageRoot, 'tasks', '12', 'image-runs', 'run-12');
  const storagePath = join(directory, 'image.png');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let current = { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 };
  const task = {
    id: 12, state: 'REVIEWED', currentCopyRevisionId: 1, currentImageRunId: 'run-12',
    copyRevisions: [{ id: 1, content: { copy: { title: '旧会话不可下载', body: '正文', tags: [] } } }],
    imageRuns: [], assets: [{ id: 12, taskId: 12, imageRunId: 'run-12', mediaType: 'image/png', originalName: '图片.png' }],
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, 'image-12');
    await withServer({
      getUserByUsername: async () => current,
      getUserByIdentity: async (actor) => current.id === actor.userId ? current : null,
      getTask: async () => task,
      getAsset: async () => {
        entered.resolve();
        await release.promise;
        return { id: 12, taskId: 12, mediaType: 'image/png', originalName: '图片.png', storagePath };
      },
    }, async (root) => {
      const pending = fetch(`${root}/v1/tasks/batch-archive`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Actor-User-Id': '1', 'X-Actor-Username': 'admin',
          'X-Actor-Role': 'ADMIN', 'X-Actor-Credential-Version': '1',
        },
        body: JSON.stringify({ taskIds: [12] }),
      });
      await entered.promise;
      current = { ...current, id: 9 };
      release.resolve();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('content-disposition'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).error.code, 'SESSION_STALE');
    }, { storageRoot, enforceUserAuth: true });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('batch permanent deletion restores every quarantined task when the database transaction fails', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-batch-permanent-delete-'));
  const files = [7, 8].map((taskId) => join(storageRoot, 'tasks', String(taskId), 'image.png'));
  for (const [index, file] of files.entries()) {
    await mkdir(join(storageRoot, 'tasks', String(index + 7)), { recursive: true });
    await writeFile(file, `task-${index + 7}`);
  }
  const repository = {
    permanentlyDeleteTasks: async (_taskIds, input) => {
      await input.beforeDelete(7);
      await input.beforeDelete(8);
      throw new ControlPlaneConflictError('DELETE_FAILED', 'database rejected deletion');
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/tasks/batch-permanent-delete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskIds: [7, 8], deletionPassword: 'delete-secret' }),
      });
      assert.equal(response.status, 409);
    }, { storageRoot });
    assert.equal(await readFile(files[0], 'utf8'), 'task-7');
    assert.equal(await readFile(files[1], 'utf8'), 'task-8');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('saved views and batch operations are scoped to authenticated administrators', async () => {
  const calls = [];
  const repository = {
    getUserByUsername: async (username) => ({
      id: username === 'admin' ? 1 : 2, username,
      role: username === 'admin' ? 'ADMIN' : 'REVIEWER', status: 'ACTIVE', credentialVersion: 1,
    }),
    listSavedTaskViews: async (username) => { calls.push(['list', username]); return []; },
    saveTaskView: async (username, input, options) => { calls.push(['save', username, input, options]); return { id: 7, ...input }; },
    deleteSavedTaskView: async (username, id, options) => { calls.push(['delete', username, id, options]); return { id: Number(id), deleted: true }; },
  };
  const headers = (username, role) => ({
    'X-Actor-User-Id': String(username === 'admin' ? 1 : 2),
    'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1',
  });
  await withServer(repository, async (root) => {
    const admin = headers('admin', 'ADMIN');
    assert.equal((await fetch(`${root}/v1/task-views`, { headers: admin })).status, 200);
    assert.equal((await fetch(`${root}/v1/task-views`, { headers: headers('reviewer', 'REVIEWER') })).status, 403);
    const input = { name: '我的失败任务', viewKey: 'ALL_JOBS', filters: { attention: 'FAILED' } };
    assert.equal((await fetch(`${root}/v1/task-views`, {
      method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(input),
    })).status, 201);
    assert.equal((await fetch(`${root}/v1/task-views/7`, { method: 'DELETE', headers: admin })).status, 200);
    assert.equal((await fetch(`${root}/v1/tasks/batch-actions`, {
      method: 'POST', headers: { ...headers('reviewer', 'REVIEWER'), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'RETRY', taskIds: [1] }),
    })).status, 403);
    assert.equal((await fetch(`${root}/v1/tasks/batch-permanent-delete`, {
      method: 'POST', headers: { ...headers('reviewer', 'REVIEWER'), 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: [1], deletionPassword: 'delete-secret' }),
    })).status, 403);
  }, { enforceUserAuth: true });
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  assert.deepEqual(calls, [
    ['list', 'admin'],
    ['save', 'admin', { name: '我的失败任务', viewKey: 'ALL_JOBS', filters: { attention: 'FAILED' } }, { actor }],
    ['delete', 'admin', '7', { actor }],
  ]);
});

test('permanent task deletion quarantines files and restores them when the database rejects deletion', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-permanent-delete-'));
  const taskFile = join(storageRoot, 'tasks', '7', 'image-runs', 'run-a', 'image.png');
  const thumbnailFile = join(storageRoot, 'thumbnails', '7', 'thumb.webp');
  await mkdir(join(storageRoot, 'tasks', '7', 'image-runs', 'run-a'), { recursive: true });
  await mkdir(join(storageRoot, 'thumbnails', '7'), { recursive: true });
  await writeFile(taskFile, 'task-image');
  await writeFile(thumbnailFile, 'thumbnail');
  const repository = {
    getTask: async () => ({ id: 7, createdByUserId: 'admin' }),
    permanentlyDeleteTask: async (taskId, input) => {
      await input.beforeDelete(Number(taskId));
      throw new ControlPlaneConflictError('DELETE_FAILED', 'database rejected deletion');
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/tasks/7/permanent`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deletionPassword: 'delete-secret' }),
      });
      assert.equal(response.status, 409);
    }, { storageRoot });
    assert.equal(await readFile(taskFile, 'utf8'), 'task-image');
    assert.equal(await readFile(thumbnailFile, 'utf8'), 'thumbnail');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('permanent task deletion removes quarantined files after the database commits', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-permanent-delete-'));
  const taskFile = join(storageRoot, 'tasks', '7', 'image.png');
  await mkdir(join(storageRoot, 'tasks', '7'), { recursive: true });
  await writeFile(taskFile, 'task-image');
  const repository = {
    getTask: async () => ({ id: 7, createdByUserId: 'admin' }),
    permanentlyDeleteTask: async (taskId, input) => {
      await input.beforeDelete(Number(taskId));
      return { id: Number(taskId) };
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/tasks/7/permanent`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deletionPassword: 'delete-secret' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { id: 7, deleted: true, cleanupPending: false });
    }, { storageRoot });
    await assert.rejects(() => readFile(taskFile), { code: 'ENOENT' });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('unknown control plane routes do not leak implementation details', async () => {
  await withServer({}, async (root) => {
    const response = await fetch(`${root}/v1/not-real`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'NOT_FOUND', message: 'route not found' },
    });
  });
});

test('Koa JSON middleware leaves JSON execution assets as raw upload bytes', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-control-plane-'));
  let recorded;
  const repository = {
    activeImageUploadContext: async () => ({ taskId: 7, imageRunId: 'run-a' }),
    recordAsset: async (input) => {
      recorded = input;
      return { id: 'asset-a' };
    },
  };
  try {
    await withServer(repository, async (root) => {
      const response = await fetch(`${root}/v1/executions/d9428888-122b-11e1-b85c-61cd3cbb3210/assets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-File-Name': 'trace.json' },
        body: '{"stage":"IMAGE"}',
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).data.url, '/v1/assets/asset-a');
    }, { storageRoot });
    assert.equal(recorded.mediaType, 'application/json');
    assert.equal(recorded.byteSize, 17);
    assert.equal(recorded.originalName, 'trace.json');
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
