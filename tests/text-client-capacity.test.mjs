import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';

import { createDotsChatClient } from '../src/dots-chat-client.mjs';
import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';

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
