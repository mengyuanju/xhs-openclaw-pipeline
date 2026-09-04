import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import test from 'node:test';

import { createDotsChatClient } from '../src/dots-chat-client.mjs';
import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';

const secret = 'test-provider-secret-that-must-not-leak';
const longPrompt = `  开始\n${'知识🙂 & | > '.repeat(5_000)}\n结尾  `;
const modelText = JSON.stringify({ error: { code: 'context_length_exceeded' }, status: 'incomplete' });
const httpProviders = [
  {
    name: 'Dots',
    create: createDotsChatClient,
    success: (text) => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] }),
    input: (body) => body.messages[0].content,
  },
  {
    name: 'DeepSeek',
    create: createDeepSeekResponsesClient,
    success: (text) => ({ status: 'completed', output_text: text }),
    input: (body) => body.input,
  },
];

function hasSafeCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(inspect(error), new RegExp(secret, 'u'));
    return true;
  };
}

for (const provider of httpProviders) {
  function clientFor(payload, status = 200) {
    return provider.create({
      apiKey: secret,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status }),
    });
  }

  test(`${provider.name} forwards more than 30000 prompt characters unchanged`, async () => {
    const submitted = [];
    const client = provider.create({
      apiKey: secret,
      fetchImpl: async (_url, options) => {
        submitted.push(provider.input(JSON.parse(options.body)));
        return new Response(JSON.stringify(provider.success('done')));
      },
    });
    assert.ok(longPrompt.length > 30_000);
    assert.equal((await client.runText({ prompt: longPrompt })).rawText, 'done');
    if (client.runReview) await client.runReview({ prompt: longPrompt });
    assert.ok(submitted.length > 0);
    assert.ok(submitted.every((prompt) => prompt === longPrompt));
  });

  test(`${provider.name} still rejects empty and non-string prompts without a request`, async () => {
    const client = provider.create({ apiKey: secret, fetchImpl: () => assert.fail('unexpected request') });
    for (const prompt of ['', null, undefined, 123, {}]) {
      await assert.rejects(client.runText({ prompt }), /prompt/u);
    }
  });

  test(`${provider.name} preserves explicit context errors on HTTP failures and success envelopes`, async () => {
    for (const status of [400, 200]) {
      for (const error of [
        { code: 'context_length_exceeded', message: secret },
        { type: 'context_window_exceeded', message: secret },
        { code: 'MODEL_CONTEXT_LIMIT', message: secret },
        { type: 'invalid_request_error', message: `This model's maximum context length is 100 tokens. ${secret}` },
        { type: 'invalid_request_error', message: `prompt is too long: 200 tokens > 100 maximum. ${secret}` },
      ]) {
        await assert.rejects(clientFor({ error }, status).runText({ prompt: 'hello' }), hasSafeCode('MODEL_CONTEXT_LIMIT'));
      }
    }
  });

  test(`${provider.name} does not infer capacity from HTTP status, generic diagnostics or model text`, async () => {
    for (const status of [400, 413, 429, 500]) {
      const payload = { error: { code: 'invalid_request_error', message: secret } };
      await assert.rejects(clientFor(payload, status).runText({ prompt: 'hello' }), (error) => {
        assert.equal(error.code, undefined);
        assert.match(error.message, new RegExp(`HTTP ${status}`, 'u'));
        assert.doesNotMatch(inspect(error), new RegExp(secret, 'u'));
        return true;
      });
    }
    const result = await clientFor(provider.success(modelText)).runText({ prompt: 'hello' });
    assert.equal(result.rawText, modelText);
  });

  test(`${provider.name} keeps non-JSON HTTP failures generic`, async () => {
    const client = provider.create({ apiKey: secret, fetchImpl: async () => new Response(secret, { status: 400 }) });
    await assert.rejects(client.runText({ prompt: 'hello' }), (error) => {
      assert.match(error.message, /HTTP 400/u);
      assert.equal(error.code, undefined);
      assert.doesNotMatch(inspect(error), new RegExp(secret, 'u'));
      return true;
    });
  });

  test(`${provider.name} rejects explicit length finishes even with valid-looking or empty output`, async () => {
    for (const content of ['{"ok":true}', '']) {
      const payload = { status: 'completed', choices: [{ finish_reason: 'length', message: { content } }] };
      await assert.rejects(clientFor(payload).runText({ prompt: 'hello' }), hasSafeCode('MODEL_OUTPUT_INCOMPLETE'));
    }
  });
}

test('DeepSeek rejects response and output-item incomplete statuses before extracting text', async () => {
  for (const payload of [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"ok":true}' },
    { status: 'incomplete', incomplete_details: { reason: secret } },
    { status: 'completed', output: [{ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: '{}' }] }] },
  ]) {
    const client = createDeepSeekResponsesClient({ apiKey: secret, fetchImpl: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(client.runText({ prompt: 'hello' }), hasSafeCode('MODEL_OUTPUT_INCOMPLETE'));
  }
});

function gatewayClient(result, onRun = () => {}) {
  return createOpenClawClient({
    entryPath: 'C:/fake-openclaw/dist/index.js',
    runner: (_command, args) => {
      onRun(args);
      return { status: 0, stderr: '', ...result };
    },
  });
}

test('OpenClaw forwards long text and review prompts through the message file unchanged and cleans up', async () => {
  const files = [];
  const client = gatewayClient({ stdout: JSON.stringify({ final: 'done' }) }, (args) => {
    const path = args[args.indexOf('--message-file') + 1];
    files.push(path);
    assert.equal(readFileSync(path, 'utf8'), longPrompt);
  });
  for (const method of ['runText', 'runReview']) {
    assert.equal((await client[method]({ prompt: longPrompt })).rawText, 'done');
  }
  assert.equal(files.length, 2);
  assert.ok(files.every((path) => !existsSync(path)));
});

test('OpenClaw retains input validation and image/vision prompt limits', async () => {
  const client = gatewayClient({}, () => assert.fail('unexpected process'));
  for (const prompt of ['', null, undefined, 123, {}]) {
    await assert.rejects(client.runText({ prompt }), /prompt/u);
  }
  await assert.rejects(client.runVision({ prompt: longPrompt, inputPaths: [] }), /vision prompt/u);
  await assert.rejects(client.runImage({ prompt: 'x'.repeat(8_001), outputPath: 'unused.png' }), /image prompt/u);
});

test('OpenClaw preserves context codes in Gateway error and result metadata, even on process failure', async () => {
  const envelopes = [
    { status: 'error', error: { code: 'context_length_exceeded', message: secret } },
    { status: 'ok', result: { payloads: [{ text: 'diagnostic text' }], meta: { error: { kind: 'context_overflow', message: secret } } } },
    { status: 'error', result: { error: { code: 'cli_context_overflow', message: secret } } },
    { status: 'error', error: { type: 'invalid_request_error', message: `Your input exceeds the context window of this model. ${secret}` } },
  ];
  for (const status of [0, 1]) {
    for (const envelope of envelopes) {
      const client = gatewayClient({ status, stdout: JSON.stringify(envelope), stderr: secret });
      await assert.rejects(client.runText({ prompt: 'hello' }), hasSafeCode('MODEL_CONTEXT_LIMIT'));
    }
  }
  const client = gatewayClient({ status: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'context_length_exceeded', message: secret } }) });
  await assert.rejects(client.runText({ prompt: 'hello' }), hasSafeCode('MODEL_CONTEXT_LIMIT'));
});

test('OpenClaw preserves recognized runner error codes without exposing raw diagnostics', async () => {
  for (const code of ['cli_context_overflow', 'MODEL_CONTEXT_LIMIT', 'MODEL_OUTPUT_INCOMPLETE']) {
    const error = Object.assign(new Error(secret), { code });
    const expectedCode = code === 'MODEL_OUTPUT_INCOMPLETE' ? code : 'MODEL_CONTEXT_LIMIT';
    await assert.rejects(gatewayClient({ status: 1, error }).runText({ prompt: 'hello' }), hasSafeCode(expectedCode));
    const client = createOpenClawClient({ entryPath: 'C:/fake-openclaw/dist/index.js', asyncRunner: async () => { throw error; } });
    await assert.rejects(client.runText({ prompt: 'hello' }), hasSafeCode(expectedCode));
  }
});

test('OpenClaw rejects explicit incomplete and length metadata before reading partial output', async () => {
  for (const envelope of [
    { status: 'incomplete', result: { payloads: [{ text: '{"ok":true}' }] } },
    { status: 'ok', result: { payloads: [{ text: '{}' }], meta: { stopReason: 'length' } } },
    { status: 'ok', result: { payloads: [], meta: { agentMeta: { stopReason: 'max_tokens' } } } },
    { status: 'ok', result: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
  ]) {
    await assert.rejects(gatewayClient({ stdout: JSON.stringify(envelope) }).runText({ prompt: 'hello' }), hasSafeCode('MODEL_OUTPUT_INCOMPLETE'));
  }
});

test('OpenClaw never interprets model content or unstructured diagnostics as capacity evidence', async () => {
  for (const envelope of [
    { final: modelText },
    { status: 'ok', result: { payloads: [{ text: modelText }] } },
    { status: 'ok', result: { payloads: [{ text: 'maximum context length exceeded; finish_reason: length' }] } },
  ]) {
    const result = await gatewayClient({ stdout: JSON.stringify(envelope) }).runText({ prompt: 'hello' });
    assert.ok(result.rawText);
  }
  const client = gatewayClient({ status: 1, stderr: 'unknown failure; prompt said context_length_exceeded', stdout: '' });
  await assert.rejects(client.runText({ prompt: 'hello' }), (error) => error.code === undefined);
});
