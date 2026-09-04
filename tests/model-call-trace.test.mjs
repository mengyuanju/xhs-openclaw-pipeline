import assert from 'node:assert/strict';
import test from 'node:test';
import { withModelCallTracing, traceModelCall, tracedOpenClawRunner, safeTraceText } from '../src/model-call-trace.mjs';
import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';
import { createDotsChatClient } from '../src/dots-chat-client.mjs';
import { createExecutorAgent } from '../src/executor/agent.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';

const meta = { provider: 'fake', operation: 'TEXT', prompt: '实际提示词', request: { model: 'fake' } };
function fixture(executionId = 'execution-a') {
  const records = [];
  const controlPlane = {
    recordModelCall: async (id, callId, record) => records.push({ executionId: id, ...structuredClone(record) }),
    updateProgress: async () => {},
  };
  return { records, controlPlane, run: (action) => withModelCallTracing({ executionId, controlPlane }, action) };
}

test('trace records start, exact prompt/raw response and failure without swallowing model errors', async () => {
  const f = fixture();
  const originalError = new Error('transport failed');
  await f.run(async (plane) => {
    await plane.updateProgress('execution-a', { stage: 'QUERY_REVIEW' });
    assert.equal(await traceModelCall(meta, async (capture) => { capture.response('原始返回'); return 7; }), 7);
    await assert.rejects(traceModelCall(meta, async () => { throw originalError; }), (error) => error === originalError);
  });
  assert.deepEqual(f.records.map((r) => r.status), ['RUNNING', 'SUCCEEDED', 'RUNNING', 'FAILED']);
  assert.deepEqual(f.records.map((r) => r.sequence), [1, 1, 2, 2]);
  assert.equal(f.records[1].prompt, '实际提示词');
  assert.equal(f.records[1].response, '原始返回');
  assert.equal(f.records[1].stage, 'QUERY_REVIEW');
  assert.equal(f.records[3].error, 'transport failed');
});

test('agent trace contexts keep parallel copy/image calls and stage updates isolated', async () => {
  const f = fixture();
  const execute = async ({ claim, controlPlane }) => {
    await controlPlane.updateProgress(claim.execution.id, { stage: claim.execution.id });
    await traceModelCall(meta, async (capture) => {
      await new Promise((resolve) => setTimeout(resolve, 5)); capture.response(claim.execution.id);
    });
  };
  const agent = createExecutorAgent({
    controlPlane: { ...f.controlPlane,
      claimCopy: async () => ({ task: { id: 1 }, execution: { id: 'copy' } }),
      claimImage: async () => ({ task: { id: 2 }, execution: { id: 'image' } }),
    }, nodeId: 'test', imageWorkerEnabled: true, readinessCheck: async () => {},
    executeCopy: execute, executeImage: execute,
  });
  await agent.prepare();
  const results = await Promise.all([agent.runCopyOnce(), agent.runImageOnce()]);
  assert.ok(results.every((r) => r.status === 'SUCCEEDED'));
  for (const record of f.records.filter((r) => r.status === 'SUCCEEDED')) {
    assert.equal(record.response, record.executionId); assert.equal(record.stage, record.executionId);
    assert.equal(record.sequence, 1);
  }
  assert.equal(f.records.length, 4);
});

test('recording outage never reruns or fails a successful model call', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  let uploads = 0;
  const result = await withModelCallTracing({ executionId: 'x', controlPlane: {
    recordModelCall: async () => { uploads++; throw new Error('offline'); },
  } }, () => traceModelCall(meta, async () => { calls++; return 'ok'; }));
  assert.equal(result, 'ok'); assert.equal(calls, 1); assert.equal(uploads, 4);
  assert.equal(await traceModelCall(meta, async () => 42), 42);
});

test('trace redacts keys and bounds long output with an explicit truncation marker', () => {
  const result = safeTraceText({ password: 'do-not-store', api_key: 'sk-fakekey123456789', raw: 'Bearer token1234567890', output: 'a'.repeat(200_001) });
  assert.doesNotMatch(result.text, /do-not-store|fakekey|token123/);
  assert.equal(result.text.length, 200_000); assert.equal(result.truncated, true);
  assert.equal(safeTraceText('echo arbitrary-secret', ['arbitrary-secret']).text, 'echo [REDACTED]');
});

test('DeepSeek records raw responses and failed HTTP attempts without consuming the original response body', async () => {
  const f = fixture();
  let requests = 0;
  const payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":"fixture"}' }] }] };
  const client = createDeepSeekResponsesClient({ apiKey: 'arbitrary-private-key', fetchImpl: async () => {
    requests++;
    return requests === 1 ? new Response('unavailable arbitrary-private-key', { status: 503 }) : Response.json(payload);
  } });
  await f.run(async () => {
    await assert.rejects(client.runText({ prompt: 'first prompt' }), /HTTP 503/);
    assert.equal((await client.runText({ prompt: 'second prompt' })).rawText, '{"title":"fixture"}');
  });
  assert.equal(f.records[1].status, 'FAILED');
  assert.equal(f.records[1].response, 'unavailable [REDACTED]');
  assert.equal(f.records[3].prompt, 'second prompt');
  assert.deepEqual(JSON.parse(f.records[3].response), payload);
  assert.doesNotMatch(JSON.stringify(f.records), /arbitrary-private-key/);
});

test('Dots records the actual messages and full provider response', async () => {
  const f = fixture();
  const client = createDotsChatClient({ apiKey: 'fake', fetchImpl: async () => Response.json({ choices: [{ message: { content: '结果' } }] }) });
  await f.run(async () => assert.equal((await client.runText({ prompt: 'Dots prompt' })).rawText, '结果'));
  assert.equal(JSON.parse(f.records[1].prompt)[0].content, 'Dots prompt');
  assert.match(f.records[1].response, /结果/);
});

test('DeepSeek image-search format retries retain every actual repair prompt and raw response', async () => {
  const f = fixture();
  const client = createDeepSeekResponsesClient({ apiKey: 'test-only-key', fetchImpl: async () => Response.json({ status: 'completed', output_text: 'not json' }) });
  await f.run(() => assert.rejects(client.runImageSearch({
    query: '测试配图', copy: { title: '标题', body: '正文' },
    imagePlan: [{ kind: 'hero' }, { kind: 'steps' }, { kind: 'summary' }],
  }), /after 3 attempts/));
  const completed = f.records.filter((r) => r.status !== 'RUNNING');
  assert.equal(completed.length, 3);
  assert.deepEqual(completed.map((r) => r.sequence), [1, 2, 3]);
  assert.ok(completed.every((r) => r.operation === 'WEB_SEARCH' && r.response.includes('not json')));
  assert.notEqual(completed[0].prompt, completed[1].prompt);
});

test('OpenClaw captures message-file prompt before cleanup and preserves original CLI contract', async () => {
  const f = fixture();
  const client = createOpenClawClient({ entryPath: 'fake-entry.mjs', asyncRunner: async (_command, args, options) => {
    assert.ok(args.includes('--message-file')); assert.equal(options.shell, false);
    return { status: 0, stdout: JSON.stringify({ result: { payloads: [{ text: '{"ok":true}' }] } }), stderr: '' };
  } });
  await f.run(() => client.runText({ prompt: 'real file prompt' }));
  assert.equal(f.records[1].prompt, 'real file prompt');
  assert.match(f.records[1].response, /payloads/);
});

test('OpenClaw image attempts each retain their own raw result and do not capture env credentials', async () => {
  const f = fixture();
  let calls = 0;
  const runner = tracedOpenClawRunner(async () => (++calls === 1
    ? { status: 1, stdout: '', stderr: 'secret1234 failed' }
    : { status: 0, stdout: '{"image":"1.png"}', stderr: '' }));
  await f.run(async () => {
    for (let i = 0; i < 2; i++) await runner('node', ['infer', 'image', 'generate', '--prompt', 'image prompt', '--model', 'fake-image'], { env: { API_KEY: 'secret1234' } });
  });
  assert.equal(f.records[1].status, 'FAILED'); assert.equal(f.records[3].status, 'SUCCEEDED');
  assert.equal(f.records[3].operation, 'IMAGE'); assert.equal(f.records[3].sequence, 2);
  assert.doesNotMatch(JSON.stringify(f.records), /secret1234|API_KEY/);
});
