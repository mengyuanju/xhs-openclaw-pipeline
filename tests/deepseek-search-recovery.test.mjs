import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeepSeekWebSearch } from '../src/deepseek-web-search.mjs';
import { withModelCallTracing } from '../src/model-call-trace.mjs';
import { createResearchSnapshot } from '../src/research.mjs';

const KEY = 'offline-fixture-key';
const ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const source = { title: '家具保养资料', url: 'https://example.gov/furniture',
  summary: '竹垫应避免刮擦皮面，并保持干燥。', snippet: '家具保养', site_name: '资料站' };
const jsonResponse = (payload = { results: [source] }) => new Response(JSON.stringify(payload));
const search = (fetchImpl, input = {}, config = {}) => runDeepSeekWebSearch({
  apiKey: KEY, timeoutMs: 5000, fetchImpl, ...config,
}, { query: '竹垫子放真皮沙发上可否', ...input });

async function traced(action) {
  const records = [];
  const result = await withModelCallTracing({ executionId: 'offline-search', controlPlane: {
    async recordModelCall(_execution, _id, record) { records.push(record); },
  } }, action);
  return { result, records: records.filter(record => record.finishedAt) };
}

test('Search API uses one model-free HTTP request and preserves the evidence contract', async () => {
  const calls = [];
  const { result, records } = await traced(() => search(async (url, init) => {
    calls.push({ url, init }); return jsonResponse();
  }, { limit: 8 }, { model: 'ignored-legacy-model' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: '竹垫子放真皮沙发上可否', count: 8, need_content: false,
  });
  assert.equal(result.provider, 'deepseek');
  assert.deepEqual(result.result.sources, [{ title: source.title, url: source.url,
    snippet: source.summary, siteName: source.site_name }]);
  assert.match(result.result.content, /搜索结果摘录/);
  assert.equal(records[0].operation, 'WEB_SEARCH');
  assert.equal(records[0].model, '');
  const request = JSON.parse(records[0].request);
  assert.deepEqual(request.payload, JSON.parse(calls[0].init.body));
  assert.deepEqual(request.provenance.versions, []);
  assert.equal(JSON.parse(records[0].response).endpoint, ENDPOINT);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(records), new RegExp(KEY));
});

test('query shortening uses Unicode characters and traces both original and actual query', async () => {
  const query = '😀'.repeat(200);
  const { records } = await traced(() => search(async (_url, init) => {
    assert.equal(JSON.parse(init.body).query, '😀'.repeat(128));
    return jsonResponse();
  }, { query }));
  assert.equal(records[0].prompt, query);
  assert.equal(JSON.parse(records[0].request).payload.query, '😀'.repeat(128));
});

for (const [topic, suffix] of [
  ['资料', '官方帮助 使用指南'], ['治疗', '卫健委 官方指南'], ['法律', '政府官网 现行规定'],
  ['基金', '监管机构 风险提示 官方资料'], ['社保', '政府官网 现行政策'],
]) {
  test(`a 500-character ${topic} query retains its distinct supplemental qualifier`, async () => {
    const query = topic + '查'.repeat(500 - topic.length);
    const queries = [];
    const client = { webSearchProviders: ['deepseek'], runWebSearch: input => search(async (_url, init) => {
      queries.push(JSON.parse(init.body).query);
      return jsonResponse({ results: queries.length === 1 ? [] : [source] });
    }, input) };
    const snapshot = await createResearchSnapshot({ client, query, requireAuthoritative: topic !== '资料' });
    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.query, query);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(value => [...value].length <= 128));
    assert.ok(queries[1].endsWith(` ${suffix}`));
    assert.notEqual(queries[0], queries[1]);
  });
}

test('invalid requests fail before any network call', async () => {
  const noFetch = () => assert.fail('invalid input must not be sent');
  for (const query of ['', '  ', '字'.repeat(501)]) await assert.rejects(search(noFetch, { query }), /query/);
  for (const limit of [0, 11, 1.5]) await assert.rejects(search(noFetch, { limit }), /limit/);
  for (const timeoutMs of [0, 4999, 120001]) await assert.rejects(search(noFetch, {}, { timeoutMs }), /timeout/);
  for (const apiKey of ['', 'key with whitespace']) await assert.rejects(search(noFetch, {}, { apiKey }), /API_KEY/);
});

test('untrusted sources are validated and deduplicated before composing an excerpt', async () => {
  const result = await search(async () => jsonResponse({ results: [null, 'not a result',
    ...['javascript:alert(1)', 'https://user:pass@example.com/a', 'http://127.0.0.1/a', 'http://service.internal/a']
      .map(url => ({ ...source, title: '不应进入摘要', url })),
    { ...source, url: `${source.url}#one` }, { ...source, url: `${source.url}#two` },
    { title: '次要资料', url: 'https://example.org/guide', summary: '  ', snippet: '短摘要', site_name: null },
  ] }));
  assert.equal(result.result.sources.length, 2);
  assert.equal(result.result.sources[0].url, source.url);
  assert.equal(result.result.sources[1].snippet, '短摘要');
  assert.equal(result.result.sources[1].siteName, '');
  assert.doesNotMatch(result.result.content, /不应进入摘要/);
});

test('all retained sources fit the generation excerpt without claiming fetched content', async () => {
  const result = await search(async () => jsonResponse({ results: Array.from({ length: 10 }, (_, index) => ({
    ...source, title: `来源${index}`, url: `https://example.gov/${index}`, summary: '长'.repeat(10_000),
    content: '这不是摘要，不能当作已抓取全文',
  })) }), { limit: 10 });
  assert.ok(result.result.content.length <= 2_000);
  for (let index = 0; index < 10; index++) assert.ok(result.result.content.includes(`来源${index}`));
  assert.ok(result.result.sources.every(item => [...item.snippet].length === 3_000));
  assert.doesNotMatch(JSON.stringify(result), /这不是摘要/);
});

test('empty results are evidence insufficiency, not a protocol failure or a retry trigger', async () => {
  let calls = 0;
  const result = await search(async () => { calls++; return jsonResponse({ results: [] }); });
  assert.deepEqual(result, { provider: 'deepseek', result: { content: '', sources: [], structuredSourcesOnly: true } });
  assert.equal(calls, 1);
});

test('URLs mentioned inside search excerpts cannot become sources or satisfy authoritative research', async () => {
  const actualUrl = 'https://forum.example.com/post';
  const mentionedUrl = 'https://example.gov/unverified-reference';
  const queries = [];
  const client = { webSearchProviders: ['deepseek'], runWebSearch: input => search(async (_url, init) => {
    queries.push(JSON.parse(init.body).query);
    return jsonResponse({ results: [{ ...source, url: actualUrl, summary: `网友提到了 ${mentionedUrl}` }] });
  }, input) };
  const ordinary = await createResearchSnapshot({ client, query: '普通问题', supplementalSearch: false });
  assert.deepEqual(ordinary.sources.map(item => item.url), [actualUrl]);
  const authoritative = await createResearchSnapshot({ client, query: '政策问题', requireAuthoritative: true });
  assert.equal(authoritative.status, 'FAILED');
  assert.deepEqual(authoritative.sources, []);
  assert.equal(authoritative.attempts.length, 2);
  assert.equal(queries.length, 3);
});

for (const status of [408, 429, 500, 504]) {
  test(`HTTP ${status} gets at most one retry within the same deadline`, async () => {
    const calls = [];
    const { result, records } = await traced(() => search(async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? new Response(`untrusted ${KEY}`, { status }) : jsonResponse();
    }));
    assert.equal(result.result.sources.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url === ENDPOINT));
    assert.equal(calls[0].init.signal, calls[1].init.signal);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.deepEqual(records.map(record => [record.operation, record.status]), [
      ['WEB_SEARCH', 'FAILED'], ['WEB_SEARCH_RETRY', 'SUCCEEDED'],
    ]);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(KEY));
  });
}

test('repeated transient failures stop after two HTTP calls without model fallback', async () => {
  let calls = 0;
  await assert.rejects(search(async url => {
    assert.equal(url, ENDPOINT); calls++; return new Response('unavailable', { status: 503 });
  }), /HTTP 503/);
  assert.equal(calls, 2);
});

test('Retry-After exceeding the remaining deadline is not ignored', async () => {
  let calls = 0;
  await assert.rejects(search(async () => {
    calls++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '3600' } });
  }), /HTTP 429/);
  assert.equal(calls, 1);
});

for (const status of [400, 401, 402, 403, 404, 413]) {
  test(`HTTP ${status} never retries or leaks the upstream error body`, async () => {
    let calls = 0;
    const { records } = await traced(async () => {
      await assert.rejects(search(async () => {
        calls++; return new Response(`sensitive ${KEY}`, { status });
      }), error => error.message === `DeepSeek web search failed with HTTP ${status}`);
    });
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(records), /sensitive|offline-fixture-key/);
  });
}

test('network and interrupted-body errors each allow one bounded retry', async () => {
  for (const kind of ['network', 'body']) {
    let calls = 0;
    const result = await search(async () => {
      calls++;
      if (calls === 2) return jsonResponse();
      if (kind === 'network') throw new Error(`untrusted ${KEY}`);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`untrusted ${KEY}`)); } }));
    });
    assert.equal(calls, 2);
    assert.equal(result.result.sources.length, 1);
  }
});

test('upstream RangeErrors cannot leak credentials through failed research snapshots', async () => {
  let calls = 0;
  const client = { webSearchProviders: ['deepseek'], runWebSearch: input => search(async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new RangeError(KEY)); } }));
  }, input) };
  const snapshot = await createResearchSnapshot({ client, query: '资料' });
  assert.equal(snapshot.status, 'FAILED');
  assert.equal(calls, 2);
  assert.match(snapshot.attempts[0].error, /body transfer was interrupted/);
  assert.ok(!JSON.stringify(snapshot).includes(KEY));
});

test('malformed payloads and legacy model output never invoke model recovery', async () => {
  for (const raw of ['', '  ', '<html>proxy error</html>', 'data: {}', '{broken',
    JSON.stringify({ error: { message: KEY } }), JSON.stringify({ results: {} }),
    JSON.stringify({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }] })]) {
    let calls = 0;
    await assert.rejects(search(async () => { calls++; return new Response(raw); }), /empty response|valid JSON|invalid search results/);
    assert.equal(calls, 1);
  }
});

test('response size is bounded before parsing and oversized streams are cancelled', async () => {
  let cancelled = false, calls = 0;
  await assert.rejects(search(async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
      cancel() { cancelled = true; },
    }));
  }), /too large/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('credentials in fields and percent-encoded URLs never enter evidence or traces', async () => {
  const encoded = [...KEY].map(char => `%${char.charCodeAt(0).toString(16)}`).join('');
  const { result, records } = await traced(() => search(async () => jsonResponse({ secret: KEY, results: [
    { ...source, title: KEY, summary: `plain ${KEY} encoded ${encoded}`, site_name: `offline-fixture-<b>key</b>` },
    { ...source, url: `https://example.gov/${KEY}` },
    { ...source, url: `https://example.gov/${encoded}` },
    { ...source, url: `https://example.gov/${encoded.replaceAll('%', '%25')}` },
  ] })));
  assert.equal(result.result.sources.length, 1);
  const serialized = JSON.stringify({ result, records });
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes(encoded));
  assert.match(serialized, /REDACTED/);
});

test('already cancelled execution never starts a search', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search(() => assert.fail('no request after cancellation'), { signal: controller.signal }), { name: 'AbortError' });
});

test('execution cancellation interrupts a body stream and does not retry', async () => {
  const controller = new AbortController();
  let calls = 0, cancelled = false;
  await assert.rejects(search(async () => {
    calls++;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    setTimeout(() => controller.abort(), 10);
    return response;
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('execution cancellation during backoff prevents the retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(search(async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Response('busy', { status: 429 });
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('one deadline covers response body transfer without reclassifying timeout as empty results', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  let calls = 0;
  await assert.rejects(search(async () => {
    calls++;
    setTimeout(() => deadline.abort(new DOMException('deadline', 'TimeoutError')), 10);
    return new Response(new ReadableStream());
  }), /timed out while reading response body/);
  assert.equal(calls, 1);
});
