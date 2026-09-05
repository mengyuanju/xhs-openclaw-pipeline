import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConcurrencyConfig, createCodexRuntime } from '../src/codex-runtime.mjs';

test('Codex total and image capacity configuration is independent and strictly bounded', () => {
  assert.deepEqual(codexConcurrencyConfig({}), { maxConcurrent: 2, maxConcurrentImages: 1 });
  assert.deepEqual(codexConcurrencyConfig({ XHS_CODEX_CONCURRENCY: '5', XHS_CODEX_IMAGE_CONCURRENCY: '2' }),
    { maxConcurrent: 5, maxConcurrentImages: 2 });
  for (const name of ['XHS_CODEX_CONCURRENCY', 'XHS_CODEX_IMAGE_CONCURRENCY']) {
    for (const value of ['', ' ', '0', '-1', '1.5', '33', '0x2']) {
      assert.throws(() => codexConcurrencyConfig({ [name]: value }), /integer/);
    }
  }
  assert.throws(() => codexConcurrencyConfig({ XHS_CODEX_CONCURRENCY: '1', XHS_CODEX_IMAGE_CONCURRENCY: '2' }), /total/);
});

test('configured runtime admits two images and three text calls without crossing either ceiling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-configured-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, 'limits.sqlite'), maxConcurrent: 5, maxConcurrentImages: 2, pollMs: 5 };
  const a = createCodexRuntime(options), b = createCodexRuntime(options);
  const gate = Promise.withResolvers();
  let entered = 0, imageCount = 0;
  const work = image => async () => { entered++; if (image) imageCount++; await gate.promise; };
  const jobs = [a.run(work(true), { image: true }), b.run(work(true), { image: true }),
    a.run(work(false)), b.run(work(false)), a.run(work(false))];
  try {
    for (let i = 0; i < 50 && entered < 5; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(entered, 5);
    assert.equal(imageCount, 2);
    await assert.rejects(b.run(() => assert.fail('full runtime admitted work'), { waitMs: 0 }), { code: 'CODEX_QUEUE_TIMEOUT' });
    const conflict = createCodexRuntime({ databasePath: options.databasePath, maxConcurrent: 6, maxConcurrentImages: 3 });
    await assert.rejects(conflict.run(() => assert.fail('conflicting configuration admitted work')), { code: 'CODEX_CONCURRENCY_MISMATCH' });
  } finally { gate.resolve(); await Promise.all(jobs); }
  assert.equal(a.status().active, 0);
});

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-limit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, 'limits.sqlite'), pollMs: 5 };
  return [createCodexRuntime(options), createCodexRuntime(options)];
}

test('independent runtime instances share two total slots and one image slot', async (t) => {
  const [a, b] = await runtimeFixture(t);
  let active = 0; let images = 0; let peak = 0; let peakImages = 0;
  const work = (image) => async () => {
    active++; if (image) images++;
    peak = Math.max(peak, active); peakImages = Math.max(peakImages, images);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--; if (image) images--;
  };
  await Promise.all([a.run(work(true), { image: true }), b.run(work(true), { image: true }),
    a.run(work(false)), b.run(work(false))]);
  assert.equal(peak, 2);
  assert.equal(peakImages, 1);
  assert.equal(a.status().active, 0);
});

test('auth/quota failures pause other instances until explicit reset', async (t) => {
  const [a, b] = await runtimeFixture(t);
  for (const code of ['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED']) {
    await assert.rejects(a.run(async () => { throw Object.assign(new Error('paused'), { code }); }), { code });
    await assert.rejects(b.run(async () => assert.fail('must not start')), { code });
    assert.equal(b.status().active, 0);
    b.reset();
    assert.equal(await a.run(async () => 'ok'), 'ok');
  }
});

test('queued cancellation never starts an operation or leaks a permit', async (t) => {
  const [a, b] = await runtimeFixture(t);
  let release; let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const first = a.run(async () => { started(); await new Promise((resolve) => { release = resolve; }); }, { image: true });
  await entered;
  const controller = new AbortController();
  const pending = b.run(async () => assert.fail('cancelled work ran'), { image: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release(); await first;
  assert.equal(a.status().active, 0);
});

test('rate limiting shares a timed cooldown without unlimited automatic retries', async (t) => {
  const [a, b] = await runtimeFixture(t);
  await assert.rejects(a.run(async () => { throw Object.assign(new Error('429'), { code: 'CODEX_RATE_LIMITED' }); }), { code: 'CODEX_RATE_LIMITED' });
  assert.throws(() => b.assertAvailable(), { code: 'CODEX_RATE_LIMITED' });
  assert.ok(b.status().retryAt > Date.now());
});

for (const [total, images] of [[2, 1], [5, 2]]) {
test(`separate Node processes obey shared ${total}/${images} concurrency limits`, { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-process-limits-'));
  const databasePath = join(root, 'limits.sqlite');
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    await rm(root, { recursive: true, force: true });
  });
  const flags = [...Array(images).fill('image'), ...Array(total - images).fill('text'), 'image', 'text'];
  for (const image of flags) {
    const child = fork(new URL('./fixtures/codex-limit-child.mjs', import.meta.url), [databasePath, image, String(total), String(images)],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    children.push(child);
    assert.equal((await once(child, 'message'))[0].type, 'ready');
  }
  const entered = children.map((child) => once(child, 'message'));
  children.slice(0, total).forEach(child => child.send('go'));
  await Promise.all(entered.slice(0, total));
  children.slice(total).forEach(child => child.send('go'));
  let queuedEntered = false;
  void Promise.race(entered.slice(total)).then(() => { queuedEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(queuedEntered, false);
  const limits = createCodexRuntime({ databasePath });
  assert.equal(limits.status().active, total);
  assert.equal(limits.status().images, images);
  const firstClosed = children.slice(0, total).map(child => once(child, 'close'));
  children.slice(0, total).forEach(child => child.send('release'));
  await Promise.all([...firstClosed, ...entered.slice(total)]);
  assert.equal(limits.status().active, 2);
  assert.equal(limits.status().images, 1);
  const closed = children.slice(total).map((child) => once(child, 'close'));
  children.slice(total).forEach(child => child.send('release'));
  await Promise.all(closed);
  assert.equal(limits.status().active, 0);
});
}
