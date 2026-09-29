import { runDeepSeekWebSearch } from '../src/deepseek-web-search.mjs';
import { businessPrompt } from '../src/prompt-runtime.mjs';

const TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export const providerCatalogue = Object.freeze([
  {
    id: 'deepseek', label: 'DeepSeek（当前系统）', kind: 'model-answer', needsKey: true,
    defaultModel: 'deepseek-v4-pro', hasModel: true,
    description: '复用当前系统的 Responses 联网搜索与来源格式。需要 DeepSeek API Key。',
    documentationUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'alibaba-iqs', label: '阿里云 IQS', kind: 'search-results', needsKey: true,
    description: '信息查询服务的独立搜索 API；需要 IQS API Key。展示网页动态摘要。',
    documentationUrl: 'https://help.aliyun.com/zh/document_detail/2883041.html',
  },
  {
    id: 'alibaba-opensearch', label: '阿里云 OpenSearch', kind: 'search-results', needsKey: true,
    description: 'AI 搜索开放平台 Web Search；需要 OS Key、工作空间及公网 HTTPS 接入地址。',
    documentationUrl: 'https://help.aliyun.com/zh/open-search/search-platform/developer-reference/web-search',
    fields: [
      { name: 'host', label: '公网 HTTPS 接入地址', placeholder: 'https://xxxx-hangzhou.opensearch.aliyuncs.com', required: true,
        pattern: '^https://[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.opensearch\\.aliyuncs\\.com$' },
      { name: 'workspaceName', label: '工作空间名称', placeholder: 'default', required: true,
        pattern: '^[A-Za-z0-9_-]{1,64}$' },
    ],
  },
  {
    id: 'alibaba-bailian', label: '阿里云百炼联网', kind: 'model-answer', needsKey: true,
    defaultModel: 'qwen-plus', hasModel: true, citationOnly: true,
    description: '千问模型联网回答；百炼 Key 与 IQS、OpenSearch Key 不通用。官方返回来源标题和链接，未保证逐条摘要。',
    documentationUrl: 'https://help.aliyun.com/zh/model-studio/web-search',
    fields: [
      { name: 'workspaceId', label: '百炼业务空间 ID', placeholder: '从百炼控制台复制', required: true,
        pattern: '^[A-Za-z0-9-]{1,80}$' },
      { name: 'region', label: '地域', placeholder: 'cn-beijing（默认）', required: false,
        pattern: '^(?:cn-beijing|ap-southeast-1)$' },
    ],
  },
  {
    id: 'xiaomi', label: '小米 MiMo', kind: 'model-answer', needsKey: true,
    defaultModel: 'mimo-v2.6-pro', hasModel: true,
    description: 'MiMo 模型强制联网，返回回答和逐条来源摘要。需先在控制台开通联网插件，并使用普通按量 API Key。',
    documentationUrl: 'https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/tool-calling/web-search',
  },
  {
    id: 'zhipu', label: '智谱 Web Search', kind: 'search-results', needsKey: true,
    description: '智谱独立网页搜索 API，返回标题、摘要和来源。Query 最多 70 字。',
    documentationUrl: 'https://docs.bigmodel.cn/api-reference/%E5%B7%A5%E5%85%B7-api/%E7%BD%91%E7%BB%9C%E6%90%9C%E7%B4%A2',
  },
  {
    id: 'qianfan', label: '百度千帆 AI Search', kind: 'search-results', needsKey: true,
    description: '千帆独立 AI 搜索 API，返回来源与摘要。Query 限 72 字符单位，汉字计 2。',
    documentationUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5',
  },
  {
    id: 'xinghuo', label: '讯飞星火万搜', kind: 'search-results', needsKey: true,
    description: 'ONE SEARCH 独立搜索 API；需要已开通万搜权限的 APIPassword。',
    documentationUrl: 'https://www.xfyun.cn/doc/spark/Search_API/search_API.html',
  },
  {
    id: 'tencent-wsa', label: '腾讯云联网搜索 WSA', kind: 'search-results', needsKey: true,
    description: '腾讯云独立联网搜索，需要 WSA 服务 API Key（不是云账号 SecretKey）。',
    documentationUrl: 'https://cloud.tencent.com/document/product/1806/130615',
  },
  {
    id: 'doubao', label: '火山引擎豆包搜索', kind: 'search-results', needsKey: true,
    description: '豆包搜索 Global 版独立搜索 API；需要联网搜索控制台创建的按量后付费 Key。',
    documentationUrl: 'https://www.volcengine.com/docs/87772/2548026',
    fields: [{ name: 'icpHostOnly', type: 'boolean', defaultValue: true,
      label: '仅国内ICP备案网站', description: '国内网站也可能包含国外内容。' }],
  },
  {
    id: 'kimi', label: 'Kimi 联网搜索 Basic', kind: 'search-results', needsKey: true,
    description: 'Kimi 开放平台独立搜索 API，返回网页标题、摘要和来源。',
    documentationUrl: 'https://platform.kimi.com/docs/api/tools-search',
  },
  {
    id: 'minimax', label: 'MiniMax Coding Plan 搜索', kind: 'search-results', needsKey: true,
    description: 'MiniMax 官方 Coding Plan 搜索接口；需 Token Plan 订阅 Key，地域与 Key 须匹配。',
    documentationUrl: 'https://platform.minimax.cn/docs/token-plan/mcp-guide',
    fields: [{ name: 'region', label: '地域', placeholder: 'mainland（默认）或 global', required: false,
      pattern: '^(?:mainland|global)$' }],
  },
]);

function plainText(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/gu, '').trim() : '';
}

function source(title, url, snippet, siteName) {
  return { title: plainText(title), url, snippet: plainText(snippet), siteName: plainText(siteName) };
}

function excerpts(sources) {
  return `搜索结果摘录（根据服务商返回的网页摘要排列，未由模型改写）：\n${sources.slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.title || item.siteName || '网页'}：${item.snippet || '该服务未返回逐条摘要'}`)
    .join('\n')}`;
}

function resultFromSources(id, sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error(`${id} 未返回搜索来源`);
  return { provider: id, result: { content: excerpts(sources), sources } };
}

function modelAnswerPrompt(query) {
  return businessPrompt('RESEARCH_SYSTEM', {
    dataTag: 'untrusted_query', data: { query },
    contract: '必须实际调用本次联网搜索。只用中文概括与 Query 直接相关的可核查信息；不要编造来源。来源链接由 API 的结构化字段单独提取，只输出资料摘要正文。',
  });
}

async function postJson(url, key, body, {
  fetchImpl = fetch, label = '搜索服务', errorFromResponse,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`${label} 网络请求失败或超时`);
  }
  if (!response.ok && !errorFromResponse) throw new Error(`${label} HTTP ${response.status}`);
  let raw;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty body');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('body too large');
      }
      chunks.push(value);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch {
    throw new Error(`${label} 响应读取失败或过大`);
  }
  let payload;
  try { payload = JSON.parse(raw); }
  catch {
    throw new Error(response.ok ? `${label} 返回了无效 JSON` : `${label} HTTP ${response.status}`);
  }
  const providerError = errorFromResponse?.(payload, response.status);
  if (providerError) throw providerError;
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return payload;
}

const TENCENT_ERROR_HINTS = Object.freeze({
  UnauthorizedOperation: '请核对 WSA 控制台创建的服务 API Key，云账号 SecretId/SecretKey 不适用于此接口',
  AuthFailure: '鉴权失败，请核对 WSA 服务 API Key 是否有效',
  ResourceNotFound: '请联系主账号开通联网搜索 WSA 服务',
  ResourceUnavailable: 'WSA 服务资源不可用，请检查账号是否欠费及服务状态',
  RequestLimitExceeded: '请求频率超过限制，请稍后重试',
  InvalidParameter: '请求参数被拒绝，请核对搜索词及已开通的服务版本',
  InternalError: '腾讯服务内部错误，可凭 RequestId 联系腾讯云排查',
});

function safeDiagnostic(value, key, limit = 400) {
  if (typeof value !== 'string') return '';
  let text = value;
  if (key) text = text.replaceAll(key, '[REDACTED_API_KEY]');
  return plainText(text)
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}/giu, 'Bearer [REDACTED_TOKEN]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function tencentRequestId(payload, key) {
  const requestId = safeDiagnostic(payload?.Response?.RequestId, key, 128);
  return /^[A-Za-z0-9-]{1,128}$/u.test(requestId) ? `RequestId: ${requestId}` : '';
}

function tencentResponseError(payload, key, httpStatus) {
  const error = payload?.Response?.Error;
  if (!error) return null;
  const code = safeDiagnostic(error.Code, key, 100) || 'UNKNOWN_ERROR';
  const message = safeDiagnostic(error.Message, key);
  const hint = TENCENT_ERROR_HINTS[code.split('.')[0]];
  return new Error([
    `腾讯云 WSA 搜索失败（${code}${httpStatus >= 400 ? `，HTTP ${httpStatus}` : ''}）`,
    message, hint, tencentRequestId(payload, key),
  ].filter(Boolean).join('；'));
}

async function runAlibabaIqs({ key, query, limit, fetchImpl }) {
  const payload = await postJson('https://cloud-iqs.aliyuncs.com/search/unified', key, {
    query, engineType: 'Generic', contents: { summary: false, rerankScore: true },
    advancedParams: { numResults: limit },
  }, { fetchImpl, label: '阿里云 IQS' });
  if (payload.code || payload.error) throw new Error('阿里云 IQS 搜索失败');
  return resultFromSources('alibaba-iqs', (payload.pageItems ?? []).slice(0, limit)
    .map((item) => source(item.title, item.link, item.snippet, item.hostname)));
}

async function runAlibabaOpenSearch({ key, query, limit, options, fetchImpl }) {
  const { host, workspaceName } = options;
  if (!/^https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.opensearch\.aliyuncs\.com$/u.test(host)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(workspaceName)) {
    throw new Error('阿里云 OpenSearch 接入地址或工作空间不正确');
  }
  const url = `${host}/v3/openapi/workspaces/${encodeURIComponent(workspaceName)}/web-search/ops-web-search-001`;
  const payload = await postJson(url, key, { query, query_rewrite: false, top_k: limit,
    content_type: 'snippet', way: 'pro' }, { fetchImpl, label: '阿里云 OpenSearch' });
  if (payload.code || payload.error) throw new Error('阿里云 OpenSearch 搜索失败');
  return resultFromSources('alibaba-opensearch', (payload.result?.search_result ?? [])
    .slice(0, limit).map((item) => source(item.title, item.link, item.snippet, '')));
}

async function runAlibabaBailian({ key, model, query, limit, options, fetchImpl }) {
  const workspaceId = options.workspaceId;
  const region = options.region || 'cn-beijing';
  if (!/^[A-Za-z0-9-]{1,80}$/u.test(workspaceId)
    || !['cn-beijing', 'ap-southeast-1'].includes(region)) {
    throw new Error('阿里云百炼业务空间或地域不正确');
  }
  const url = `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation`;
  const payload = await postJson(url, key, {
    model, input: { messages: [{ role: 'user', content: modelAnswerPrompt(query) }] },
    parameters: { enable_search: true, search_options: { forced_search: true, enable_source: true },
      result_format: 'message' },
  }, { fetchImpl, label: '阿里云百炼' });
  if (payload.code || payload.error) throw new Error('阿里云百炼联网搜索失败');
  const output = payload.output;
  const sources = (output?.search_info?.search_results ?? []).slice(0, limit)
    .map((item) => source(item.title, item.url, item.snippet, item.site_name));
  const content = plainText(output?.choices?.[0]?.message?.content);
  if (!content || !sources.length) throw new Error('阿里云百炼未返回联网回答或来源');
  return { provider: 'alibaba-bailian', result: { content, sources } };
}

async function runXiaomi({ key, model, query, limit, fetchImpl }) {
  const payload = await postJson('https://api.xiaomimimo.com/v1/chat/completions', key, {
    model, messages: [{ role: 'user', content: modelAnswerPrompt(query) }],
    max_completion_tokens: 2048, stream: false,
    tools: [{ type: 'web_search', max_keyword: 1, force_search: true, limit: 1 }], tool_choice: 'auto',
    thinking: { type: 'disabled' },
  }, { fetchImpl, label: '小米 MiMo' });
  const message = payload.choices?.[0]?.message;
  const sources = (message?.annotations ?? []).filter((item) => item?.type === 'url_citation')
    .slice(0, limit).map((item) => source(item.title, item.url, item.summary, item.site_name));
  const content = plainText(message?.content);
  if (!content || !sources.length || payload.usage?.web_search_usage?.tool_usage === 0) {
    throw new Error('小米 MiMo 未返回真实联网结果，请检查联网插件');
  }
  return { provider: 'xiaomi', result: { content, sources } };
}

async function runZhipu({ key, query, limit, fetchImpl }) {
  if ([...query].length > 70) throw new RangeError('智谱搜索 Query 最多 70 字');
  const payload = await postJson('https://open.bigmodel.cn/api/paas/v4/web_search', key, {
    search_query: query, search_engine: 'search_std', search_intent: false,
    count: limit, content_size: 'medium',
  }, { fetchImpl, label: '智谱' });
  if (payload.error) throw new Error('智谱搜索失败');
  return resultFromSources('zhipu', (payload.search_result ?? []).slice(0, limit)
    .map((item) => source(item.title, item.link, item.content, item.media)));
}

async function runQianfan({ key, query, limit, fetchImpl }) {
  const queryUnits = [...query].reduce((count, character) => count + (character.codePointAt(0) > 127 ? 2 : 1), 0);
  if (queryUnits > 72) throw new RangeError('百度千帆搜索 Query 最多 72 字符单位（汉字计 2）');
  const payload = await postJson('https://qianfan.baidubce.com/v2/ai_search/web_search', key, {
    messages: [{ role: 'user', content: query }], search_source: 'baidu_search_v2',
    edition: 'standard', resource_type_filter: [{ type: 'web', top_k: limit }],
  }, { fetchImpl, label: '百度千帆' });
  if (payload.error) throw new Error('百度千帆搜索失败');
  return resultFromSources('qianfan', (payload.references ?? []).slice(0, limit)
    .map((item) => source(item.title, item.url, item.snippet ?? item.content, item.website)));
}

async function runTencentWsa({ key, query, limit, fetchImpl }) {
  // Omit Mode: its default is natural search, and the lite edition does not
  // support explicitly supplying this parameter.
  const payload = await postJson('https://api.wsa.cloud.tencent.com/SearchPro', key,
    { Query: query }, { fetchImpl, label: '腾讯云 WSA',
      errorFromResponse: (body, status) => tencentResponseError(body, key, status),
    });
  const pages = payload.Response?.Pages ?? [];
  if (!Array.isArray(pages)) throw new Error('腾讯云 WSA 返回的 Pages 格式不正确');
  const sources = pages.slice(0, limit).map((item) => {
    try {
      const page = typeof item === 'string' ? JSON.parse(item) : item;
      return source(page.title, page.url, page.passage || page.content, page.site);
    } catch { return null; }
  }).filter(Boolean);
  if (!sources.length) {
    throw new Error(['腾讯云 WSA 未返回搜索来源',
      safeDiagnostic(payload.Response?.Msg, key), tencentRequestId(payload, key),
    ].filter(Boolean).join('；'));
  }
  return resultFromSources('tencent-wsa', sources);
}

async function runXinghuo({ key, query, limit, fetchImpl }) {
  const payload = await postJson('https://search-api-open.cn-huabei-1.xf-yun.com/v2/search', key, {
    search_params: { query, limit, enhance: { open_full_text: false, open_rerank: true } },
  }, { fetchImpl, label: '讯飞星火万搜' });
  if (payload.success !== true || String(payload.err_code) !== '0') throw new Error('讯飞星火万搜搜索失败');
  return resultFromSources('xinghuo', (payload.data?.search_results?.documents ?? [])
    .slice(0, limit).map((item) => source(item.name, item.url, item.summary, '')));
}

async function runDoubao({ key, query, limit, options, fetchImpl }) {
  const icpHostOnly = options.icpHostOnly === undefined ? true : options.icpHostOnly;
  if (typeof icpHostOnly !== 'boolean') throw new TypeError('豆包搜索来源限制必须为布尔值');
  const payload = await postJson('https://open.feedcoopapi.com/search_api/global_search', key, {
    SearchType: 'web', Query: query, DocCount: limit, MaxSnippetLength: 1000,
    Filter: { IcpHostOnly: icpHostOnly },
  }, { fetchImpl, label: '豆包搜索' });
  if (payload.Result?.ErrorCode !== 0) throw new Error('豆包搜索失败');
  return resultFromSources('doubao', (payload.Result?.Documents ?? []).slice(0, limit).map((item) => {
    const snippet = (item.Snippet ?? []).filter((part) => part?.Type === 'text')
      .map((part) => part.Text).filter((part) => typeof part === 'string').join(' ');
    return source(item.Title, item.Url, snippet, item.HostInfo?.Hostname);
  }));
}

async function runKimi({ key, query, limit, fetchImpl }) {
  const payload = await postJson('https://api.moonshot.cn/v1/tools/search', key, {
    text_query: query, limit, timeout_seconds: 30, include_content: false,
  }, { fetchImpl, label: 'Kimi 搜索' });
  if (payload.error) throw new Error('Kimi 搜索失败');
  return resultFromSources('kimi', (payload.search_results ?? []).slice(0, limit)
    .map((item) => source(item.title, item.url, item.snippet, item.site_name)));
}

async function runMiniMax({ key, query, limit, options, fetchImpl }) {
  const region = options.region || 'mainland';
  if (!['mainland', 'global'].includes(region)) throw new Error('MiniMax 地域不正确');
  const host = region === 'global' ? 'https://api.minimax.io' : 'https://api.minimax.cn';
  const payload = await postJson(`${host}/v1/coding_plan/search`, key, { q: query },
    { fetchImpl, label: 'MiniMax 搜索' });
  if (payload.base_resp?.status_code !== 0) throw new Error('MiniMax 搜索失败或 Key 无此接口权限');
  return resultFromSources('minimax', (payload.organic ?? []).slice(0, limit)
    .map((item) => source(item.title, item.link, item.snippet, '')));
}

export async function runProviderSearch(input) {
  const { id, key, model, query, limit = 5, options = {}, fetchImpl = fetch } = input;
  switch (id) {
    case 'deepseek': return runDeepSeekWebSearch({ apiKey: key, model, timeoutMs: TIMEOUT_MS, fetchImpl }, { query, limit });
    case 'alibaba-iqs': return runAlibabaIqs({ key, query, limit, fetchImpl });
    case 'alibaba-opensearch': return runAlibabaOpenSearch({ key, query, limit, options, fetchImpl });
    case 'alibaba-bailian': return runAlibabaBailian({ key, model, query, limit, options, fetchImpl });
    case 'xiaomi': return runXiaomi({ key, model, query, limit, fetchImpl });
    case 'zhipu': return runZhipu({ key, query, limit, fetchImpl });
    case 'qianfan': return runQianfan({ key, query, limit, fetchImpl });
    case 'xinghuo': return runXinghuo({ key, query, limit, fetchImpl });
    case 'tencent-wsa': return runTencentWsa({ key, query, limit, fetchImpl });
    case 'doubao': return runDoubao({ key, query, limit, options, fetchImpl });
    case 'kimi': return runKimi({ key, query, limit, fetchImpl });
    case 'minimax': return runMiniMax({ key, query, limit, options, fetchImpl });
    default: throw new TypeError('未知搜索服务商');
  }
}
