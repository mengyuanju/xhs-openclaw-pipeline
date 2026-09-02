import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';
import { createDotsChatClient } from '../src/dots-chat-client.mjs';

const DOTS_BASE_URL = 'https://note3-prev-api.askdiandian.com';

describe('Dots Chat Completions client', () => {
  it('uses the documented endpoint, api-key header and non-streaming request contract', async () => {
    let invocation;
    const client = createDotsChatClient({
      apiKey: 'dots-test-key',
      baseUrl: DOTS_BASE_URL,
      model: 'dots3-note-prev',
      async fetchImpl(url, options) {
        invocation = { url, options };
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"title":"成稿"}' } }],
          model: 'dots3-note-prev',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const generated = await client.runText({ prompt: '生成结构化小红书文案。' });
    const body = JSON.parse(invocation.options.body);

    assert.equal(invocation.url, `${DOTS_BASE_URL}/v1/chat/completions`);
    assert.equal(invocation.options.method, 'POST');
    assert.equal(invocation.options.redirect, 'error');
    assert.equal(invocation.options.headers['Content-Type'], 'application/json');
    assert.equal(invocation.options.headers['api-key'], 'dots-test-key');
    assert.deepEqual(body.messages, [{ role: 'user', content: '生成结构化小红书文案。' }]);
    assert.equal(body.model, 'dots3-note-prev');
    assert.equal(body.stream, false);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.equal(generated.rawText, '{"title":"成稿"}');
    assert.equal(generated.model, 'dots3-note-prev');
  });

  it('fails before the network call when the server-side API key is missing', async () => {
    let called = false;
    const client = createDotsChatClient({
      apiKey: '',
      baseUrl: DOTS_BASE_URL,
      model: 'dots3-note-prev',
      async fetchImpl() {
        called = true;
        throw new Error('must not run');
      },
    });

    await assert.rejects(
      client.runText({ prompt: '生成文案。' }),
      /XHS_DOTS_API_KEY/iu,
    );
    assert.equal(called, false);
  });

  it('treats malformed responses as untrusted and never includes the API key in errors', async () => {
    const apiKey = 'dots-secret-that-must-not-leak';
    const malformed = createDotsChatClient({
      apiKey,
      baseUrl: DOTS_BASE_URL,
      model: 'dots3-note-prev',
      async fetchImpl() {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      },
    });
    await assert.rejects(
      malformed.runText({ prompt: '生成文案。' }),
      (error) => !String(error?.message).includes(apiKey) && /response/iu.test(error?.message),
    );

    const failed = createDotsChatClient({
      apiKey,
      baseUrl: DOTS_BASE_URL,
      model: 'dots3-note-prev',
      async fetchImpl() {
        return new Response(apiKey, { status: 401 });
      },
    });
    await assert.rejects(
      failed.runText({ prompt: '生成文案。' }),
      (error) => !String(error?.message).includes(apiKey) && /HTTP 401/iu.test(error?.message),
    );
  });
});

describe('copy generation provider selection', () => {
  it('uses Dots for copy text while keeping OpenClaw research and reviews', async () => {
    const openclaw = {
      async runReview() { return { rawText: 'openclaw-review', model: 'openai/reviewer' }; },
      async runWebSearch() { return { result: 'openclaw-search' }; },
    };
    const client = createCopyGenerationClient({
      modelApi: {
        copyGenerationProvider: 'DOTS',
        dotsBaseUrl: DOTS_BASE_URL,
        dotsModel: 'dots3-note-prev',
      },
      environment: { XHS_DOTS_API_KEY: 'dots-test-key' },
      openclaw,
      async fetchImpl() {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'dots-copy' } }],
          model: 'dots3-note-prev',
        }), { status: 200 });
      },
    });

    assert.deepEqual(await client.runText({ prompt: '生成文案。' }), {
      rawText: 'dots-copy',
      model: 'dots3-note-prev',
    });
    assert.equal((await client.runReview({ prompt: '审核。' })).rawText, 'openclaw-review');
    assert.equal((await client.runWebSearch({ query: '检索。' })).result, 'openclaw-search');
  });

  it('uses the production-configured thinking effort for OpenClaw copy and review calls', async () => {
    const invocations = [];
    const openclaw = {
      async runText(input) {
        invocations.push(['text', input]);
        return { rawText: 'copy', model: 'openai/copy', thinking: input.thinking };
      },
      async runReview(input) {
        invocations.push(['review', input]);
        return { rawText: 'review', model: 'openai/review', thinking: input.thinking };
      },
      async runWebSearch(input) {
        invocations.push(['search', input]);
        return { result: 'search' };
      },
    };
    const client = createCopyGenerationClient({
      modelApi: {
        copyGenerationProvider: 'OPENCLAW',
        copyGenerationThinking: 'xhigh',
      },
      environment: {},
      openclaw,
    });

    await client.runText({ prompt: '生成。', thinking: 'high' });
    await client.runReview({ prompt: '审核。', thinking: 'high' });
    await client.runWebSearch({ query: '检索。' });

    assert.deepEqual(invocations, [
      ['text', { prompt: '生成。', thinking: 'xhigh' }],
      ['review', { prompt: '审核。', thinking: 'xhigh' }],
      ['search', { query: '检索。' }],
    ]);
  });
});
