import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import JSZip from 'jszip';
import { createTaskArchivePreparation } from '../src/task-archive-preparation.mjs';

function task(id) {
  return { id, currentCopyRevisionId: 1, currentImageRunId: `run-${id}`, sourceClientBatchCode: '客户批次',
    copyRevisions: [{ id: 1, content: { copy: { title: `标题-${id}`, body: '正文' } } }],
    imageRuns: [{ id: `run-${id}`, result: { images: [{ assetId: id }] } }],
    assets: [{ id, taskId: id, imageRunId: `run-${id}`, mediaType: 'image/png' }] };
}
const image = content => ({ mediaType: 'image/png', originalName: '图.png', content });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-prepared-archives-'));
  const manager = createTaskArchivePreparation({ storageRoot: root, ...options });
  t.after(async () => { await manager.dispose(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, manager };
}
async function consume(stream) { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts); }

test('disk archives preserve flat single-task and grouped batch layouts and stream only after preparation', async t => {
  const { root, manager } = await fixture(t);
  const single = await manager.prepareTask(task(1), async () => image(Readable.from(['image-one'])));
  assert.ok(single.size > 0); assert.equal(single.taskCount, 1);
  const zip = await JSZip.loadAsync(await consume(await single.openStream()));
  assert.deepEqual(Object.keys(zip.files).sort(), ['01-图.png', '标题-1.txt']);
  assert.equal(await zip.file('01-图.png').async('string'), 'image-one');
  await single.dispose(); await assert.rejects(single.openStream(), /disposed/);
  const batch = await manager.prepareBatch([task(1), task(2)], async (_task, id) => image(Readable.from([`image-${id}`])));
  const bytes = await consume(await batch.openStream());
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  const outer = await JSZip.loadAsync(bytes);
  assert.equal(await outer.file('客户批次/任务-2-资源包/01-图.png').async('string'), 'image-2');
  await batch.dispose(); assert.deepEqual(await readdir(join(root, '.task-archives')), []);
});

test('bounded preparation rejects overload and cancellation releases both active and queued slots', { timeout: 5000 }, async t => {
  const { root, manager } = await fixture(t, { concurrency: 1, maxQueued: 1 });
  let loaded; const loading = new Promise(resolve => { loaded = resolve; });
  const source = new Readable({ read() {} }), firstAbort = new AbortController(), queuedAbort = new AbortController();
  const first = manager.prepareTask(task(1), async () => { loaded(); return image(source); }, { signal: firstAbort.signal });
  const firstFailure = assert.rejects(first, /cancelled|aborted/u); await loading;
  const queued = manager.prepareTask(task(2), async () => assert.fail('cancelled queue must not load assets'), { signal: queuedAbort.signal });
  const queuedFailure = assert.rejects(queued, /cancelled/u);
  assert.throws(() => manager.prepareTask(task(3), async () => image(Buffer.alloc(1))), { code: 'ARCHIVE_BUSY' });
  queuedAbort.abort(new Error('queued client cancelled')); await queuedFailure;
  firstAbort.abort(new Error('active client cancelled')); await firstFailure;
  assert.equal(source.destroyed, true);
  const next = await manager.prepareTask(task(4), async () => image(Readable.from(['recovered']))); await next.dispose();
  assert.deepEqual(await readdir(join(root, '.task-archives')), []);
});

test('disk bounds and source failures remove incomplete archives', { timeout: 5000 }, async t => {
  const { root, manager } = await fixture(t, { maxBytes: 32 });
  await assert.rejects(manager.prepareTask(task(1), async () => image(Readable.from(['large']))), { code: 'ARCHIVE_TOO_LARGE' });
  assert.deepEqual(await readdir(join(root, '.task-archives')), []);
  const second = await fixture(t);
  await assert.rejects(second.manager.prepareTask(task(2), async () => image(Readable.from((async function* () {
    yield Buffer.from('partial'); throw new Error('source failed');
  })()))), /source failed/);
  assert.deepEqual(await readdir(join(second.root, '.task-archives')), []);
});

test('preparation deadlines and service shutdown reject waiting jobs and close ready readers', { timeout: 5000 }, async t => {
  const { root, manager } = await fixture(t, { concurrency: 1, timeoutMs: 60 });
  await assert.rejects(manager.prepareTask(task(1), async () => image(new Readable({ read() {} }))), { code: 'ARCHIVE_TIMEOUT' });
  assert.deepEqual(await readdir(join(root, '.task-archives')), []);
  const second = await fixture(t);
  const ready = await second.manager.prepareTask(task(2), async () => image(Readable.from(['bytes'])));
  const reader = await ready.openStream(); await second.manager.dispose(); assert.equal(reader.destroyed, true);
  assert.deepEqual(await readdir(join(second.root, '.task-archives')), []);
});

test('orphan ZIP sweeps preserve prepared downloads and foreign files', async t => {
  const { root, manager } = await fixture(t);
  const prepared = await manager.prepareTask(task(1), async () => image(Readable.from(['image'])));
  const orphan = join(root, '.task-archives', `${randomUUID()}.zip`), unknown = join(root, '.task-archives', 'original.png');
  await writeFile(orphan, 'orphan'); await writeFile(unknown, 'original');
  const old = new Date(Date.now() - 2 * 60 * 60_000); await utimes(orphan, old, old); await utimes(prepared.path, old, old);
  await manager.sweep(); await assert.rejects(stat(orphan), { code: 'ENOENT' });
  assert.ok((await stat(prepared.path)).size > 0); assert.equal(await readFile(unknown, 'utf8'), 'original');
  await prepared.dispose();
});
