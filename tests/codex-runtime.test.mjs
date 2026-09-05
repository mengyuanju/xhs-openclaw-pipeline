import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime } from '../src/codex-runtime.mjs';

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
