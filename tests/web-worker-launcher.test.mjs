import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createWebWorkerLauncher,
  WorkerRunConflictError,
} from '../src/admin/web-worker-launcher.mjs';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.unrefCalled = false;
  }

  unref() {
    this.unrefCalled = true;
  }

  finish(exitCode = 0) {
    this.exitCode = exitCode;
    this.emit('exit', exitCode);
  }
}

function launcherHarness() {
  const calls = [];
  const children = [];
  const launcher = createWebWorkerLauncher({
    nodePath: 'C:/runtime/node.exe',
    cliPath: 'C:/project/src/cli.mjs',
    projectRoot: 'C:/project',
    createRunId: () => `run-${children.length + 1}`,
    spawnProcess(command, args, options) {
      const child = new FakeChild(4000 + children.length);
      calls.push({ command, args, options });
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  return { calls, children, launcher };
}

describe('web worker launcher', () => {
  it('starts a detached live drain through a fixed Node entry without a shell', async () => {
    const { calls, children, launcher } = launcherHarness();

    const result = await launcher.start({ max: 3 });

    assert.deepEqual(result, { status: 'STARTED', runId: 'run-1', max: 3 });
    assert.deepEqual(calls, [{
      command: 'C:/runtime/node.exe',
      args: [
        'C:/project/src/cli.mjs',
        'drain',
        '--live',
        '--max',
        '3',
        '--worker-id',
        'web-run-1',
      ],
      options: {
        cwd: 'C:/project',
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    }]);
    assert.equal(children[0].unrefCalled, true);
  });

  it('caps the public contract at twenty tasks before spawning', async () => {
    const { calls, launcher } = launcherHarness();

    await assert.rejects(() => launcher.start({ max: 0 }), /between 1 and 20/i);
    await assert.rejects(() => launcher.start({ max: 21 }), /between 1 and 20/i);
    await assert.rejects(() => launcher.start({ max: 1.5 }), /between 1 and 20/i);
    assert.equal(calls.length, 0);
  });

  it('rejects concurrent launches and permits another run after exit', async () => {
    const { calls, children, launcher } = launcherHarness();

    await launcher.start({ max: 2 });
    await assert.rejects(
      () => launcher.start({ max: 2 }),
      (error) => error instanceof WorkerRunConflictError,
    );
    assert.equal(calls.length, 1);

    children[0].finish();
    const next = await launcher.start({ max: 1 });
    assert.equal(next.runId, 'run-2');
    assert.equal(calls.length, 2);
  });
});
