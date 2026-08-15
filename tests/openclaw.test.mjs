import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('generates one image to an explicit path without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-image-'));
    const outputPath = join(directory, 'raw.png');
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        writeFileSync(outputPath, Buffer.from('fake image'));
        return { status: 0, stdout: JSON.stringify({ ok: true, outputs: [{ path: outputPath }] }), stderr: '' };
      },
    });

    try {
      const result = client.runImage({
        model: 'openai/gpt-image-2',
        prompt: 'a clean desk & no visible text',
        outputPath,
      });

      assert.equal(invocation.options.shell, false);
      assert.equal(invocation.args.at(-1), 'a clean desk & no visible text');
      assert.match(invocation.args.join(' '), /--count 1/);
      assert.equal(result.outputPath, outputPath);
      assert.equal(result.model, 'openai/gpt-image-2');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
