import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installStandaloneImageEditorRoutes } from '../src/standalone-image-editor-routes.mjs';
import { createUploadGate } from '../src/standalone-image-uploads.mjs';

const nextTurn = () => new Promise(done => setImmediate(done));
const outcome = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));

async function occupySlots(gate, count = 2) {
  const entered = Array.from({ length: count }, () => Promise.withResolvers());
  const released = Array.from({ length: count }, () => Promise.withResolvers());
  const pending = entered.map((entry, index) => gate.run(async () => {
    entry.resolve();
    await released[index].promise;
    return index;
  }));
  await Promise.all(entered.map(entry => entry.promise));
  return { released, pending, release: () => released.forEach(entry => entry.resolve()) };
}

function routeFixture() {
  const handlers = new Map();
  const router = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, handler) => {
    handlers.set(`${method} ${path}`, handler);
  }]));
  const actor = { userId: 12, username: 'fake-user', role: 'USER', credentialVersion: 1 };
  let created = 0, databaseCalls = 0, responses = 0;
  const service = installStandaloneImageEditorRoutes(router, { pool: {
    async query() { databaseCalls++; assert.fail('cancelled upload must never reach the database'); },
    async connect() { databaseCalls++; assert.fail('cancelled upload must never open a transaction'); },
  } }, join(tmpdir(), 'standalone-upload-cancellation-unused'), {
    requestActor: () => actor,
    requireJson: ctx => ctx.input,
    json: (ctx, status, body) => { responses++; ctx.status = status; ctx.body = body; ctx.res.writableEnded = true; },
    readBody: () => assert.fail('workspace submission must not read a binary body'),
  });
  service.create = async (input, current) => {
    created++;
    assert.equal(current, actor);
    assert.equal(input.title, 'fake workspace');
    return { id: 123 };
  };
  const context = () => ({ req: new EventEmitter(), res: Object.assign(new EventEmitter(), { writableEnded: false }),
    input: { title: 'fake workspace', uploads: [] } });
  return { service, context, create: handlers.get('post /v1/image-editor/workspaces'),
    counts: () => ({ created, databaseCalls, responses }) };
}

for (const disconnect of ['request aborted', 'response close']) {
  test(`queued workspace submission stops on ${disconnect} before creating any data`, { timeout: 5_000 }, async () => {
    const fixture = routeFixture();
    const occupied = await occupySlots(fixture.service.uploads);
    const ctx = fixture.context();
    const settled = outcome(fixture.create(ctx));
    try {
      await nextTurn();
      if (disconnect === 'request aborted') ctx.req.emit('aborted');
      else ctx.res.emit('close');
      const result = await Promise.race([settled, nextTurn().then(() => ({ status: 'pending' }))]);
      assert.equal(result.status, 'rejected', 'disconnected queued request must settle without waiting for a slot');
      assert.equal(result.error.name, 'AbortError');
      assert.deepEqual(fixture.counts(), { created: 0, databaseCalls: 0, responses: 0 });
      assert.equal(ctx.req.listenerCount('aborted'), 0);
      assert.equal(ctx.res.listenerCount('close'), 0);

      occupied.release();
      await Promise.all(occupied.pending);
      await nextTurn();
      assert.deepEqual(fixture.counts(), { created: 0, databaseCalls: 0, responses: 0 }, 'freeing slots must not resurrect the cancelled commit');

      const retry = fixture.context();
      await fixture.create(retry);
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.body, { id: 123 });
      assert.deepEqual(fixture.counts(), { created: 1, databaseCalls: 0, responses: 1 });
      assert.equal(retry.req.listenerCount('aborted'), 0);
      assert.equal(retry.res.listenerCount('close'), 0);
    } finally {
      occupied.release();
      await Promise.allSettled([...occupied.pending, settled]);
      await fixture.service.uploads.dispose();
    }
  });
}

for (const disconnected of ['request already aborted', 'response already destroyed']) {
  test(`queued workspace submission rejects a ${disconnected} before route listeners attach`, { timeout: 5_000 }, async () => {
    const fixture = routeFixture();
    const occupied = await occupySlots(fixture.service.uploads);
    const ctx = fixture.context();
    if (disconnected === 'request already aborted') ctx.req.aborted = true;
    else ctx.res.destroyed = true;
    const settled = outcome(fixture.create(ctx));
    try {
      const result = await Promise.race([settled, nextTurn().then(() => ({ status: 'pending' }))]);
      assert.equal(result.status, 'rejected', 'an earlier disconnect must not need a second event to cancel the queued request');
      assert.equal(result.error.name, 'AbortError');
      assert.deepEqual(fixture.counts(), { created: 0, databaseCalls: 0, responses: 0 });
      assert.equal(ctx.req.listenerCount('aborted'), 0);
      assert.equal(ctx.res.listenerCount('close'), 0);
      occupied.release();
      await Promise.all(occupied.pending);
      await nextTurn();
      assert.deepEqual(fixture.counts(), { created: 0, databaseCalls: 0, responses: 0 });
    } finally {
      occupied.release();
      await Promise.allSettled([...occupied.pending, settled]);
      await fixture.service.uploads.dispose();
    }
  });
}

test('upload shutdown rejects queued and future submissions and waits for every active operation', { timeout: 5_000 }, async () => {
  const gate = createUploadGate({ concurrency: 2 });
  const occupied = await occupySlots(gate);
  const controllers = [new AbortController(), new AbortController()];
  const queued = controllers.map(controller => outcome(gate.run(() => assert.fail('queued work must not run during shutdown'), { signal: controller.signal })));
  let disposed = false;
  let disposal;
  try {
    await nextTurn();
    controllers.forEach(controller => assert.equal(getEventListeners(controller.signal, 'abort').length, 1));
    disposal = gate.dispose().then(() => { disposed = true; });
    for (const result of await Promise.all(queued)) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.error.code, 'UPLOAD_STOPPING');
    }
    controllers.forEach(controller => {
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      controller.abort();
    });
    await assert.rejects(gate.run(() => assert.fail('new work must not enter a stopped gate')), { code: 'UPLOAD_STOPPING' });
    assert.equal(disposed, false);
    occupied.released[0].resolve();
    assert.equal(await occupied.pending[0], 0);
    await nextTurn();
    assert.equal(disposed, false, 'shutdown must wait for the second admitted operation');
    const repeatedDisposal = gate.dispose();
    occupied.released[1].resolve();
    assert.equal(await occupied.pending[1], 1);
    await Promise.all([disposal, repeatedDisposal]);
    assert.equal(disposed, true);
    await gate.dispose();
    await assert.rejects(gate.run(() => assert.fail('disposed gate must stay closed')), { code: 'UPLOAD_STOPPING' });
  } finally {
    occupied.release();
    await Promise.allSettled([...occupied.pending, ...queued]);
    if (disposal) await disposal;
  }
});

test('a queued cancellation frees queue capacity without releasing an occupied upload slot', { timeout: 5_000 }, async () => {
  const gate = createUploadGate({ concurrency: 2, maxQueued: 2 });
  const held = Array.from({ length: 4 }, () => Promise.withResolvers());
  const entered = Array.from({ length: 4 }, () => Promise.withResolvers());
  let active = 0, maximum = 0;
  const action = index => async () => {
    maximum = Math.max(maximum, ++active);
    entered[index].resolve();
    try { await held[index].promise; }
    finally { active--; }
  };
  const admitted = [gate.run(action(0)), gate.run(action(1))];
  await Promise.all([entered[0].promise, entered[1].promise]);
  const controller = new AbortController();
  const cancelled = outcome(gate.run(() => assert.fail('aborted queue entry must never run'), { signal: controller.signal }));
  const firstQueued = gate.run(action(2));
  const pending = [...admitted, firstQueued];
  try {
    controller.abort();
    assert.equal((await cancelled).error.name, 'AbortError');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const secondQueued = gate.run(action(3));
    pending.push(secondQueued);
    await assert.rejects(gate.run(() => assert.fail('full queue must reject excess work')), { code: 'UPLOAD_BUSY' });
    assert.equal(active, 2, 'cancelled queue entry must not release either active slot');
    held[0].resolve();
    await entered[2].promise;
    assert.equal(active, 2);
    held[1].resolve();
    await entered[3].promise;
    assert.equal(active, 2);
    held[2].resolve(); held[3].resolve();
    await Promise.all(pending);
    await gate.run(() => { maximum = Math.max(maximum, ++active); active--; });
    assert.equal(active, 0);
    assert.equal(maximum, 2);
  } finally {
    held.forEach(entry => entry.resolve());
    await Promise.allSettled(pending);
    await gate.dispose();
  }
});
