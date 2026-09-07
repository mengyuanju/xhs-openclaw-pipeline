import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { runCodexProcess, codexChildEnvironment, terminateCodexTree } from '../src/codex-process.mjs';

test('Windows tree termination releases a referenced helper even when its kill cannot confirm exit',
  { skip: process.platform !== 'win32', timeout: 3000 }, async t => {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const close = new Promise(resolve => helper.once('close', resolve));
    const kill = helper.kill.bind(helper);
    const unref = helper.unref.bind(helper);
    let killRequested = false, released = false, fallback = false;
    t.after(async () => { kill(); await close; });
    helper.kill = () => { killRequested = true; return false; };
    helper.unref = () => { released = true; unref(); };
    await terminateCodexTree({ pid: 12345, kill() { fallback = true; } },
      { spawnImpl: () => helper, timeoutMs: 20 });
    assert.ok(killRequested && released && fallback);
    assert.equal(helper.exitCode, null, 'release does not depend on the helper exiting');
  });

test('timeout returns even when process close and tree termination never arrive', { timeout: 1000 }, async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    unref() {},
  });
  let kills = 0;
  const result = await runCodexProcess('fake', [], { timeoutMs: 10, shutdownGraceMs: 20,
    spawnImpl: () => child, terminate: () => { kills++; return new Promise(() => {}); } });
  assert.equal(result.error.code, 'CODEX_EXEC_TIMEOUT');
  assert.equal(result.terminationConfirmed, false);
  assert.equal(kills, 1);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed);
});

test('process runner forwards stdin verbatim without a shell and captures both streams', async () => {
  const input = '中文 ` $(danger)\n' + 'x'.repeat(50_000);
  const result = await runCodexProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("trace");'],
    { input, timeoutMs: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, input);
  assert.equal(result.stderr, 'trace');
});

test('timeouts terminate an actual child before returning and are not retried', async () => {
  let pid;
  const result = await runCodexProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'],
    { timeoutMs: 100, onSpawn: (value) => { pid = value; } });
  assert.equal(result.error.code, 'CODEX_EXEC_TIMEOUT');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('abort and bounded output terminate running processes', async () => {
  const controller = new AbortController();
  const running = runCodexProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'],
    { timeoutMs: 5000, signal: controller.signal, onSpawn: () => controller.abort() });
  const aborted = await running;
  assert.equal(aborted.error.name, 'AbortError');
  const oversized = await runCodexProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(()=>{}, 1000)'],
    { timeoutMs: 5000, maxBuffer: 1000 });
  assert.equal(oversized.error.code, 'CODEX_OUTPUT_TOO_LARGE');
});

test('subscription child environment excludes inherited application secrets and API billing credentials', () => {
  const env = codexChildEnvironment({ PATH: '/bin', USERPROFILE: 'C:/user', OPENAI_API_KEY: 'secret',
    CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret', XHS_SESSION_SECRET: 'secret',
    DATABASE_URL: 'private', NODE_OPTIONS: '--require evil', CODEX_HOME: 'C:/codex' }, 'http://127.0.0.1:7897');
  assert.equal(env.CODEX_HOME, 'C:/codex');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.equal(env.NODE_OPTIONS, undefined);
});
