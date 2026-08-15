import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const directories = [];
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function makeEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-cli-'));
  directories.push(directory);
  return {
    ...process.env,
    XHS_DATABASE_PATH: join(directory, 'queue.sqlite'),
    XHS_OUTPUT_ROOT: join(directory, 'output'),
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
});
