import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listCopyQaItems } from '../src/copy-quality-control.mjs';
import { listDeliveryPool } from '../src/final-delivery.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { listQueryPackages } from '../src/query-packages.mjs';

const users = Object.freeze({
  admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
  worker: { id: 22, username: 'worker', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  reviewer: { id: 91, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
});

function headers(username, contentType = false) {
  const user = users[username];
  return {
    'X-Actor-User-Id': String(user.id),
    'X-Actor-Username': user.username,
    'X-Actor-Role': user.role,
    'X-Actor-Credential-Version': String(user.credentialVersion),
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function withServer(repository, action) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-modular-http-'));
  const app = createControlPlaneApp({
    repository: {
      getUserByUsername: async (username) => users[username] ?? null,
      ...repository,
    },
    storageRoot,
    enforceUserAuth: true,
  });
  let server;
  try {
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    await action(`http://127.0.0.1:${server.address().port}`, storageRoot);
  } finally {
    await app.context.disposeControlPlaneResources?.();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(storageRoot, { recursive: true, force: true });
  }
}

test('workflow list endpoints reject invalid pagination before database access', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; } };
  const repository = {
    listQueryPackages: (options, { actor }) => listQueryPackages(pool, options, actor),
    listCopyQaItems: (options, { actor }) => listCopyQaItems(pool, options, actor),
    listDeliveryPool: (options, { actor }) => listDeliveryPool(pool, options, actor),
  };
  await withServer(repository, async (root) => {
    const requests = [
      fetch(`${root}/v1/query-packages?limit=1.5`, { headers: headers('admin') }),
      fetch(`${root}/v2/copy-qa/batches?offset=-1`, { headers: headers('reviewer') }),
      fetch(`${root}/v1/delivery-pool?limit=NaN`, { headers: headers('admin') }),
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
  });
  assert.equal(queryCount, 0);
});

test('Query package HTTP routes separate delegated screening from administrator operations', async () => {
  const calls = [];
  const repository = {
    listQueryPackages: async (...args) => { calls.push(['list', ...args]); return []; },
    getQueryPackage: async (...args) => { calls.push(['detail', ...args]); return { id: 9, version: 1 }; },
    getQueryPackageItemAssignmentSummary: async (...args) => { calls.push(['assignment-summary', ...args]); return { packageId: 9, packageVersion: 1 }; },
    assignQueryPackageItems: async (...args) => { calls.push(['assign-items', ...args]); return { queryPackage: { id: 9, version: 2 } }; },
    assignQueryPackage: async (...args) => { calls.push(['assign', ...args]); return { id: 9, version: 2 }; },
    updateQueryPackageScreening: async (...args) => { calls.push(['screen', ...args]); return { id: 9, version: 2 }; },
    createQueryPackageProductionBatch: async (...args) => { calls.push(['produce', ...args]); return { id: 301, taskIds: [501] }; },
  };
  await withServer(repository, async (root) => {
    const listed = await fetch(`${root}/v1/query-packages?limit=25&offset=50`, { headers: headers('admin') });
    assert.equal(listed.status, 200);

    const assignment = {
      expectedVersion: 1,
      assignedToUserId: 'worker',
      assignedToAccountId: 22,
    };
    const assigned = await fetch(`${root}/v1/query-packages/9/assignee`, {
      method: 'PATCH', headers: headers('admin', true), body: JSON.stringify(assignment),
    });
    assert.equal(assigned.status, 200);

    const assignmentSummary = await fetch(`${root}/v1/query-packages/9/item-assignment-summary`, {
      headers: headers('admin'),
    });
    assert.equal(assignmentSummary.status, 200);
    const itemAssignment = {
      expectedVersion: 1,
      strategy: 'EVEN',
      assignees: [{ accountId: 22 }],
      requestId: '10101010-1010-4010-8010-101010101010',
    };
    const itemsAssigned = await fetch(`${root}/v1/query-packages/9/item-assignments`, {
      method: 'PUT', headers: headers('admin', true), body: JSON.stringify(itemAssignment),
    });
    assert.equal(itemsAssigned.status, 200);

    const screening = {
      expectedVersion: 1,
      decisions: [{ itemId: 101, decision: 'SELECT' }],
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const production = {
      expectedVersion: 2,
      itemIds: [101],
      requestId: '22222222-2222-4222-8222-222222222222',
    };
    const produced = await fetch(`${root}/v1/query-packages/9/production-batches`, {
      method: 'POST', headers: headers('admin', true), body: JSON.stringify(production),
    });
    assert.equal(produced.status, 201);

    for (const username of ['worker', 'reviewer']) {
      const listedForScreening = await fetch(`${root}/v1/query-packages`, { headers: headers(username) });
      assert.equal(listedForScreening.status, 200, `${username}:list`);
      const detail = await fetch(`${root}/v1/query-packages/9`, { headers: headers(username) });
      assert.equal(detail.status, 200, `${username}:detail`);
      const screened = await fetch(`${root}/v1/query-packages/9/screening`, {
        method: 'PUT', headers: headers(username, true), body: JSON.stringify(screening),
      });
      assert.equal(screened.status, 200, `${username}:screen`);

      for (const [path, method] of [
        ['/v1/query-packages', 'POST'],
        ['/v1/query-packages/9/assignee', 'PATCH'],
        ['/v1/query-packages/9/item-assignment-summary', 'GET'],
        ['/v1/query-packages/9/item-assignments', 'PUT'],
        ['/v1/query-packages/9/production-batches', 'POST'],
        ['/v1/query-packages/9/abandon', 'POST'],
        ['/v1/query-packages/9/permanent-delete-preview', 'GET'],
        ['/v1/query-packages/9/permanent', 'DELETE'],
      ]) {
        const denied = await fetch(`${root}${path}`, {
          method,
          headers: headers(username, true),
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{}' }),
        });
        assert.equal(denied.status, 403, `${username}:${method}:${path}`);
        assert.equal((await denied.json()).error.code, 'FORBIDDEN');
      }
    }

    assert.deepEqual(calls[0], ['list', { limit: '25', offset: '50' }, {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls[1], ['assign', '9', assignment, {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.find(([kind]) => kind === 'assignment-summary'), ['assignment-summary', '9', {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.find(([kind]) => kind === 'assign-items'), ['assign-items', '9', itemAssignment, {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.find(([kind]) => kind === 'produce'), ['produce', '9', production, {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.filter(([kind]) => kind === 'screen').map(([, , , context]) => context.actor), [
      { userId: 22, username: 'worker', role: 'USER', credentialVersion: 1 },
      { userId: 91, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
    ]);
    assert.equal(calls.length, 11, 'administrator-only denials must happen before repository access');
  });
});

test('workflow quality settings are administrator-only and legacy batch readiness is retired', async () => {
  let settingsReads = 0;
  const readinessCalls = [];
  const repository = {
    getWorkflowQualitySettings: async () => {
      settingsReads += 1;
      return { queryPackage: { workerImportEnabled: false } };
    },
    getProductionBatchSamplingReadiness: async (...args) => {
      readinessCalls.push(args);
      return { batchId: 301, ready: true };
    },
  };
  await withServer(repository, async (root) => {
    const adminSettings = await fetch(`${root}/v1/workflow-quality-settings`, {
      headers: headers('admin'),
    });
    assert.equal(adminSettings.status, 200);
    assert.equal((await adminSettings.json()).data.queryPackage.workerImportEnabled, false);

    for (const username of ['worker', 'reviewer']) {
      const denied = await fetch(`${root}/v1/workflow-quality-settings`, {
        headers: headers(username),
      });
      assert.equal(denied.status, 403, username);
      assert.equal((await denied.json()).error.code, 'FORBIDDEN');
    }
    assert.equal(settingsReads, 1, 'non-administrator settings reads must stop before repository access');

    const workerReadiness = await fetch(
      `${root}/v1/production-batches/301/copy-sampling-readiness`,
      { headers: headers('worker') },
    );
    assert.equal(workerReadiness.status, 410);
    assert.equal((await workerReadiness.json()).error.code, 'LEGACY_COPY_QA_RETIRED');
    assert.equal(readinessCalls.length, 0, 'ordinary-user readiness reads must stop before repository access');

    for (const username of ['reviewer', 'admin']) {
      const response = await fetch(`${root}/v1/production-batches/301/copy-sampling-readiness`, {
        headers: headers(username),
      });
      assert.equal(response.status, 410, username);
      assert.equal((await response.json()).error.code, 'LEGACY_COPY_QA_RETIRED');
    }
    assert.deepEqual(readinessCalls, [], 'retired readiness must not access the repository');
  });
});

test('ordinary task responses remove package, delivery and Xiaohongshu search metadata', async () => {
  const sensitiveFields = [
    'sourceQueryPackageId',
    'sourceQueryPackageName',
    'sourceQueryPackageExternalId',
    'productionBatchId',
    'deliveryStatus',
  ];
  const xiaohongshuFields = [
    'xiaohongshuSearchStatus',
    'xiaohongshuSearchBlockedReason',
    'xiaohongshuLinks',
  ];
  const task = {
    id: 42,
    query: '标注仍需处理的 Query',
    state: 'COPY_REVIEW_PENDING',
    createdByUserId: 'admin',
    createdByAccountId: users.admin.id,
    assignedToUserId: 'worker',
    assignedToAccountId: users.worker.id,
    sourceQueryPackageId: 7,
    sourceQueryPackageName: '不可见词包',
    sourceQueryPackageExternalId: 'secret-external-id',
    productionBatchId: 9,
    deliveryStatus: 'READY',
    xiaohongshuSearchStatus: 'BLOCKED',
    xiaohongshuSearchBlockedReason: 'CAPTCHA_REQUIRED',
    xiaohongshuLinks: [{ noteId: 'secret-note', url: 'https://example.invalid/note' }],
    executions: [{ id: 'internal-execution' }],
  };
  let listReads = 0;
  const repository = {
    listTasks: async () => {
      listReads += 1;
      return { items: [task], total: 1, limit: 50, offset: 0 };
    },
    getTaskAccess: async () => task,
    getTask: async () => task,
    approveCopy: async () => task,
    retryTask: async () => task,
    requeueImageTask: async () => task,
    reviseImages: async () => task,
    cancelTask: async () => task,
  };
  await withServer(repository, async (root) => {
    const userList = await fetch(`${root}/v1/tasks?includeTotal=true`, { headers: headers('worker') });
    assert.equal(userList.status, 200);
    const userListTask = (await userList.json()).data.items[0];
    assert.equal(userListTask.query, task.query);
    for (const field of sensitiveFields) {
      assert.equal(Object.hasOwn(userListTask, field), false, `USER list leaked ${field}`);
    }
    for (const field of xiaohongshuFields) {
      assert.equal(Object.hasOwn(userListTask, field), false, `USER list leaked ${field}`);
    }

    const readsBeforeForbiddenFilter = listReads;
    const forbiddenFilter = await fetch(
      `${root}/v1/tasks?queryPackageName=${encodeURIComponent(task.sourceQueryPackageName)}`,
      { headers: headers('worker') },
    );
    assert.equal(forbiddenFilter.status, 403);
    assert.equal((await forbiddenFilter.json()).error.code, 'FORBIDDEN');
    assert.equal(listReads, readsBeforeForbiddenFilter,
      'package-name filtering must be rejected before task repository access');

    const userDetail = await fetch(`${root}/v1/tasks/42`, { headers: headers('worker') });
    assert.equal(userDetail.status, 200);
    const userDetailTask = (await userDetail.json()).data;
    assert.equal(userDetailTask.query, task.query);
    assert.equal(Object.hasOwn(userDetailTask, 'executions'), false);
    for (const field of sensitiveFields) {
      assert.equal(Object.hasOwn(userDetailTask, field), false, `USER detail leaked ${field}`);
    }
    for (const field of xiaohongshuFields) {
      assert.deepEqual(userDetailTask[field], task[field], `USER detail omitted ${field}`);
    }

    for (const [path, expectedStatus] of [
      ['/v1/tasks/42/approve-copy', 200],
      ['/v1/tasks/42/retry', 200],
      ['/v1/tasks/42/retry-image', 200],
      ['/v1/tasks/42/image-revisions', 201],
      ['/v1/tasks/42/cancel', 200],
    ]) {
      const response = await fetch(`${root}${path}`, {
        method: 'POST', headers: headers('worker', true), body: '{}',
      });
      assert.equal(response.status, expectedStatus, path);
      const mutationTask = (await response.json()).data;
      assert.equal(mutationTask.query, task.query);
      for (const field of [...sensitiveFields, ...xiaohongshuFields]) {
        assert.equal(Object.hasOwn(mutationTask, field), false, `USER ${path} leaked ${field}`);
      }
    }

    const reviewerDetail = await fetch(`${root}/v1/tasks/42`, { headers: headers('reviewer') });
    assert.equal(reviewerDetail.status, 200);
    const reviewerTask = (await reviewerDetail.json()).data;
    for (const field of [...sensitiveFields, ...xiaohongshuFields]) {
      assert.deepEqual(reviewerTask[field], task[field], `REVIEWER lost ${field}`);
    }
    assert.equal(Object.hasOwn(reviewerTask, 'executions'), false,
      'reviewer execution visibility must remain unchanged');

    const adminList = await fetch(`${root}/v1/tasks?includeTotal=true`, { headers: headers('admin') });
    assert.equal(adminList.status, 200);
    const adminListTask = (await adminList.json()).data.items[0];
    for (const field of [...sensitiveFields, ...xiaohongshuFields]) {
      assert.deepEqual(adminListTask[field], task[field], `ADMIN list lost ${field}`);
    }
    const adminDetail = await fetch(`${root}/v1/tasks/42`, { headers: headers('admin') });
    assert.equal(adminDetail.status, 200);
    assert.deepEqual((await adminDetail.json()).data, task);
  });
});

test('V2 QA HTTP lists use opaque identities and blind content while statistics remain administrator-only', async () => {
  const itemId = '71717171-7171-4717-8717-717171717171';
  const batchId = '81818181-8181-4818-8818-818181818181';
  const revisionToken = 'a'.repeat(64);
  const queries = [];
  let statisticsReads = 0;
  const batch = { id: 18, public_id: batchId, display_name: '新质检批次', mode: 'PERSONAL_AUTO',
    status: 'INSPECTING', member_count: 2, sample_count: 1, full_inspection: false,
    blind_review_enabled: true, return_trigger_count: 1 };
  const repository = {
    getCopyQaStatistics: async () => { statisticsReads++; return { random: [], mandatory: {} }; },
    pool: { async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('SELECT * FROM app_users')) return { rows: [{ id: values[0], role: values[2], copy_qc_enabled: true }] };
      if (sql.startsWith('SELECT count(*) AS total')) return { rows: [{ total: '1' }] };
      if (sql.includes('SELECT batch.*')) return { rows: [{ ...batch, pending_count: 1, passed_count: 0,
        returned_count: 0, discarded_count: 0, affected_count: 0 }] };
      if (sql.startsWith('SELECT * FROM copy_qa_batches_v2')) return { rows: [batch] };
      if (sql.startsWith('SELECT count(*) FILTER')) return { rows: [{ total: 1, pending_count: 1,
        passed_count: 0, returned_count: 0, discarded_count: 0, affected_count: 0 }] };
      if (sql.startsWith('SELECT member.*')) return { rows: [{ public_id: itemId, task_id: 991,
        query: 'PRIVATE-QUERY', approver_username: 'PRIVATE-APPROVER', status: 'PENDING',
        content: { copy: { title: '最终稿', body: '正文', tags: [] }, qualityReturn: { returnedByUsername: 'PRIVATE-RETURNER' } },
        content_sha256: revisionToken, selected: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    } },
  };
  await withServer(repository, async root => {
    for (const username of ['reviewer', 'worker', 'admin']) {
      const listed = await fetch(`${root}/v2/copy-qa/batches?view=PENDING&limit=20&offset=0`, { headers: headers(username) });
      assert.equal(listed.status, 200, username);
      const list = (await listed.json()).data;
      assert.equal(list.items[0].id, batchId);
      assert.equal(list.total, 1);
      const detail = await fetch(`${root}/v2/copy-qa/batches/${batchId}?limit=20&offset=0`, { headers: headers(username) });
      assert.equal(detail.status, 200, username);
      const data = (await detail.json()).data;
      assert.equal(data.items[0].id, itemId);
      assert.equal(data.items[0].revisionToken, revisionToken);
      assert.equal(data.items[0].content.copy.title, '最终稿');
      if (username !== 'admin') {
        assert.equal(data.items[0].taskId, null);
        for (const secret of ['PRIVATE-QUERY', 'PRIVATE-APPROVER', 'PRIVATE-RETURNER']) {
          assert.equal(JSON.stringify(data).includes(secret), false, secret);
        }
      } else assert.equal(data.items[0].taskId, 991);
    }
    for (const username of ['worker', 'reviewer']) {
      const denied = await fetch(`${root}/v2/copy-qa/candidates`, { headers: headers(username) });
      assert.equal(denied.status, 403);
      const stats = await fetch(`${root}/v1/copy-qa/statistics`, { headers: headers(username) });
      assert.equal(stats.status, 403);
    }
    const statistics = await fetch(`${root}/v1/copy-qa/statistics`, { headers: headers('admin') });
    assert.equal(statistics.status, 200);
    const queryCount = queries.length;
    const invalidDecision = await fetch(`${root}/v2/copy-qa/items/${itemId}/decision`, {
      method: 'POST', headers: headers('reviewer', true), body: JSON.stringify({
        decision: 'RETURN', revisionToken, requestId: '33333333-3333-4333-8333-333333333333',
      }),
    });
    assert.equal(invalidDecision.status, 400, 'a return must include a reason');
    assert.equal(queries.length, queryCount, 'invalid V2 decisions stop before database access');
  });
  assert.equal(statisticsReads, 1);
});

test('all retired copy QA mutation routes stop before repository access', async () => {
  let calls = 0;
  const retired = () => { calls++; assert.fail('retired copy QA must not reach repository'); };
  await withServer({ getCopyQaItem: retired, passCopyQaItem: retired, returnCopyQaItem: retired,
    getCopyQaBatchReturnPreview: retired, batchReturnCopyQa: retired }, async root => {
    for (const [path, method] of [
      ['/v1/copy-qa/items', 'GET'], ['/v1/copy-qa/items/71717171-7171-4717-8717-717171717171', 'GET'],
      ['/v1/copy-qa/items/71717171-7171-4717-8717-717171717171/pass', 'POST'],
      ['/v1/copy-qa/items/71717171-7171-4717-8717-717171717171/return', 'POST'],
      ['/v1/copy-qa/freezes/81818181-8181-4818-8818-818181818181/batch-return-preview', 'GET'],
      ['/v1/copy-qa/batch-return', 'POST'],
    ]) {
      const response = await fetch(`${root}${path}`, { method, headers: headers('admin', true),
        ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(response.status, 410, path);
      assert.equal((await response.json()).error.code, 'LEGACY_COPY_QA_RETIRED');
    }
  });
  assert.equal(calls, 0);
});

test('active blind QA tasks disappear from generic reviewer task APIs, including guessed ids', async () => {
  let fullTaskReads = 0;
  let listOptions;
  const repository = {
    listTasks: async (options) => { listOptions = options; return []; },
    getTaskAccess: async () => ({
      id: 991,
      state: 'COPY_QC_PENDING',
      activeBlindQa: true,
      createdByUserId: 'worker',
      createdByAccountId: 22,
      assignedToUserId: 'worker',
      assignedToAccountId: 22,
    }),
    getTask: async () => { fullTaskReads += 1; return { id: 991, query: 'must stay hidden' }; },
  };
  await withServer(repository, async (root) => {
    const list = await fetch(`${root}/v1/tasks`, { headers: headers('reviewer') });
    assert.equal(list.status, 200);
    assert.equal(listOptions.excludeActiveBlindQa, true);

    const guessed = await fetch(`${root}/v1/tasks/991`, { headers: headers('reviewer') });
    assert.equal(guessed.status, 404);
    assert.equal((await guessed.json()).error.code, 'TASK_NOT_FOUND');
    assert.equal(fullTaskReads, 0, 'authorization must fail before loading identity-rich task detail');
  });
});

test('operators can list their scoped delivery pool while management exports stay administrator-only', async () => {
  const snapshotActors = [];
  const repository = {
    listDeliveryPool: async (options, { actor }) => {
      snapshotActors.push(actor);
      return [];
    },
    listAllDeliveryPoolTaskIds: async () => assert.fail('operator broad exports must be rejected'),
  };
  await withServer(repository, async (root) => {
    const workerListing = await fetch(`${root}/v1/delivery-pool`, { headers: headers('worker') });
    assert.equal(workerListing.status, 200);
    assert.deepEqual((await workerListing.json()).data, []);
    const reviewerListing = await fetch(`${root}/v1/delivery-pool`, { headers: headers('reviewer') });
    assert.equal(reviewerListing.status, 403);
    assert.equal((await reviewerListing.json()).error.code, 'FORBIDDEN');

    for (const username of ['worker', 'reviewer']) {
      const spreadsheet = await fetch(`${root}/v1/delivery-pool/xlsx`, {
        method: 'POST',
        headers: headers(username, true),
        body: JSON.stringify({ scope: 'ALL_READY' }),
      });
      assert.equal(spreadsheet.status, 403, `${username}:xlsx`);
    }
    const unknownWorkerSpreadsheet = await fetch(
      `${root}/v1/delivery-pool/xlsx/11111111-1111-4111-8111-111111111111`,
      { headers: headers('worker') },
    );
    assert.equal(unknownWorkerSpreadsheet.status, 404,
      'operators may download their prepared history workbook but cannot use an unknown token');
    const reviewerSpreadsheetDownload = await fetch(
      `${root}/v1/delivery-pool/xlsx/11111111-1111-4111-8111-111111111111`,
      { headers: headers('reviewer') },
    );
    assert.equal(reviewerSpreadsheetDownload.status, 403);

    const reviewerArchive = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST', headers: headers('reviewer', true),
      body: JSON.stringify({ scope: 'SELECTED', taskIds: [77] }),
    });
    assert.equal(reviewerArchive.status, 403);
    const reviewerDownload = await fetch(
      `${root}/v1/delivery-pool/archive/11111111-1111-4111-8111-111111111111`,
      { headers: headers('reviewer') },
    );
    assert.equal(reviewerDownload.status, 403);

    const workerBroadScope = await fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST', headers: headers('worker', true),
      body: JSON.stringify({ scope: 'ALL_READY' }),
    });
    assert.equal(workerBroadScope.status, 403);
    assert.equal((await workerBroadScope.json()).error.code, 'FORBIDDEN');
    const unknownWorkerDownload = await fetch(
      `${root}/v1/delivery-pool/archive/11111111-1111-4111-8111-111111111111`,
      { headers: headers('worker') },
    );
    assert.equal(unknownWorkerDownload.status, 404,
      'operators may enter the actor-bound download route, but cannot access an unknown token');
  });
  assert.equal(snapshotActors.length, 1);
  assert.equal(snapshotActors[0].role, 'USER');
  assert.equal(snapshotActors[0].userId, users.worker.id);
  assert.equal(snapshotActors[0].username, users.worker.username);
});

test('single delivery packages allow only the current task owner or an administrator', async () => {
  let accessReads = 0;
  let assetStoragePath = '';
  const access = {
    id: 77,
    state: 'REVIEWED',
    createdByUserId: 'worker',
    createdByAccountId: users.worker.id,
    assignedToUserId: 'another-worker',
    assignedToAccountId: 33,
    currentCopyRevisionId: 177,
    currentImageRunId: '77777777-7777-4777-8777-777777777777',
  };
  const task = {
    ...access,
    copyRevisions: [{
      id: 177,
      content: { copy: { title: '交付文案', body: '正文', tags: [] } },
    }],
    imageRuns: [{
      id: access.currentImageRunId,
      result: { images: [{ assetId: 277 }] },
    }],
    assets: [{
      id: 277,
      taskId: 77,
      imageRunId: access.currentImageRunId,
      mediaType: 'image/png',
    }],
  };
  const repository = {
    getTaskAccess: async () => { accessReads += 1; return access; },
    getTask: async () => ({ ...task,
      assignedToUserId: access.assignedToUserId,
      assignedToAccountId: access.assignedToAccountId,
    }),
    getAsset: async (assetId) => assetId === 277 ? {
      ...task.assets[0],
      storagePath: assetStoragePath,
    } : null,
    assertTaskReadyForDelivery: async () => ({
      taskId: 77,
      copyRevisionId: 177,
      imageRunId: access.currentImageRunId,
    }),
  };
  await withServer(repository, async (root, storageRoot) => {
    assetStoragePath = join(storageRoot, '277.png');
    await writeFile(assetStoragePath, Buffer.from('owned delivery image'));
    const reviewer = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('reviewer'),
    });
    assert.equal(reviewer.status, 403);
    assert.equal(accessReads, 0, 'reviewer denial must happen before task lookup');

    const worker = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('worker'),
    });
    assert.equal(worker.status, 403);
    assert.equal(accessReads, 1, 'ownership must be checked before a worker receives archive metadata');

    access.assignedToUserId = users.worker.username;
    access.assignedToAccountId = users.worker.id;
    const owner = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('worker'),
    });
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get('content-type'), 'application/zip');
    const ownerDownload = await fetch(`${root}/v1/tasks/77/archive`, {
      headers: headers('worker'),
    });
    assert.equal(ownerDownload.status, 200);
    assert.match(ownerDownload.headers.get('content-disposition'), /attachment/u);
    assert.ok((await ownerDownload.arrayBuffer()).byteLength > 0);

    const administrator = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('admin'),
    });
    assert.equal(administrator.status, 200);
    assert.equal(administrator.headers.get('content-type'), 'application/zip');
  });
});

test('an inaccessible worker delivery fails before archive bytes are read', async () => {
  let taskReads = 0;
  let assetReads = 0;
  await withServer({
    getTaskAccess: async () => { taskReads += 1; return null; },
    getTask: async () => { taskReads += 1; return null; },
    getAsset: async () => { assetReads += 1; return null; },
  }, async (root) => {
    const response = await fetch(`${root}/v1/tasks/78/archive`, {
      headers: headers('worker'),
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-disposition'), null);
  });
  assert.equal(taskReads, 1);
  assert.equal(assetReads, 0);
});

test('disconnecting a delivery preparation cancels work and removes its staged files', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let storagePath = '';
  await withServer({
    listAllDeliveryPoolTaskIds: async () => [79],
    getTask: async () => ({
      id: 79,
      state: 'REVIEWED',
      currentCopyRevisionId: 179,
      currentImageRunId: '79797979-7979-4979-8979-797979797979',
      copyRevisions: [{
        id: 179,
        content: { copy: { title: '取消导出', body: '正文', tags: [] } },
      }],
      imageRuns: [{
        id: '79797979-7979-4979-8979-797979797979',
        result: { images: [{ assetId: 279 }] },
      }],
      assets: [{
        id: 279,
        taskId: 79,
        imageRunId: '79797979-7979-4979-8979-797979797979',
        mediaType: 'image/png',
      }],
    }),
    assertTaskReadyForDelivery: async () => ({
      taskId: 79,
      copyRevisionId: 179,
      imageRunId: '79797979-7979-4979-8979-797979797979',
    }),
    getAsset: async () => {
      entered.resolve();
      await release.promise;
      return {
        id: 279,
        taskId: 79,
        mediaType: 'image/png',
        originalName: '图片.png',
        storagePath,
      };
    },
  }, async (root, storageRoot) => {
    storagePath = join(storageRoot, 'tasks', '79', 'image-runs', 'run', 'image.png');
    await mkdir(join(storageRoot, 'tasks', '79', 'image-runs', 'run'), { recursive: true });
    await writeFile(storagePath, 'image');
    const controller = new AbortController();
    const pending = fetch(`${root}/v1/delivery-pool/archive`, {
      method: 'POST',
      headers: headers('admin', true),
      body: JSON.stringify({ scope: 'ALL_READY' }),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    const exportRoot = join(storageRoot, '.delivery-exports');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const remaining = await readdir(exportRoot).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      if (remaining.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(await readdir(exportRoot), []);
  });
});
