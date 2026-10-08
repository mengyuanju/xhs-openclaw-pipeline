import assert from 'node:assert/strict';
import test from 'node:test';
import { runDoubaoWebSearch } from '../src/doubao-search.mjs';
import { withModelCallTracing } from '../src/model-call-trace.mjs';

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

function traceFixture() {
  const records = [];
  const executionId = 'doubao-offline-execution';
  const controlPlane = {
    recordModelCall: async (id, _callId, record) => {
      assert.equal(id, executionId);
      records.push(structuredClone(record));
    },
    updateProgress: async () => {},
  };
  return { records, run: (action) => withModelCallTracing({ executionId, controlPlane }, async (plane) => {
    await plane.updateProgress(executionId, { stage: 'WEB_SEARCH', details: { mode: 'fixture' } });
    return action();
  }) };
}

function completedTrace(fixture, status) {
  assert.deepEqual(fixture.records.map((record) => record.status), ['RUNNING', status]);
  assert.equal(fixture.records[0].id, fixture.records[1].id);
  const record = fixture.records[1];
  assert.equal(record.sequence, 1);
  assert.equal(record.stage, 'WEB_SEARCH');
  assert.equal(record.provider, 'Doubao');
  assert.equal(record.operation, 'WEB_SEARCH');
  assert.equal(record.model, '');
  assert.ok(record.finishedAt);
  assert.ok(record.durationMs >= 0);
  return record;
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

test('Doubao traces each mode with the exact normalized Unicode query and HTTP request body', async (t) => {
  const query = `  ${'自驾🚗'.repeat(45)}\n 行程  `;
  const expectedQuery = [...query.replace(/\s+/gu, ' ').trim()].slice(0, 100).join('');
  for (const mode of ['GLOBAL', 'CUSTOM']) {
    await t.test(mode, async () => {
      const f = traceFixture();
      let calls = 0;
      let request;
      const body = mode === 'GLOBAL' ? payload() : customPayload();
      const result = await f.run(() => runWith(async (_url, init) => {
        calls += 1;
        request = JSON.parse(init.body);
        return Response.json(body);
      }, { mode }, { query, limit: 7 }));
      const record = completedTrace(f, 'SUCCEEDED');
      const envelope = JSON.parse(record.request);
      assert.equal(calls, 1);
      assert.equal(record.prompt, expectedQuery);
      assert.equal([...record.prompt].length, 100);
      assert.equal(envelope.scope, 'HTTP_BODY');
      assert.deepEqual(envelope.stageContext, { name: 'WEB_SEARCH', details: { mode: 'fixture' } });
      assert.deepEqual(envelope.payload, request);
      assert.equal(envelope.payload.Query, record.prompt);
      assert.equal(mode === 'GLOBAL' ? request.DocCount : request.Count, 7);
      assert.equal(record.error, null);
      assert.deepEqual(JSON.parse(record.response), {
        httpStatus: 200, scope: 'NORMALIZED_SEARCH_EVIDENCE', result: result.result,
      });
      assert.equal(result.provider, 'doubao');
    });
  }
});

test('Doubao traces semantic failures as failed even when HTTP succeeds', async (t) => {
  const cases = [
    ['GLOBAL', { Result: { ErrorCode: 9001, ErrorMsg: 'untrusted error' } }, /service code 9001/u],
    ['CUSTOM', { Result: { ErrorCode: 'QuotaExceeded' } }, /service code QuotaExceeded/u],
    ['GLOBAL', { ResponseMetadata: { Error: { Code: 'PermissionDenied' } } }, /API code PermissionDenied/u],
    ['CUSTOM', { ResponseMetadata: { Error: { CodeN: 10409 } } }, /API code 10409/u],
    ['GLOBAL', { unrelated: 'upstream diagnostic' }, /missing Result/u],
    ['GLOBAL', { Result: {} }, /missing ErrorCode/u],
    ['GLOBAL', { Result: { ErrorCode: '0' } }, /invalid ErrorCode/u],
    ['GLOBAL', payload([]), /no source evidence/u],
    ['CUSTOM', customPayload([]), /no source evidence/u],
  ];
  for (const [mode, body, message] of cases) {
    await t.test(`${mode} ${message.source}`, async () => {
      const f = traceFixture();
      let calls = 0;
      await f.run(() => assert.rejects(runWith(async () => {
        calls += 1;
        return Response.json(body);
      }, { mode }), message));
      const record = completedTrace(f, 'FAILED');
      assert.equal(calls, 1);
      assert.match(record.error, message);
      assert.deepEqual(JSON.parse(record.response), { httpStatus: 200 });
    });
  }
});

test('Doubao traces transport, HTTP and response-read failures without repeating a request', async (t) => {
  const encoder = new TextEncoder();
  const cases = [
    ['network', async () => { throw new Error(`transport ${KEY}`); }, /network request failed/u],
    ['HTTP', async () => new Response(`upstream ${KEY}`, { status: 429 }), /HTTP 429/u],
    ['invalid JSON', async () => new Response('<html>upstream</html>'), /not valid JSON/u],
    ['empty body', async () => new Response(null), /empty response body/u],
    ['interrupted body', async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`partial ${KEY}`));
        controller.error(new Error(`read interrupted ${KEY}`));
      },
    })), /transfer was interrupted/u],
    ['oversized body', async () => new Response('x'.repeat(2_000_001)), /response is too large/u],
  ];
  for (const [name, fetchImpl, message] of cases) {
    await t.test(name, async () => {
      const f = traceFixture();
      let calls = 0;
      await f.run(() => assert.rejects(runWith(async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      }), message));
      const record = completedTrace(f, 'FAILED');
      assert.equal(calls, 1);
      assert.match(record.error, message);
      assert.deepEqual(record.response === null ? null : JSON.parse(record.response),
        name === 'network' ? null : { httpStatus: name === 'HTTP' ? 429 : 200 });
      assert.doesNotMatch(JSON.stringify(f.records), new RegExp(KEY, 'u'));
    });
  }
});

test('Doubao traces execution cancellation while preserving the caller cancellation error', async () => {
  const f = traceFixture();
  const controller = new AbortController();
  const cancellation = new Error('task cancelled during search');
  let calls = 0;
  await f.run(() => assert.rejects(runWith(async () => {
    calls += 1;
    controller.abort(cancellation);
    throw new Error('fetch aborted');
  }, {}, { signal: controller.signal }), (error) => error === cancellation));
  const record = completedTrace(f, 'FAILED');
  assert.equal(calls, 1);
  assert.equal(record.error, cancellation.message);
});

test('Doubao trace evidence redacts direct, mixed-case and nested percent-encoded credentials in both modes', async (t) => {
  const key = 'offline/fixture+key';
  const variants = new Set([key]);
  let encoded = [key];
  function mixedCase(value, firstLowercase) {
    let index = 0;
    return value.replace(/%[0-9A-F]{2}/gu, (escape) =>
      (index++ % 2 === 0) === firstLowercase ? escape.toLowerCase() : escape.toUpperCase());
  }
  for (let depth = 0; depth < 3; depth += 1) {
    encoded = [...new Set(encoded.flatMap((value) => {
      const escaped = encodeURIComponent(value);
      return [escaped, escaped.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
        mixedCase(escaped, true), mixedCase(escaped, false)];
    }))];
    for (const value of encoded) variants.add(value);
  }
  assert.ok(variants.has('offline%2ffixture%2Bkey'));
  assert.ok(variants.has('offline%25252ffixture%25252Bkey'));
  const fullyEncoded = [...Buffer.from(key, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  for (const value of [fullyEncoded, mixedCase(fullyEncoded, true)]) {
    variants.add(value);
    variants.add(encodeURIComponent(value));
  }
  const echo = [...variants, 'offline%2f<b>fixture</b>%2Bkey'].join(' ');
  for (const mode of ['GLOBAL', 'CUSTOM']) {
    await t.test(mode, async () => {
      const f = traceFixture();
      const body = mode === 'GLOBAL' ? payload([document(1, {
        Title: `title ${echo}`, Snippet: [{ Type: 'text', Text: `summary ${echo}` }],
      })]) : customPayload([{
        Title: `title ${echo}`, Url: 'https://example.cn/route', Summary: `summary ${echo}`,
      }]);
      // Unknown payload fields and error metadata are untrusted, and should never enter the trace.
      body.unknown = echo;
      await f.run(() => runWith(async () => Response.json(body), { mode, apiKey: key }));
      const record = completedTrace(f, 'SUCCEEDED');
      const evidence = JSON.parse(record.response);
      assert.equal(evidence.scope, 'NORMALIZED_SEARCH_EVIDENCE');
      assert.equal(evidence.unknown, undefined);
      for (const credential of variants) {
        assert.ok(!JSON.stringify(f.records).includes(credential), `trace leaked credential variant: ${credential}`);
      }
      assert.match(record.response, /REDACTED/u);
    });
  }
  for (const [name, fetchImpl, message] of [
    ['HTTP', async () => new Response(echo, { status: 403 }), /HTTP 403/u],
    ['API', async () => Response.json({ ResponseMetadata: { Error: {
      Code: 'PermissionDenied', Message: echo,
    } }, unknown: echo }), /API code PermissionDenied/u],
  ]) {
    await t.test(name, async () => {
      const f = traceFixture();
      await f.run(() => assert.rejects(runWith(fetchImpl, { apiKey: key }), message));
      completedTrace(f, 'FAILED');
      for (const credential of variants) {
        assert.ok(!JSON.stringify(f.records).includes(credential), `trace leaked credential variant: ${credential}`);
      }
    });
  }
});

test('Doubao percent-escape redaction preserves literal credential character case', async (t) => {
  const cases = [
    ['literal letters', 'AbC/Def+GhI', 'abc%2fDef%2BGhI', 'AbC%2fDef%2BGhI'],
    ['literal percent escape', 'AbC%2F/Def+GhI', 'AbC%252f%2FDef%2BGhI', 'AbC%252F%2fDef%2BGhI'],
  ];
  for (const [name, key, differentValue, credential] of cases) {
    await t.test(name, async () => {
      const f = traceFixture();
      const result = await f.run(() => runWith(async () => Response.json(payload([document(1, {
        Title: differentValue, Snippet: [{ Type: 'text', Text: credential }],
      })])), { apiKey: key }));
      const record = completedTrace(f, 'SUCCEEDED');
      assert.equal(result.result.sources[0].title, differentValue);
      assert.equal(result.result.sources[0].snippet, '[REDACTED_API_KEY]');
      assert.ok(record.response.includes(differentValue));
      assert.ok(!record.response.includes(credential));
    });
  }
});

test('Doubao trace recording outages never replay or fail the upstream search', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  let uploads = 0;
  const result = await withModelCallTracing({ executionId: 'doubao-recording-outage', controlPlane: {
    recordModelCall: async () => { uploads += 1; throw new Error('recording unavailable'); },
  } }, () => runWith(async () => { calls += 1; return Response.json(payload()); }));
  assert.equal(calls, 1);
  assert.equal(uploads, 4);
  assert.equal(result.result.sources.length, 2);
});
