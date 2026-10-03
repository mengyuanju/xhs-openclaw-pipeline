import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createThumbnailCache } from '../src/thumbnail-cache.mjs';
import { createAssetDelivery } from '../src/asset-delivery.mjs';

const hash = 'a'.repeat(64), name = id => `${id}-${hash}-thumb-480-v1.webp`;
async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-thumb-cache-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function derivative(root, task, id, size, ageMs = 0) {
  const directory = join(root, 'thumbnails', String(task)); await mkdir(directory, { recursive: true });
  const path = join(directory, name(id)); await writeFile(path, Buffer.alloc(size, id));
  const time = new Date(Date.now() - ageMs); await utimes(path, time, time); return path;
}

test('bounded thumbnail sweeps enforce capacity and age while preserving originals and unknown files', async t => {
  const root = await rootFixture(t), original = join(root, name(99)); await writeFile(original, 'original');
  const paths = await Promise.all([derivative(root, 1, 1, 8, 4000), derivative(root, 1, 2, 8, 3000), derivative(root, 1, 3, 8, 2000)]);
  const unknown = join(root, 'thumbnails', '1', 'upload.webp'); await writeFile(unknown, 'unknown');
  const cache = createThumbnailCache(root, { maxBytes: 8, maxFiles: 1, sweepEntries: 4 });
  t.after(() => cache.dispose());
  for (let i = 0; i < 5; i += 1) { const result = await cache.sweep(); assert.ok(result.scanned <= 4); assert.ok(result.removed <= 4); }
  assert.equal((await Promise.all(paths.map(path => stat(path).catch(() => null)))).filter(Boolean).length, 1);
  assert.equal(await readFile(original, 'utf8'), 'original'); assert.equal(await readFile(unknown, 'utf8'), 'unknown');
  const expired = await derivative(root, 2, 4, 1, 9 * 24 * 60 * 60_000);
  const partial = `${await derivative(root, 2, 5, 1)}.${randomUUID()}.tmp`;
  await writeFile(partial, 'partial'); const old = new Date(Date.now() - 2 * 60 * 60_000); await utimes(partial, old, old);
  const releasePartial = await cache.pin(partial);
  for (let i = 0; i < 6; i += 1) await cache.sweep();
  await assert.rejects(stat(expired), { code: 'ENOENT' }); assert.ok((await stat(partial)).size > 0);
  releasePartial(); for (let i = 0; i < 3; i += 1) await cache.sweep();
  await assert.rejects(stat(partial), { code: 'ENOENT' });
  assert.equal(await readFile(original, 'utf8'), 'original');
});

function context() {
  return { query: { variant: 'thumbnail' }, method: 'GET', fresh: false, set() {}, body: null };
}
async function consume(stream) {
  const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts);
}

test('concurrent generation and sweeps preserve pinned read bytes and delete only after close', async t => {
  const root = await rootFixture(t), source = join(root, 'original.png');
  const original = await sharp({ create: { width: 600, height: 400, channels: 4, background: '#33669980' } }).png().toBuffer();
  await writeFile(source, original);
  const deliver = createAssetDelivery({ storageRoot: root, thumbnailCache: { maxBytes: 1, sweepIntervalMs: 0 } });
  t.after(() => deliver.dispose());
  const asset = { id: 1, taskId: 1, sha256: hash, mediaType: 'image/png' };
  const contexts = Array.from({ length: 12 }, () => context());
  await Promise.all(contexts.map(ctx => deliver(ctx, asset, source)));
  await deliver.sweep();
  const path = join(root, 'thumbnails', '1', name(1)); assert.ok((await stat(path)).size > 0);
  const images = await Promise.all(contexts.map(ctx => consume(ctx.body)));
  assert.ok(images.every(image => image.equals(images[0])));
  assert.equal((await sharp(images[0]).metadata()).width, 480);
  await deliver.sweep(); await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readdir(join(root, 'thumbnails', '1')), []);
});

test('thumbnail directory links and foreign cache names are never traversed for cleanup', async t => {
  const root = await rootFixture(t), outside = join(root, 'originals'); await mkdir(outside);
  const original = join(outside, name(1)); await writeFile(original, 'original');
  await mkdir(join(root, 'thumbnails')); await symlink(outside, join(root, 'thumbnails', '1'), process.platform === 'win32' ? 'junction' : 'dir');
  const cache = createThumbnailCache(root); t.after(() => cache.dispose());
  // Dirent links are ignored, and remember cannot make an original a removable candidate.
  cache.remember(original, { size: 8, mtimeMs: 0 }); await cache.sweep();
  assert.equal(await readFile(original, 'utf8'), 'original');
  const deliver = createAssetDelivery({ storageRoot: root }); t.after(() => deliver.dispose());
  await assert.rejects(deliver(context(), { id: 1, taskId: 1, sha256: hash, mediaType: 'image/png' }, original), /link/);
  assert.equal(await readFile(original, 'utf8'), 'original');
});
