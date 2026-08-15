import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOpenClawClient } from '../src/openclaw.mjs';

describe('OpenClaw client', () => {
  it('passes the prompt as one argument without enabling a shell', () => {
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({ final: '{"ok":true}' }),
          stderr: '',
        };
      },
    });

    const result = client.runText({
      model: 'openai-codex/gpt-5.4-mini',
      prompt: 'query with & | > shell characters',
    });

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.args.at(-1), 'query with & | > shell characters');
    assert.deepEqual(result, { rawText: '{"ok":true}', model: 'openai-codex/gpt-5.4-mini' });
  });

  it('redacts credential-looking text from OpenClaw failures', () => {
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'request failed with sk-abcdefghijklmnop',
      }),
    });

    assert.throws(
      () => client.runText({ model: 'openai-codex/gpt-5.4-mini', prompt: 'hello' }),
      (error) => {
        assert.doesNotMatch(error.message, /sk-abcdefghijklmnop/);
        assert.match(error.message, /REDACTED/);
        return true;
      },
    );
  });
});
