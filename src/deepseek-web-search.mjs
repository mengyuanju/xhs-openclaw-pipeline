import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_WEB_SEARCH_TIMEOUT_MS, validatedWebSearchTimeout } from './web-search-config.mjs';
import { traceModelCall } from './model-call-trace.mjs';
import { normalizedPublicUrl, supplementalResearchSuffix } from './research.mjs';

const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_UPSTREAM_QUERY_LENGTH = 128;

function requiredApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new Error('DeepSeek web search requires DEEPSEEK_API_KEY');
  if (key.length > 2_000 || /\s/u.test(key)) throw new TypeError('DEEPSEEK_API_KEY is invalid');
  return key;
}

function upstreamQuery(query) {
  const characters = [...query];
  if (characters.length <= MAX_UPSTREAM_QUERY_LENGTH) return query;
  // Preserve the research layer's official-source qualifier after shortening.
  const suffix = supplementalResearchSuffix(query);
  return `${characters.slice(0, MAX_UPSTREAM_QUERY_LENGTH - [...suffix].length).join('').trimEnd()}${suffix}`;
}

function credentialTextRedactor(key) {
  return (value) => value.replaceAll(key, '[REDACTED_API_KEY]').replace(/\S+/gu, (token) => {
    let decoded = token;
    for (let depth = 0; depth < 3; depth += 1) {
      const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (bytes) =>
        Buffer.from(bytes.replaceAll('%', ''), 'hex').toString('utf8'));
      if (next === decoded) break;
      if (next.includes(key)) return '[REDACTED_API_KEY]';
      decoded = next;
    }
    return token;
  });
}

function plainText(value, maxLength, redact) {
  if (typeof value !== 'string') return '';
  const text = redact(value).replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return [...redact(text)].slice(0, maxLength).join('');
}

function sourceFromResult(item, redact) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.url !== 'string') return null;
  // Never keep credentials echoed in source URLs, including encoded ones.
  if (redact(item.url) !== item.url) return null;
  const url = normalizedPublicUrl(item.url);
  if (!url || redact(url) !== url) return null;
  return {
    title: plainText(item.title, 300, redact),
    url,
    snippet: plainText(item.summary, 3_000, redact) || plainText(item.snippet, 3_000, redact),
    siteName: plainText(item.site_name, 200, redact),
  };
}

function searchEvidence(payload, limit, redact) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error != null
    || !Array.isArray(payload.results)) {
    throw new TypeError('DeepSeek web search returned invalid search results');
  }
  const seen = new Set();
  const sources = payload.results.slice(0, 100).map(item => sourceFromResult(item, redact))
    .filter(item => {
      if (!item || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }).slice(0, limit);
  if (sources.length === 0) return { content: '', sources: [], structuredSourcesOnly: true };
  // Fairly bound each excerpt so all sources fit in the existing 2,000-character
  // generation summary. Per-source longer summaries remain in sources[].snippet.
  const heading = '搜索结果摘录（服务商返回的网页摘要，未抓取全文）：';
  const perSource = Math.floor((2_000 - heading.length - sources.length) / sources.length);
  const lines = sources.map((item, index) => {
    const title = (item.title || item.siteName || new URL(item.url).hostname).slice(0, 60);
    return `${index + 1}. ${title}：${item.snippet || '该服务未返回逐条摘要'}`.slice(0, perSource);
  });
  return { content: `${heading}\n${lines.join('\n')}`, sources, structuredSourcesOnly: true };
}

function requestFailure(message, retryable = false, retryAfterMs = 250) {
  return Object.assign(new Error(message), { retryable, retryAfterMs });
}

function retryDelay(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return 250;
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(250, milliseconds) : 250;
}

async function readBoundedJson(response, signal, executionSignal, capture, audit) {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('DeepSeek web search returned an empty response body');
  const chunks = [];
  let size = 0;
  let oversized = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        oversized = true;
        throw new RangeError('DeepSeek web search response is too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    executionSignal?.throwIfAborted();
    capture.response({ ...audit, bodyRead: signal.aborted ? 'TIMEOUT' : 'INTERRUPTED', bodyBytes: size });
    if (oversized) throw new RangeError('DeepSeek web search response is too large');
    throw requestFailure(signal.aborted ? 'DeepSeek web search request timed out while reading response body'
      : 'DeepSeek web search response body transfer was interrupted; check the network connection', !signal.aborted);
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const format = !raw ? 'EMPTY' : /^</u.test(raw) ? 'HTML_OR_XML'
    : /^(?:event:|data:|:)/u.test(raw) ? 'EVENT_STREAM' : 'JSON_OR_TEXT';
  // Do not persist malformed bodies or upstream error messages; either can echo secrets.
  capture.response({ ...audit, bodyFormat: format, bodyBytes: size });
  if (!raw) throw new TypeError('DeepSeek web search returned an empty response body');
  try { return JSON.parse(raw); }
  catch {
    const hint = format === 'HTML_OR_XML' ? '; received an HTML/XML page, check the upstream service or proxy'
      : format === 'EVENT_STREAM' ? '; received an unexpected event stream' : '; response is malformed or truncated';
    throw new TypeError(`DeepSeek web search response is not valid JSON${hint}`);
  }
}

export async function runDeepSeekWebSearch(
  { apiKey, timeoutMs: configuredTimeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_MS, fetchImpl = fetch },
  { query, limit = 5, timeoutMs = configuredTimeoutMs, signal: executionSignal },
) {
  executionSignal?.throwIfAborted();
  const key = requiredApiKey(apiKey);
  const normalizedQuery = typeof query === 'string' ? query.replace(/\s+/gu, ' ').trim() : '';
  if (!normalizedQuery || [...normalizedQuery].length > 500) {
    throw new RangeError('web search query must contain between 1 and 500 characters');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError('web search limit must be an integer between 1 and 10');
  }
  const requestTimeoutMs = validatedWebSearchTimeout(timeoutMs);
  const expiresAt = Date.now() + requestTimeoutMs;
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const signal = executionSignal ? AbortSignal.any([executionSignal, deadline]) : deadline;
  const body = { query: upstreamQuery(normalizedQuery), count: limit, need_content: false };
  const redact = credentialTextRedactor(key);

  async function requestEvidence(operation) {
    signal.throwIfAborted();
    return traceModelCall({ provider: 'DeepSeek', operation, model: '', prompt: redact(normalizedQuery),
      request: { ...body, query: redact(body.query) }, requestScope: 'HTTP_BODY' }, async capture => {
      const audit = { api: 'deepseek-search', endpoint: SEARCH_ENDPOINT };
      capture.response(audit);
      let response;
      try {
        response = await fetchImpl(SEARCH_ENDPOINT, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
      } catch (error) {
        executionSignal?.throwIfAborted();
        const timedOut = signal.aborted || error?.name === 'TimeoutError';
        throw requestFailure(timedOut ? 'DeepSeek web search request timed out'
          : 'DeepSeek web search network request failed', !timedOut);
      }
      const httpStatus = Number.isInteger(response?.status) ? response.status : 502;
      capture.response({ ...audit, httpStatus });
      if (!response?.ok) {
        void response?.body?.cancel?.().catch(() => {});
        throw requestFailure(`DeepSeek web search failed with HTTP ${httpStatus}`,
          [408, 429].includes(httpStatus) || (httpStatus >= 500 && httpStatus <= 599), retryDelay(response));
      }
      const payload = await readBoundedJson(response, signal, executionSignal, capture, { ...audit, httpStatus });
      const result = searchEvidence(payload, limit, redact);
      capture.response({ ...audit, httpStatus, scope: 'NORMALIZED_SEARCH_EVIDENCE', result });
      return { provider: 'deepseek', result };
    }, [key]);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await requestEvidence(attempt === 0 ? 'WEB_SEARCH' : 'WEB_SEARCH_RETRY'); }
    catch (error) {
      executionSignal?.throwIfAborted();
      if (attempt !== 0 || !error.retryable || signal.aborted || error.retryAfterMs >= expiresAt - Date.now()) throw error;
      try { await wait(error.retryAfterMs, undefined, { signal }); }
      catch {
        executionSignal?.throwIfAborted();
        throw new Error('DeepSeek web search request timed out during retry delay');
      }
    }
  }
}
