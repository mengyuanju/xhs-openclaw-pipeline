import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachResearchToTask,
  createResearchSnapshot,
  normalizeResearchSnapshot,
  researchSourceUrls,
} from '../src/research.mjs';
import { createPromptRuntime, withPromptRuntime } from '../src/prompt-runtime.mjs';

const NOW = '2026-08-29T08:00:00.000Z';

describe('web research snapshots', () => {
  it('honors a configured source limit after deduplication and authority ranking', async () => {
    const requests = [];
    const results = Array.from({ length: 9 }, (_, index) => ({
      title: `普通来源 ${index + 1}`,
      url: `https://example${index + 1}.com/article`,
      snippet: `第 ${index + 1} 条可核验资料`,
    }));
    results.push({ title: '官方来源', url: 'https://www.gov.cn/guide', snippet: '官方资料' });
    const client = { async runWebSearch(request) {
      requests.push(request);
      return { provider: 'codex', result: { summary: '已完成检索', results } };
    } };
    const snapshot = await createResearchSnapshot({ client, query: '收纳资料',
      providers: ['codex'], limit: 8, now: () => NOW });
    assert.equal(requests[0].limit, 8);
    assert.equal(snapshot.sources.length, 8);
    assert.equal(snapshot.sources[0].url, 'https://www.gov.cn/guide');
    assert.equal(attachResearchToTask({ query: '收纳资料' }, snapshot).input.webResearch.sources.length, 8);
    assert.equal(researchSourceUrls(snapshot).length, 8);

    const one = await createResearchSnapshot({ client, query: '收纳资料',
      providers: ['codex'], limit: 1, now: () => NOW });
    assert.deepEqual(researchSourceUrls(one), ['https://www.gov.cn/guide']);
    await assert.rejects(createResearchSnapshot({ client, query: '收纳资料', limit: 11 }),
      /source limit must be an integer between 1 and 10/u);
    assert.equal(requests.length, 2, 'invalid limits must fail before any provider call');
  });

  it('accepts ten saved sources but rejects more than the supported maximum', () => {
    const value = {
      schemaVersion: 1, status: 'COMPLETED', query: '资料', searchedAt: NOW,
      provider: 'codex', summary: '摘要',
      attempts: [{ provider: 'codex', status: 'COMPLETED', error: null }],
      sources: Array.from({ length: 10 }, (_, index) => ({
        title: `资料 ${index + 1}`, url: `https://example${index + 1}.com/guide`,
        snippet: '可核验', provider: 'codex', retrievedAt: NOW,
      })),
    };
    assert.equal(normalizeResearchSnapshot(value).sources.length, 10);
    assert.throws(() => normalizeResearchSnapshot({ ...value,
      sources: [...value.sources, { ...value.sources[0], url: 'https://example11.com/guide' }],
    }), /research sources are invalid/u);
  });

  it('bounds untrusted source candidates while considering official sources near the bound', async () => {
    const results = Array.from({ length: 99 }, (_, index) => ({
      title: `普通资料 ${index + 1}`, url: `https://example${index + 1}.com/guide`, snippet: '资料',
    }));
    results.push({ title: '官方资料', url: 'https://www.gov.cn/guide', snippet: '官方资料' });
    results.push({ title: '候选上限后的来源', url: 'https://www.nist.gov/guide', snippet: '其他资料' });
    const snapshot = await createResearchSnapshot({
      client: { async runWebSearch() { return { provider: 'codex', result: { summary: '摘要', results } }; } },
      query: '收纳资料', limit: 2, now: () => NOW,
    });
    assert.deepEqual(researchSourceUrls(snapshot), [
      'https://www.gov.cn/guide', 'https://example1.com/guide',
    ]);

    const summaryFallback = await createResearchSnapshot({
      client: { async runWebSearch() { return { provider: 'codex', result: {
        summary: '可核验资料 https://www.gov.cn/from-summary',
        results: Array.from({ length: 100 }, () => ({ title: '无效来源', url: 'javascript:alert(1)' })),
      } }; } },
      query: '收纳资料', limit: 1, now: () => NOW,
    });
    assert.deepEqual(researchSourceUrls(summaryFallback), ['https://www.gov.cn/from-summary']);
  });

  it('uses an intent-aware fallback query independently of prompt runtime configuration', async () => {
    const query = '机械键盘轴体体验比较';
    const calls = [];
    const runtime = createPromptRuntime({ prompts: {
      RESEARCH_SYSTEM: { content: '优先检索用户长期使用反馈，按来源原文引用。', versionId: 'community-search-2', version: 2 },
    } });
    const snapshot = await withPromptRuntime(runtime, () => createResearchSnapshot({
      client: {
        async runWebSearch(input) {
          calls.push(input);
          return { provider: input.provider, result: { results: [] } };
        },
      },
      query,
      providers: ['codex', 'duckduckgo'],
      now: () => NOW,
    }));

    assert.equal(snapshot.status, 'FAILED');
    assert.deepEqual(calls.map(({ provider, query: submittedQuery }) => ({ provider, query: submittedQuery })), [
      { provider: 'codex', query },
      { provider: 'duckduckgo', query },
      { provider: 'codex', query: `${query} 官方帮助 使用指南` },
      { provider: 'duckduckgo', query: `${query} 官方帮助 使用指南` },
    ]);
    assert.ok(calls.every((call) => !call.query.includes('官方 标准 技术规范')));
    assert.deepEqual(snapshot.sources, []);
  });

  it('classifies medical, legal, financial and policy topics for authoritative research', async () => {
    const { requiresAuthoritativeResearch } = await import('../src/research.mjs');
    for (const query of ['儿童发烧怎么用药', '劳动合同纠纷怎么办', '基金定投建议', '社保补贴政策']) {
      assert.equal(requiresAuthoritativeResearch({ query, input: {} }), true, query);
    }
    assert.equal(requiresAuthoritativeResearch({ query: '谷歌浏览器的使用方法', input: { category: '教程' } }), false);
  });

  it('uses only search providers supported by the current OpenClaw release by default', async () => {
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: {
        async runWebSearch({ query, provider }) {
          calls.push({ query, provider });
          return { provider, result: { results: [] } };
        },
      },
      query: '需要核验的主题',
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'FAILED');
    assert.deepEqual(calls.map(({ provider }) => provider), ['codex', 'codex']);
  });

  it('stops after sufficient Doubao evidence without charging a backup search', async () => {
    const calls = [];
    const client = {
      webSearchProviders: ['doubao', 'deepseek'],
      async runWebSearch(request) {
        calls.push(request);
        assert.equal(request.provider, 'doubao');
        return { provider: 'doubao', result: {
          summary: '两条资料共同说明使用方法。',
          results: [
            { title: '豆包资料一', url: 'https://example.com/one', snippet: '第一条资料' },
            { title: '豆包资料二', url: 'https://example.org/two', snippet: '第二条资料' },
          ],
        } };
      },
    };
    const snapshot = await createResearchSnapshot({ client, query: '如何使用产品', now: () => NOW });
    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.provider, 'doubao');
    assert.deepEqual(snapshot.attempts, [{ provider: 'doubao', status: 'COMPLETED', error: null }]);
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao']);
  });

  it('uses the requested source count when deciding if one complete API source is sufficient', async () => {
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: {
        webSearchProviders: ['doubao', 'deepseek'],
        async runWebSearch(request) {
          calls.push(request);
          return { provider: 'doubao', result: { summary: '资料摘要', results: [
            { title: '完整资料', url: 'https://example.com/one', snippet: '可核验摘录' },
          ] } };
        },
      },
      query: '使用说明', limit: 1, now: () => NOW,
    });
    assert.equal(snapshot.provider, 'doubao');
    assert.equal(snapshot.sources.length, 1);
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao']);
  });

  it('tries providers in order after errors or insufficient grounded evidence', async () => {
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: {
        webSearchProviders: ['doubao', 'deepseek', 'codex'],
        async runWebSearch(request) {
          calls.push(request);
          if (request.provider === 'doubao') return { provider: 'doubao', result: {
            summary: '只有一条可核验资料', results: [
              { title: '单条资料', url: 'https://example.com/one', snippet: '资料一' },
            ],
          } };
          if (request.provider === 'deepseek') return { provider: 'deepseek', result: {
            summary: '两条可核验资料', results: [
              { title: '第二条资料', url: 'https://example.org/two', snippet: '资料二' },
              { title: '第三条资料', url: 'https://example.net/three', snippet: '资料三' },
            ],
          } };
          assert.fail('sufficient backup evidence must stop before Codex');
        },
      },
      query: '产品使用方法', now: () => NOW,
    });
    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.provider, 'deepseek');
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao', 'deepseek']);
    assert.deepEqual(snapshot.attempts.map(({ provider, status }) => ({ provider, status })), [
      { provider: 'doubao', status: 'COMPLETED' },
      { provider: 'deepseek', status: 'COMPLETED' },
    ]);
  });

  it('fails over a Codex service error but keeps legacy single-provider error behavior', async () => {
    const serviceError = Object.assign(new Error('Codex quota exhausted'), { code: 'CODEX_QUOTA_EXHAUSTED' });
    const calls = [];
    const client = { webSearchProviders: ['codex', 'doubao'], async runWebSearch(request) {
      calls.push(request);
      if (request.provider === 'codex') throw serviceError;
      return { provider: 'doubao', result: { summary: '可靠资料', results: [
        { title: '官方资料', url: 'https://example.gov.cn/guide', snippet: '官方说明' },
      ] } };
    } };
    const snapshot = await createResearchSnapshot({ client, query: '使用方法', now: () => NOW });
    assert.equal(snapshot.provider, 'doubao');
    assert.deepEqual(calls.map(({ provider }) => provider), ['codex', 'doubao']);
    assert.equal(snapshot.attempts[0].status, 'FAILED');

    await assert.rejects(createResearchSnapshot({ client, query: '使用方法',
      providers: ['codex'], now: () => NOW }), (error) => error === serviceError);
  });

  it('rejects a mismatched provider response and never calls a duplicate provider on one query', async () => {
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: { webSearchProviders: ['doubao', 'deepseek'], async runWebSearch(request) {
        calls.push(request);
        if (request.provider === 'doubao') return { provider: 'deepseek', result: {
          summary: '错误标记的资料', results: [
            { title: '错误来源', url: 'https://example.com/one', snippet: '资料' },
          ],
        } };
        return { provider: 'deepseek', result: { summary: '正确资料', results: [
          { title: '可信来源', url: 'https://example.gov.cn/guide', snippet: '官方说明' },
        ] } };
      } },
      query: '产品说明', providers: ['doubao', 'doubao', 'deepseek'], now: () => NOW,
    });
    assert.equal(snapshot.provider, 'deepseek');
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao', 'deepseek']);
    assert.match(snapshot.attempts[0].error, /provider mismatch/u);
  });

  it('keeps a legacy client that reports its actual backend provider', async () => {
    const snapshot = await createResearchSnapshot({
      client: { async runWebSearch() {
        return { provider: 'duckduckgo', result: { summary: '官方资料', results: [
          { title: '官方说明', url: 'https://example.gov.cn/guide', snippet: '来源摘录' },
        ] } };
      } },
      query: '产品说明', now: () => NOW,
    });
    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.provider, 'duckduckgo');
    assert.equal(snapshot.attempts[0].provider, 'codex');
  });

  it('propagates cancellation without contacting fallback providers', async () => {
    const calls = [];
    const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    await assert.rejects(createResearchSnapshot({
      client: { webSearchProviders: ['doubao', 'deepseek'], async runWebSearch(request) {
        calls.push(request);
        throw aborted;
      } },
      query: '产品说明', now: () => NOW,
    }), (error) => error === aborted);
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao']);
  });

  it('caps each multi-provider attempt by the remaining overall research time', async () => {
    let elapsed = 0;
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: { webSearchProviders: ['doubao', 'deepseek'], webSearchTimeoutMs: 80_000,
        async runWebSearch(request) {
          calls.push(request);
          assert.equal(request.signal.aborted, false);
          if (request.provider === 'doubao') {
            elapsed = 270_000;
            return { provider: 'doubao', result: { results: [] } };
          }
          return { provider: 'deepseek', result: { summary: '官方资料', results: [
            { title: '官方说明', url: 'https://example.gov.cn/guide', snippet: '可核验资料' },
          ] } };
        } },
      query: '产品说明', monotonicNow: () => elapsed, now: () => NOW,
    });
    assert.equal(snapshot.provider, 'deepseek');
    assert.deepEqual(calls.map(({ provider, timeoutMs }) => ({ provider, timeoutMs })), [
      { provider: 'doubao', timeoutMs: 80_000 },
      { provider: 'deepseek', timeoutMs: 30_000 },
    ]);
  });

  it('records a budget failure and stops before an unusably short backup attempt', async () => {
    let elapsed = 0;
    const calls = [];
    const snapshot = await createResearchSnapshot({
      client: { webSearchProviders: ['doubao', 'deepseek'], webSearchTimeoutMs: 80_000,
        async runWebSearch(request) {
          calls.push(request);
          elapsed = 299_999;
          return { provider: 'doubao', result: { results: [] } };
        } },
      query: '产品说明', monotonicNow: () => elapsed, now: () => NOW,
    });
    assert.equal(snapshot.status, 'FAILED');
    assert.deepEqual(calls.map(({ provider }) => provider), ['doubao']);
    assert.deepEqual(snapshot.attempts.map(({ provider, status }) => ({ provider, status })), [
      { provider: 'doubao', status: 'FAILED' },
      { provider: 'deepseek', status: 'FAILED' },
    ]);
    assert.match(snapshot.attempts[1].error, /time budget exhausted/u);
  });

  it('keeps legacy single-provider calls free of the multi-provider deadline', async () => {
    const calls = [];
    await createResearchSnapshot({
      client: { webSearchProviders: ['deepseek'], webSearchTimeoutMs: 5_000,
        async runWebSearch(request) {
          calls.push(request);
          return { provider: 'deepseek', result: { summary: '资料', results: [
            { title: '官方说明', url: 'https://example.gov.cn/guide', snippet: '说明' },
          ] } };
        } },
      query: '产品说明', now: () => NOW,
    });
    assert.deepEqual(calls, [{ query: '产品说明', provider: 'deepseek', limit: 5 }]);
  });

  it('falls back between providers and keeps only bounded public source evidence', async () => {
    const calls = [];
    const client = {
      async runWebSearch({ query, provider, limit }) {
        calls.push({ query, provider, limit });
        if (provider === 'codex') throw new Error('Reconnecting with sk-abcdefghijklmnop');
        return {
          provider: 'duckduckgo',
          result: {
            query,
            results: [
              {
                title: '\n<<<EXTERNAL_UNTRUSTED_CONTENT id="title">>>\nSource: Web Search\n---\n官方养护指南\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="title">>>',
                url: 'https://garden.gov.cn/guide',
                snippet: '\n<<<EXTERNAL_UNTRUSTED_CONTENT id="snippet">>>\nSource: Web Search\n---\n先判断光照，再调整浇水频率。\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="snippet">>>',
                siteName: 'garden.gov.cn',
              },
              {
                title: '重复来源',
                url: 'https://garden.gov.cn/guide',
                snippet: '重复摘要',
              },
              {
                title: '内部地址',
                url: 'http://127.0.0.1/private',
                snippet: '不得保存',
              },
            ],
          },
        };
      },
    };

    const snapshot = await createResearchSnapshot({
      client,
      query: '绿萝叶子发黄怎么办',
      providers: ['codex', 'duckduckgo'],
      now: () => NOW,
    });

    assert.deepEqual(calls, [
      { query: '绿萝叶子发黄怎么办', provider: 'codex', limit: 5 },
      { query: '绿萝叶子发黄怎么办', provider: 'duckduckgo', limit: 5 },
    ]);
    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.provider, 'duckduckgo');
    assert.equal(snapshot.searchedAt, NOW);
    assert.equal(snapshot.attempts[0].status, 'FAILED');
    assert.match(snapshot.attempts[0].error, /REDACTED/u);
    assert.doesNotMatch(snapshot.attempts[0].error, /sk-abcdefghijklmnop/u);
    assert.deepEqual(snapshot.sources, [{
      title: '官方养护指南',
      url: 'https://garden.gov.cn/guide',
      snippet: '先判断光照，再调整浇水频率。',
      siteName: 'garden.gov.cn',
      provider: 'duckduckgo',
      retrievedAt: NOW,
    }]);
  });

  it('retries a low-authority fallback result with an official-evidence query', async () => {
    const calls = [];
    const client = {
      async runWebSearch({ query, provider, limit }) {
        calls.push({ query, provider, limit });
        if (provider === 'codex') throw new Error('hosted search unavailable');
        if (query === '自行车活鱼桶 装水防晃 技巧') {
          return {
            provider,
            result: {
              results: [{
                title: '短视频经验分享',
                url: 'https://www.douyin.com/video/123',
                snippet: '装满水就不会晃。',
                siteName: 'douyin.com',
              }],
            },
          };
        }
        return {
          provider,
          result: {
            results: [{
              title: '活鱼运输技术规范',
              url: 'https://fishery.gov.cn/standards/live-fish',
              snippet: '运输容器应固定，并结合密度、运输时间和供氧条件管理水体。',
              siteName: 'fishery.gov.cn',
            }],
          },
        };
      },
    };

    const snapshot = await createResearchSnapshot({
      client,
      query: '自行车活鱼桶 装水防晃 技巧',
      providers: ['codex', 'duckduckgo'],
      now: () => NOW,
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(({ provider }) => provider), [
      'codex',
      'duckduckgo',
      'duckduckgo',
    ]);
    assert.match(calls[2].query, /官方|标准|技术规范/u);
    assert.equal(snapshot.provider, 'duckduckgo');
    assert.deepEqual(researchSourceUrls(snapshot), [
      'https://fishery.gov.cn/standards/live-fish',
    ]);
  });

  it('refuses low-authority search pages when no grounded summary is available', async () => {
    const client = {
      async runWebSearch({ provider }) {
        if (provider === 'codex') throw new Error('hosted search unavailable');
        return {
          provider,
          result: {
            results: [{
              title: '短视频搜索页',
              url: 'https://www.douyin.com/search/example',
              snippet: '未经核验的经验说法。',
              siteName: 'douyin.com',
            }],
          },
        };
      },
    };

    const snapshot = await createResearchSnapshot({
      client,
      query: '自行车活鱼桶 装水防晃 技巧',
      providers: ['codex', 'duckduckgo'],
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'FAILED');
    assert.equal(snapshot.provider, null);
    assert.deepEqual(snapshot.sources, []);
    assert.ok(snapshot.attempts.every((attempt) => attempt.status === 'FAILED'));
    assert.match(snapshot.attempts.at(-1).error, /authoritative|grounded|evidence/iu);
  });

  it('extracts source URLs from a Codex grounded answer', async () => {
    const snapshot = await createResearchSnapshot({
      client: {
        async runWebSearch() {
          return {
            provider: 'codex',
            result: {
              content: '\n<<<EXTERNAL_UNTRUSTED_CONTENT id="answer">>>\nSource: Web Search\n---\n结论见 https://example.gov.cn/rules 和 [研究](https://journal.example.org/paper)。\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="answer">>>',
              searches: [{ query: '规则 研究' }],
            },
          };
        },
      },
      query: '规则研究',
      providers: ['codex'],
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.summary, '结论见 https://example.gov.cn/rules 和 [研究](https://journal.example.org/paper)。');
    assert.deepEqual(researchSourceUrls(snapshot), [
      'https://example.gov.cn/rules',
      'https://journal.example.org/paper',
    ]);
  });

  it('accepts a Codex grounded answer whose source URLs have no separate snippets', async () => {
    const snapshot = await createResearchSnapshot({
      client: {
        async runWebSearch() {
          return {
            provider: 'codex',
            result: {
              content: '华为与小米手表都可通过蓝牙连接安卓手机，具体功能以'
                + '[华为兼容说明](https://consumer.huawei.com/cn/support/content/zh-cn15893330/)'
                + '和[小米帮助](https://www.mi.com/service/support/)为准。',
              searches: [{ query: '华为手表 小米手表 安卓兼容说明' }],
            },
          };
        },
      },
      query: 'OPPO手机适合华为fit4还是红米watch6',
      providers: ['codex'],
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'COMPLETED');
    assert.equal(snapshot.provider, 'codex');
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.sources.length, 2);
    assert.ok(snapshot.sources.every((source) => source.snippet === ''));
  });

  it('keeps Markdown source URLs clean when Chinese prose immediately follows the link', async () => {
    const currentStandard = 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=CURRENT';
    const previousStandard = 'https://std.samr.gov.cn/gb/search/gbDetailed?id=PREVIOUS';
    const snapshot = await createResearchSnapshot({
      client: {
        async runWebSearch() {
          return {
            provider: 'codex',
            result: {
              content: `现行标准为 [新版](${currentStandard})，2025年实施；旧版 [旧版](${previousStandard})仍标注现行。`,
            },
          };
        },
      },
      query: '活鱼运输标准',
      providers: ['codex'],
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'COMPLETED');
    assert.deepEqual(researchSourceUrls(snapshot), [currentStandard, previousStandard]);
  });

  it('returns a saved failed snapshot when no provider yields a public source', async () => {
    const snapshot = await createResearchSnapshot({
      client: {
        async runWebSearch({ provider }) {
          if (provider === 'codex') throw new Error('hosted search unavailable');
          return { provider, result: { results: [] } };
        },
      },
      query: '需要核验的主题',
      providers: ['codex', 'duckduckgo'],
      now: () => NOW,
    });

    assert.equal(snapshot.status, 'FAILED');
    assert.equal(snapshot.provider, null);
    assert.deepEqual(snapshot.sources, []);
    assert.deepEqual(snapshot.attempts.map(({ provider, status }) => ({ provider, status })), [
      { provider: 'codex', status: 'FAILED' },
      { provider: 'duckduckgo', status: 'FAILED' },
      { provider: 'duckduckgo', status: 'FAILED' },
    ]);
  });

  it('attaches only successful evidence to the untrusted task input', async () => {
    const snapshot = normalizeResearchSnapshot({
      schemaVersion: 1,
      status: 'COMPLETED',
      query: '主题',
      searchedAt: NOW,
      provider: 'duckduckgo',
      summary: '总'.repeat(6_000),
      attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
      sources: [{
        title: '来源',
        url: 'https://example.com/source',
        snippet: '证'.repeat(3_000),
        siteName: 'example.com',
        provider: 'duckduckgo',
        retrievedAt: NOW,
      }],
    });
    const task = attachResearchToTask({
      id: 1,
      query: '主题',
      input: { category: '知识科普', referenceUrls: ['https://input.example.com/reference'] },
    }, snapshot);

    assert.equal(task.input.webResearch.provider, 'duckduckgo');
    assert.equal(task.input.webResearch.summary.length, 2_000);
    assert.equal(task.input.webResearch.sources[0].snippet.length, 800);
    assert.equal(snapshot.summary.length, 6_000, 'saved snapshot must retain the bounded provider evidence');
    assert.equal(snapshot.sources[0].snippet.length, 3_000);
    assert.equal(task.input.webResearch.attempts, undefined);
    assert.deepEqual(researchSourceUrls(snapshot), ['https://example.com/source']);
  });

  it('rejects malformed completed snapshots instead of trusting a checkpoint', () => {
    assert.throws(() => normalizeResearchSnapshot({
      schemaVersion: 1,
      status: 'COMPLETED',
      query: '主题',
      searchedAt: NOW,
      provider: 'duckduckgo',
      summary: null,
      attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
      sources: [{ url: 'javascript:alert(1)' }],
    }), /research source/iu);

    assert.throws(() => normalizeResearchSnapshot({
      schemaVersion: 1,
      status: 'COMPLETED',
      query: '主题',
      searchedAt: NOW,
      provider: 'duckduckgo',
      summary: null,
      attempts: [{ provider: 'duckduckgo', status: 'COMPLETED', error: null }],
      sources: [{
        title: '回环地址',
        url: 'http://[::1]/private',
        snippet: '不得保存',
        siteName: 'localhost',
        provider: 'duckduckgo',
        retrievedAt: NOW,
      }],
    }), /research source/iu);
  });
});
