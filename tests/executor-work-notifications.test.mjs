import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createControlPlaneClient, ControlPlaneApiError } from '../src/control-plane/client.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';
import { createExecutorWorkNotifications } from '../src/executor/work-notifications.mjs';
import { runExecutor } from '../src/executor/runtime.mjs';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const payload = overrides => ({ epoch: 'epoch-a', revision: 0, settingsRevision: 0, changed: false, timedOut: false, ...overrides });
function transportFixture() {
  const requests = [];
  const waitForWork = (cursor, { signal }) => {
    const pending = Promise.withResolvers();
    const abort = () => pending.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    requests.push({ ...pending, cursor, signal });
    return pending.promise.finally(() => signal.removeEventListener('abort', abort));
  };
  const statuses = [], wakes = [], invalidations = [], errors = [];
  const scheduler = { setWorkNotificationsOnline: value => statuses.push(value), wake: () => wakes.push(true) };
  return { requests, waitForWork, statuses, wakes, invalidations, errors, scheduler };
}

test('notification client preserves configured authentication, validates cursors and bounds transport timeout', async t => {
  let response = payload();
  let expectedCursor = { nodeId: 'node-a', epoch: null, revision: null, timeoutMs: 20000 };
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; });
  const client = createControlPlaneClient({ baseUrl: 'http://localhost', headers: { Authorization: 'Bearer fake-test-token' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://localhost/v1/executions/work-notifications/wait');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
      assert.deepEqual(JSON.parse(options.body), expectedCursor);
      return Response.json({ data: response });
    },
  });
  assert.deepEqual(await client.waitForWorkNotifications({ nodeId: 'node-a' }), response);
  assert.equal(timeouts[0], 25000);
  for (const invalid of [null, {}, payload({ epoch: '' }), payload({ revision: -1 }), payload({ revision: 0.5 }),
    payload({ settingsRevision: undefined }), payload({ changed: 'true' }), payload({ changed: true, timedOut: true })]) {
    response = invalid;
    await assert.rejects(client.waitForWorkNotifications({ nodeId: 'node-a' }), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
  }
  await assert.rejects(client.waitForWorkNotifications({ nodeId: 'node-a', epoch: 'epoch-a' }), /incomplete/);
  await assert.rejects(client.waitForWorkNotifications({ nodeId: 'node-a', timeoutMs: 20001 }), /20000/);
  expectedCursor = { nodeId: 'node-a', epoch: 'epoch-a', revision: 0, timeoutMs: 20000 };
  response = payload({ revision: 1, changed: false, timedOut: true });
  await assert.rejects(client.waitForWorkNotifications(expectedCursor), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
});

test('notification caller cancellation aborts the HTTP wait', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers();
  const client = createControlPlaneClient({ baseUrl: 'http://localhost', fetchImpl: async (_url, { signal }) => {
    entered.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const running = client.waitForWorkNotifications({ nodeId: 'node-a' }, { signal: controller.signal });
  const signal = await entered.promise;
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
});

test('handshake and changed revisions wake; normal wait timeouts stay online; settings and epoch changes invalidate cache', async () => {
  const f = transportFixture();
  const worker = createExecutorWorkNotifications({ ...f, invalidateSettings: () => f.invalidations.push(true) });
  const running = worker.start();
  assert.deepEqual(f.requests[0].cursor, { epoch: null, revision: null, timeoutMs: 20000 });
  assert.equal(worker.status().online, false);
  f.requests[0].resolve(payload()); await settle();
  assert.equal(worker.status().online, true); assert.equal(f.wakes.length, 1); assert.equal(f.invalidations.length, 1);
  f.requests[1].resolve(payload({ timedOut: true })); await settle();
  assert.equal(worker.status().online, true); assert.equal(f.wakes.length, 1);
  f.requests[2].resolve(payload({ revision: 1, changed: true })); await settle();
  assert.equal(f.wakes.length, 2); assert.equal(f.invalidations.length, 1);
  f.requests[3].resolve(payload({ revision: 2, settingsRevision: 1, changed: true })); await settle();
  assert.equal(f.wakes.length, 3); assert.equal(f.invalidations.length, 2);
  f.requests[4].resolve(payload({ epoch: 'epoch-b', changed: true })); await settle();
  assert.equal(f.wakes.length, 4); assert.equal(f.invalidations.length, 3);
  assert.deepEqual(f.requests[5].cursor, { epoch: 'epoch-b', revision: 0, timeoutMs: 20000 });
  await worker.dispose(); await running;
  assert.equal(f.requests[5].signal.aborted, true);
  assert.equal(worker.status().online, false);
});

test('transport failures immediately go offline and reconnect with jitter using the retained cursor', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = transportFixture();
  const worker = createExecutorWorkNotifications({ ...f, reconnectMs: 1000, random: () => 0,
    onError: error => f.errors.push(error.message) });
  const running = worker.start();
  f.requests[0].resolve(payload()); await settle();
  f.requests[1].reject(new Error('connection lost')); await settle();
  assert.equal(worker.status().online, false); assert.equal(f.statuses.at(-1), false);
  t.mock.timers.tick(799); await settle(); assert.equal(f.requests.length, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2].cursor, { epoch: 'epoch-a', revision: 0, timeoutMs: 20000 });
  f.requests[2].resolve(payload({ timedOut: true })); await settle();
  assert.equal(worker.status().online, true); assert.equal(f.wakes.length, 2);
  assert.deepEqual(f.errors, ['connection lost']);
  await worker.dispose(); await running;
});

test('404 disables notifications and stopping cancels a reconnect wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = transportFixture();
  const unsupported = createExecutorWorkNotifications({ ...old });
  const ended = unsupported.start();
  old.requests[0].reject(new ControlPlaneApiError(404, 'NOT_FOUND', 'old center'));
  await ended;
  assert.equal(unsupported.status().online, false);
  assert.equal(old.requests.length, 1);
  const f = transportFixture();
  const worker = createExecutorWorkNotifications({ ...f, reconnectMs: 5000 });
  const running = worker.start();
  f.requests[0].reject(new Error('offline')); await settle();
  await worker.dispose(); await running;
  t.mock.timers.tick(10000); await settle();
  assert.equal(f.requests.length, 1);
});

test('once runs and older center capabilities never subscribe', async () => {
  for (const options of [{ once: true, capability: 1 }, { once: false, capability: undefined }]) {
    const host = new EventEmitter();
    let claims = 0;
    await runExecutor({ host, configuration: { nodeId: 'test', pollMs: 5, once: options.once, copyConcurrency: 1 },
      log: { log() {}, error() {} }, agent: {
        prepare: async () => ({ health: { capabilities: { executionWorkNotificationsVersion: options.capability } } }),
        register: async () => {}, heartbeat: async () => {},
        waitForWorkNotifications: async () => assert.fail('this run must not subscribe'),
        claimBatch: async (_kind, request) => { claims++; if (!options.once) host.emit('SIGTERM'); return { requestId: request.requestId, claims: [] }; },
      },
    });
    assert.equal(claims, 1);
    assert.equal(host.listenerCount('SIGTERM'), 0);
  }
});

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('notification integration did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('real HTTP notification wakes an idle real executor agent and delivers one fake-model task without quota', { timeout: 10000 }, async t => {
  const host = new EventEmitter();
  const waits = new Set(), receipts = new Map();
  let revision = 0, settingsRevision = 0, settingsReads = 0, taskReady = false, completionCount = 0, claimCount = 0;
  let publishedAt = null, executedAt = null, notificationAborted = false;
  const executionId = randomUUID();
  const send = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data })); };
  const notification = overrides => payload({ epoch: 'http-fixture', revision, settingsRevision, ...overrides });
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      if (req.url === '/health') return send(res, { ok: true, capabilities: { executionWorkNotificationsVersion: 1 } });
      if (req.url === '/v1/nodes') return send(res, {});
      if (req.url === '/v1/settings') { settingsReads++; return send(res, [{ key: 'production', value: { version: settingsRevision } }]); }
      if (req.url === '/v1/executions/work-notifications/wait') {
        if (body.epoch === null) return send(res, notification());
        if (body.epoch !== 'http-fixture' || body.revision !== revision) return send(res, notification({ changed: true }));
        const timer = setTimeout(() => { waits.delete(res); send(res, notification({ timedOut: true })); }, body.timeoutMs);
        waits.add(res);
        res.on('close', () => { clearTimeout(timer); if (waits.delete(res)) notificationAborted = true; });
        return;
      }
      if (req.url === '/v1/executions/claim-copy-batch') {
        claimCount++;
        let claims = receipts.get(body.requestId);
        if (!claims) {
          claims = taskReady ? [{ task: { id: 1, state: 'COPY_RUNNING', currentExecutionId: executionId },
            execution: { id: executionId, taskId: 1, nodeId: body.nodeId, kind: 'COPY', status: 'RUNNING', snapshot: {} } }] : [];
          taskReady = false; receipts.set(body.requestId, claims);
        }
        return send(res, { requestId: body.requestId, claims });
      }
      if (req.url === `/v1/executions/${executionId}/complete-copy`) { completionCount++; return send(res, {}); }
      res.statusCode = 404; send(res, null);
    } catch (error) { if (!res.destroyed) { res.statusCode = 500; send(res, { message: error.message }); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { host.emit('SIGTERM'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const agent = createExecutorAgent({ nodeId: 'http-wake-fixture', controlPlane: client,
    readinessCheck: async ({ controlPlane }) => ({ health: await controlPlane.health() }),
    availabilityCheck: async ({ controlPlane }) => { await controlPlane.listSettings(); },
    executeCopy: async ({ claim, controlPlane }) => { executedAt = Date.now(); await controlPlane.completeCopy(claim.execution.id, { copy: { title: 'fake fixture' } }); },
  });
  const errors = [];
  const running = runExecutor({ agent, host, configuration: { nodeId: 'http-wake-fixture', copyConcurrency: 1,
    imageConcurrency: 1, pollMs: 500, idleMaxPollMs: 2000, once: false }, log: { log() {}, error: text => errors.push(text) } });
  await until(() => claimCount >= 3 && waits.size === 1);
  const readsBefore = settingsReads;
  revision++; settingsRevision++; taskReady = true; publishedAt = Date.now();
  for (const res of [...waits]) { waits.delete(res); send(res, notification({ changed: true })); }
  await until(() => completionCount === 1);
  assert.ok(executedAt - publishedAt < 300, 'notification wakes the idle pool before its next 1000ms poll');
  assert.ok(settingsReads > readsBefore, 'settings notification invalidates a warm cache before fresh claiming');
  host.emit('SIGTERM'); await running;
  await until(() => waits.size === 0);
  assert.equal(notificationAborted, true);
  assert.equal(completionCount, 1);
  assert.deepEqual(errors, []);
});
