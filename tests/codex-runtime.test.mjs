import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConcurrencyConfig, createCodexRuntime } from '../src/codex-runtime.mjs';

test('a surviving child keeps its permit after timeout and releases it after actual exit', async t => {
  const [runtime] = await runtimeFixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  await once(child, 'spawn');
  await assert.rejects(runtime.run(async ({ onSpawn }) => {
    onSpawn(child.pid);
    throw Object.assign(new Error('termination not confirmed'), { code: 'CODEX_EXEC_TIMEOUT' });
  }), { code: 'CODEX_EXEC_TIMEOUT' });
  assert.equal(runtime.status().active, 1);
  child.kill(); await closed;
  assert.equal(runtime.status().active, 0);
});

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

test('model capacity shares a bounded cooldown instead of consuming more task attempts', async (t) => {
  const [a, b] = await runtimeFixture(t);
  await assert.rejects(a.run(async () => { throw Object.assign(new Error('at capacity'), { code: 'CODEX_MODEL_AT_CAPACITY' }); }),
    { code: 'CODEX_MODEL_AT_CAPACITY' });
  assert.throws(() => b.assertAvailable(), { code: 'CODEX_MODEL_AT_CAPACITY', haltWorker: false });
  assert.ok(b.status().retryAt > Date.now());
  assert.ok(b.status().retryAt <= Date.now() + 65_000);
  assert.equal(b.status().active, 0);
});

test('named model capacity opens only that model circuit and routes a fallback', async (t) => {
  const [a, b] = await runtimeFixture(t);
  const primary = 'openai/gpt-5.6-sol';
  const fallback = 'openai/gpt-5.6-terra';
  await assert.rejects(a.run(async () => {
    throw Object.assign(new Error('at capacity'), { code: 'CODEX_MODEL_AT_CAPACITY' });
  }, { model: primary }), { code: 'CODEX_MODEL_AT_CAPACITY' });

  assert.equal(b.status().code, null, 'model capacity must not become an account-wide pause');
  assert.equal(b.selectModel([primary, fallback]).model, fallback);
  assert.throws(() => b.selectModel([primary]), { code: 'CODEX_MODEL_AT_CAPACITY' });
  assert.equal(await b.run(async () => 'fallback-ok', { model: fallback }), 'fallback-ok');
  assert.deepEqual(b.status().modelCooldowns.map(({ model }) => model), [primary]);
});

test('expired model cooldown permits one half-open probe and closes after success', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-probe-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, 'limits.sqlite'), pollMs: 5, modelCapacityCooldownMs: 60_000 };
  const a = createCodexRuntime(options), b = createCodexRuntime(options);
  const primary = 'openai/gpt-5.6-sol';
  const fallback = 'openai/gpt-5.6-terra';
  await assert.rejects(a.run(async () => {
    throw Object.assign(new Error('at capacity'), { code: 'CODEX_MODEL_AT_CAPACITY' });
  }, { model: primary }), { code: 'CODEX_MODEL_AT_CAPACITY' });
  t.mock.timers.tick(60_000);

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const probe = a.run(async () => { entered.resolve(); await release.promise; return 'primary-ok'; }, { model: primary });
  await entered.promise;
  assert.equal(b.selectModel([primary, fallback]).model, fallback, 'parallel callers must not duplicate the probe');
  release.resolve();
  assert.equal(await probe, 'primary-ok');
  assert.equal(b.selectModel([primary, fallback]).model, primary);
  assert.equal(b.status().modelCooldowns.length, 0);
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
