import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { main } from '../src/cli.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function makeEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-cli-'));
  directories.push(directory);
  return {
    ...process.env,
    XHS_DATABASE_PATH: join(directory, 'queue.sqlite'),
    XHS_OUTPUT_ROOT: join(directory, 'output'),
    XHS_ASSET_ROOT: join(directory, 'assets'),
  };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env,
  });
}

function memoryStream() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    read() { return value; },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CLI', () => {
  it('initializes, enqueues, reports status and runs one mock task', async () => {
    const env = await makeEnvironment();

    assert.equal(runCli(['init'], env).status, 0);
    const enqueued = runCli([
      'enqueue',
      '--query',
      '租房卧室的桌面总是乱，怎么做低成本整理？',
    ], env);
    assert.equal(enqueued.status, 0, enqueued.stderr);
    assert.equal(JSON.parse(enqueued.stdout).status, 'pending');

    const before = runCli(['status'], env);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).counts.pending, 1);

    const worker = runCli(['worker', '--once', '--mock'], env);
    assert.equal(worker.status, 0, worker.stderr);
    assert.equal(JSON.parse(worker.stdout).status, 'completed');

    const after = runCli(['status'], env);
    assert.equal(JSON.parse(after.stdout).counts.completed, 1);
  });

  it('rejects worker mode without the explicit --once safety flag', async () => {
    const env = await makeEnvironment();

    const result = runCli(['worker', '--mock'], env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--once/);
  });

  it('rejects unknown flags instead of accidentally consuming live quota', async () => {
    const env = await makeEnvironment();

    const result = runCli(['worker', '--once', '--mokk'], env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown option.*--mokk/i);
  });

  it('drains an explicit bounded mock batch and syncs deliveries for review', async () => {
    const env = await makeEnvironment();
    const store = createAdminStore(env.XHS_DATABASE_PATH);
    const batch = store.createImportBatch({
      name: 'CLI drain', sourceFileName: 'drain.xlsx',
      rows: [1, 2].map((number) => ({
        rowNumber: number + 1,
        externalId: `drain-${number}`,
        query: `第 ${number} 条批量任务`,
        input: {}, imageCount: 3, referenceImageFiles: [], errors: [],
        screening: { admitted: true, demandLevel: 'STRONG', reason: '测试准入行', source: 'EXCEL' },
      })),
    });
    store.commitImportBatch(batch.id);
    store.close();

    const result = runCli(['drain', '--mock', '--max', '10'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).contentCompleted, 2);

    const check = createAdminStore(env.XHS_DATABASE_PATH);
    try {
      assert.equal(check.getDashboardStats().reviews.waiting, 2);
    } finally { check.close(); }
  });

  it('requires an explicit mode and maximum for batch drain', async () => {
    const env = await makeEnvironment();
    assert.match(runCli(['drain', '--max', '10'], env).stderr, /--mock or --live/i);
    assert.match(runCli(['drain', '--mock'], env).stderr, /--max/i);
    assert.match(runCli(['drain', '--mock', '--max', '2', '--concurrency', '3'], env).stderr,
      /--concurrency.*between 1 and 2/i);
  });

  it('runs two content tasks concurrently while forcing one image call per task', async () => {
    const env = await makeEnvironment();
    const stdout = memoryStream();
    const stderr = memoryStream();
    const calls = [];
    let releaseTasks;
    let signalStarted;
    const tasksStarted = new Promise((resolve) => { signalStarted = resolve; });
    const gate = new Promise((resolve) => { releaseTasks = resolve; });

    const running = main(['drain', '--mock', '--max', '2', '--concurrency', '2'], {
      env,
      stdout,
      stderr,
      async processContentTask(options) {
        calls.push(options);
        if (calls.length === 2) signalStarted();
        await gate;
        return { status: 'completed', taskId: calls.length };
      },
    });
    const signal = await Promise.race([
      tasksStarted.then(() => 'started'),
      running.then(() => 'completed'),
    ]);
    releaseTasks();

    assert.equal(signal, 'started');
    assert.equal(await running, 0, stderr.read());
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map(({ workerId }) => workerId)).size, 2);
    assert.ok(calls.every(({ imageConcurrency }) => imageConcurrency === 1));
    const summary = JSON.parse(stdout.read());
    assert.equal(summary.concurrency, 2);
    assert.equal(summary.contentCompleted, 2);
  });

  it('fails live batch preflight before claiming a queued task', async () => {
    const env = await makeEnvironment();
    const queue = createQueue(env.XHS_DATABASE_PATH);
    const task = queue.enqueue({ query: '预检失败时不得领取的任务' });
    queue.close();
    const stdout = memoryStream();
    const stderr = memoryStream();
    let preflightCalls = 0;

    const exitCode = await main(['drain', '--live', '--max', '1'], {
      env,
      stdout,
      stderr,
      createOpenClaw() {
        return {
          checkReady() {
            preflightCalls += 1;
            throw new Error('OpenClaw batch preflight failed: auth unavailable');
          },
        };
      },
    });

    const check = createQueue(env.XHS_DATABASE_PATH);
    try {
      assert.equal(exitCode, 1);
      assert.equal(preflightCalls, 1);
      assert.match(stderr.read(), /preflight failed.*auth unavailable/iu);
      assert.equal(stdout.read(), '');
      assert.equal(check.get(task.id).status, 'pending');
      assert.equal(check.get(task.id).attempts, 0);
    } finally {
      check.close();
    }
  });

  it('keeps a live drain open until a delayed retry reaches a terminal result', async () => {
    const env = await makeEnvironment();
    const seed = createQueue(env.XHS_DATABASE_PATH);
    seed.enqueue({ query: '由 drain 自己完成退避重试的任务' });
    seed.openCircuit('openclaw-auth', { reason: 'stale auth failure' });
    seed.close();
    const stdout = memoryStream();
    const stderr = memoryStream();
    const sleeps = [];
    let calls = 0;

    const exitCode = await main(['drain', '--live', '--max', '1', '--concurrency', '1'], {
      env,
      stdout,
      stderr,
      createOpenClaw() {
        return { checkReady() { return { textModel: 'fake', imageModel: 'fake' }; } };
      },
      async processContentTask({ queue, workerId, recoveryEnabled }) {
        calls += 1;
        assert.equal(recoveryEnabled, true);
        const task = queue.claimNext({ workerId });
        if (!task) return { status: 'idle' };
        if (task.attempts === 1) {
          const scheduled = queue.scheduleRetry(task.id, {
            workerId,
            error: 'fetch failed: ECONNRESET',
            failureClass: 'TRANSIENT',
            delayMs: 20,
          });
          return {
            status: 'retry_scheduled',
            taskId: task.id,
            nextAttemptAt: scheduled.nextAttemptAt,
            recovery: { failureClass: 'TRANSIENT', delayMs: 20 },
          };
        }
        queue.complete(task.id, { workerId, outputDir: 'output/recovered' });
        return { status: 'completed', taskId: task.id };
      },
      async processImageEditTask() {
        return { status: 'idle' };
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
      },
    });

    assert.equal(exitCode, 0, stderr.read());
    const summary = JSON.parse(stdout.read());
    assert.equal(summary.processed, 1);
    assert.equal(summary.attempted, 2);
    assert.equal(summary.contentCompleted, 1);
    assert.equal(summary.retriesScheduled, 1);
    assert.ok(sleeps.length >= 1);
    const check = createQueue(env.XHS_DATABASE_PATH);
    try {
      assert.equal(check.get(1).status, 'completed');
      assert.equal(check.getCircuit('openclaw-auth').status, 'CLOSED');
    } finally {
      check.close();
    }
  });

  it('halts a live drain when task recovery reports an auth circuit break', async () => {
    const env = await makeEnvironment();
    const stdout = memoryStream();
    const stderr = memoryStream();
    let calls = 0;

    const exitCode = await main(['drain', '--live', '--max', '2', '--concurrency', '1'], {
      env,
      stdout,
      stderr,
      createOpenClaw() {
        return { checkReady() {} };
      },
      async processContentTask() {
        calls += 1;
        return {
          status: 'failed',
          taskId: 1,
          recovery: { failureClass: 'AUTH', haltWorker: true, manualRequired: true },
        };
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(calls, 1);
    const summary = JSON.parse(stdout.read());
    assert.equal(summary.status, 'authentication_required');
    assert.equal(summary.failed, 1);
    assert.equal(summary.manualRequired, 1);
  });
});
