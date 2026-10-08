import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createStandaloneImageUploads, createUploadGate, normalizeUploadManifest } from '../src/standalone-image-uploads.mjs';

const actor = { userId: 1, credentialVersion: 1 };
const png = () => sharp({ create: { width: 1086, height: 1448, channels: 4, background: 'white' } }).png().toBuffer();

test('upload admission retains its limit after a queued cancellation and rejects overflow', async () => {
  const gate = createUploadGate({ concurrency: 1, maxQueued: 1 });
  let release, active = 0, maximum = 0;
  const first = gate.run(async () => { maximum = Math.max(maximum, ++active); await new Promise(done => { release = done; }); active--; });
  await new Promise(done => setImmediate(done));
  const controller = new AbortController();
  const cancelled = gate.run(() => assert.fail('cancelled waiter must not run'), { signal: controller.signal });
  await assert.rejects(gate.run(() => assert.fail('overflow must not run')), { code: 'UPLOAD_BUSY' });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const next = gate.run(async () => { maximum = Math.max(maximum, ++active); active--; });
  release();
  await Promise.all([first, next]);
  await gate.run(() => { maximum = Math.max(maximum, ++active); active--; });
  assert.equal(maximum, 1);
});

test('upload shutdown rejects queued and future work and waits for an admitted transaction', async () => {
  const gate = createUploadGate({ concurrency: 1 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const active = gate.run(async () => { entered.resolve(); await release.promise; return 123; });
  await entered.promise;
  const pending = gate.run(() => assert.fail('stopped queued upload must not commit'));
  const stopped = gate.dispose();
  await assert.rejects(pending, { code: 'UPLOAD_STOPPING' });
  await assert.rejects(gate.run(() => assert.fail('new upload after shutdown')), { code: 'UPLOAD_STOPPING' });
  release.resolve(); assert.equal(await active, 123); await stopped;
});

test('binary stages validate every file, survive restart, and keep failed commits atomic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'binary-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorize = async value => { assert.equal(value.credentialVersion, actor.credentialVersion); };
  const make = options => createStandaloneImageUploads({ storageRoot: root, authorize, ...options });
  const service = make(), requestId = randomUUID(), bytes = await png();
  const staged = await service.stage(requestId, 1, bytes, 'image/png', actor);
  assert.deepEqual(await make().stage(requestId, 1, bytes, 'image/png', actor), staged);
  await assert.rejects(service.stage(requestId, 2, bytes, 'image/jpeg', actor), /签名/u);
  const small = await sharp({ create: { width: 10, height: 10, channels: 4, background: 'red' } }).png().toBuffer();
  await assert.rejects(service.stage(requestId, 2, small, 'image/png', actor), /1086/u);
  let calls = 0;
  const input = { requestId, uploads: [{ ...staged, token: randomUUID() }] };
  await assert.rejects(service.commit(input, actor, () => { calls++; }), /凭据/u);
  assert.equal(calls, 0);
  input.uploads = [staged];
  await assert.rejects(service.commit(input, actor, () => { calls++; throw new Error('transaction failed'); }), /transaction failed/u);
  assert.equal(calls, 1);
  const result = await make().commit(input, actor, async (images, manifest) => {
    assert.equal(images.length, 1); assert.equal(manifest[0].token, staged.token);
    assert.deepEqual(await readFile(images[0].bytesFile), bytes);
    return { id: 123 };
  });
  assert.equal(result.id, 123);
  assert.equal((await readdir(join(root, 'image-editor-upload-staging'))).filter(name => name.endsWith('.png')).length, 0);
  await service.cancel(requestId, actor);
  assert.equal((await readdir(join(root, 'image-editor-upload-staging'))).length, 1, 'committed retry receipt stays until expiry');
  for (const bad of [[], [staged, staged], [{ index: 2, token: staged.token }], [{ index: 1, token: '../escape' }]]) assert.throws(() => normalizeUploadManifest(bad));
});

test('staging bounds disk use, repairs a crash before its receipt, and permits cleanup after credential rotation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'binary-upload-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await png();
  const authorize = async value => { assert.equal(value.credentialVersion, actor.credentialVersion); };
  const service = createStandaloneImageUploads({ storageRoot: root, authorize, maxBytes: bytes.length });
  const requestId = randomUUID(), staged = await service.stage(requestId, 1, bytes, 'image/png', actor);
  await assert.rejects(service.stage(randomUUID(), 1, bytes, 'image/png', actor), { code: 'UPLOAD_STORAGE_FULL' });
  await unlink(join(root, 'image-editor-upload-staging', `1-${requestId}-1.json`));
  const recovered = await service.stage(requestId, 1, bytes, 'image/png', actor);
  assert.notEqual(recovered.token, staged.token);
  actor.credentialVersion = 2;
  try { await service.cancel(requestId, actor); } finally { actor.credentialVersion = 1; }
  assert.deepEqual(await readdir(join(root, 'image-editor-upload-staging')), []);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(service.stage(randomUUID(), 1, bytes, 'image/png', actor, { signal: aborted.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(join(root, 'image-editor-upload-staging')), []);
  await writeFile(join(root, 'image-editor-upload-staging', 'untouched.txt'), 'user file');
  await service.sweep();
  assert.equal(await readFile(join(root, 'image-editor-upload-staging', 'untouched.txt'), 'utf8'), 'user file');
});
