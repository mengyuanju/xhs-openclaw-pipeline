import assert from 'node:assert/strict';
import test from 'node:test';
import { runDoubaoWebSearch } from '../src/doubao-search.mjs';

const KEY = 'offline-fixture-key';
const QUERY = '绵阳到北京自驾8天行程';

function document(index, overrides = {}) {
  return {
    Title: `第${index}条资料`,
    Url: `https://example${index}.com/guide`,
    HostInfo: { Hostname: `example${index}.com` },
    Snippet: [{ Type: 'text', Text: `摘要${index}` }, { Type: 'image', Text: '不应出现' }],
    ...overrides,
  };
}

function payload(documents = [document(1), document(2)]) {
  return { Result: { ErrorCode: 0, Documents: documents } };
}

function customPayload(webResults = [{
  Title: '自驾线路', Url: 'https://example.cn/route', SiteName: 'example.cn',
  Summary: '八天行程摘要', Snippet: '备用摘要',
}]) {
  return { Result: { WebResults: webResults } };
}

function runWith(fetchImpl, options = {}, input = {}) {
  return runDoubaoWebSearch({ apiKey: KEY, timeoutMs: 5_000, fetchImpl, ...options },
    { query: QUERY, ...input });
}

test('Doubao requests web search with domestic ICP scope and returns grounded source excerpts', async () => {
  let called = 0;
  const result = await runWith(async (url, init) => {
    called += 1;
    assert.equal(url, 'https://open.feedcoopapi.com/search_api/global_search');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), {
      SearchType: 'web', Query: QUERY, DocCount: 5, MaxSnippetLength: 1000,
      Filter: { IcpHostOnly: true },
    });
    return new Response(JSON.stringify(payload([document(1, {
      Title: '<b>行程</b>', Snippet: [{ Type: 'text', Text: '<p>路况提示</p>' },
        { Type: 'image', Text: '应排除' }, { Type: 'text', Text: '住宿建议' }],
    }), document(2)])));
  });
  assert.equal(called, 1);
  assert.equal(result.provider, 'doubao');
  assert.equal(result.result.sources.length, 2);
  assert.deepEqual(result.result.sources[0], {
    title: '行程', url: 'https://example1.com/guide', snippet: '路况提示 住宿建议', siteName: 'example1.com',
  });
  assert.match(result.result.content, /1\. 行程：路况提示 住宿建议/u);
  assert.match(result.result.content, /2\. 第2条资料：摘要2/u);
  assert.doesNotMatch(result.result.content, /应排除|<p>/u);
});

test('Doubao Custom uses the subscription endpoint and returns service summaries as evidence', async () => {
  const result = await runWith(async (url, init) => {
    assert.equal(url, 'https://open.feedcoopapi.com/search_api/web_search');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(init.body), {
      Query: QUERY, SearchType: 'web', Count: 5, NeedSummary: true,
    });
    return new Response(JSON.stringify(customPayload([{
      Title: '<b>自驾线路</b>', Url: 'https://example.cn/route', SiteName: 'example.cn',
      Summary: '<p>八天行程摘要</p>', Snippet: '备用摘要',
    }, {
      Title: '第二条', Url: 'https://example.cn/second', SiteName: 'example.cn',
      Snippet: '无 Summary 时使用 Snippet',
    }])));
  }, { mode: 'CUSTOM', icpHostOnly: true });
  assert.equal(result.provider, 'doubao');
  assert.deepEqual(result.result.sources, [
    { title: '自驾线路', url: 'https://example.cn/route',
      snippet: '八天行程摘要', siteName: 'example.cn' },
    { title: '第二条', url: 'https://example.cn/second',
      snippet: '无 Summary 时使用 Snippet', siteName: 'example.cn' },
  ]);
  assert.match(result.result.content, /八天行程摘要/u);
  assert.doesNotMatch(result.result.content, /备用摘要|<p>|未由模型改写/u);
});

test('Doubao Custom handles upstream errors and redacts echoed credentials', async () => {
  const result = await runWith(async () => new Response(JSON.stringify(customPayload([{
    Title: `secret ${KEY}`, Url: 'https://example.cn/guide', SiteName: 'example.cn',
    Summary: `summary ${KEY}`,
  }, {
    Title: 'unsafe', Url: `https://example.cn/?key=${KEY}`, Summary: 'skip',
  }]))), { mode: 'CUSTOM' });
  assert.equal(result.result.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY, 'u'));
  await assert.rejects(runWith(async () => new Response(JSON.stringify({
    ResponseMetadata: { Error: { CodeN: 10409, Message: `secret ${KEY}` } },
  })), { mode: 'CUSTOM' }), (error) => {
    assert.equal(error.message, 'Doubao web search failed with API code 10409');
    assert.doesNotMatch(error.message, new RegExp(KEY, 'u'));
    return true;
  });
  await assert.rejects(runWith(async () => new Response(JSON.stringify(customPayload([]))),
    { mode: 'CUSTOM' }), /no source evidence/u);
});

test('Doubao excludes URLs that echo an encoded API key in either mode', async () => {
  const key = 'offline/fixture+key';
  const encodedUrl = `https://example.cn/?token=${encodeURIComponent(key)}`;
  for (const mode of ['GLOBAL', 'CUSTOM']) {
    const body = mode === 'GLOBAL' ? payload([
      document(1, { Url: encodedUrl }), document(2),
    ]) : customPayload([{
      Title: 'unsafe', Url: encodedUrl, Summary: 'should not appear',
    }, {
      Title: 'safe', Url: 'https://example.cn/route', Summary: 'safe source',
    }]);
    const result = await runWith(async () => new Response(JSON.stringify(body)),
      { mode, apiKey: key });
    assert.equal(result.result.sources.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /offline%2Ffixture%2Bkey/u);
  }
});

test('Doubao allows worldwide scope and includes all configured sources in the excerpt', async () => {
  const documents = Array.from({ length: 7 }, (_, index) => document(index + 1));
  const result = await runWith(async (_url, init) => {
    assert.equal(JSON.parse(init.body).Filter.IcpHostOnly, false);
    assert.equal(JSON.parse(init.body).DocCount, 7);
    return new Response(JSON.stringify(payload(documents)));
  }, { icpHostOnly: false }, { limit: 7 });
  assert.equal(result.result.sources.length, 7);
  assert.match(result.result.content, /7\. 第7条资料：摘要7/u);
});

test('Doubao truncates long research queries to the upstream 100-character limit', async () => {
  await runWith(async (_url, init) => {
    assert.equal([...JSON.parse(init.body).Query].length, 100);
    return new Response(JSON.stringify(payload()));
  }, {}, { query: '自'.repeat(120) });
});

test('Doubao rejects invalid local inputs before calling the network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify(payload())); };
  const cases = [
    [{ apiKey: '' }, {}, /DOUBAO_SEARCH_API_KEY/u],
    [{ apiKey: 'bad key' }, {}, /DOUBAO_SEARCH_API_KEY/u],
    [{ icpHostOnly: 'true' }, {}, /IcpHostOnly/u],
    [{ mode: 'INVALID' }, {}, /mode/u],
    [{ timeoutMs: 1_000 }, {}, /timeoutMs/u],
    [{}, { query: '' }, /query/u],
    [{}, { query: 'x'.repeat(501) }, /query/u],
    [{}, { limit: 11 }, /limit/u],
  ];
  for (const [options, input, error] of cases) {
    await assert.rejects(runWith(fetchImpl, options, input), error);
  }
  assert.equal(calls, 0);
});

test('Doubao fails safely for HTTP, protocol and no-source errors', async () => {
  await assert.rejects(runWith(async () => new Response('secret upstream text', { status: 429 })),
    /HTTP 429/u);
  await assert.rejects(runWith(async () => new Response('<html>upstream</html>')),
    /not valid JSON/u);
  await assert.rejects(runWith(async () => new Response(JSON.stringify({ Result: {
    ErrorCode: 9001, ErrorMsg: `secret ${KEY}`,
  } }))), /service code 9001/u);
  await assert.rejects(runWith(async () => new Response(JSON.stringify(payload([])))),
    /no source evidence/u);
});

test('Doubao reports only safe API error codes from response metadata', async () => {
  const metadataError = (error, result = null) => new Response(JSON.stringify({
    ResponseMetadata: { RequestId: 'upstream-request-id', Error: error }, Result: result,
  }));
  await assert.rejects(runWith(async () => metadataError({
    Code: 'PermissionDenied', CodeN: 10403, Message: `secret ${KEY}`,
  })), (error) => {
    assert.equal(error.message, 'Doubao web search failed with API code PermissionDenied');
    assert.doesNotMatch(error.message, new RegExp(KEY, 'u'));
    return true;
  });
  await assert.rejects(runWith(async () => metadataError({ CodeN: 10408, Message: `secret ${KEY}` })),
    /API code 10408/u);
  await assert.rejects(runWith(async () => metadataError({
    Code: `invalid_${KEY}`, Message: `secret ${KEY}`,
  })), (error) => {
    assert.equal(error.message, 'Doubao web search failed with an API error without safe code');
    assert.doesNotMatch(error.message, new RegExp(KEY, 'u'));
    return true;
  });
  await assert.rejects(runWith(async () => metadataError({
    Code: 'Invalid\nrequest body', Message: 'untrusted message',
  })), /API error without safe code/u);
  await assert.rejects(runWith(async () => metadataError({
    Code: 'A'.repeat(65), Message: 'untrusted message',
  })), /API error without safe code/u);
  await assert.rejects(runWith(async () => metadataError({ Code: 'PermissionDenied' }, {
    ErrorCode: 0, Documents: [document(1)],
  })), /API code PermissionDenied/u);
  await assert.rejects(runWith(async () => metadataError({ Code: 'PermissionDenied' }, {
    ErrorCode: 9001,
  })), /service code 9001/u);
});

test('Doubao distinguishes missing response fields without exposing payload content', async () => {
  const cases = [
    [{ unrelated: `secret ${KEY}` }, 'missing Result'],
    [{ Result: { unrelated: `secret ${KEY}` } }, 'missing ErrorCode'],
    [{ Result: { ErrorCode: '0', unrelated: `secret ${KEY}` } }, 'invalid ErrorCode'],
  ];
  for (const [body, diagnostic] of cases) {
    await assert.rejects(runWith(async () => new Response(JSON.stringify(body))), (error) => {
      assert.equal(error.message, `Doubao web search failed with ${diagnostic}`);
      assert.doesNotMatch(error.message, new RegExp(KEY, 'u'));
      return true;
    });
  }
});

test('Doubao does not expose the API key echoed by untrusted result fields', async () => {
  const result = await runWith(async () => new Response(JSON.stringify(payload([
    document(1, { Title: `title ${KEY}`, Snippet: [{ Type: 'text', Text: `Bearer ${KEY}` }] }),
    document(2, { Url: `https://example.com/?token=${KEY}` }),
  ]))));
  assert.equal(result.result.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY, 'u'));
});

test('Doubao limits upstream response size and propagates execution cancellation', async () => {
  await assert.rejects(runWith(async () => new Response('x'.repeat(2_000_001))),
    /response is too large/u);
  const controller = new AbortController();
  controller.abort(new Error('task cancelled'));
  await assert.rejects(runWith(async () => { throw new Error('unexpected network call'); }, {},
    { signal: controller.signal }), /task cancelled/u);
});
