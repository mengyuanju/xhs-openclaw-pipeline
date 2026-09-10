import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeliveryExportRegistry,
  MAX_SELECTED_DELIVERY_TASKS,
  loadReadyDeliveryTasks,
  normalizeDeliveryExportRequest,
  resolveDeliveryExportTaskIds,
} from '../src/delivery-export.mjs';

test('delivery export request separates all-ready scope from selected task ids', () => {
  assert.deepEqual(normalizeDeliveryExportRequest({ scope: 'ALL_READY' }), {
    scope: 'ALL_READY',
  });
  assert.deepEqual(normalizeDeliveryExportRequest({
    scope: 'QUERY_PACKAGE',
    queryPackageName: '  九月   选题  ',
  }), { scope: 'QUERY_PACKAGE', queryPackageName: '九月 选题' });
  assert.deepEqual(normalizeDeliveryExportRequest({
    scope: 'SELECTED',
    taskIds: ['2', 1, 2],
  }), { scope: 'SELECTED', taskIds: [2, 1] });
  assert.throws(
    () => normalizeDeliveryExportRequest({ scope: 'ALL_READY', taskIds: [1] }),
    /cannot include taskIds/u,
  );
  assert.throws(
    () => normalizeDeliveryExportRequest({ scope: 'QUERY_PACKAGE', queryPackageName: '九月', taskIds: [1] }),
    /cannot include taskIds/u,
  );
  assert.throws(
    () => normalizeDeliveryExportRequest({ scope: 'QUERY_PACKAGE', queryPackageName: '   ' }),
    /between 1 and 200/u,
  );
  assert.throws(
    () => normalizeDeliveryExportRequest({ scope: 'SELECTED', taskIds: [1], queryPackageName: '九月' }),
    /cannot include queryPackageName/u,
  );
  assert.throws(
    () => normalizeDeliveryExportRequest({
      scope: 'SELECTED',
      taskIds: Array.from({ length: MAX_SELECTED_DELIVERY_TASKS + 1 }, (_, index) => index + 1),
    }),
    /between 1 and 200/u,
  );
});

test('query-package export resolves only that package and never falls back when it is empty', async () => {
  const actor = { role: 'ADMIN', userId: 1, username: 'admin' };
  const calls = [];
  await assert.rejects(
    resolveDeliveryExportTaskIds({
      listAllDeliveryPoolTaskIds: async (options) => {
        calls.push(options);
        return [];
      },
    }, { scope: 'QUERY_PACKAGE', queryPackageName: '九月选题' }, actor),
    (error) => error?.code === 'DELIVERY_POOL_EMPTY',
  );
  assert.deepEqual(calls, [{ actor, queryPackageName: '九月选题' }]);
});

test('all-ready task ids come from the repository snapshot and reject an empty pool', async () => {
  const actor = { role: 'ADMIN', userId: 1, username: 'admin' };
  let received;
  assert.deepEqual(await resolveDeliveryExportTaskIds({
    listAllDeliveryPoolTaskIds: async (options) => { received = options; return [3, '2', 3]; },
  }, { scope: 'ALL_READY' }, actor), [3, 2]);
  assert.deepEqual(received, { actor });
  await assert.rejects(
    resolveDeliveryExportTaskIds({ listAllDeliveryPoolTaskIds: async () => [] }, {
      scope: 'ALL_READY',
    }, actor),
    (error) => error?.code === 'DELIVERY_POOL_EMPTY',
  );
});

test('delivery export finishes every READY preflight before returning tasks', async () => {
  const events = [];
  const repository = {
    getTask: async (id) => {
      events.push(`task:${id}`);
      return {
        id,
        state: id === 2 ? 'MANUAL_ARCHIVE' : 'REVIEWED',
        currentCopyRevisionId: 100 + id,
        currentImageRunId: `run-${id}`,
      };
    },
    assertTaskReadyForDelivery: async (id) => {
      events.push(`ready:${id}`);
      return { taskId: id, copyRevisionId: 100 + id, imageRunId: `run-${id}` };
    },
  };
  await assert.rejects(
    loadReadyDeliveryTasks(repository, [1, 2, 3]),
    (error) => error?.code === 'INVALID_TASK_STATE',
  );
  assert.deepEqual(events, ['task:1', 'ready:1', 'task:2']);
});

test('prepared delivery downloads are actor-bound, one-time and expire with cleanup', async () => {
  let clock = 1_000;
  let cleanups = 0;
  const registry = createDeliveryExportRegistry({ ttlMs: 100, now: () => clock });
  const actor = {
    userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 3,
  };
  const staged = { cleanup: async () => { cleanups += 1; } };
  const prepared = registry.issue(staged, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  assert.equal(prepared.taskCount, 1);
  await assert.rejects(
    registry.take(prepared.downloadId, { ...actor, userId: 2 }),
    (error) => error?.code === 'NOT_FOUND',
  );
  const record = await registry.take(prepared.downloadId, actor);
  assert.equal(record.staged, staged);
  await assert.rejects(
    registry.take(prepared.downloadId, actor),
    (error) => error?.code === 'NOT_FOUND',
  );
  await registry.complete(prepared.downloadId, record);

  const expiring = registry.issue(staged, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 8, copyRevisionId: 18, imageRunId: 'run-8' }],
  });
  clock += 101;
  await assert.rejects(
    registry.take(expiring.downloadId, actor),
    (error) => error?.code === 'NOT_FOUND',
  );
  assert.equal(cleanups, 2);
});

test('an active delivery download remains inside account and global concurrency limits', async () => {
  let cleanups = 0;
  const registry = createDeliveryExportRegistry({ maxConcurrentPreparations: 2 });
  const actor = (userId) => ({
    userId, username: `admin-${userId}`, role: 'ADMIN', credentialVersion: 1,
  });
  const prepared = registry.issue({ cleanup: async () => { cleanups += 1; } }, actor(1), {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  const active = await registry.take(prepared.downloadId, actor(1));
  assert.equal(active.downloadSignal.aborted, false);
  assert.throws(
    () => registry.beginPreparation(actor(1)),
    (error) => error?.code === 'DELIVERY_EXPORT_IN_PROGRESS',
  );
  const releaseSecond = registry.beginPreparation(actor(2));
  assert.throws(
    () => registry.beginPreparation(actor(3)),
    (error) => error?.code === 'DELIVERY_EXPORT_BUSY',
  );
  releaseSecond();
  await registry.complete(prepared.downloadId, active);
  assert.equal(cleanups, 1);
});

test('registry shutdown aborts and cleans an active delivery download', async () => {
  let cleanups = 0;
  const registry = createDeliveryExportRegistry();
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const prepared = registry.issue({ cleanup: async () => { cleanups += 1; } }, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  const active = await registry.take(prepared.downloadId, actor);
  await registry.dispose();
  assert.equal(active.downloadSignal.aborted, true);
  assert.equal(cleanups, 1);
});

test('an active delivery download is aborted after making no progress', async () => {
  let cleanups = 0;
  const registry = createDeliveryExportRegistry({ downloadIdleTimeoutMs: 20 });
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const prepared = registry.issue({ cleanup: async () => { cleanups += 1; } }, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  const active = await registry.take(prepared.downloadId, actor);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.equal(active.downloadSignal.aborted, true);
  assert.equal(cleanups, 1);
  const release = registry.beginPreparation(actor);
  release();
  await registry.dispose();
});

test('download progress renews the active idle lease', async () => {
  const registry = createDeliveryExportRegistry({ downloadIdleTimeoutMs: 30 });
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const prepared = registry.issue({ cleanup: async () => {} }, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  const active = await registry.take(prepared.downloadId, actor);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(registry.touch(prepared.downloadId, active), true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(active.downloadSignal.aborted, false);
  await registry.complete(prepared.downloadId, active);
  await registry.dispose();
});

test('registry shutdown waits for a cleanup already started by download completion', async () => {
  let finishCleanup;
  const cleanupBlocked = new Promise((resolvePromise) => { finishCleanup = resolvePromise; });
  const registry = createDeliveryExportRegistry();
  const actor = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  const prepared = registry.issue({ cleanup: async () => cleanupBlocked }, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 7, copyRevisionId: 17, imageRunId: 'run-7' }],
  });
  const active = await registry.take(prepared.downloadId, actor);
  const completion = registry.complete(prepared.downloadId, active);
  let disposed = false;
  const disposal = registry.dispose().then(() => { disposed = true; });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(disposed, false);
  finishCleanup();
  await Promise.all([completion, disposal]);
  assert.equal(disposed, true);
});

test('HEAD-style lookup does not consume a prepared download', async () => {
  const registry = createDeliveryExportRegistry();
  const actor = {
    userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 3,
  };
  const staged = { cleanup: async () => {} };
  const prepared = registry.issue(staged, actor, {
    fileName: '交付池.zip',
    taskCount: 1,
    bindings: [{ taskId: 9, copyRevisionId: 19, imageRunId: 'run-9' }],
  });
  assert.equal((await registry.peek(prepared.downloadId, actor)).staged, staged);
  const active = await registry.take(prepared.downloadId, actor);
  assert.equal(active.staged, staged);
  await registry.complete(prepared.downloadId, active);
  await registry.dispose();
});

test('delivery export preparation is bounded globally and per account', async () => {
  const registry = createDeliveryExportRegistry({ maxConcurrentPreparations: 2 });
  const actor = (userId) => ({
    userId, username: `admin-${userId}`, role: 'ADMIN', credentialVersion: 1,
  });
  let aborted = 0;
  const releaseOne = registry.beginPreparation(actor(1), () => { aborted += 1; });
  assert.throws(
    () => registry.beginPreparation(actor(1)),
    (error) => error?.code === 'DELIVERY_EXPORT_IN_PROGRESS',
  );
  const releaseTwo = registry.beginPreparation(actor(2), () => { aborted += 1; });
  assert.throws(
    () => registry.beginPreparation(actor(3)),
    (error) => error?.code === 'DELIVERY_EXPORT_BUSY',
  );
  await registry.dispose();
  assert.equal(aborted, 2);
  releaseOne();
  releaseTwo();
});
