import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { startProgrammaticImageEditProcessing } from '../src/programmatic-image-edit-runner.mjs';
import { notifyProgrammaticImageEdits, startProgrammaticImageEditProcess } from '../src/programmatic-image-edit-supervisor.mjs';

const silent = { log() {}, error() {} };
function fixture(count) {
  const edits = Array.from({ length: count }, () => ({ id: randomUUID(), operation: 'SVG_DISCLOSURE', status: 'QUEUED', execution_id: null }));
  const service = {
    async recoverProgrammatic() { return { recovered: 0 }; },
    async claimProgrammatic(_worker, { editId, maxConcurrency }) {
      assert.equal(maxConcurrency, 2);
      const edit = edits.find(edit => edit.status === 'QUEUED' && (!editId || edit.id === editId));
      if (!edit) return null;
      edit.status = 'RUNNING';
      return edit;
    },
    claim() { assert.fail('generic model-capable claim must never be used'); },
  };
  return { edits, service };
}

test('programmatic submissions start immediately, run two at once, and refill without waiting for a scan', async () => {
  const { edits, service } = fixture(3);
  const entered = [], releases = new Map();
  const runner = startProgrammaticImageEditProcessing({ service, storageRoot: 'fixture' }, {
    intervalMs: 60_000, runImmediately: false, log: silent,
    processEdit: async ({ edit }) => {
      entered.push(edit.id);
      const gate = Promise.withResolvers();
      releases.set(edit.id, gate);
      await gate.promise;
      edit.status = 'PREVIEW_READY';
      return { status: 'PREVIEW_READY' };
    },
  });
  try {
    runner.wake(edits.map(edit => edit.id));
    await immediate();
    assert.deepEqual(entered, edits.slice(0, 2).map(edit => edit.id));
    assert.equal(edits[2].status, 'QUEUED');
    runner.wake([edits[0].id]);
    releases.get(edits[0].id).resolve();
    await immediate();
    assert.deepEqual(entered, edits.map(edit => edit.id));
  } finally {
    for (const release of releases.values()) release.resolve();
    await runner.stop();
  }
});

test('shutdown drains current programmatic work and leaves pending requests for the next worker', async () => {
  const { edits, service } = fixture(3);
  const release = Promise.withResolvers();
  const runner = startProgrammaticImageEditProcessing({ service, storageRoot: 'fixture' }, {
    intervalMs: 60_000, log: silent, processEdit: async () => { await release.promise; return { status: 'PREVIEW_READY' }; },
  });
  await immediate();
  let stopped = false;
  const stopping = runner.stop().then(() => { stopped = true; });
  await immediate();
  assert.equal(stopped, false);
  assert.equal(runner.wake([edits[2].id]), false);
  release.resolve();
  await stopping;
  assert.equal(edits[2].status, 'QUEUED');
});

test('a wakeup during an empty claim is retained and malformed notifications do not reach SQL', async () => {
  const { edits, service } = fixture(1);
  const gate = Promise.withResolvers();
  const original = service.claimProgrammatic;
  let claims = 0, runs = 0;
  service.claimProgrammatic = async (...args) => { if (++claims === 1) { await gate.promise; return null; } return original(...args); };
  const runner = startProgrammaticImageEditProcessing({ service, storageRoot: 'fixture' }, {
    intervalMs: 60_000, log: silent, processEdit: async ({ edit }) => { runs += 1; edit.status = 'PREVIEW_READY'; return { status: 'PREVIEW_READY' }; },
  });
  try {
    await immediate();
    runner.wake([edits[0].id]);
    assert.throws(() => runner.wake(['invalid']), /editId/u);
    gate.resolve();
    await immediate();
    assert.equal(runs, 1);
  } finally { gate.resolve(); await runner.stop(); }
});

test('programmatic runner refuses a model edit returned by a faulty claim implementation', async () => {
  const { edits, service } = fixture(1);
  edits[0].operation = 'TEXT';
  let calls = 0;
  const errors = [];
  const runner = startProgrammaticImageEditProcessing({ service, storageRoot: 'fixture' }, {
    intervalMs: 60_000, log: { error: message => errors.push(message) }, processEdit: () => { calls += 1; },
  });
  await immediate();
  await runner.stop();
  assert.equal(calls, 0);
  assert.match(errors.join('\n'), /only locally claimed programmatic/u);
});

test('programmatic notifications split within the PostgreSQL payload limit and use prepared parameters', async () => {
  const ids = Array.from({ length: 500 }, () => randomUUID());
  const calls = [];
  await notifyProgrammaticImageEdits({ query: async (sql, parameters) => calls.push({ sql, parameters }) }, ids);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.flatMap(call => JSON.parse(call.parameters[1])), ids);
  for (const call of calls) {
    assert.equal(call.sql, 'SELECT pg_notify($1, $2)');
    assert.ok(Buffer.byteLength(call.parameters[1]) < 8000);
  }
  await assert.rejects(() => notifyProgrammaticImageEdits({}, ['invalid']), /editId/u);
});

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, connected: true, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), sent: [] });
  child.send = (message, callback) => { child.sent.push(message); callback?.(null); };
  child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
  return child;
}

test('supervisor starts an isolated process, retains startup wakeups, and waits for graceful shutdown', async () => {
  const child = fakeChild(), ids = [randomUUID()];
  let options;
  const supervisor = startProgrammaticImageEditProcess({ connectionString: 'postgresql://fixture@localhost/test', storageRoot: 'fixture' }, {
    environment: {}, log: silent,
    forkProcess: (path, args, input) => { options = input; assert.match(path.pathname, /programmatic-image-edit-process\.mjs$/u); assert.deepEqual(args, []); return child; },
  });
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.PROGRAMMATIC_IMAGE_CONCURRENCY, '2');
  supervisor.wake(ids);
  assert.equal(child.sent.length, 0);
  child.emit('message', { type: 'ready' });
  assert.deepEqual(child.sent[0], { type: 'wake', editIds: ids });
  let stopped = false;
  const stopping = supervisor.stop().then(() => { stopped = true; });
  await immediate();
  assert.equal(stopped, false);
  assert.deepEqual(child.sent.at(-1), { type: 'stop' });
  child.emit('exit', 0);
  child.emit('close', 0);
  await stopping;
  assert.equal(stopped, true);
});

test('an asynchronous spawn failure without exit restarts once and close completes shutdown', async () => {
  const children = [], messages = [];
  const supervisor = startProgrammaticImageEditProcess({ connectionString: 'postgresql://fixture:private@localhost/test', storageRoot: 'fixture' }, {
    restartDelayMs: 5, log: { error: message => messages.push(message) }, environment: {},
    forkProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  try {
    children[0].pid = undefined;
    children[0].emit('error', new Error('postgresql://fixture:private@localhost/test could not start'));
    children[0].emit('close', 1);
    await delay(20);
    assert.equal(children.length, 2);
    assert.doesNotMatch(messages.join('\n'), /private/u);
    const stopping = supervisor.stop();
    children[1].emit('close', 0);
    await stopping;
  } finally { await supervisor.stop(); }
});
