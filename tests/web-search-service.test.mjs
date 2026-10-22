import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { withWebSearchProvider } from '../src/web-search-service.mjs';
import { createResearchSnapshot } from '../src/research.mjs';
import { createAgentClient } from '../src/agent-client.mjs';
import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';
import { CopyGenerationResearchError, generateCopy } from '../src/copy-generation.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { createPromptRuntime, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { withModelCallTracing } from '../src/model-call-trace.mjs';

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
    results: result.sources.map(({ title, url, snippet, siteName }) => ({
      title, url, summary: snippet, snippet: '较短的摘要', site_name: siteName ?? null,
      content: '', rerank_score: 2, authority: -1, date: null, site_icon: null,
    })),
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

test('DeepSeek Search API sends the query without a model or the published research prompt', async () => {
  const query = '机械键盘轴体体验比较';
  const preference = '管理员检索版本五：优先参考长期使用者的社区反馈，区分个人体验与可核查规格。';
  const runtime = createPromptRuntime({ prompts: {
    RESEARCH_SYSTEM: { content: preference, versionId: 'research-test-5', version: 5 },
  } });
  const calls = [];
  const client = withWebSearchProvider({}, { environment, async fetchImpl(url, init) {
    calls.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(responsePayload());
  } });
  const snapshot = await withPromptRuntime(runtime, () => createResearchSnapshot({ client, query }));

  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.deepEqual(calls[0].body, { query, count: 5, need_content: false });
  assert.ok(!JSON.stringify(calls[0].body).includes(preference));
  assert.match(snapshot.summary, /搜索结果摘录/u);
  assert.equal(snapshot.sources[0].url, evidence.sources[0].url);
  assert.equal(snapshot.sources[0].snippet, evidence.sources[0].snippet);
});

test('DeepSeek long summaries are used as source excerpts and short snippets are the fallback', async () => {
  let calls = 0;
  const payload = { results: [
    { title: '长摘要资料', url: 'https://example.com/long', summary: '完整摘要', snippet: '短摘要', site_name: '资料站点' },
    { title: '短摘要资料', url: 'https://example.com/short', summary: '', snippet: '备用摘要', site_name: null },
  ] };
  const client = withWebSearchProvider({}, { environment, fetchImpl: async () => { calls++; return jsonResponse(payload); } });
  const snapshot = await createResearchSnapshot({ client, query: 'fixture' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.sources[0].snippet, '完整摘要');
  assert.equal(snapshot.sources[0].siteName, '资料站点');
  assert.equal(snapshot.sources[1].snippet, '备用摘要');
  assert.equal(snapshot.sources[1].siteName, 'example.com');
  assert.match(snapshot.summary, /完整摘要/u);
  assert.match(snapshot.summary, /备用摘要/u);
  assert.equal(calls, 1);
});

test('DeepSeek request truncation counts Unicode characters while preserving the original snapshot query', async () => {
  const query = '🧰'.repeat(200);
  const calls = [];
  const client = withWebSearchProvider({}, { environment, fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse(responsePayload());
  } });
  const snapshot = await createResearchSnapshot({ client, query });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.query, query);
  assert.deepEqual(calls, [{ query: '🧰'.repeat(128), count: 5, need_content: false }]);
});

test('explicit Codex search preserves the original client without requiring a DeepSeek key', async () => {
  const original = { async runWebSearch(input) { return { provider: input.provider, result: evidence }; } };
  const client = withWebSearchProvider(original, { environment: { XHS_WEB_SEARCH_PROVIDER: 'CODEX' }, fetchImpl: () => assert.fail('no network') });
  assert.equal(client, original);
  assert.equal(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'CODEX' }).provider, 'CODEX');
  const snapshot = await createResearchSnapshot({ client, query: '选题' });
  assert.equal(snapshot.provider, 'codex');
});

test('search configuration accepts explicit switching and rejects invalid active settings', () => {
  assert.deepEqual(resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: ' deepseek ' }), {
    provider: 'DEEPSEEK', timeoutMs: 120_000, resultLimit: 5,
  });
  assert.throws(() => resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'typo' }), /XHS_WEB_SEARCH_PROVIDER/u);
  assert.deepEqual(resolveWebSearchConfig({ ...environment, XHS_DEEPSEEK_SEARCH_MODEL: 'not a model' }),
    resolveWebSearchConfig(environment));
  assert.deepEqual(resolveWebSearchConfig(environment, { deepseekSearchModel: 'deepseek-v5-search-preview' }),
    resolveWebSearchConfig(environment));
  for (const value of ['no', '4999', '120001', '5000.5']) {
    assert.throws(() => resolveWebSearchConfig({ ...environment, XHS_DEEPSEEK_SEARCH_TIMEOUT_MS: value }), /timeout/iu);
  }
  assert.equal(resolveWebSearchConfig({
    XHS_WEB_SEARCH_PROVIDER: 'CODEX', XHS_DEEPSEEK_SEARCH_MODEL: 'inactive-setting',
  }).provider, 'CODEX');
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
    environment: { ...environment, XHS_DEEPSEEK_SEARCH_MODEL: 'deepseek-v5-search-preview', XHS_DEEPSEEK_SEARCH_TIMEOUT_MS: '5000' },
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
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.DEEPSEEK_API_KEY}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, { query: '整理选题', count: 5, need_content: false });
  assert.equal(calls[0].init.headers.Accept, 'application/json');
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

test('body timeout after successful HTTP headers is not misreported as invalid JSON', async () => {
  let requests = 0;
  const client = withWebSearchProvider({}, { environment, fetchImpl: async (_url, { signal }) => {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('\n\n'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  } });
  // Keep the event loop alive while AbortSignal.timeout's unref'd timer runs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(client.runWebSearch({ query: 'fixture', timeoutMs: 5000 }), error => {
      assert.match(error.message, /timed out while reading response body/);
      assert.doesNotMatch(error.message, /JSON/);
      return true;
    });
  } finally { clearInterval(keepAlive); }
  assert.equal(requests, 1);
});

test('interrupted response bodies retain a transport error without exposing the upstream cause', async () => {
  const client = withWebSearchProvider({}, { environment, fetchImpl: async () => new Response(
    new ReadableStream({ start(controller) { controller.error(new TypeError(environment.DEEPSEEK_API_KEY)); } }),
  ) });
  await assert.rejects(client.runWebSearch({ query: 'fixture' }), error => {
    assert.match(error.message, /body transfer was interrupted/);
    assert.doesNotMatch(error.message, /not valid JSON|test-search-secret/);
    return true;
  });
});

test('non-streaming keep-alive whitespace is accepted without repeating research', async () => {
  let requests = 0;
  const client = withWebSearchProvider({}, { environment, fetchImpl: async () => {
    requests++;
    return new Response(`\r\n\n ${JSON.stringify(responsePayload())}\n`);
  } });
  assert.ok((await client.runWebSearch({ query: 'fixture' })).result.content.includes(evidence.sources[0].snippet));
  assert.equal(requests, 1);
});

test('invalid HTTP bodies have distinct safe diagnostics and cannot supply research evidence', async () => {
  for (const [raw, expected, format] of [
    ['\r\n\n', /empty response body/, 'EMPTY'],
    [`<html>${environment.DEEPSEEK_API_KEY}</html>`, /HTML\/XML page/, 'HTML_OR_XML'],
    ['event: response.completed\ndata: {}\n\n', /unexpected event stream/, 'EVENT_STREAM'],
    ['{"status":"completed","output":', /malformed or truncated/, 'JSON_OR_TEXT'],
  ]) {
    const records = [];
    const client = withWebSearchProvider({}, { environment, fetchImpl: async () => new Response(raw) });
    await withModelCallTracing({ executionId: 'body-failure', controlPlane: {
      async recordModelCall(_executionId, _id, record) { records.push(record); },
    } }, () => assert.rejects(client.runWebSearch({ query: 'fixture' }), expected));
    const last = records.at(-1);
    assert.equal(last.status, 'FAILED');
    assert.equal(JSON.parse(last.response).bodyFormat, format);
    assert.doesNotMatch(JSON.stringify(records), /test-search-secret/);
  }
});

test('malformed, source-free, or private Search API results cannot complete research', async () => {
  for (const payload of [
    { results: {} }, { summary: evidence.summary, sources: evidence.sources },
    { status: 'completed', output: [] }, responsePayload({ summary: 'empty', sources: [] }),
    responsePayload({ ...evidence, sources: [{ url: 'http://localhost/private', snippet: 'private' }] }),
  ]) {
    const client = withWebSearchProvider({}, { environment, fetchImpl: async () => jsonResponse(payload) });
    const snapshot = await createResearchSnapshot({ client, query: '选题' });
    assert.equal(snapshot.status, 'FAILED');
    assert.deepEqual(snapshot.sources, []);
  }
});

test('empty DeepSeek results trigger a supplemental query with the authoritative suffix retained', async () => {
  const query = `政策${'资料'.repeat(240)}`;
  const calls = [];
  const client = withWebSearchProvider({}, { environment, fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse(calls.length === 1 ? { results: [] } : responsePayload());
  } });
  const snapshot = await createResearchSnapshot({ client, query, requireAuthoritative: true });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.query, query);
  assert.equal(calls.length, 2);
  assert.equal([...calls[0].query].length, 128);
  assert.equal([...calls[1].query].length, 128);
  assert.ok(calls[1].query.endsWith('政府官网 现行政策'));
  assert.deepEqual(snapshot.attempts.map(({ status }) => status), ['FAILED', 'COMPLETED']);
});

test('the production Codex factory switches research without starting its CLI', async () => {
  const client = createAgentClient({
    executable: 'fake-codex', environment, runtime: { assertAvailable() {} },
    runner: () => assert.fail('search must not invoke Codex'),
    fetchImpl: async () => jsonResponse(responsePayload()),
  });
  const snapshot = await createResearchSnapshot({ client, query: '选题' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'deepseek');
});

test('the copy workflow uses DeepSeek evidence with Query screening off by default', async () => {
  const stages = [];
  const calls = [];
  const client = createCopyGenerationClient({
    environment,
    agentClient: {
      async runReview() {
        calls.push('review');
        return { rawText: JSON.stringify({ schemaVersion: 1, decision: 'PASS', summary: '通过', issues: [] }), model: 'original-review' };
      },
      async runText({ prompt }) {
        calls.push('text');
        assert.ok(prompt.includes(evidence.sources[0].url));
        assert.ok(prompt.includes(evidence.sources[0].snippet));
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
  assert.deepEqual(calls, ['deepseek', 'text']);
  assert.deepEqual(stages, ['RESEARCH', 'ORIGINAL_GENERATION']);
  assert.equal(generated.stageReviews.query.skipped, true);
  assert.equal(generated.originalModel, 'original-text');
  assert.equal(generated.researchSnapshot.provider, 'deepseek');
});

test('failed configured search stops the copy workflow before text generation', async () => {
  const client = createCopyGenerationClient({
    environment: { XHS_WEB_SEARCH_PROVIDER: 'DEEPSEEK' },
    agentClient: {
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
    agentClient: { runWebSearch() { assert.fail('must use DeepSeek search'); } },
    async fetchImpl(url) {
      return url === 'https://api.deepseek.com/v1/tools/search'
        ? jsonResponse(responsePayload())
        : jsonResponse({ model: 'dots3-note-prev', choices: [{ message: { content: 'Dots text' } }] });
    },
  });
  assert.equal((await client.runText({ prompt: '文案' })).rawText, 'Dots text');
  assert.equal((await createResearchSnapshot({ client, query: '选题' })).provider, 'deepseek');
});
