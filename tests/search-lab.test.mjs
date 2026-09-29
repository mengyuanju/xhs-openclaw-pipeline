import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSearch, validateCompareRequest } from '../search-lab/compare.mjs';
import { providerCatalogue, runProviderSearch } from '../search-lab/providers.mjs';
import { createSearchLabServer } from '../search-lab/server.mjs';

function fakeFetch(payload, inspect = () => {}) {
  return async (url, init) => {
    inspect(url, init, JSON.parse(init.body));
    return Response.json(payload);
  };
}

test('search lab compares each provider independently with the same Query and redacts keys', async () => {
  const calls = [];
  const output = await compareSearch({
    query: '  机械键盘   轴体比较 ',
    providers: [{ id: 'zhipu', key: 'secret-zhipu' }, { id: 'qianfan', key: 'secret-qianfan' }],
  }, {
    search: async (input) => {
      calls.push(input);
      return { provider: input.id, result: { content: `检索摘要 ${input.key}`,
        sources: [{ title: '来源', url: 'https://example.org/article', snippet: `页面摘要 ${input.key}` }] } };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((input) => input.query), ['机械键盘 轴体比较', '机械键盘 轴体比较']);
  assert.deepEqual(output.results.map((item) => item.status), ['COMPLETED', 'COMPLETED']);
  assert.equal(output.results[0].snapshot.attempts.length, 1);
  assert.doesNotMatch(JSON.stringify(output), /secret-zhipu|secret-qianfan/u);
});

test('search lab shows safe source previews when production authority rules reject a result', async () => {
  const output = await compareSearch({ query: '股票投资风险', providers: [{ id: 'zhipu', key: 'private-test-key' }] }, {
    search: async () => ({ provider: 'zhipu', result: { content: '普通网页的回答',
      sources: [{ title: '普通来源', url: 'https://example.org/finance', snippet: '资讯摘要' },
        { title: '私网来源', url: 'http://127.0.0.1/private', snippet: '不应展示' }] } }),
  });
  assert.equal(output.results[0].status, 'FAILED');
  assert.deepEqual(output.results[0].snapshot.sources, []);
  assert.equal(output.results[0].preview.sources.length, 1);
  assert.equal(output.results[0].preview.sources[0].url, 'https://example.org/finance');
  assert.doesNotMatch(JSON.stringify(output), /private-test-key|127\.0\.0\.1/u);
});

test('search lab validates key, vendor options and duplicate selection before a request', () => {
  assert.throws(() => validateCompareRequest({ query: '测试', providers: [{ id: 'xiaomi' }] }), /API key/u);
  assert.throws(() => validateCompareRequest({ query: '测试', providers: [
    { id: 'xiaomi', key: 'key-one' }, { id: 'xiaomi', key: 'key-two' },
  ] }), /重复/u);
  assert.throws(() => validateCompareRequest({ query: '测试', providers: [{
    id: 'alibaba-opensearch', key: 'OS-secret', options: { host: 'http://127.0.0.1', workspaceName: 'default' },
  }] }), /接入地址/u);
});

test('Doubao advertises its ICP scope and validates boolean options before search', async () => {
  const doubao = providerCatalogue.find((provider) => provider.id === 'doubao');
  const field = doubao.fields.find((item) => item.name === 'icpHostOnly');
  assert.equal(field.type, 'boolean');
  assert.equal(field.defaultValue, true);
  assert.equal(field.label, '仅国内ICP备案网站');

  for (const [options, expected] of [[undefined, true], [{}, true],
    [{ icpHostOnly: true }, true], [{ icpHostOnly: false }, false]]) {
    const request = validateCompareRequest({ query: '绵阳到北京自驾8天行程',
      providers: [{ id: 'doubao', key: 'test-key', options }],
    });
    assert.equal(request.selections[0].options.icpHostOnly, expected);
  }

  for (const icpHostOnly of ['false', 0, null]) {
    const request = { query: '绵阳到北京自驾8天行程',
      providers: [{ id: 'doubao', key: 'test-key', options: { icpHostOnly } }],
    };
    assert.throws(() => validateCompareRequest(request), TypeError);
    await assert.rejects(compareSearch(request, {
      search: () => assert.fail('invalid scope should fail before search'),
    }), TypeError);
  }
});

test('Doubao adapter sends the original Query and a boolean ICP filter to Global Search', async () => {
  const query = '绵阳到北京自驾8天行程';
  for (const [options, expected] of [[undefined, true], [{ icpHostOnly: true }, true],
    [{ icpHostOnly: false }, false]]) {
    const result = await runProviderSearch({ id: 'doubao', key: 'test-key', query, options,
      fetchImpl: fakeFetch({ Result: { ErrorCode: 0, Documents: [
        { Title: '路线参考', Url: 'https://example.org/route',
          Snippet: [{ Type: 'text', Text: '自驾路线参考' }] },
      ] } }, (url, init, body) => {
        assert.equal(url, 'https://open.feedcoopapi.com/search_api/global_search');
        assert.equal(init.method, 'POST');
        assert.equal(body.Query, query);
        assert.deepEqual(body.Filter, { IcpHostOnly: expected });
      }),
    });
    assert.equal(result.result.sources[0].snippet, '自驾路线参考');
  }

  for (const icpHostOnly of ['false', 0, null]) {
    await assert.rejects(runProviderSearch({ id: 'doubao', key: 'test-key', query,
      options: { icpHostOnly },
      fetchImpl: () => assert.fail('invalid scope should fail before network'),
    }), TypeError);
  }
});

test('search lab preserves Doubao scope through comparison into the HTTP request', async () => {
  const query = '绵阳到北京自驾8天行程';
  for (const [options, expected] of [[undefined, true], [{ icpHostOnly: true }, true],
    [{ icpHostOnly: false }, false]]) {
    const calls = [];
    const output = await compareSearch({ query,
      providers: [{ id: 'doubao', key: 'test-key', options }],
    }, {
      search: (input) => runProviderSearch({ ...input,
        fetchImpl: fakeFetch({ Result: { ErrorCode: 0, Documents: [
          { Title: '路线参考', Url: 'https://example.org/route',
            Snippet: [{ Type: 'text', Text: '自驾路线参考' }] },
        ] } }, (_url, _init, body) => calls.push(body)),
      }),
    });
    assert.equal(output.query, query);
    assert.equal(output.results[0].status, 'COMPLETED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].Query, query);
    assert.deepEqual(calls[0].Filter, { IcpHostOnly: expected });
  }
});

test('Xiaomi, Tencent WSA and Spark adapters parse actual citation and search result shapes', async () => {
  const xiaomi = await runProviderSearch({ id: 'xiaomi', key: 'test-key', model: 'mimo-v2.6-pro', query: '测试',
    fetchImpl: fakeFetch({ choices: [{ message: { content: '模型概括', annotations: [
      { type: 'url_citation', title: '来源', url: 'https://example.org/a', summary: '来源摘要', site_name: '例站' },
    ] } }], usage: { web_search_usage: { tool_usage: 1 } } }, (_url, _init, body) => {
      assert.equal(body.tools[0].force_search, true);
      assert.equal(body.tools[0].limit, 1);
      assert.match(body.messages[0].content, /<untrusted_query>/u);
    }),
  });
  assert.equal(xiaomi.result.content, '模型概括');
  assert.equal(xiaomi.result.sources[0].snippet, '来源摘要');

  const tencent = await runProviderSearch({ id: 'tencent-wsa', key: 'test-key', query: '测试',
    fetchImpl: fakeFetch({ Response: { Pages: [JSON.stringify({ title: '结果', url: 'https://example.org/b',
      passage: '<strong>匹配</strong>片段', site: '例站' })] } }, (url, init, body) => {
      assert.equal(url, 'https://api.wsa.cloud.tencent.com/SearchPro');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      assert.deepEqual(body, { Query: '测试' });
    }),
  });
  assert.equal(tencent.result.sources[0].snippet, '匹配片段');
  assert.match(tencent.result.content, /搜索结果摘录/u);

  const xinghuo = await runProviderSearch({ id: 'xinghuo', key: 'test-key', query: '测试',
    fetchImpl: fakeFetch({ success: true, err_code: '0', data: { search_results: { documents: [
      { name: '结果', url: 'https://example.org/c', summary: '讯飞摘要' },
    ] } } }),
  });
  assert.equal(xinghuo.result.sources[0].snippet, '讯飞摘要');

  const doubao = await runProviderSearch({ id: 'doubao', key: 'test-key', query: '测试',
    fetchImpl: fakeFetch({ Result: { ErrorCode: 0, Documents: [
      { Title: '豆包结果', Url: 'https://example.org/d', Snippet: [{ Type: 'text', Text: '豆包摘要' }],
        HostInfo: { Hostname: '例站' } },
    ] } }),
  });
  assert.equal(doubao.result.sources[0].snippet, '豆包摘要');

  const kimi = await runProviderSearch({ id: 'kimi', key: 'test-key', query: '测试',
    fetchImpl: fakeFetch({ search_results: [
      { title: 'Kimi 结果', url: 'https://example.org/e', snippet: 'Kimi 摘要', site_name: '例站' },
    ] }, (url, _init, body) => {
      assert.equal(url, 'https://api.moonshot.cn/v1/tools/search');
      assert.equal(body.include_content, false);
    }),
  });
  assert.equal(kimi.result.sources[0].snippet, 'Kimi 摘要');

  const minimax = await runProviderSearch({ id: 'minimax', key: 'test-key', query: '测试',
    options: { region: 'mainland' },
    fetchImpl: fakeFetch({ base_resp: { status_code: 0 }, organic: [
      { title: 'MiniMax 结果', link: 'https://example.org/f', snippet: 'MiniMax 摘要' },
    ] }, (url, _init, body) => {
      assert.equal(url, 'https://api.minimax.cn/v1/coding_plan/search');
      assert.equal(body.q, '测试');
    }),
  });
  assert.equal(minimax.result.sources[0].snippet, 'MiniMax 摘要');
});

test('Tencent WSA exposes actionable business errors and request IDs without leaking the key', async () => {
  const key = 'private-tencent-service-key';
  const output = await compareSearch({ query: '三星堆的由来',
    providers: [{ id: 'tencent-wsa', key }],
  }, {
    search: (input) => runProviderSearch({ ...input,
      fetchImpl: fakeFetch({ Response: { Error: { Code: 'UnauthorizedOperation',
        Message: `Invalid API Key ${key}` }, RequestId: 'wsa-request-123' } }),
    }),
  });
  assert.equal(output.results[0].status, 'FAILED');
  const error = output.results[0].snapshot.attempts[0].error;
  assert.match(error, /UnauthorizedOperation/u);
  assert.match(error, /WSA 控制台/u);
  assert.match(error, /RequestId: wsa-request-123/u);
  assert.doesNotMatch(JSON.stringify(output), new RegExp(key, 'u'));
});

test('Tencent WSA retains error diagnostics for non-2xx responses and safely handles non-JSON errors', async () => {
  await assert.rejects(runProviderSearch({ id: 'tencent-wsa', key: 'private-key', query: '测试',
    fetchImpl: async () => Response.json({ Response: { Error: { Code: 'ResourceNotFound',
      Message: 'Service is not enabled' }, RequestId: 'wsa-request-456' } }, { status: 403 }),
  }), (error) => {
    assert.match(error.message, /ResourceNotFound/u);
    assert.match(error.message, /HTTP 403/u);
    assert.match(error.message, /开通联网搜索/u);
    assert.match(error.message, /wsa-request-456/u);
    return true;
  });
  await assert.rejects(runProviderSearch({ id: 'tencent-wsa', key: 'private-key', query: '测试',
    fetchImpl: async () => new Response('private-key upstream body', { status: 502 }),
  }), { message: '腾讯云 WSA HTTP 502' });
});

test('Tencent WSA keeps no-result reasons and supports a dynamic summary when passage is absent', async () => {
  await assert.rejects(runProviderSearch({ id: 'tencent-wsa', key: 'private-key', query: '测试',
    fetchImpl: fakeFetch({ Response: { Pages: [], Msg: 'hit black query', RequestId: 'wsa-request-789' } }),
  }), /未返回搜索来源；hit black query；RequestId: wsa-request-789/u);
  const result = await runProviderSearch({ id: 'tencent-wsa', key: 'private-key', query: '测试',
    fetchImpl: fakeFetch({ Response: { Pages: [{ title: '来源', url: 'https://example.org/tencent',
      content: '动态摘要' }] } }),
  });
  assert.equal(result.result.sources[0].snippet, '动态摘要');
});

test('Qianfan uses top-level references and falls back to content for source snippets', async () => {
  const result = await runProviderSearch({ id: 'qianfan', key: 'test-key', query: '英文字',
    fetchImpl: fakeFetch({ references: [
      { title: '百度结果', url: 'https://example.org/g', content: '网页摘录' },
    ] }, (url, _init, body) => {
      assert.equal(url, 'https://qianfan.baidubce.com/v2/ai_search/web_search');
      assert.deepEqual(body.messages, [{ role: 'user', content: '英文字' }]);
    }),
  });
  assert.equal(result.result.sources[0].snippet, '网页摘录');
  await assert.rejects(runProviderSearch({ id: 'qianfan', key: 'test-key', query: '中'.repeat(37),
    fetchImpl: () => assert.fail('query should fail before network'),
  }), /72/u);
});

test('Alibaba IQS and Bailian keep distinct key products and response formats', async () => {
  const iqs = await runProviderSearch({ id: 'alibaba-iqs', key: 'test-key', query: '测试',
    fetchImpl: fakeFetch({ pageItems: [{ title: '结果', link: 'https://example.org/iqs', snippet: '动态摘要' }] },
      (url, _init, body) => {
        assert.equal(url, 'https://cloud-iqs.aliyuncs.com/search/unified');
        assert.equal(body.engineType, 'Generic');
      }),
  });
  assert.equal(iqs.result.sources[0].snippet, '动态摘要');

  const bailian = await runProviderSearch({ id: 'alibaba-bailian', key: 'test-key', model: 'qwen-plus', query: '测试',
    options: { workspaceId: 'workspace-123', region: 'cn-beijing' },
    fetchImpl: fakeFetch({ output: { choices: [{ message: { content: '百炼回答' } }],
      search_info: { search_results: [{ title: '来源', url: 'https://example.org/bailian', site_name: '例站' }] } } },
      (url, _init, body) => {
        assert.match(url, /^https:\/\/workspace-123\.cn-beijing\.maas\.aliyuncs\.com/u);
        assert.equal(body.parameters.search_options.enable_source, true);
      }),
  });
  assert.equal(bailian.result.content, '百炼回答');
  assert.equal(bailian.result.sources[0].snippet, '');

  const comparison = await compareSearch({ query: '普通选题', providers: [{ id: 'alibaba-bailian', key: 'test-key',
    options: { workspaceId: 'workspace-123' } }] }, {
    search: async () => bailian,
  });
  assert.equal(comparison.results[0].status, 'COMPLETED');
  assert.equal(comparison.results[0].snapshot.sources[0].snippet, '');
});

test('search lab server serves only local static assets and rejects cross-site POST', async (t) => {
  const server = createSearchLabServer({
    catalogue: providerCatalogue,
    compare: async () => ({ query: '测试', results: [] }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const providers = await fetch(`${base}/api/providers`);
  assert.equal(providers.status, 200);
  assert.equal(providers.headers.get('cache-control'), 'no-store');
  assert.ok((await providers.json()).providers.length >= 8);

  const denied = await fetch(`${base}/api/compare`, { method: 'POST',
    headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '测试', providers: [] }),
  });
  assert.equal(denied.status, 403);
});
