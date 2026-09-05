import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachResearchToTask,
  createResearchSnapshot,
  normalizeResearchSnapshot,
  researchSourceUrls,
} from '../src/research.mjs';

const NOW = '2026-08-29T08:00:00.000Z';

describe('web research snapshots', () => {
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
