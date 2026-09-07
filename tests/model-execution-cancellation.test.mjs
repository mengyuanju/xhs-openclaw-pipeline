import assert from 'node:assert/strict';
import test from 'node:test';
import { createDotsChatClient } from '../src/dots-chat-client.mjs';
import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';
import { runDeepSeekWebSearch } from '../src/deepseek-web-search.mjs';
import { guardExecutionCalls } from '../src/executor/execution-signal.mjs';

const factories = [
  ['Dots', fetchImpl => input => createDotsChatClient({ apiKey: 'fixture-only', fetchImpl }).runText(input)],
  ['DeepSeek responses', fetchImpl => input => createDeepSeekResponsesClient({ apiKey: 'fixture-only', fetchImpl }).runText(input)],
  ['DeepSeek search', fetchImpl => input => runDeepSeekWebSearch({ apiKey: 'fixture-only', model: 'fake', timeoutMs: 5000, fetchImpl }, input)],
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

for (const abortAt of ['before finalization', 'during finalization']) {
  test(`DeepSeek search cancellation ${abortAt} prevents further work and preserves the execution reason`, async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('execution revoked'), { code: 'STALE_EXECUTION' });
    let calls = 0;
    const searched = { status: 'completed', output: [{ type: 'web_search_call', id: 'fake-search', status: 'completed' }] };
    await assert.rejects(runDeepSeekWebSearch({ apiKey: 'fixture-only', model: 'fake', timeoutMs: 5000,
      fetchImpl: async (_url, { signal }) => {
        calls++;
        if (calls === 2) {
          controller.abort(reason);
          assert.equal(signal.aborted, true);
          signal.throwIfAborted();
        }
        return { ok: true, status: 200, text: async () => {
          if (abortAt === 'before finalization') controller.abort(reason);
          return JSON.stringify(searched);
        } };
      },
    }, { query: 'fake', signal: controller.signal }), error => error === reason);
    assert.equal(calls, abortAt === 'before finalization' ? 1 : 2);
  });
}
