import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCodexProcess, codexChildEnvironment } from '../src/codex-process.mjs';

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
