import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createCodexClient } from '../src/codex.mjs';
import { createCodexRuntime } from '../src/codex-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-canvas-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const client = createCodexClient({ executable: process.execPath,
    environment: { CODEX_HOME: root, XHS_WEB_SEARCH_PROVIDER: 'CODEX' },
    runtime: createCodexRuntime({ databasePath: join(root, 'limits.sqlite') }),
    runner: () => ({ status: 0, stdout: '', stderr: 'Logged in using ChatGPT' }),
    asyncRunner: async (_command, args, options) => {
      calls.push({ args, options });
      const savedPath = join(options.cwd, 'native.png');
      await sharp({ create: { width: 160, height: 64, channels: 3, background: '#edf2fa' } }).png().toFile(savedPath);
      return { status: 0, stderr: '', stdout: [
        { type: 'thread.started', thread_id: 'fake-canvas' },
        { type: 'item.completed', item: { type: 'image_generation', status: 'completed', saved_path: savedPath } },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ rawText: 'fake native image' }) } },
        { type: 'turn.completed' },
      ].map(JSON.stringify).join('\n') };
    },
  });
  return { root, calls, client };
}

function developerInstructions(call) {
  return call.args.find(value => value.startsWith('developer_instructions='));
}

test('local text crop image calls preserve requested aspect ratio in native execution instructions', async t => {
  const { root, calls, client } = await fixture(t);
  const sourcePath = join(root, 'paragraph.png');
  await sharp({ create: { width: 160, height: 64, channels: 3, background: 'white' } }).png().toFile(sourcePath);
  await client.runImageEdit({ prompt: 'Correct only the requested glyph in the text paragraph.',
    inputPaths: [sourcePath], outputPath: join(root, 'edited.png'), canvas: { width: 1280, height: 512 } });
  assert.equal(calls.length, 1);
  assert.match(developerInstructions(calls[0]), /1280 by 512 pixel canvas/u);
  assert.match(developerInstructions(calls[0]), /preserving that aspect ratio/u);
  assert.doesNotMatch(developerInstructions(calls[0]), /portrait 3:4/u);
});

test('glyph reference canvas and default full poster canvas stay separate', async t => {
  const { root, calls, client } = await fixture(t);
  await client.runImage({ prompt: 'Generate one accurate Chinese glyph reference.',
    outputPath: join(root, 'reference.png'), canvas: { width: 1024, height: 1024 } });
  await client.runImage({ prompt: 'Generate one full portrait poster.', outputPath: join(root, 'poster.png') });
  assert.match(developerInstructions(calls[0]), /1024 by 1024 pixel canvas/u);
  assert.match(developerInstructions(calls[1]), /portrait 3:4/u);
});

test('invalid custom canvas is rejected before a model request', async t => {
  const { root, calls, client } = await fixture(t);
  for (const canvas of [null, [], { width: 32, height: 31 }, { width: '1024', height: 1024 },
    { width: 100.5, height: 100 }, { width: 4097, height: 100 }, { width: 4096, height: 4096 },
    { width: 100, height: 100, instruction: 'override' }]) {
    await assert.rejects(client.runImage({ prompt: 'Generate a bounded glyph reference.',
      outputPath: join(root, 'invalid.png'), canvas }), /canvas dimensions/u);
  }
  assert.equal(calls.length, 0);
});
