import assert from 'node:assert/strict';
import test from 'node:test';
import { createDotsChatClient } from '../src/dots-chat-client.mjs';
import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';
import { runDeepSeekWebSearch } from '../src/deepseek-web-search.mjs';
import { guardExecutionCalls } from '../src/executor/execution-signal.mjs';

const factories = [
  ['Dots', fetchImpl => input => createDotsChatClient({ apiKey: 'fixture-only', fetchImpl }).runText(input)],
  ['DeepSeek responses', fetchImpl => input => createDeepSeekResponsesClient({ apiKey: 'fixture-only', fetchImpl }).runText(input)],
  ['DeepSeek search', fetchImpl => input => runDeepSeekWebSearch({ apiKey: 'fixture-only', timeoutMs: 5000, fetchImpl }, input)],
];
for (const [name, factory] of factories) {
  test(`${name} propagates execution cancellation through fetch and preserves its reason`, async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
    const run = factory(async (_url, { signal }) => {
      controller.abort(reason);
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    });
    await assert.rejects(run({ prompt: 'fake', query: 'fake', signal: controller.signal }), error => error === reason);
  });
}

test('model guard passes execution signals and prevents calls after cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = guardExecutionCalls({ runText: async ({ signal }) => { calls++; assert.equal(signal, controller.signal); } }, controller.signal, { model: true });
  await model.runText({ prompt: 'fake' });
  controller.abort();
  assert.throws(() => model.runText({ prompt: 'late' }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';

test('DeepSeek search cancelled before dispatch makes no Search or Responses request', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
  const calls = [];
  controller.abort(reason);
  await assert.rejects(runDeepSeekWebSearch({ apiKey: 'fixture-only', timeoutMs: 5000,
    fetchImpl: async url => { calls.push(url); assert.fail('cancelled execution must not dispatch'); },
  }, { query: 'fake', signal: controller.signal }), error => error === reason);
  assert.deepEqual(calls, []);
});

test('DeepSeek search cancellation while reading the body cancels the stream without another request', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
  const calls = [];
  let bodyCancelled = false;
  await assert.rejects(runDeepSeekWebSearch({ apiKey: 'fixture-only', timeoutMs: 5000,
    fetchImpl: async (url, { signal }) => {
      calls.push(url);
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode('{"results":[')); },
        pull() { controller.abort(reason); assert.equal(signal.aborted, true); },
        cancel() { bodyCancelled = true; },
      }));
    },
  }, { query: 'fake', signal: controller.signal }), error => error === reason);
  assert.equal(bodyCancelled, true);
  assert.deepEqual(calls, [SEARCH_ENDPOINT]);
});

test('DeepSeek search cancellation during the retry delay prevents Search retries and Responses fallback', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
  const calls = [];
  await assert.rejects(runDeepSeekWebSearch({ apiKey: 'fixture-only', timeoutMs: 5000,
    fetchImpl: async url => {
      calls.push(url);
      // The immediate runs after the retryable response has started its delay.
      setImmediate(() => controller.abort(reason));
      return new Response('', { status: 429, headers: { 'Retry-After': '0.25' } });
    },
  }, { query: 'fake', signal: controller.signal }), error => error === reason);
  assert.deepEqual(calls, [SEARCH_ENDPOINT]);
});

test('DeepSeek search cancellation during a retry preserves its reason and stops all further requests', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
  const calls = [];
  const configuration = { apiKey: 'fixture-only', timeoutMs: 5000,
    fetchImpl: async (url, { signal }) => {
      calls.push(url);
      if (calls.length === 1) return new Response('', { status: 503 });
      controller.abort(reason);
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    },
  };
  const request = { query: 'fake', signal: controller.signal };
  await assert.rejects(runDeepSeekWebSearch(configuration, request), error => error === reason);
  await assert.rejects(runDeepSeekWebSearch(configuration, request), error => error === reason);
  assert.deepEqual(calls, [SEARCH_ENDPOINT, SEARCH_ENDPOINT]);
});
