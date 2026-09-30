import { validatedWebSearchTimeout } from './web-search-config.mjs';

const SEARCH_ENDPOINTS = Object.freeze({
  GLOBAL: 'https://open.feedcoopapi.com/search_api/global_search',
  CUSTOM: 'https://open.feedcoopapi.com/search_api/web_search',
});
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_QUERY_LENGTH = 500;
const MAX_UPSTREAM_QUERY_LENGTH = 100;
const SAFE_API_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function requiredApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new Error('Doubao web search requires DOUBAO_SEARCH_API_KEY');
  if (key.length > 2_000 || /\s/u.test(key)) throw new TypeError('DOUBAO_SEARCH_API_KEY is invalid');
  return key;
}

function plainText(value, maxLength, key = '') {
  if (typeof value !== 'string') return '';
  const withoutKey = key ? value.replaceAll(key, '[REDACTED_API_KEY]') : value;
  return [...withoutKey.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()]
    .slice(0, maxLength).join('');
}

function sourceUrl(value, key) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.includes(key)) return '';
  // Upstream result URLs are untrusted and may echo a percent-encoded credential.
  let decoded = url;
  try {
    for (let depth = 0; depth < 3 && decoded.includes('%'); depth += 1) {
      decoded = decodeURIComponent(decoded);
      if (decoded.includes(key)) return '';
    }
  } catch {
    return '';
  }
  return url;
}

function sourceFromDocument(document, key) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const url = sourceUrl(document.Url, key);
  if (!url) return null;
  const snippet = Array.isArray(document.Snippet)
    ? document.Snippet.filter((part) => part?.Type === 'text')
      .map((part) => plainText(part.Text, 1_000, key)).filter(Boolean).join(' ')
    : '';
  return {
    title: plainText(document.Title, 300, key),
    url,
    snippet: plainText(snippet, 3_000, key),
    siteName: plainText(document.HostInfo?.Hostname, 200, key),
  };
}

function sourceFromWebResult(item, key) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const url = sourceUrl(item.Url, key);
  if (!url) return null;
  const summary = typeof item.Summary === 'string' && item.Summary.trim()
    ? item.Summary : item.Snippet;
  return {
    title: plainText(item.Title, 300, key),
    url,
    snippet: plainText(summary, 3_000, key),
    siteName: plainText(item.SiteName, 200, key),
  };
}

function resultContent(sources) {
  const lines = sources.map((item, index) =>
    `${index + 1}. ${item.title || item.siteName || '网页'}：${item.snippet || '该服务未返回逐条摘要'}`);
  return [...`搜索结果摘录（根据服务商返回的网页摘要排列）：\n${lines.join('\n')}`]
    .slice(0, 6_000).join('');
}

function safeApiErrorCode(error, key) {
  const code = error?.Code;
  if (typeof code === 'string' && SAFE_API_ERROR_CODE.test(code)
    && !code.toLowerCase().includes(key.toLowerCase())) return code;
  const numericCode = error?.CodeN;
  if (Number.isSafeInteger(numericCode) && numericCode > 0
    && !String(numericCode).includes(key)) return String(numericCode);
  return null;
}

async function readBoundedJson(response, signal, executionSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('Doubao web search returned an empty response body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RangeError('Doubao web search response is too large');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RangeError) await reader.cancel().catch(() => {});
    executionSignal?.throwIfAborted();
    if (signal.aborted) throw new Error('Doubao web search request timed out while reading response body');
    if (error instanceof RangeError) throw error;
    throw new Error('Doubao web search response body transfer was interrupted');
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TypeError('Doubao web search response is not valid JSON');
  }
}

export async function runDoubaoWebSearch(
  { apiKey, timeoutMs: configuredTimeoutMs = DEFAULT_TIMEOUT_MS, icpHostOnly = true,
    mode = 'GLOBAL', fetchImpl = fetch },
  { query, limit = 5, timeoutMs = configuredTimeoutMs, signal: executionSignal },
) {
  executionSignal?.throwIfAborted();
  const key = requiredApiKey(apiKey);
  const normalizedQuery = typeof query === 'string' ? query.replace(/\s+/gu, ' ').trim() : '';
  if (!normalizedQuery || [...normalizedQuery].length > MAX_QUERY_LENGTH) {
    throw new RangeError('Doubao web search query must contain between 1 and 500 characters');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError('Doubao web search limit must be an integer between 1 and 10');
  }
  if (typeof icpHostOnly !== 'boolean') {
    throw new TypeError('Doubao search IcpHostOnly must be boolean');
  }
  if (typeof mode !== 'string' || !Object.hasOwn(SEARCH_ENDPOINTS, mode)) {
    throw new TypeError('Doubao search mode must be GLOBAL or CUSTOM');
  }
  const requestTimeoutMs = validatedWebSearchTimeout(timeoutMs);
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const signal = executionSignal ? AbortSignal.any([executionSignal, deadline]) : deadline;
  let response;
  try {
    response = await fetchImpl(SEARCH_ENDPOINTS[mode], {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(mode === 'CUSTOM'
        ? {
          Query: [...normalizedQuery].slice(0, MAX_UPSTREAM_QUERY_LENGTH).join(''),
          SearchType: 'web', Count: limit, NeedSummary: true,
        }
        : {
          SearchType: 'web',
          Query: [...normalizedQuery].slice(0, MAX_UPSTREAM_QUERY_LENGTH).join(''),
          DocCount: limit,
          MaxSnippetLength: 1000,
          Filter: { IcpHostOnly: icpHostOnly },
        }),
    });
  } catch {
    executionSignal?.throwIfAborted();
    throw new Error(signal.aborted
      ? 'Doubao web search request timed out'
      : 'Doubao web search network request failed');
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 502;
    throw new Error(`Doubao web search failed with HTTP ${status}`);
  }
  const payload = await readBoundedJson(response, signal, executionSignal);
  const serviceCode = payload?.Result?.ErrorCode;
  if (serviceCode !== undefined && serviceCode !== null
    && serviceCode !== 0 && !(mode === 'CUSTOM' && serviceCode === '0')) {
    const safeCode = mode === 'CUSTOM' && typeof serviceCode === 'string'
      ? SAFE_API_ERROR_CODE.test(serviceCode) && !serviceCode.toLowerCase().includes(key.toLowerCase())
        ? serviceCode : null
      : Number.isSafeInteger(serviceCode) && !String(serviceCode).includes(key)
        ? String(serviceCode) : null;
    throw new Error(safeCode
      ? `Doubao web search failed with service code ${safeCode}`
      : 'Doubao web search failed with invalid ErrorCode');
  }
  const apiError = payload?.ResponseMetadata?.Error;
  if (apiError != null) {
    // Message and the raw response are untrusted and can echo request data or credentials.
    const code = safeApiErrorCode(apiError, key);
    throw new Error(code
      ? `Doubao web search failed with API code ${code}`
      : 'Doubao web search failed with an API error without safe code');
  }
  if (!payload?.Result || typeof payload.Result !== 'object' || Array.isArray(payload.Result)) {
    throw new Error('Doubao web search failed with missing Result');
  }
  if (mode === 'GLOBAL' && (serviceCode === undefined || serviceCode === null)) {
    throw new Error('Doubao web search failed with missing ErrorCode');
  }
  if (mode === 'GLOBAL' && serviceCode !== 0) {
    throw new Error('Doubao web search failed with invalid ErrorCode');
  }
  const documents = mode === 'CUSTOM' ? payload.Result.WebResults : payload.Result.Documents;
  if (!Array.isArray(documents)) throw new TypeError('Doubao web search returned no source evidence');
  const sourceFromResult = mode === 'CUSTOM' ? sourceFromWebResult : sourceFromDocument;
  const sources = documents.slice(0, limit).map((document) => sourceFromResult(document, key)).filter(Boolean);
  if (sources.length === 0) throw new TypeError('Doubao web search returned no source evidence');
  return { provider: 'doubao', result: { content: resultContent(sources), sources } };
}
