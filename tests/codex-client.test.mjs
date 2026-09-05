import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createCodexClient } from '../src/codex.mjs';
import { createCodexRuntime } from '../src/codex-runtime.mjs';
import { createResearchSnapshot } from '../src/research.mjs';

function success(answer, items = []) {
  return { status: 0, stderr: '', stdout: [
    { type: 'thread.started', thread_id: 'test-thread' },
    ...items.map((item) => ({ type: 'item.completed', item })),
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } },
    { type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 5 } },
  ].map(JSON.stringify).join('\n') };
}

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-client-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = createCodexClient({ executable: process.execPath, asyncRunner: runner,
    environment: { CODEX_HOME: root, XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' }, runtime: createCodexRuntime({ databasePath: join(root, 'limits.sqlite') }),
    runner: () => ({ status: 0, stdout: '', stderr: 'Logged in using ChatGPT' }) });
  return { root, client };
}

test('text/review use model overrides, full stdin and the established rawText contract', async (t) => {
  const seen = [];
  const { client } = await fixture(t, async (command, args, options) => {
    seen.push({ command, args, options });
    const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.ok(schema.properties.rawText);
    return success({ rawText: '{"answer":"完整正文"}' });
  });
  const prompt = '原始提示词\n' + '长'.repeat(35000);
  const result = await client.runText({ prompt, model: 'openai/gpt-5.6-sol', thinking: 'high' });
  assert.equal(result.rawText, '{"answer":"完整正文"}');
  assert.equal(result.provider, 'codex');
  assert.equal(result.execution.sessionId, 'test-thread');
  assert.ok(seen[0].options.input.includes(prompt));
  assert.equal(seen[0].args[seen[0].args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(seen[0].args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal((await client.runReview({ prompt: 'review', model: 'openai/gpt-5.4' })).model, 'openai/gpt-5.4');
  assert.equal(client.checkReady().provider, 'codex');
});

test('vision attaches normalized copies in an isolated directory and cleans them after completion', async (t) => {
  let imagePath;
  const { client, root } = await fixture(t, async (_command, args) => {
    imagePath = args[args.indexOf('--image') + 1];
    assert.equal((await sharp(imagePath).metadata()).format, 'jpeg');
    return success({ rawText: '{"passed":true}' });
  });
  const input = join(root, 'reference.png');
  await sharp({ create: { width: 20, height: 30, channels: 3, background: '#aabbcc' } }).png().toFile(input);
  assert.equal((await client.runVision({ prompt: 'analyse', inputPaths: [input] })).provider, 'codex');
  await assert.rejects(readFile(imagePath), { code: 'ENOENT' });
  assert.equal((await sharp(input).metadata()).width, 20);
});

test('structured text writes the business output schema and keeps the public rawText response', async (t) => {
  const outputSchema = { type: 'object', properties: { pages: { type: 'array', items: { type: 'string' } } }, required: ['pages'], additionalProperties: false };
  const { client } = await fixture(t, async (_command, args) => {
    const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.deepEqual(schema, outputSchema);
    return success({ pages: ['第一张'] });
  });
  const result = await client.runText({ prompt: 'plan', outputSchema });
  assert.deepEqual(JSON.parse(result.rawText), { pages: ['第一张'] });
});

test('search needs an actual web_search event and produces the existing research snapshot', async (t) => {
  let searched = true;
  const answer = { summary: '官方资料说明测试方法。', results: [{ title: 'Official', url: 'https://www.nist.gov/testing', snippet: '测试依据' }] };
  const { client } = await fixture(t, async () => success(answer, searched ? [{ type: 'web_search', id: 's', query: 'testing' }] : []));
  const research = await createResearchSnapshot({ client, query: 'testing' });
  assert.equal(research.status, 'COMPLETED', JSON.stringify(research));
  assert.equal(research.provider, 'codex');
  searched = false;
  await assert.rejects(client.runWebSearch({ query: 'testing' }), { code: 'CODEX_SEARCH_UNVERIFIED' });
});

test('image generation requires native tool evidence and a valid fresh image before delivery', async (t) => {
  let evidence = true;
  const { client, root } = await fixture(t, async (_command, _args, options) => {
    const path = join(options.cwd, 'generated.png');
    await sharp({ create: { width: 24, height: 32, channels: 3, background: '#aabbcc' } }).png().toFile(path);
    return success({ rawText: 'generated' }, evidence ? [{ type: 'image_generation', id: 'image-1', status: 'completed', saved_path: path }] : []);
  });
  const destination = join(root, 'delivered.png');
  const result = await client.runImage({ prompt: 'Generate a clear infographic.', outputPath: destination });
  assert.equal(result.provider, 'codex');
  assert.equal(result.model, 'openai/gpt-image-2');
  assert.equal((await sharp(destination).metadata()).format, 'png');
  evidence = false;
  await assert.rejects(client.runImage({ prompt: 'Generate a clear infographic.', outputPath: join(root, 'unverified.png') }), { code: 'CODEX_IMAGE_UNVERIFIED' });
  await assert.rejects(readFile(join(root, 'unverified.png')), { code: 'ENOENT' });
});

test('invalid image bytes and non-OpenAI models fail before success can be reported', async (t) => {
  const { client, root } = await fixture(t, async (_command, _args, options) => {
    const path = join(options.cwd, 'fake.png'); await writeFile(path, 'not an image');
    return success({ rawText: 'done' }, [{ type: 'image_generation', id: 'i', status: 'completed', saved_path: path }]);
  });
  await assert.rejects(client.runText({ prompt: 'hello', model: 'other/model' }), /openai/u);
  await assert.rejects(client.runImage({ prompt: 'Generate a clear infographic.', outputPath: join(root, 'bad.png') }));
});

test('image edits attach copies, accept image-only native completion and never overwrite the target', async (t) => {
  let attachment;
  const { client, root } = await fixture(t, async (_command, args, options) => {
    attachment = args[args.indexOf('--image') + 1];
    assert.equal((await sharp(attachment).metadata()).format, 'png');
    const path = join(options.cwd, 'edited.png');
    await sharp(attachment).negate().png().toFile(path);
    return { status: 0, stdout: [
      { type: 'item.completed', item: { type: 'image_generation', id: 'i', status: 'completed', saved_path: path } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') };
  });
  const target = join(root, 'target.png');
  await sharp({ create: { width: 24, height: 32, channels: 3, background: '#aabbcc' } }).png().toFile(target);
  const original = await readFile(target);
  const result = await client.runImageEdit({ prompt: 'Make the background lighter.', inputPaths: [target], outputPath: join(root, 'edited.png') });
  assert.equal(result.provider, 'codex-image-edit');
  assert.deepEqual(await readFile(target), original);
  await assert.rejects(readFile(attachment), { code: 'ENOENT' });
  await assert.rejects(client.runImageEdit({ prompt: 'Make the background lighter.', inputPaths: [target], outputPath: target }));
  assert.deepEqual(await readFile(target), original);
});

test('image paths outside the native output roots and stale files are rejected', async (t) => {
  let path;
  let stale = false;
  const { client, root } = await fixture(t, async (_command, _args, options) => {
    if (stale) {
      path = join(options.cwd, 'stale.png');
      await sharp({ create: { width: 24, height: 32, channels: 3, background: '#aabbcc' } }).png().toFile(path);
      await utimes(path, new Date(0), new Date(0));
    }
    return success({ rawText: 'done' }, [{ type: 'image_generation', id: 'i', status: 'completed', saved_path: path }]);
  });
  path = join(root, 'private.png');
  await sharp({ create: { width: 24, height: 32, channels: 3, background: '#aabbcc' } }).png().toFile(path);
  for (const value of [false, true]) {
    stale = value;
    await assert.rejects(client.runImage({ prompt: 'Generate a clear infographic.', outputPath: join(root, 'output.png') }), { code: 'CODEX_IMAGE_UNVERIFIED' });
  }
});

test('vision requires an attachment and search rejects unsafe source URLs', async (t) => {
  let calls = 0;
  const { client } = await fixture(t, async () => {
    calls++;
    return success({ summary: 'result', results: [{ title: 'bad', url: 'javascript:alert(1)', snippet: 'bad' }] }, [{ type: 'web_search' }]);
  });
  await assert.rejects(client.runVision({ prompt: 'analyse' }), /input images/u);
  assert.equal(calls, 0);
  await assert.rejects(client.runWebSearch({ query: 'testing' }), { code: 'CODEX_SEARCH_UNVERIFIED' });
});
