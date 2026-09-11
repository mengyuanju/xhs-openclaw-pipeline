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
      fetch(`${root}/v1/copy-qa/items?offset=-1`, { headers: headers('reviewer') }),
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
    assert.deepEqual(calls[2], ['produce', '9', production, {
      actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.filter(([kind]) => kind === 'screen').map(([, , , context]) => context.actor), [
      { userId: 22, username: 'worker', role: 'USER', credentialVersion: 1 },
      { userId: 91, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
    ]);
    assert.equal(calls.length, 9, 'administrator-only denials must happen before repository access');
  });
});

test('workflow quality settings are administrator-only and batch readiness excludes ordinary users', async () => {
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
    assert.equal(workerReadiness.status, 403);
    assert.equal((await workerReadiness.json()).error.code, 'FORBIDDEN');
    assert.equal(readinessCalls.length, 0, 'ordinary-user readiness reads must stop before repository access');

    for (const username of ['reviewer', 'admin']) {
      const response = await fetch(`${root}/v1/production-batches/301/copy-sampling-readiness`, {
        headers: headers(username),
      });
      assert.equal(response.status, 200, username);
      assert.equal((await response.json()).data.ready, true);
    }
    assert.deepEqual(readinessCalls, [
      ['301', { actor: { userId: 91, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 } }],
      ['301', { actor: { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 } }],
    ]);
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
    query: '普通用户仍需处理的 Query',
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

test('QA HTTP routes use opaque ids and tokens while statistics remain administrator-only', async () => {
  const itemId = '71717171-7171-4717-8717-717171717171';
  const freezePublicId = '81818181-8181-4818-8818-818181818181';
  const revisionToken = 'a'.repeat(64);
  const calls = [];
  const safeItem = {
    id: itemId,
    freezePublicId,
    anonymousCode: 'QCI-A8B12C',
    blindReview: true,
    status: 'PENDING',
    sampleKind: 'RANDOM',
    query: '匿名抽检 Query',
    approvedRevision: { content: { copy: { title: '最终稿', body: '正文', tags: [] } }, contentSha256: revisionToken, revisionToken },
    productionBatch: { anonymousCode: 'QCB-B81A2C' },
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
  };
  const repository = {
    listCopyQaItems: async (...args) => { calls.push(['list', ...args]); return [safeItem]; },
    getCopyQaItem: async (...args) => { calls.push(['detail', ...args]); return safeItem; },
    passCopyQaItem: async (...args) => { calls.push(['pass', ...args]); return { id: itemId, status: 'PASSED', releasedCount: 0 }; },
    returnCopyQaItem: async (...args) => { calls.push(['return', ...args]); return { id: itemId, status: 'RETURNED' }; },
    getCopyQaBatchReturnPreview: async (...args) => { calls.push(['preview', ...args]); return { freezePublicId, confirmedCount: 1, items: [{ id: itemId }] }; },
    batchReturnCopyQa: async (...args) => { calls.push(['batch', ...args]); return { freezePublicId, status: 'BATCH_RETURNED' }; },
    getCopyQaStatistics: async (...args) => { calls.push(['stats', ...args]); return { random: [], mandatory: { passed: 0, returned: 0, pending: 0 }, batchAffectedCount: 0 }; },
  };
  await withServer(repository, async (root) => {
    const listed = await fetch(`${root}/v1/copy-qa/items?status=PENDING&limit=20&offset=0`, { headers: headers('reviewer') });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).data, [safeItem]);

    const detail = await fetch(`${root}/v1/copy-qa/items/${itemId}`, { headers: headers('reviewer') });
    assert.equal(detail.status, 200);

    const passInput = { expectedRevisionToken: revisionToken, requestId: '33333333-3333-4333-8333-333333333333' };
    const passed = await fetch(`${root}/v1/copy-qa/items/${itemId}/pass`, {
      method: 'POST', headers: headers('reviewer', true), body: JSON.stringify(passInput),
    });
    assert.equal(passed.status, 200);
    assert.deepEqual((await passed.json()).data, { id: itemId, status: 'PASSED', releasedCount: 0 });

    const preview = await fetch(`${root}/v1/copy-qa/freezes/${freezePublicId}/batch-return-preview`, { headers: headers('reviewer') });
    assert.equal(preview.status, 200);

    const batchInput = {
      freezePublicId,
      triggerSamplingItemId: itemId,
      itemIds: [itemId],
      reasonCodes: ['FACT_ERROR'],
      note: '预检后整批打回',
      confirmedCount: 1,
      requestId: '44444444-4444-4444-8444-444444444444',
    };
    const batch = await fetch(`${root}/v1/copy-qa/batch-return`, {
      method: 'POST', headers: headers('reviewer', true), body: JSON.stringify(batchInput),
    });
    assert.equal(batch.status, 200);

    const reviewerStats = await fetch(`${root}/v1/copy-qa/statistics`, { headers: headers('reviewer') });
    assert.equal(reviewerStats.status, 403);
    const adminStats = await fetch(`${root}/v1/copy-qa/statistics`, { headers: headers('admin') });
    assert.equal(adminStats.status, 200);

    assert.deepEqual(calls.find(([kind]) => kind === 'pass').slice(1), [itemId, passInput, {
      actor: { userId: 91, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
    }]);
    assert.deepEqual(calls.find(([kind]) => kind === 'batch').slice(1), [batchInput, {
      actor: { userId: 91, username: 'reviewer', role: 'REVIEWER', credentialVersion: 1 },
    }]);
    assert.equal(calls.filter(([kind]) => kind === 'stats').length, 1,
      'a denied reviewer statistics request must not reach the repository');
  });
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

test('delivery-pool list and batch exports are administrator-only', async () => {
  let snapshotReads = 0;
  const repository = {
    listDeliveryPool: async () => { snapshotReads += 1; return []; },
    listAllDeliveryPoolTaskIds: async () => { snapshotReads += 1; return []; },
  };
  await withServer(repository, async (root) => {
    for (const username of ['worker', 'reviewer']) {
      const listing = await fetch(`${root}/v1/delivery-pool`, { headers: headers(username) });
      assert.equal(listing.status, 403, `${username}:list`);
      assert.equal((await listing.json()).error.code, 'FORBIDDEN', `${username}:list`);
      for (const endpoint of ['archive', 'xlsx']) {
        const response = await fetch(`${root}/v1/delivery-pool/${endpoint}`, {
          method: 'POST',
          headers: headers(username, true),
          body: JSON.stringify({ scope: 'ALL_READY' }),
        });
        assert.equal(response.status, 403, `${username}:${endpoint}`);
        assert.equal(
          (await response.json()).error.code,
          'FORBIDDEN',
          `${username}:${endpoint}`,
        );
        const download = await fetch(
          `${root}/v1/delivery-pool/${endpoint}/11111111-1111-4111-8111-111111111111`,
          { headers: headers(username) },
        );
        assert.equal(download.status, 403, `${username}:${endpoint}`);
        assert.equal(
          (await download.json()).error.code,
          'FORBIDDEN',
          `${username}:${endpoint}`,
        );
      }
    }
  });
  assert.equal(snapshotReads, 0, 'authorization must run before reading the delivery snapshot');
});

test('single delivery packages are administrator-only', async () => {
  let accessReads = 0;
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
    getTask: async () => task,
    assertTaskReadyForDelivery: async () => ({
      taskId: 77,
      copyRevisionId: 177,
      imageRunId: access.currentImageRunId,
    }),
  };
  await withServer(repository, async (root) => {
    const reviewer = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('reviewer'),
    });
    assert.equal(reviewer.status, 403);
    assert.equal(accessReads, 0, 'reviewer denial must happen before task lookup');

    const worker = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('worker'),
    });
    assert.equal(worker.status, 403);
    assert.equal(accessReads, 0, 'non-admin denial must happen before task lookup');

    const administrator = await fetch(`${root}/v1/tasks/77/archive`, {
      method: 'HEAD', headers: headers('admin'),
    });
    assert.equal(administrator.status, 200);
    assert.equal(administrator.headers.get('content-type'), 'application/zip');
  });
});

test('single worker delivery is rejected before archive data is read', async () => {
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
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('content-disposition'), null);
  });
  assert.equal(taskReads, 0);
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
