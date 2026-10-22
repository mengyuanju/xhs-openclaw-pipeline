import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishImmutableFile, withImmutableFileLock } from '../src/immutable-file-publication.mjs';
import { loadDeliverySnapshot, removeDeliverySnapshot, saveDeliverySnapshot } from '../src/delivery-snapshots.mjs';

function error(code) { return Object.assign(new Error(code), { code }); }
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'xhs-immutable-publication-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'xhs-immutable-publication-')));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, path: join(root, 'snapshot.json') };
}

function wrappedHandle(handle, overrides = {}) {
  return { writeFile: handle.writeFile.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle), ...overrides };
}

function snapshot() {
  const text = Buffer.from('冻结正文'), entryName = '任务-1-资源包/文案.txt';
  const manifest = { version: 1, publicId: randomUUID(), sourceArchive: { sha256: 'a'.repeat(64), byteSize: 123 },
    entries: [{ entryName, taskId: 1, kind: 'text', byteSize: text.length, sha256: hash(text), contentBase64: text.toString('base64') }],
    members: [{ taskId: 1, directory: '任务-1-资源包', files: [entryName], byteSize: text.length }],
    taskSnapshots: [{ id: 1, query: '冻结问题', currentCopyRevisionId: 7, copyRevisions: [{ id: 7, content: { copy: { title: '标题', body: '正文' } } }] }] };
  return { ...manifest, manifestSha256: hash(JSON.stringify(manifest)) };
}

test('immutable publication works when hard links and explicit file sync are unavailable', async t => {
  const data = await fixture(t);
  let links = 0;
  const removableFs = { ...fs, link: async () => { links += 1; throw error('ENOSYS'); },
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return path.endsWith('.tmp') ? wrappedHandle(handle, { sync: async () => { throw error('EPERM'); } }) : handle;
    } };
  const content = JSON.stringify({ frozen: 'complete metadata' });
  assert.deepEqual(await publishImmutableFile(data.path, content, { fs: removableFs }), { created: true });
  assert.deepEqual(await publishImmutableFile(data.path, content, { fs: removableFs }), { created: false });
  assert.equal(await fs.readFile(data.path, 'utf8'), content);
  assert.equal(links, 0);
  assert.deepEqual(await fs.readdir(data.root), ['snapshot.json']);
});

test('concurrent identical writers publish once and never rename over an existing destination', async t => {
  const data = await fixture(t), content = JSON.stringify({ values: Array.from({ length: 1000 }, (_, index) => index) });
  let renames = 0;
  const checkedFs = { ...fs, rename: async (source, destination) => {
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
    renames += 1; return fs.rename(source, destination);
  } };
  const results = await Promise.all(Array.from({ length: 24 }, () => publishImmutableFile(data.path, content, { fs: checkedFs, pollIntervalMs: 1 })));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(renames, 1);
  assert.equal(await fs.readFile(data.path, 'utf8'), content);
  assert.deepEqual(await fs.readdir(data.root), ['snapshot.json']);
});

test('conflicting concurrent writers leave one complete JSON and reject all other versions', async t => {
  const data = await fixture(t), contents = Array.from({ length: 16 }, (_, writer) => JSON.stringify({ writer, text: 'x'.repeat(10_000) }));
  const results = await Promise.allSettled(contents.map(content => publishImmutableFile(data.path, content, { pollIntervalMs: 1 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'IMMUTABLE_FILE_CONFLICT'));
  const actual = await fs.readFile(data.path, 'utf8');
  assert.ok(contents.includes(actual));
  assert.equal(JSON.parse(actual).text.length, 10_000);
  assert.deepEqual(await fs.readdir(data.root), ['snapshot.json']);
});

test('readers cannot see a partial JSON while a temporary file is still being written', async t => {
  const data = await fixture(t), started = deferred(), release = deferred(), contents = JSON.stringify({ body: 'x'.repeat(100_000) });
  const slowFs = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return !path.endsWith('.tmp') ? handle : wrappedHandle(handle, { writeFile: async bytes => {
      const half = Math.floor(bytes.length / 2);
      await handle.writeFile(bytes.subarray(0, half));
      started.resolve(); await release.promise;
      await handle.writeFile(bytes.subarray(half));
    } });
  } };
  const first = publishImmutableFile(data.path, contents, { fs: slowFs });
  try {
    await started.promise;
    await assert.rejects(fs.readFile(data.path), { code: 'ENOENT' });
    const second = publishImmutableFile(data.path, contents, { pollIntervalMs: 1 });
    release.resolve();
    assert.deepEqual(await first, { created: true });
    assert.deepEqual(await second, { created: false });
    assert.equal(await fs.readFile(data.path, 'utf8'), contents);
  } finally { release.resolve(); await first.catch(() => {}); }
});

test('failed writes, file flushes, and renames leave no published file, temporary file, or owned lock', async t => {
  for (const failure of ['write', 'sync', 'rename']) await t.test(failure, async child => {
    const data = await fixture(child);
    const failingFs = { ...fs,
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args);
        return !path.endsWith('.tmp') ? handle : wrappedHandle(handle, {
          ...(failure === 'write' ? { writeFile: async () => { throw error('ENOSPC'); } } : {}),
          ...(failure === 'sync' ? { sync: async () => { throw error('EIO'); } } : {}),
        });
      },
      ...(failure === 'rename' ? { rename: async () => { throw error('EIO'); } } : {}),
    };
    await assert.rejects(publishImmutableFile(data.path, '{"complete":true}', { fs: failingFs }), { code: failure === 'write' ? 'ENOSPC' : 'EIO' });
    assert.deepEqual(await fs.readdir(data.root), []);
  });
});

test('an externally created destination is compared and retained instead of being replaced', async t => {
  const data = await fixture(t), unexpected = Buffer.from('{"external":true}');
  const competingFs = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return !path.endsWith('.tmp') ? handle : wrappedHandle(handle, { sync: async () => {
      await handle.sync(); await fs.writeFile(data.path, unexpected, { flag: 'wx' });
    } });
  }, rename: async () => { assert.fail('an existing destination must never be renamed over'); } };
  await assert.rejects(publishImmutableFile(data.path, '{"ours":true}', { fs: competingFs }), { code: 'IMMUTABLE_FILE_CONFLICT' });
  assert.deepEqual(await fs.readFile(data.path), unexpected);
  assert.deepEqual(await fs.readdir(data.root), ['snapshot.json']);
});

test('busy locks time out with manual recovery guidance and are never stolen', async t => {
  const data = await fixture(t), lockPath = `${data.path}.publish.lock`, locked = JSON.stringify({ pid: process.pid, token: 'another owner' });
  await fs.writeFile(lockPath, locked);
  await assert.rejects(publishImmutableFile(data.path, '{}', { lockTimeoutMs: 10, pollIntervalMs: 1 }), error => {
    assert.equal(error.code, 'IMMUTABLE_FILE_BUSY');
    assert.match(error.message, /人工清理/u);
    return true;
  });
  assert.equal(await fs.readFile(lockPath, 'utf8'), locked);
  assert.deepEqual(await fs.readdir(data.root), ['snapshot.json.publish.lock']);
});

test('cancellation while holding a lock cleans the incomplete temporary file before releasing it', async t => {
  const data = await fixture(t), started = deferred(), release = deferred(), controller = new AbortController();
  const slowFs = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return !path.endsWith('.tmp') ? handle : wrappedHandle(handle, { writeFile: async bytes => {
      started.resolve(); await release.promise; await handle.writeFile(bytes);
    } });
  } };
  const operation = publishImmutableFile(data.path, '{"complete":true}', { fs: slowFs, signal: controller.signal });
  await started.promise;
  controller.abort(new Error('publication cancelled')); release.resolve();
  await assert.rejects(operation, /publication cancelled/u);
  assert.deepEqual(await fs.readdir(data.root), []);
});

test('removal uses the same lock and waits until a concurrent publication has completed', async t => {
  const data = await fixture(t), started = deferred(), release = deferred();
  const slowFs = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return !path.endsWith('.tmp') ? handle : wrappedHandle(handle, { writeFile: async bytes => {
      started.resolve(); await release.promise; await handle.writeFile(bytes);
    } });
  } };
  const publication = publishImmutableFile(data.path, '{}', { fs: slowFs });
  await started.promise;
  let removed = false;
  const removal = withImmutableFileLock(data.path, async ({ path, fs }) => { await fs.unlink(path); removed = true; }, { pollIntervalMs: 1 });
  assert.equal(removed, false);
  release.resolve(); await publication; await removal;
  assert.equal(removed, true);
  assert.deepEqual(await fs.readdir(data.root), []);
});

test('a destination symlink cannot replace or modify an external file', async t => {
  const data = await fixture(t), external = join(data.root, 'external.json');
  await fs.writeFile(external, 'external original');
  try { await fs.symlink(external, data.path); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  await assert.rejects(publishImmutableFile(data.path, '{}'), { code: 'IMMUTABLE_FILE_CONFLICT' });
  assert.equal(await fs.readFile(external, 'utf8'), 'external original');
  assert.equal((await fs.lstat(data.path)).isSymbolicLink(), true);
  assert.deepEqual((await fs.readdir(data.root)).sort(), ['external.json', 'snapshot.json']);
});

test('delivery snapshot publication keeps frozen metadata, idempotence and conflicts on a filesystem without hard links', async t => {
  const data = await fixture(t), frozen = snapshot();
  const noLinks = { ...fs, link: async () => { assert.fail('snapshot publication must not require hard links'); } };
  await Promise.all(Array.from({ length: 12 }, () => saveDeliverySnapshot(data.root, frozen, { fs: noLinks, pollIntervalMs: 1 })));
  assert.deepEqual(await loadDeliverySnapshot(data.root, frozen.publicId), frozen);
  const changed = structuredClone(frozen);
  changed.sourceArchive.sha256 = 'b'.repeat(64);
  const { manifestSha256, ...manifest } = changed;
  changed.manifestSha256 = hash(JSON.stringify(manifest));
  await assert.rejects(saveDeliverySnapshot(data.root, changed, { fs: noLinks }), { code: 'DELIVERY_SNAPSHOT_CONFLICT' });
  assert.deepEqual(await loadDeliverySnapshot(data.root, frozen.publicId), frozen);
  assert.deepEqual(await fs.readdir(join(data.root, '.delivery-snapshots')), [`${frozen.publicId}.json`]);
  await removeDeliverySnapshot(data.root, frozen.publicId, { fs: noLinks });
  assert.deepEqual(await fs.readdir(join(data.root, '.delivery-snapshots')), []);
});
