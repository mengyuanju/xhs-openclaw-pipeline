import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { processNext } from '../src/pipeline.mjs';
import { processNextImageEdit } from '../src/admin/image-edit-worker.mjs';
import { createCodexRuntime } from '../src/codex-runtime.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';
import { createQueue } from '../src/queue.mjs';
import { main } from '../src/cli.mjs';

const TEMPORARY_CODES = ['CODEX_MODEL_AT_CAPACITY', 'CODEX_RATE_LIMITED'];
const PERMANENT_CODES = ['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED'];

async function fixture(t, code) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-worker-capacity-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const databasePath = join(root, 'runtime.sqlite');
  const producer = createCodexRuntime({ databasePath });
  const runtime = createCodexRuntime({ databasePath });
  if (code) await assert.rejects(producer.run(async () => { throw Object.assign(new Error(code), { code }); }), { code });
  const env = {
    XHS_DATABASE_PATH: join(root, 'queue.sqlite'),
    XHS_OUTPUT_ROOT: join(root, 'output'),
    XHS_ASSET_ROOT: join(root, 'assets'),
    XHS_KNOWLEDGE_ROOT: join(root, 'knowledge'),
  };
  const client = {
    checkReady() {},
    assertAvailable: () => runtime.assertAvailable(),
    runText() { assert.fail('cooling workers must not invoke text models'); },
    runImage() { assert.fail('cooling workers must not invoke image models'); },
    runImageEdit() { assert.fail('cooling workers must not invoke image-edit models'); },
  };
  return { root, runtime, env, client, onCleanup: cleanup => cleanups.push(cleanup) };
}

function stream() {
  let value = '';
  return { write(chunk) { value += String(chunk); }, read() { return value; } };
}

for (const code of TEMPORARY_CODES) {
  test(`content and image-edit pre-claim gates recover after shared ${code} cooldown`, async t => {
    const { root, runtime, client } = await fixture(t, code);
    const retryAt = runtime.status().retryAt;
    let contentClaims = 0;
    let imageClaims = 0;
    const content = () => processNext({ queue: { claimNext() { contentClaims++; return null; } },
      workerId: 'content', outputRoot: root, openclaw: client });
    const image = () => processNextImageEdit({ store: { claimNextImageEdit() { imageClaims++; return null; } },
      workerId: 'image', assetRoot: root, openclaw: client });

    const blocked = await Promise.all([content(), image()]);
    assert.deepEqual([contentClaims, imageClaims], [0, 0]);
    for (const result of blocked) {
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, code);
      assert.equal(result.retryAt, retryAt);
      assert.equal(result.haltWorker, false, 'temporary capacity must not become a permanent worker stop');
    }
    t.mock.timers.tick(retryAt - Date.now());
    assert.deepEqual(await Promise.all([content(), image()]), [{ status: 'idle' }, { status: 'idle' }]);
    assert.deepEqual([contentClaims, imageClaims], [1, 1]);
  });
}

for (const code of PERMANENT_CODES) {
  test(`${code} remains blocked across time in both local entry points`, async t => {
    const { root, client } = await fixture(t, code);
    for (const elapsed of [0, 120_000]) {
      t.mock.timers.tick(elapsed);
      const content = await processNext({ queue: { claimNext() { assert.fail('permanent pause claimed content'); } },
        workerId: 'content', outputRoot: root, openclaw: client });
      const image = await processNextImageEdit({ store: { claimNextImageEdit() { assert.fail('permanent pause claimed an image edit'); } },
        workerId: 'image', assetRoot: root, openclaw: client });
      for (const result of [content, image]) {
        assert.equal(result.reason, code);
        assert.equal(result.haltWorker, true);
      }
    }
  });
}

test('worker --once reports capacity as temporary without claiming work or entering another lane', async t => {
  const { env, client, onCleanup } = await fixture(t, 'CODEX_MODEL_AT_CAPACITY');
  const queue = createQueue(env.XHS_DATABASE_PATH);
  onCleanup(() => queue.close());
  const task = queue.enqueue({ query: '单次 worker 冷却期间保留任务' });
  const stdout = stream(), stderr = stream();
  const exitCode = await main(['worker', '--once'], { env, stdout, stderr,
    createOpenClaw: () => client,
    processImageEditTask() { assert.fail('blocked content must not fall through to image edits'); },
    sleep() { assert.fail('--once must retain its single-pass contract'); },
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr.read(), '');
  assert.equal(queue.get(task.id).status, 'pending');
  assert.equal(queue.get(task.id).attempts, 0);
  assert.equal(JSON.parse(stdout.read()).haltWorker, false);
});

for (const code of TEMPORARY_CODES) {
  test(`live drain waits for ${code} without spending task attempts, then resumes`, async t => {
    const { env, runtime, client, onCleanup } = await fixture(t, code);
    const queue = createQueue(env.XHS_DATABASE_PATH);
    onCleanup(() => queue.close());
    const task = queue.enqueue({ query: '容量恢复后继续处理' });
    const stdout = stream(), stderr = stream(), sleeps = [];
    let models = 0;
    const exitCode = await main(['drain', '--live', '--max', '1', '--concurrency', '1'], {
      env, stdout, stderr, createOpenClaw: () => client,
      async processContentTask(options) {
        if (runtime.status().code) return processNext(options);
        const claimed = options.queue.claimNext({ workerId: options.workerId });
        assert.equal(claimed.id, task.id);
        models++;
        options.queue.complete(claimed.id, { workerId: options.workerId, outputDir: 'fixture-completed' });
        return { status: 'completed', taskId: claimed.id };
      },
      processImageEditTask() { assert.fail('cooldown must stop all model lanes before image-edit dispatch'); },
      async sleep(milliseconds) {
        assert.ok(milliseconds > 0 && milliseconds <= 60_000);
        assert.equal(queue.get(task.id).attempts, 0);
        assert.equal(models, 0);
        sleeps.push(milliseconds);
        assert.ok(sleeps.length <= 2, 'cooldown must not spin in tiny increments');
        t.mock.timers.tick(milliseconds);
      },
    });
    assert.equal(exitCode, 0, stderr.read());
    assert.ok(sleeps.length > 0);
    assert.equal(models, 1);
    assert.equal(queue.get(task.id).attempts, 1);
    assert.equal(queue.get(task.id).status, 'completed');
    assert.equal(JSON.parse(stdout.read()).attempted, 1);
  });
}

test('live drain honors a non-halting capacity result without falling through to the image-edit lane', async t => {
  const { env, runtime, client } = await fixture(t, 'CODEX_MODEL_AT_CAPACITY');
  const stdout = stream(), stderr = stream(), sleeps = [];
  let contentCalls = 0;
  const exitCode = await main(['drain', '--live', '--max', '1', '--concurrency', '1'], {
    env, stdout, stderr, createOpenClaw: () => client,
    async processContentTask() {
      contentCalls++;
      const state = runtime.status();
      return state.code ? { status: 'blocked', reason: state.code, haltWorker: false, retryAt: state.retryAt }
        : { status: 'completed', taskId: 1 };
    },
    processImageEditTask() { assert.fail('capacity result incorrectly fell through to image-edit work'); },
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      assert.ok(sleeps.length <= 2);
      t.mock.timers.tick(milliseconds);
    },
  });
  assert.equal(exitCode, 0, stderr.read());
  assert.ok(sleeps.length > 0);
  assert.equal(contentCalls, sleeps.length + 1);
});

for (const code of TEMPORARY_CODES) {
  test(`live drain survives ${code} already active during startup readiness`, async t => {
    const { env, runtime, client } = await fixture(t, code);
    const stdout = stream(), stderr = stream(), sleeps = [];
    let readinessCalls = 0, contentCalls = 0;
    client.checkReady = () => { readinessCalls++; runtime.assertAvailable(); };
    const exitCode = await main(['drain', '--live', '--max', '1', '--concurrency', '1'], {
      env, stdout, stderr, createOpenClaw: () => client,
      async processContentTask() {
        runtime.assertAvailable();
        contentCalls++;
        return { status: 'completed', taskId: 1 };
      },
      processImageEditTask() { assert.fail('startup cooldown must not dispatch image edits'); },
      async sleep(milliseconds) {
        assert.equal(contentCalls, 0);
        assert.ok(milliseconds > 0 && milliseconds <= 60_000);
        sleeps.push(milliseconds);
        assert.ok(sleeps.length <= 2);
        t.mock.timers.tick(milliseconds);
      },
    });
    assert.equal(exitCode, 0, stderr.read());
    assert.ok(readinessCalls >= 2);
    assert.ok(sleeps.length > 0);
    assert.equal(contentCalls, 1);
  });
}

for (const code of TEMPORARY_CODES) {
  test(`live drain waits after an actual ${code} call failure and preserves bounded recovery`, async t => {
    const { env, runtime, client, onCleanup } = await fixture(t);
    const queue = createQueue(env.XHS_DATABASE_PATH);
    onCleanup(() => queue.close());
    const task = queue.enqueue({ query: '模型持续繁忙时保留有限恢复次数' });
    const stdout = stream(), stderr = stream(), callTimes = [];
    let sleeps = 0;
    client.checkReady = () => runtime.assertAvailable();
    client.runText = () => runtime.run(async () => {
      callTimes.push(Date.now());
      throw Object.assign(new Error(code), { code });
    });
    const exitCode = await main(['drain', '--live', '--max', '1', '--concurrency', '1'], {
      env, stdout, stderr, createOpenClaw: () => client,
      processContentTask: options => processNext({ ...options, configProvider: undefined, onFailed: undefined }),
      processImageEditTask() {
        runtime.assertAvailable();
        return { status: 'idle' };
      },
      async sleep(milliseconds) {
        assert.ok(milliseconds > 0 && milliseconds <= 60_000);
        assert.ok(++sleeps <= 6, 'waiting must be bounded by cooldown and task recovery deadlines');
        const waiting = queue.get(task.id);
        assert.equal(waiting.attempts, callTimes.length, 'waiting must not add another claim');
        assert.equal(waiting.recoveryTotalAttempts, callTimes.length, 'only actual failures consume recovery budget');
        t.mock.timers.tick(milliseconds);
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(stderr.read(), '');
    assert.equal(callTimes.length, 3, 'persistent overload must stop at the existing retry limit');
    for (let index = 1; index < callTimes.length; index++) {
      assert.ok(callTimes[index] - callTimes[index - 1] >= 65_000);
    }
    const failed = queue.get(task.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.recoveryTotalAttempts, 2);
    const summary = JSON.parse(stdout.read());
    assert.equal(summary.status, 'completed_with_failures');
    assert.equal(summary.attempted, 3);
    assert.equal(summary.retriesScheduled, 2);
    assert.equal(summary.manualRequired, 1);
  });
}

for (const code of PERMANENT_CODES) {
  test(`live drain does not automatically wait through startup ${code}`, async t => {
    const { env, runtime, client } = await fixture(t, code);
    const stdout = stream(), stderr = stream();
    client.checkReady = () => runtime.assertAvailable();
    const exitCode = await main(['drain', '--live', '--max', '1'], {
      env, stdout, stderr, createOpenClaw: () => client,
      processContentTask() { assert.fail('permanently paused startup claimed content'); },
      processImageEditTask() { assert.fail('permanently paused startup claimed an image edit'); },
      sleep() { assert.fail('auth/quota require an explicit recovery, not automatic sleep'); },
    });
    assert.equal(exitCode, 1);
    assert.match(stderr.read(), new RegExp(code, 'u'));
  });
}

test('central executor shares capacity cooldown across both claim lanes and resumes without model retries', async t => {
  const { runtime } = await fixture(t, 'CODEX_MODEL_AT_CAPACITY');
  const retryAt = runtime.status().retryAt;
  let claims = 0, models = 0;
  const claim = () => { claims++; return { task: { id: claims }, execution: { id: `execution-${claims}` } }; };
  const agent = createExecutorAgent({ nodeId: 'capacity-fixture', imageWorkerEnabled: true,
    readinessCheck: async () => {}, availabilityCheck: () => runtime.assertAvailable(),
    executeCopy: async () => { models++; }, executeImage: async () => { models++; },
    controlPlane: { claimCopy: claim, claimImage: claim,
      claimCopyBatch: () => { claims++; return { claims: [] }; },
      claimImageBatch: () => { claims++; return { claims: [] }; },
    },
  });
  await agent.prepare();
  const paused = await Promise.all([agent.runCopyOnce(), agent.runImageOnce(),
    agent.claimBatch('COPY', { limit: 1, requestId: 'copy-batch' }),
    agent.claimBatch('IMAGE', { limit: 1, requestId: 'image-batch' })]);
  for (const result of paused) {
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.code, 'CODEX_MODEL_AT_CAPACITY');
    assert.equal(result.retryAt, retryAt);
  }
  assert.deepEqual([claims, models], [0, 0]);
  t.mock.timers.tick(retryAt - Date.now());
  const resumed = await Promise.all([agent.runCopyOnce(), agent.runImageOnce()]);
  assert.ok(resumed.every(result => result.status === 'SUCCEEDED'));
  assert.deepEqual([claims, models], [2, 2]);
});
