import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCodexClient } from '../src/codex.mjs';
import { runDeepSeekWebSearch } from '../src/deepseek-web-search.mjs';
import { withModelCallTracing, traceModelCall } from '../src/model-call-trace.mjs';
import { businessPrompt, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { renderPrompt } from '../src/admin/prompt-service.mjs';

function fixture(snapshot) {
  const records = [];
  return { records, run: action => withModelCallTracing({ executionId: 'fixture', snapshot, controlPlane: {
    recordModelCall: async (_execution, _id, record) => records.push(structuredClone(record)),
  } }, action) };
}

test('Codex request evidence matches stdin, developer instructions, output schema and tool configuration sent to the runner', async () => {
  const f = fixture();
  let sent;
  const outputSchema = { type: 'object', properties: { title: { type: 'string', maxLength: 20 } }, required: ['title'] };
  const client = createCodexClient({ executable: process.execPath,
    runtime: { run: action => action({ onSpawn() {} }) },
    asyncRunner: async (_command, args, options) => {
      sent = { args, input: options.input, outputSchema: JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')) };
      return { status: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"title":"测试"}' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
    },
  });
  await f.run(() => client.runText({ prompt: '测试完整输入', outputSchema }));
  const evidence = JSON.parse(f.records.at(-1).request);
  assert.equal(evidence.format, 'xhs-model-request');
  assert.equal(evidence.scope, 'CLI_INPUT');
  assert.deepEqual(evidence.payload.args, sent.args);
  assert.equal(evidence.payload.input, sent.input);
  assert.deepEqual(evidence.payload.outputSchema, sent.outputSchema);
  assert.match(evidence.payload.developerInstructions, /Do not wrap it in rawText/);
  assert.ok(sent.args.includes(`developer_instructions=${JSON.stringify(evidence.payload.developerInstructions)}`));
  assert.equal('env' in evidence.payload, false);
});

test('each call retains only business versions actually present in its request and freezes the original version', async () => {
  const f = fixture();
  const prompts = {
    TEXT_SYSTEM: { id: 11, version: 2, content: '文案规则：{{query}}' },
    TEXT_REVIEW_SYSTEM: { id: 12, version: 5, content: '逐项核对证据' },
  };
  await f.run(() => withPromptRuntime({ prompts, source: 'TEST_SNAPSHOT', capturedAt: '2026-09-07T00:00:00Z' }, async () => {
    const first = businessPrompt('TEXT_SYSTEM', { data: { query: '原始选题' } });
    const second = businessPrompt('TEXT_REVIEW_SYSTEM', { data: { query: '审核选题' } });
    prompts.TEXT_SYSTEM.version = 99;
    for (const prompt of [first, second]) await traceModelCall({ prompt, request: { input: prompt }, provider: 'fake' }, async () => {});
  }));
  const first = JSON.parse(f.records[0].request).provenance;
  const second = JSON.parse(f.records[2].request).provenance;
  assert.deepEqual(first.versions.map(v => [v.kind, v.versionId, v.version]), [['TEXT_SYSTEM', 11, 2]]);
  assert.deepEqual(second.versions.map(v => v.kind), ['TEXT_REVIEW_SYSTEM']);
  assert.match(first.versions[0].templateSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.versions[0].templateSha256, first.versions[0].renderedSha256);
  assert.equal(first.versions[0].source, 'TEST_SNAPSHOT');
});

test('legacy rendered templates are linked to the execution snapshot without exposing unused templates', async () => {
  const f = fixture({ capturedAt: '2026-09-07T00:00:00Z', prompts: {
    TEXT_SYSTEM: { versionId: 71, version: 4, content: '给{{query}}写文案' },
    IMAGE_SYSTEM: { versionId: 72, version: 2, content: '尚未使用的图片规则' },
  } });
  await f.run(async () => {
    const prompt = renderPrompt('给{{query}}写文案', { query: '测试主题' });
    await traceModelCall({ prompt, request: { input: prompt }, provider: 'fake' }, async () => {});
  });
  const evidence = JSON.parse(f.records.at(-1).request);
  assert.deepEqual(evidence.provenance.versions.map(v => [v.kind, v.versionId, v.version]), [['TEXT_SYSTEM', 71, 4]]);
  assert.doesNotMatch(f.records.at(-1).request, /尚未使用的图片规则/);
});

test('quoting earlier rules as task data does not claim that earlier business version was used', async () => {
  const f = fixture();
  await f.run(() => withPromptRuntime({ prompts: {
    TEXT_SYSTEM: { id: 1, version: 1, content: '旧文案规则' },
    TEXT_REVIEW_SYSTEM: { id: 2, version: 2, content: '实际审核规则' },
  } }, async () => {
    businessPrompt('TEXT_SYSTEM');
    const prompt = businessPrompt('TEXT_REVIEW_SYSTEM', { data: { previousOutput: '旧文案规则' } });
    await traceModelCall({ prompt, request: { input: prompt }, provider: 'fake' }, async () => {});
  }));
  assert.deepEqual(JSON.parse(f.records.at(-1).request).provenance.versions.map(v => v.kind), ['TEXT_REVIEW_SYSTEM']);
});

test('DeepSeek search evidence is the exact outgoing body with instructions, schema and tool choice', async () => {
  const f = fixture();
  let body;
  await f.run(() => runDeepSeekWebSearch({ apiKey: 'fixture-private-key', model: 'test-model', timeoutMs: 5000,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '资料', sources: [{ title: '官网', url: 'https://example.com', snippet: '依据' }] }) }] }] });
    },
  }, { query: '测试任务', limit: 3 }));
  const evidence = JSON.parse(f.records.at(-1).request);
  assert.equal(evidence.scope, 'HTTP_BODY');
  assert.deepEqual(evidence.payload, body);
  assert.equal(f.records.at(-1).prompt, body.input);
  assert.equal(evidence.payload.tool_choice.type, 'web_search');
  assert.doesNotMatch(f.records.at(-1).request, /fixture-private-key/);
});
