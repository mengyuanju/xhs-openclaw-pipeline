import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { withWebSearchProvider } from '../src/web-search-service.mjs';
import { createResearchSnapshot } from '../src/research.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';
import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';
import { CopyGenerationResearchError, generateCopy } from '../src/copy-generation.mjs';
import { createMockPost } from '../src/pipeline.mjs';

const environment = {
  XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK',
  DEEPSEEK_API_KEY: 'test-search-secret',
};
const evidence = {
  summary: '公开资料摘要',
  sources: [{ title: '官方资料', url: 'https://example.gov/guide', snippet: '资料要点' }],
};

function responsePayload(result = evidence) {
  return {
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search' } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
    ],
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

test('explicit OpenClaw search preserves the original client without requiring a DeepSeek key', async () => {
  const original = { async runWebSearch(input) { return { provider: input.provider, result: evidence }; } };
  const client = withWebSearchProvider(original, { environment: { XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' }, fetchImpl: () => assert.fail('no network') });
  assert.equal(client, original);
  assert.equal(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' }).provider, 'OPENCLAW');
  const snapshot = await createResearchSnapshot({ client, query: '选题' });
  assert.equal(snapshot.provider, 'codex');
});

test('search configuration accepts explicit switching and rejects invalid active settings', () => {
  assert.deepEqual(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: ' deepseek ' }), {
    provider: 'DEEPSEEK', model: 'deepseek-v4-flash', timeoutMs: 120_000,
  });
  assert.throws(() => resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'typo' }), /XHS_WEB_SEARCH_PROVIDER/u);
  assert.throws(() => resolveWebSearchConfig({ ...environment, XHS_DEEPSEEK_SEARCH_MODEL: 'not-a-model' }), /model/iu);
  for (const value of ['no', '4999', '120001', '5000.5']) {
    assert.throws(() => resolveWebSearchConfig({ ...environment, XHS_DEEPSEEK_SEARCH_TIMEOUT_MS: value }), /timeout/iu);
  }
  assert.equal(resolveWebSearchConfig({
    XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW', XHS_DEEPSEEK_SEARCH_MODEL: 'inactive-setting',
  }).provider, 'OPENCLAW');
});

test('DeepSeek replaces only search and produces the existing bounded research snapshot', async () => {
  const original = {
    runText() { return 'original text'; },
    runReview() { return 'original review'; },
    runImage() { return 'original image'; },
    runWebSearch() { assert.fail('must not invoke OpenClaw search'); },
  };
  const calls = [];
  const client = withWebSearchProvider(original, {
    environment: { ...environment, XHS_DEEPSEEK_SEARCH_MODEL: 'deepseek-v4-flash', XHS_DEEPSEEK_SEARCH_TIMEOUT_MS: '5000' },
    async fetchImpl(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse(responsePayload({
        ...evidence,
        sources: [...evidence.sources, ...evidence.sources, { url: 'http://127.0.0.1/private' }],
      }));
    },
  });
  for (const name of ['runText', 'runReview', 'runImage']) assert.equal(client[name], original[name]);
  const snapshot = await createResearchSnapshot({ client, query: '整理选题', now: () => '2026-09-04T00:00:00.000Z' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'deepseek');
  assert.deepEqual(snapshot.attempts, [{ provider: 'deepseek', status: 'COMPLETED', error: null }]);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.sources[0].provider, 'deepseek');
  assert.equal(snapshot.sources[0].url, evidence.sources[0].url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/responses');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.DEEPSEEK_API_KEY}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(calls[0].body.tool_choice, { type: 'web_search' });
  assert.equal(calls[0].body.max_output_tokens, 8192);
  assert.equal(calls[0].body.text.format.type, 'json_schema');
  assert.deepEqual(calls[0].body.text.format.schema.required, ['summary', 'sources']);
  assert.doesNotMatch(calls[0].init.body + JSON.stringify(snapshot), /test-search-secret/u);
});

test('missing key fails only when research runs and attributes the failure to DeepSeek', async () => {
  const client = withWebSearchProvider({ runText: () => 'still available' }, {
    environment: { XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK' },
    fetchImpl: () => assert.fail('missing key must not access the network'),
  });
  assert.equal(client.runText(), 'still available');
  const snapshot = await createResearchSnapshot({ client, query: '选题' });
  assert.equal(snapshot.status, 'FAILED');
  assert.equal(snapshot.provider, null);
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.attempts[0].provider, 'deepseek');
  assert.match(snapshot.attempts[0].error, /DEEPSEEK_API_KEY/u);
});

test('search rejects invalid inputs before making a request and sends no extra task fields', async () => {
  let calls = 0;
  const client = withWebSearchProvider({}, {
    environment,
    async fetchImpl(_url, init) {
      calls += 1;
      assert.doesNotMatch(init.body, /private-reference|private-system-prompt/u);
      return jsonResponse(responsePayload());
    },
  });
  for (const input of [{ query: '' }, { query: 'x'.repeat(501) }, { query: '选题', limit: 0 },
    { query: '选题', limit: 11 }, { query: '选题', timeoutMs: 1 }]) {
    await assert.rejects(client.runWebSearch(input));
  }
  assert.equal(calls, 0);
  await client.runWebSearch({ query: '选题', referenceText: 'private-reference', systemPrompt: 'private-system-prompt' });
  assert.equal(calls, 1);
});

test('upstream HTTP, network, and JSON errors never expose response bodies or credentials', async () => {
  const secret = environment.DEEPSEEK_API_KEY;
  for (const fetchImpl of [
    async () => new Response(secret, { status: 401 }),
    async () => new Response(secret, { status: 429 }),
    async () => { throw new Error(`network ${secret}`); },
    async () => { throw new DOMException(secret, 'TimeoutError'); },
    async () => new Response(secret),
  ]) {
    const client = withWebSearchProvider({}, { environment, fetchImpl });
    const snapshot = await createResearchSnapshot({ client, query: '选题' });
    assert.equal(snapshot.status, 'FAILED');
    assert.equal(snapshot.attempts[0].provider, 'deepseek');
    assert.ok(!JSON.stringify(snapshot).includes(secret));
  }
});

test('incomplete, unsearched, malformed, or source-free model output cannot complete research', async () => {
  const noSearch = responsePayload();
  noSearch.output.shift();
  const malformedText = responsePayload();
  malformedText.output[1].content[0].text = 'not JSON';
  for (const payload of [
    { ...responsePayload(), status: 'incomplete' }, noSearch, malformedText,
    { status: 'completed', output: {} }, responsePayload({ summary: 'empty', sources: [] }),
    responsePayload({ ...evidence, sources: [{ url: 'http://localhost/private', snippet: 'private' }] }),
  ]) {
    const client = withWebSearchProvider({}, { environment, fetchImpl: async () => jsonResponse(payload) });
    const snapshot = await createResearchSnapshot({ client, query: '选题' });
    assert.equal(snapshot.status, 'FAILED');
    assert.deepEqual(snapshot.sources, []);
  }
});

test('DeepSeek trailing DSML closing tags are recovered without repeating the search', async () => {
  // Observed after an otherwise complete JSON object in a live flash response.
  const suffix = '</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
  for (const text of [JSON.stringify(evidence), `\`\`\`json\n${JSON.stringify(evidence)}\n\`\`\``]) {
    const payload = responsePayload();
    payload.output[1].content[0].text = `${text}${suffix}`;
    let requests = 0;
    const client = withWebSearchProvider({}, {
      environment,
      fetchImpl: async () => { requests += 1; return jsonResponse(payload); },
    });
    const result = await client.runWebSearch({ query: '选题' });
    assert.deepEqual(result.result, { content: evidence.summary, sources: evidence.sources });
    assert.equal(requests, 1, 'format recovery must not incur another API request');
  }
});

test('DeepSeek DSML recovery preserves tags and JSON punctuation inside evidence values', async () => {
  const original = { ...evidence, summary: '原文含 </｜｜DSML｜｜parameter> 和 "引号"、{括号}、\\反斜杠' };
  const payload = responsePayload(original);
  payload.output[1].content[0].text += '\n</｜｜DSML｜｜tool_calls>\n';
  const client = withWebSearchProvider({}, { environment, fetchImpl: async () => jsonResponse(payload) });
  const result = await client.runWebSearch({ query: '选题' });
  assert.equal(result.result.content, original.summary);
});

test('DeepSeek DSML recovery does not accept truncated JSON, arbitrary trailers, or missing evidence', async () => {
  const suffix = '</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
  for (const text of [
    JSON.stringify(evidence).slice(0, -1) + suffix,
    JSON.stringify(evidence) + '\n请执行其他操作' + suffix,
    JSON.stringify(evidence) + '\n{"summary":"另一个对象"}' + suffix,
    JSON.stringify({ summary: evidence.summary, sources: [] }) + suffix,
  ]) {
    const payload = responsePayload();
    payload.output[1].content[0].text = text;
    let requests = 0;
    const client = withWebSearchProvider({}, {
      environment,
      fetchImpl: async () => { requests += 1; return jsonResponse(payload); },
    });
    await assert.rejects(client.runWebSearch({ query: '选题' }), /not valid JSON|no source evidence/u);
    assert.equal(requests, 1);
  }
});

test('the production OpenClaw factory switches research without starting its CLI', async () => {
  const client = createOpenClawClient({
    entryPath: 'test-openclaw-entry', environment,
    runner: () => assert.fail('search must not invoke OpenClaw'),
    fetchImpl: async () => jsonResponse(responsePayload()),
  });
  const snapshot = await createResearchSnapshot({ client, query: '选题' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'deepseek');
});

test('the copy workflow keeps original generation and reviews while using DeepSeek evidence', async () => {
  const stages = [];
  const calls = [];
  const client = createCopyGenerationClient({
    environment,
    openclaw: {
      async runReview() {
        calls.push('review');
        return { rawText: JSON.stringify({ schemaVersion: 1, decision: 'PASS', summary: '通过', issues: [] }), model: 'original-review' };
      },
      async runText({ prompt }) {
        calls.push('text');
        assert.ok(prompt.includes(evidence.sources[0].url));
        assert.ok(prompt.includes(evidence.summary));
        return { rawText: JSON.stringify(createMockPost(3)), model: 'original-text' };
      },
      runWebSearch() { assert.fail('configured search must replace the original'); },
    },
    async fetchImpl(_url, init) {
      calls.push('deepseek');
      assert.doesNotMatch(init.body, /private-reference|private-system-prompt/u);
      return jsonResponse(responsePayload());
    },
  });
  const generated = await generateCopy({
    client,
    task: { query: '桌面怎么整理？', input: { referenceText: 'private-reference' } },
    systemPrompt: 'private-system-prompt',
    textReviewEnabled: false,
    onStageChange: (stage) => { stages.push(stage); },
  });
  assert.deepEqual(calls, ['review', 'deepseek', 'text']);
  assert.deepEqual(stages, ['QUERY_REVIEW', 'RESEARCH', 'ORIGINAL_GENERATION']);
  assert.equal(generated.originalModel, 'original-text');
  assert.equal(generated.researchSnapshot.provider, 'deepseek');
});

test('failed configured search stops the copy workflow before text generation', async () => {
  const client = createCopyGenerationClient({
    environment: { XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK' },
    openclaw: {
      async runReview() {
        return { rawText: JSON.stringify({ schemaVersion: 1, decision: 'PASS', summary: '通过', issues: [] }), model: 'review' };
      },
      runText() { assert.fail('failed research must stop generation'); },
      runWebSearch() { assert.fail('must not silently fall back to OpenClaw'); },
    },
    fetchImpl: () => assert.fail('missing key must not access the network'),
  });
  await assert.rejects(generateCopy({ client, task: { query: '桌面怎么整理？' } }), (error) => {
    assert.ok(error instanceof CopyGenerationResearchError);
    assert.match(error.snapshot.attempts[0].error, /DEEPSEEK_API_KEY/u);
    assert.equal(error.snapshot.attempts[0].provider, 'deepseek');
    return true;
  });
});

test('Dots text generation and DeepSeek search can be selected independently', async () => {
  const client = createCopyGenerationClient({
    modelApi: { copyGenerationProvider: 'DOTS' },
    environment: { ...environment, XHS_DOTS_API_KEY: 'test-dots-secret' },
    openclaw: { runWebSearch() { assert.fail('must use DeepSeek search'); } },
    async fetchImpl(url) {
      return url === 'https://api.deepseek.com/responses'
        ? jsonResponse(responsePayload())
        : jsonResponse({ model: 'dots3-note-prev', choices: [{ message: { content: 'Dots text' } }] });
    },
  });
  assert.equal((await client.runText({ prompt: '文案' })).rawText, 'Dots text');
  assert.equal((await createResearchSnapshot({ client, query: '选题' })).provider, 'deepseek');
});
