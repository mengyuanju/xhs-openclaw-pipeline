import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResearchSnapshot, researchSourceUrls } from '../src/research.mjs';

const NOW = '2026-09-05T08:00:00.000Z';
const QUERY = '比较两款设备的兼容条件';

function sufficientEvidence() {
  return {
    summary: '两个来源分别说明了设备连接条件，应按各自说明核对兼容性。',
    sources: [
      { title: '厂商甲兼容说明', url: 'https://support.example.com/device-a', snippet: '设备甲支持的连接条件。' },
      { title: '厂商乙兼容说明', url: 'https://help.example.org/device-b', snippet: '设备乙支持的连接条件。' },
    ],
  };
}

function authoritativeEvidence() {
  return {
    summary: '标准机构提供进一步核验依据。',
    sources: [{ title: '标准资料', url: 'https://www.nist.gov/testing', snippet: '标准资料中的测试条件。' }],
  };
}

async function researchWithResponses(responses, options = {}) {
  const calls = [];
  const provider = options.provider ?? 'deepseek';
  const snapshot = await createResearchSnapshot({
    client: {
      webSearchProviders: [provider],
      async runWebSearch(input) {
        calls.push(input);
        assert.ok(calls.length <= responses.length, 'unexpected additional search request');
        return { provider, result: responses[calls.length - 1] };
      },
    },
    query: QUERY,
    now: () => NOW,
    ...(options.requireAuthoritative === undefined ? {} : { requireAuthoritative: options.requireAuthoritative }),
  });
  return { snapshot, calls };
}

test('DeepSeek stops after one request when a summary and two independent complete sources are available', async () => {
  const evidence = sufficientEvidence();
  const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()]);
  assert.equal(calls.length, 1, 'sufficient evidence must not trigger a second official-evidence query');
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'deepseek');
  assert.equal(snapshot.summary, evidence.summary);
  assert.equal(snapshot.attempts.length, 1);
  assert.deepEqual(researchSourceUrls(snapshot), evidence.sources.map((source) => source.url));
});

const incompleteCases = [
  ['one source', (evidence) => { evidence.sources.pop(); }],
  ['two URLs on one hostname', (evidence) => { evidence.sources[1].url = 'https://support.example.com/another-page'; }],
  ['missing summary', (evidence) => { delete evidence.summary; }],
  ['one missing source snippet', (evidence) => { delete evidence.sources[1].snippet; }],
  ['blank source snippet', (evidence) => { evidence.sources[1].snippet = ' \n '; }],
  ['missing source title', (evidence) => { delete evidence.sources[1].title; }],
];

for (const [label, makeIncomplete] of incompleteCases) {
  test(`DeepSeek supplements evidence with ${label} instead of treating it as sufficient`, async () => {
    const evidence = sufficientEvidence();
    makeIncomplete(evidence);
    const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()]);
    assert.equal(calls.length, 2);
    assert.match(calls[1].query, /官方|标准|技术规范/u);
    assert.equal(snapshot.status, 'COMPLETED');
    assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
  });
}

for (const unsafeUrl of [
  'javascript:alert(1)',
  'http://127.0.0.1/private',
  'https://reader:password@example.org/private',
  'http://service.internal/private',
]) {
  test(`DeepSeek does not count the unsafe source ${unsafeUrl} toward evidence sufficiency`, async () => {
    const evidence = sufficientEvidence();
    evidence.sources[1].url = unsafeUrl;
    const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()]);
    assert.equal(calls.length, 2);
    assert.equal(snapshot.status, 'COMPLETED');
    assert.ok(snapshot.sources.every((source) => source.url !== unsafeUrl));
    assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
  });
}

for (const provider of ['deepseek', 'codex']) {
  test(`${provider} honors requireAuthoritative by continuing beyond complete ordinary-site evidence`, async () => {
    const { snapshot, calls } = await researchWithResponses([sufficientEvidence(), authoritativeEvidence()], {
      provider, requireAuthoritative: true,
    });
    assert.equal(calls.length, 2);
    assert.equal(snapshot.status, 'COMPLETED');
    assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
  });

  test(`${provider} does not silently use ordinary-site fallback when authoritative evidence is required`, async () => {
    const { snapshot, calls } = await researchWithResponses([sufficientEvidence(), sufficientEvidence()], {
      provider, requireAuthoritative: true,
    });
    assert.equal(calls.length, 2);
    assert.equal(snapshot.status, 'FAILED');
    assert.equal(snapshot.provider, null);
    assert.deepEqual(snapshot.sources, []);
  });
}

test('Codex retains its default single grounded-source behavior without separate snippets', async () => {
  const evidence = {
    content: '兼容条件可见[设备说明](https://support.example.com/device-a)。',
    searches: [{ query: QUERY }],
  };
  const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()], { provider: 'codex' });
  assert.equal(calls.length, 1);
  assert.equal(snapshot.status, 'COMPLETED');
  assert.equal(snapshot.provider, 'codex');
  assert.equal(snapshot.sources[0].snippet, '');
});

test('DeepSeek early stopping does not silently broaden the default fallback-provider contract', async () => {
  const { snapshot, calls } = await researchWithResponses([sufficientEvidence(), authoritativeEvidence()], { provider: 'duckduckgo' });
  assert.equal(calls.length, 2);
  assert.equal(snapshot.status, 'COMPLETED');
  assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
});

test('a hostname trailing-dot alias is not a second independent DeepSeek source', async () => {
  const evidence = sufficientEvidence();
  evidence.sources[1].url = 'https://support.example.com./another-page';
  const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()]);
  assert.equal(calls.length, 2);
  assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
});

for (const hostname of ['gov.example.org', 'example.gov.evil.com', 'edu.example.org']) {
  test(`requireAuthoritative does not trust the ordinary hostname ${hostname} for containing an authority word`, async () => {
    const evidence = sufficientEvidence();
    evidence.sources = [{ title: '普通网站文章', url: `https://${hostname}/article`, snippet: '未经权威认证的站点内容。' }];
    const { snapshot, calls } = await researchWithResponses([evidence, authoritativeEvidence()], { requireAuthoritative: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(researchSourceUrls(snapshot), ['https://www.nist.gov/testing']);
  });
}
