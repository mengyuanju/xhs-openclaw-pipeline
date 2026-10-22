import assert from 'node:assert/strict';
import test from 'node:test';

import { createResearchSnapshot } from '../src/research.mjs';
import { withWebSearchProvider } from '../src/web-search-service.mjs';

const environment = {
  DEEPSEEK_API_KEY: 'deepseek-test-secret',
  DOUBAO_SEARCH_API_KEY: 'doubao-test-secret',
};

function deepseekResponse() {
  return new Response(JSON.stringify({
    results: [
      { title: '资料甲', url: 'https://example.com/a', summary: '详细资料甲', snippet: '资料甲', site_name: 'example.com' },
      { title: '资料乙', url: 'https://example.com/b', summary: '详细资料乙', snippet: '资料乙', site_name: 'example.com' },
    ],
  }));
}

function doubaoResponse() {
  return new Response(JSON.stringify({ Result: { ErrorCode: 0, Documents: [
    { Title: '豆包来源甲', Url: 'https://example.cn/a', HostInfo: { Hostname: 'example.cn' },
      Snippet: [{ Type: 'text', Text: '详细资料甲' }] },
    { Title: '豆包来源乙', Url: 'https://example.cn/b', HostInfo: { Hostname: 'example.cn' },
      Snippet: [{ Type: 'text', Text: '详细资料乙' }] },
  ] } }));
}

function doubaoCustomResponse() {
  return new Response(JSON.stringify({ Result: { ErrorCode: 0, WebResults: [
    { Title: 'Custom 来源甲', Url: 'https://example.cn/a', SiteName: 'example.cn', Summary: '详细资料甲' },
    { Title: 'Custom 来源乙', Url: 'https://example.cn/b', SiteName: 'example.cn', Summary: '详细资料乙' },
  ] } }));
}

test('explicit order routes to Doubao first and stops after sufficient evidence', async () => {
  const calls = [];
  const client = withWebSearchProvider({}, {
    environment,
    settings: { webSearchProviderOrder: ['DOUBAO', 'DEEPSEEK'] },
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return doubaoResponse();
    },
  });
  const snapshot = await createResearchSnapshot({ client, query: '绵阳到北京自驾八天' });
  assert.deepEqual(client.webSearchProviders, ['doubao', 'deepseek']);
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'doubao');
  assert.deepEqual(snapshot.attempts.map(({ provider, status }) => [provider, status]), [['doubao', 'COMPLETED']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://open.feedcoopapi.com/search_api/global_search');
  assert.equal(JSON.parse(calls[0].init.body).Filter.IcpHostOnly, true);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.DOUBAO_SEARCH_API_KEY}`);
  assert.doesNotMatch(JSON.stringify(snapshot), /doubao-test-secret|deepseek-test-secret/u);
});

test('Custom mode routes the same Doubao provider to WebResults evidence', async () => {
  const calls = [];
  const client = withWebSearchProvider({}, {
    environment,
    settings: { webSearchProviderOrder: ['DOUBAO', 'DEEPSEEK'], doubaoSearchMode: 'CUSTOM' },
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return doubaoCustomResponse();
    },
  });
  const snapshot = await createResearchSnapshot({ client, query: '绵阳到北京自驾八天' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'doubao');
  assert.equal(snapshot.sources.length, 2);
  assert.equal(snapshot.sources[0].snippet, '详细资料甲');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://open.feedcoopapi.com/search_api/web_search');
  assert.equal(JSON.parse(calls[0].init.body).Count, 5);
  assert.equal(JSON.parse(calls[0].init.body).NeedSummary, true);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.DOUBAO_SEARCH_API_KEY}`);
  assert.doesNotMatch(JSON.stringify(snapshot), /doubao-test-secret|deepseek-test-secret/u);
});

test('a failed Custom Doubao request switches to DeepSeek without sending the Doubao key to DeepSeek', async () => {
  const calls = [];
  const client = withWebSearchProvider({}, {
    environment,
    settings: { webSearchProviderOrder: ['DOUBAO', 'DEEPSEEK'], doubaoSearchMode: 'CUSTOM' },
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return url.includes('feedcoopapi') ? new Response('upstream failure', { status: 503 }) : deepseekResponse();
    },
  });
  const snapshot = await createResearchSnapshot({ client, query: '家庭收纳方法' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'deepseek');
  assert.deepEqual(snapshot.attempts.map(({ provider, status }) => [provider, status]), [
    ['doubao', 'FAILED'], ['deepseek', 'COMPLETED'],
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://open.feedcoopapi.com/search_api/web_search');
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/search');
  assert.deepEqual(JSON.parse(calls[1].init.body), { query: '家庭收纳方法', count: 5, need_content: false });
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${environment.DEEPSEEK_API_KEY}`);
  assert.doesNotMatch(calls[1].init.body + JSON.stringify(snapshot), /doubao-test-secret|deepseek-test-secret/u);
});

test('empty DeepSeek results fall through to the next provider without model search', async () => {
  const calls = [];
  const client = withWebSearchProvider({}, {
    environment,
    settings: { webSearchProviderOrder: ['DEEPSEEK', 'DOUBAO'] },
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return url.includes('deepseek') ? new Response(JSON.stringify({ results: [] })) : doubaoResponse();
    },
  });
  const snapshot = await createResearchSnapshot({ client, query: '家庭收纳方法' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'doubao');
  assert.deepEqual(snapshot.attempts.map(({ provider, status }) => [provider, status]), [
    ['deepseek', 'FAILED'], ['doubao', 'COMPLETED'],
  ]);
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://api.deepseek.com/v1/tools/search', 'https://open.feedcoopapi.com/search_api/global_search',
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: '家庭收纳方法', count: 5, need_content: false });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${environment.DEEPSEEK_API_KEY}`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${environment.DOUBAO_SEARCH_API_KEY}`);
});

test('Codex backup uses the original client and never calls a disabled provider', async () => {
  const original = { async runWebSearch(input) {
    assert.equal(input.provider, 'codex');
    return { provider: 'codex', result: { content: '可引用的资料', sources: [
      { title: '官方资料', url: 'https://example.gov/guide', snippet: '资料内容' },
    ] } };
  } };
  const client = withWebSearchProvider(original, {
    environment: { DOUBAO_SEARCH_API_KEY: environment.DOUBAO_SEARCH_API_KEY },
    settings: { webSearchProviderOrder: ['DOUBAO', 'CODEX'] },
    fetchImpl: async () => new Response('failure', { status: 500 }),
  });
  assert.throws(() => client.runWebSearch({ provider: 'deepseek', query: '不允许' }), /not configured/u);
  const snapshot = await createResearchSnapshot({ client, query: '政策指南' });
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'codex');
  assert.deepEqual(snapshot.attempts.map(({ provider, status }) => [provider, status]), [
    ['doubao', 'FAILED'], ['codex', 'COMPLETED'],
  ]);
});
