import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexImageProcess } from '../src/codex-app-server.mjs';
import { parseCodexOutput } from '../src/codex-protocol.mjs';

async function fixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-image-protocol-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const schemaPath = join(root, 'schema.json');
  await writeFile(schemaPath, '{"type":"object"}');
  const args = ['exec', '--output-schema', schemaPath, '--model', 'gpt-5.6-sol', '--image', '/reference.png',
    '-c', 'model_reasoning_effort="low"', '-c', 'developer_instructions="generate"',
    '-c', 'features.shell_tool=false', '-c', 'features.apps=false'];
  return runCodexImageProcess(process.execPath, args, { input: 'untrusted test prompt', cwd: root,
    timeoutMs: scenario === 'timeout' ? 100 : 5000,
    spawnImpl(command, actualArgs, options) {
      assert.ok(actualArgs.includes('forced_login_method="chatgpt"'));
      assert.equal(options.shell, false);
      return spawn(command, [fileURLToPath(new URL('./fixtures/codex-image-server.mjs', import.meta.url)), scenario], options);
    },
  });
}
for (const scenario of ['normal', 'terminal-only']) test(`native image evidence is correlated and deduplicated: ${scenario}`, async t => {
  const result = await fixture(t, scenario);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  const parsed = parseCodexOutput(result.stdout, { requireText: false });
  assert.deepEqual(parsed.images, [{ id: 'native', path: '/generated/native.png' }]);
  assert.equal(parsed.reconnectCount, 1);
});
test('terminal image errors preserve retry and quota categories', async t => {
  const failed = await fixture(t, 'failed');
  assert.throws(() => parseCodexOutput(failed.stdout), { code: 'CODEX_RATE_LIMITED' });
  assert.equal((await fixture(t, 'quota')).error.code, 'CODEX_QUOTA_EXHAUSTED');
});
test('malformed protocol and timeout stop the owned process before returning', async t => {
  const malformed = await fixture(t, 'malformed');
  assert.equal(malformed.error.code, 'CODEX_EXEC_FAILED');
  assert.match(malformed.rawStdout, /malformed setup protocol omitted/);
  assert.equal((await fixture(t, 'timeout')).error.code, 'CODEX_EXEC_TIMEOUT');
});

test('failed image diagnostics omit configured credentials but retain malformed task protocol', async t => {
  const result = await fixture(t, 'malformed-after-config');
  assert.equal(result.error.code, 'CODEX_EXEC_FAILED');
  assert.match(result.rawStdout, /invalid task protocol/);
  assert.doesNotMatch(result.rawStdout, /opaque-sensitive-value|CUSTOM_AUTH|never-run-this/);
});

test('invalid configuration fails before starting a thread with user MCP configuration', async t => {
  for (const scenario of ['missing-config', 'malformed-config']) {
    const result = await fixture(t, scenario);
    assert.match(result.error.message, /invalid config\/read response/);
    assert.doesNotMatch(result.stdout, /thread.started/);
  }
});
