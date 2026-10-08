import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { createTaskArchivePreparation } from '../src/task-archive-preparation.mjs';
import { writeTaskArchive } from '../src/task-archive.mjs';

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function task(id = 1) {
  return {
    id, currentCopyRevisionId: 1, currentImageRunId: 'run',
    copyRevisions: [{ id: 1, content: { copy: { title: '归档生命周期', body: '正文' } } }],
    imageRuns: [{ id: 'run', result: { images: [{ assetId: id }] } }],
    assets: [{ id, taskId: id, imageRunId: 'run', mediaType: 'image/png' }],
  };
}

const image = content => ({ mediaType: 'image/png', originalName: '01.png', content });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-archive-lifecycle-'));
  const manager = createTaskArchivePreparation({ storageRoot: root, concurrency: 1, timeoutMs: 3000 });
  t.after(async () => {
    await manager.dispose();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}

test('cancelled preparation waits for the input close before rejecting and destroys it once', { timeout: 5000 }, async t => {
  const { manager } = await fixture(t);
  const reading = deferred(), destroying = deferred(), allowClose = deferred();
  let destroyCount = 0, closeCount = 0;
  const source = new Readable({
    read() { reading.resolve(); },
    destroy(error, callback) {
      destroyCount += 1;
      destroying.resolve();
      void allowClose.promise.then(() => callback(error));
    },
  });
  source.once('close', () => { closeCount += 1; });
  t.after(() => { allowClose.resolve(); source.destroy(); });
  const controller = new AbortController();
  const reason = new Error('archive client cancelled');
  const outcome = manager.prepareTask(task(), async () => image(source), { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  await reading.promise;
  controller.abort(reason);
  await destroying.promise;
  const beforeClose = await Promise.race([outcome, delay(40).then(() => ({ pending: true }))]);
  allowClose.resolve();
  const result = await outcome;
  assert.equal(beforeClose.pending, true, 'preparation must remain pending while the input descriptor is closing');
  assert.equal(result.error, reason);
  assert.equal(source.closed, true, 'rejection must not leave an input close pending');
  assert.equal(destroyCount, 1);
  assert.equal(closeCount, 1);
});

test('abort settles a blocked finalization and closes output and input exactly once', { timeout: 5000 }, async t => {
  const finalizing = deferred(), allowFinalize = deferred();
  const originalFinalize = ZipArchive.prototype.finalize;
  // Hold the finalization waiter independently of buffering and disk scheduling.
  // The output is also held below, so the outer pipeline cannot finish normally.
  t.mock.method(ZipArchive.prototype, 'finalize', function (...args) {
    void originalFinalize.apply(this, args).catch(() => {});
    finalizing.resolve();
    return allowFinalize.promise;
  });
  const controller = new AbortController();
  const source = Readable.from([Buffer.from('image bytes')]);
  let sourceCloses = 0, outputCloses = 0, outputDestroys = 0, releaseWrite;
  source.once('close', () => { sourceCloses += 1; });
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { releaseWrite = callback; },
    destroy(error, callback) { outputDestroys += 1; callback(error); },
  });
  output.once('close', () => { outputCloses += 1; });
  function releaseOutputWrite() {
    const callback = releaseWrite;
    releaseWrite = undefined;
    callback?.();
  }
  t.after(() => { allowFinalize.resolve(); releaseOutputWrite(); source.destroy(); output.destroy(); });
  const outcome = writeTaskArchive(task(), async () => image(source), output, { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  await finalizing.promise;
  assert.equal(typeof releaseWrite, 'function', 'the destination must be under backpressure at finalization');
  controller.abort(new Error('cancel while finalizing'));
  const cancelled = await Promise.race([outcome, delay(200).then(() => ({ timedOut: true }))]);
  // Release the test gate even if the old writer waited on finalize forever.
  allowFinalize.resolve();
  releaseOutputWrite();
  const result = await outcome;
  assert.notEqual(cancelled.timedOut, true, 'abort must reject without waiting for finalization to complete');
  assert.match(result.error?.message ?? '', /cancel|abort/iu);
  assert.equal(output.closed, true);
  assert.equal(source.closed, true);
  assert.equal(outputDestroys, 1);
  assert.equal(outputCloses, 1);
  assert.equal(sourceCloses, 1);
});

test('successful preparation closes its asset FileHandle and disposal closes a ready reader once', { timeout: 5000 }, async t => {
  const { root, manager } = await fixture(t);
  const imagePath = join(root, 'input.png');
  await writeFile(imagePath, 'original image bytes');
  const handle = await open(imagePath, 'r');
  const source = handle.createReadStream();
  let sourceCloses = 0, readerCloses = 0;
  source.once('close', () => { sourceCloses += 1; });
  t.after(async () => { source.destroy(); await handle.close(); });
  const artifact = await manager.prepareTask(task(), async () => image(source));
  assert.equal(source.closed, true, 'an archive must not become ready while its input handle is closing');
  assert.equal(sourceCloses, 1);
  await assert.rejects(handle.stat(), { code: 'EBADF' });
  const reader = await artifact.openStream();
  reader.once('close', () => { readerCloses += 1; });
  await artifact.dispose();
  assert.equal(reader.closed, true);
  assert.equal(readerCloses, 1);
  await manager.dispose();
  assert.equal(sourceCloses, 1);
  assert.equal(readerCloses, 1);
});
