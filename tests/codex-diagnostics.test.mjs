import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../scripts/agent-runtime.mjs';

test('diagnostics use login status only; resume requires valid subscription login', () => {
  let reset = 0; let loggedIn = true;
  const options = { executable: process.execPath, environment: {}, stdout: { write() {} },
    runtime: { reset() { reset++; }, status: () => ({ code: 'CODEX_QUOTA_EXHAUSTED' }) },
    runner(_command, args) {
      assert.ok(args.includes('status') || args.includes('--version'));
      return args.includes('--version') ? { status: 0, stdout: 'codex-cli test' }
        : { status: loggedIn ? 0 : 1, stderr: loggedIn ? 'Logged in using ChatGPT' : 'Not logged in' };
    } };
  assert.equal(main(['check'], options).authentication, 'chatgpt');
  assert.equal(reset, 0);
  loggedIn = false;
  assert.throws(() => main(['resume'], options), { code: 'CODEX_AUTH_REQUIRED' });
  assert.equal(reset, 0);
  loggedIn = true;
  main(['resume'], options);
  assert.equal(reset, 1);
});
