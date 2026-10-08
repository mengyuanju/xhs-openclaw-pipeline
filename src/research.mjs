import { isIP } from 'node:net';
import { codexErrorCode } from './codex-protocol.mjs';
import { DEFAULT_WEB_SEARCH_RESULT_LIMIT, DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  validatedWebSearchTimeout } from './web-search-config.mjs';

const RESEARCH_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDERS = ['codex'];
const MAX_SOURCES = 10;
const MAX_SOURCE_CANDIDATES = 100;
const MAX_SUMMARY_URL_CANDIDATES = 20;
const MAX_ATTEMPTS = 5;
const MULTI_PROVIDER_BUDGET_MS = 300_000;
const MIN_PROVIDER_TIMEOUT_MS = 5_000;

function cleanExternalText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/giu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && line !== '---' && !/^Source:\s*Web Search$/iu.test(line))
    .join('\n')
    .trim();
  return [...cleaned].slice(0, maxLength).join('');
}

function redactedError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}

function normalizedPublicUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 500) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const ipCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!hostname || isIP(ipCandidate) !== 0 || hostname === 'localhost'
    || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) return null;
  parsed.hash = '';
  return parsed.href;
}

function sourceAuthorityScore(source) {
  let hostname = '';
  try {
    hostname = new URL(source?.url).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return 0;
  }
  if (/(?:^|\.)gov(?:\.[a-z]{2})?$/u.test(hostname)) return 3;
  if (/(?:^|\.)edu(?:\.[a-z]{2})?$/u.test(hostname)) return 2;
  if (/^(?:www\.)?(?:who\.int|fao\.org|iso\.org)$/u.test(hostname)) return 2;
  return 0;
}

function urlsFromText(value) {
  const text = cleanExternalText(value, 6_000);
  const markdownLink = /\[[^\]\r\n]*\]\((https?:\/\/[^\s)]+)\)/giu;
  const urls = [...text.matchAll(markdownLink)].map((match) => match[1]);
  const withoutMarkdownLinks = text.replace(markdownLink, '');
  const bare = withoutMarkdownLinks.match(/https?:\/\/[^\s<>"'`()\]}>，。；;!?！]+/giu) ?? [];
  urls.push(...bare.map((match) => match.replace(/[.,]+$/gu, '')));
  return [...new Set(urls)];
}

function sourceItems(result) {
  const items = [];
  for (const key of ['results', 'sources', 'citations']) {
    if (!Array.isArray(result?.[key])) continue;
    for (const item of result[key]) {
      items.push(item);
      if (items.length === MAX_SOURCE_CANDIDATES) return items;
    }
  }
  if (Array.isArray(result?.searches)) {
    for (const item of result.searches) {
      items.push(item);
      if (items.length === MAX_SOURCE_CANDIDATES) return items;
    }
  }
  return items;
}

function normalizeSources(result, provider, retrievedAt, limit = DEFAULT_WEB_SEARCH_RESULT_LIMIT) {
  const summary = cleanExternalText(
    result?.content ?? result?.answer ?? result?.text ?? result?.summary,
    6_000,
  );
  const candidates = [];
  for (const item of sourceItems(result)) {
    if (typeof item === 'string') {
      candidates.push({ url: item });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    candidates.push({
      title: item.title ?? item.name,
      url: item.url ?? item.link ?? item.href,
      snippet: item.snippet ?? item.description ?? item.excerpt ?? item.content ?? item.text,
      siteName: item.siteName ?? item.site_name ?? item.domain,
    });
  }
  for (const url of urlsFromText(summary).slice(0, MAX_SUMMARY_URL_CANDIDATES)) {
    candidates.push({ url });
  }

  const sources = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const url = normalizedPublicUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const hostname = new URL(url).hostname;
    sources.push({
      title: cleanExternalText(candidate.title, 300) || hostname,
      url,
      snippet: cleanExternalText(candidate.snippet, 3_000),
      siteName: cleanExternalText(candidate.siteName, 200) || hostname,
      provider,
      retrievedAt,
    });
  }
  sources.sort((left, right) => sourceAuthorityScore(right) - sourceAuthorityScore(left));
  return { summary: summary || null, sources: sources.slice(0, limit) };
}

export function normalizeResearchEvidence(result, provider, retrievedAt) {
  return normalizeSources(result, normalizedProvider(provider), normalizedTimestamp(retrievedAt, 'research source retrievedAt'));
}

function hasGroundedSummary(evidence, provider, citationOnlyProviders) {
  // Codex Hosted Search and selected citation-only APIs return a synthesized
  // answer with citation URLs, but may omit per-source snippets.
  return Boolean(evidence?.summary
    && evidence.sources.length > 0
    && (citationOnlyProviders.has(provider)
      || evidence.sources.some((source) => typeof source.snippet === 'string' && source.snippet)));
}

function hasSufficientApiSearchEvidence(evidence, limit) {
  if (!evidence.summary) return false;
  // Distinct official help pages on one product domain are useful independent
  // evidence for ordinary how-to content. High-risk topics still use the
  // explicit authoritative-source policy below.
  const completeUrls = new Set(evidence.sources.filter((source) => source.snippet.trim()
    && source.title !== new URL(source.url).hostname)
    .map((source) => source.url));
  return completeUrls.size >= Math.min(2, limit);
}

function isSearchCancellation(error) {
  return error?.name === 'AbortError'
    || ['ABORT_ERR', 'ERR_ABORTED', 'ERR_CANCELED'].includes(error?.code);
}

async function runTimedWebSearch(client, input, timeoutMs) {
  const deadline = new AbortController();
  const timeoutError = Object.assign(new Error('web search attempt timed out'), { name: 'TimeoutError' });
  const timer = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
  let onAbort;
  const expired = new Promise((_, reject) => {
    onAbort = () => reject(deadline.signal.reason ?? timeoutError);
    deadline.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      client.runWebSearch({ ...input, timeoutMs, signal: deadline.signal }),
      expired,
    ]);
  } catch (error) {
    // An adapter may turn our timeout signal into an AbortError. It is still a
    // provider timeout, so another configured provider can be tried.
    if (deadline.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.signal.removeEventListener('abort', onAbort);
  }
}

const MEDICAL_RESEARCH = /(诊断|诊疗|疾病|症状|用药|药物|剂量|手术|治疗|急救|孕期|婴幼儿健康)/u;
const LEGAL_RESEARCH = /(法律|法规|诉讼|仲裁|合同纠纷|劳动争议|行政处罚|刑事|判决)/u;
const FINANCIAL_RESEARCH = /(投资|股票|基金|期货|证券|理财|贷款|信贷|保险理赔|虚拟货币|加密货币)/u;
const POLICY_RESEARCH = /(政策|补贴|税务|报税|落户|社保|医保|签证|政府规定)/u;

function highRiskResearchKind(value) {
  const text = String(value ?? '');
  if (MEDICAL_RESEARCH.test(text)) return 'MEDICAL';
  if (LEGAL_RESEARCH.test(text)) return 'LEGAL';
  if (FINANCIAL_RESEARCH.test(text)) return 'FINANCIAL';
  if (POLICY_RESEARCH.test(text)) return 'POLICY';
  return null;
}

export function requiresAuthoritativeResearch(task) {
  const query = typeof task?.query === 'string' ? task.query : '';
  const category = typeof task?.input?.category === 'string' ? task.input.category : '';
  return highRiskResearchKind(`${query} ${category}`) !== null;
}

function supplementalResearchQuery(query, requireAuthoritative) {
  const kind = requireAuthoritative ? highRiskResearchKind(query) : null;
  const suffix = kind === 'MEDICAL' ? '卫健委 官方指南'
    : kind === 'LEGAL' ? '政府官网 现行规定'
      : kind === 'FINANCIAL' ? '监管机构 风险提示 官方资料'
        : kind === 'POLICY' ? '政府官网 现行政策'
          : '官方帮助 使用指南';
  return `${query} ${suffix}`.slice(0, 500);
}

function normalizedTimestamp(value, field) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function normalizedProvider(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider)) {
    throw new TypeError('research provider is invalid');
  }
  return provider;
}

export function normalizeResearchSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== RESEARCH_SCHEMA_VERSION) {
    throw new TypeError('research snapshot is invalid');
  }
  if (!['COMPLETED', 'FAILED'].includes(value.status)) {
    throw new TypeError('research status is invalid');
  }
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  if (query.length < 1 || query.length > 500) throw new RangeError('research query is invalid');
  if (!Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 5) {
    throw new RangeError('research attempts are invalid');
  }
  const attempts = value.attempts.map((attempt) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)
      || !['COMPLETED', 'FAILED'].includes(attempt.status)) {
      throw new TypeError('research attempt is invalid');
    }
    return {
      provider: normalizedProvider(attempt.provider),
      status: attempt.status,
      error: attempt.error === null || attempt.error === undefined
        ? null
        : redactedError(attempt.error),
    };
  });
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw new RangeError('research sources are invalid');
  }
  const sources = value.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError('research source is invalid');
    }
    const url = normalizedPublicUrl(source.url);
    if (!url) throw new TypeError('research source URL is invalid');
    const provider = normalizedProvider(source.provider);
    return {
      title: cleanExternalText(source.title, 300) || new URL(url).hostname,
      url,
      snippet: cleanExternalText(source.snippet, 3_000),
      siteName: cleanExternalText(source.siteName, 200) || new URL(url).hostname,
      provider,
      retrievedAt: normalizedTimestamp(source.retrievedAt, 'research source retrievedAt'),
    };
  });
  const provider = value.provider === null
    ? null
    : normalizedProvider(value.provider);
  if (value.status === 'COMPLETED' && (!provider || sources.length === 0)) {
    throw new TypeError('completed research snapshot requires a provider and sources');
  }
  if (value.status === 'FAILED' && provider !== null) {
    throw new TypeError('failed research snapshot cannot have a provider');
  }
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    status: value.status,
    query,
    searchedAt: normalizedTimestamp(value.searchedAt, 'research searchedAt'),
    provider,
    summary: value.summary === null || value.summary === undefined
      ? null
      : cleanExternalText(value.summary, 6_000) || null,
    attempts,
    sources,
  };
}

export async function createResearchSnapshot({
  client,
  query,
  providers = client?.webSearchProviders ?? DEFAULT_PROVIDERS,
  limit = DEFAULT_WEB_SEARCH_RESULT_LIMIT,
  now = () => new Date().toISOString(),
  requireAuthoritative = false,
  supplementalSearch = true,
  citationOnlyProviders = ['codex'],
  monotonicNow = () => performance.now(),
}) {
  if (!client?.runWebSearch) throw new TypeError('Model web search client is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOURCES) {
    throw new RangeError(`research source limit must be an integer between 1 and ${MAX_SOURCES}`);
  }
  if (typeof requireAuthoritative !== 'boolean') throw new TypeError('requireAuthoritative must be boolean');
  if (typeof supplementalSearch !== 'boolean') throw new TypeError('supplementalSearch must be boolean');
  if (!Array.isArray(citationOnlyProviders) || citationOnlyProviders.some((value) => typeof value !== 'string')) {
    throw new TypeError('citationOnlyProviders must be provider names');
  }
  const citationOnly = new Set(citationOnlyProviders.map((value) => normalizedProvider(value)));
  const normalizedQuery = String(query ?? '').replace(/\s+/gu, ' ').trim().slice(0, 500);
  if (!normalizedQuery) throw new RangeError('research query is required');
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 5) {
    throw new RangeError('research providers are invalid');
  }
  const orderedProviders = [...new Set(providers.map((value) => normalizedProvider(value)))];
  const boundedFailover = Array.isArray(client.webSearchProviders)
    && client.webSearchProviders.length > 1 && orderedProviders.length > 1;
  const providerTimeoutMs = boundedFailover
    ? validatedWebSearchTimeout(client.webSearchTimeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS) : null;
  const startedAt = boundedFailover ? monotonicNow() : null;
  if (boundedFailover && !Number.isFinite(startedAt)) throw new TypeError('research clock is invalid');
  const searchedAt = normalizedTimestamp(now(), 'research searchedAt');
  const attempts = [];
  const unavailableProviders = new Set();
  const supplementalQuery = supplementalResearchQuery(normalizedQuery, requireAuthoritative);
  const queryVariants = supplementalSearch
    ? [...new Set([normalizedQuery, supplementalQuery])]
    : [normalizedQuery];
  let bestFallback = null;
  searchLoop:
  for (const searchQuery of queryVariants) {
    for (const provider of orderedProviders) {
      if (attempts.length >= MAX_ATTEMPTS) break searchLoop;
      if (unavailableProviders.has(provider)) continue;
      let attemptTimeoutMs = null;
      if (boundedFailover) {
        const elapsedMs = monotonicNow() - startedAt;
        if (!Number.isFinite(elapsedMs)) throw new TypeError('research clock is invalid');
        const remainingMs = Math.floor(MULTI_PROVIDER_BUDGET_MS - Math.max(0, elapsedMs));
        if (remainingMs < MIN_PROVIDER_TIMEOUT_MS) {
          attempts.push({ provider, status: 'FAILED', error: 'web search total time budget exhausted' });
          break searchLoop;
        }
        attemptTimeoutMs = Math.min(providerTimeoutMs, remainingMs);
      }
      try {
        const request = { query: searchQuery, provider, limit };
        const response = boundedFailover
          ? await runTimedWebSearch(client, request, attemptTimeoutMs)
          : await client.runWebSearch(request);
        const actualProvider = normalizedProvider(response?.provider ?? provider);
        if (boundedFailover && actualProvider !== provider) {
          throw new Error('web search provider mismatch');
        }
        const evidence = normalizeSources(response?.result, actualProvider, searchedAt, limit);
        if (evidence.sources.length === 0) {
          attempts.push({
            provider,
            status: 'FAILED',
            error: 'web search returned no public sources',
          });
          continue;
        }
        const authorityScore = Math.max(...evidence.sources.map(sourceAuthorityScore));
        const groundedSummary = hasGroundedSummary(evidence, actualProvider, citationOnly);
        if (authorityScore === 0 && (requireAuthoritative || !groundedSummary)) {
          attempts.push({
            provider,
            status: 'FAILED',
            error: requireAuthoritative ? 'web search returned no authoritative evidence' : 'web search returned no authoritative or grounded evidence',
          });
          continue;
        }
        attempts.push({ provider, status: 'COMPLETED', error: null });
        if (authorityScore > 0 || (!requireAuthoritative && (
          (citationOnly.has(actualProvider) && groundedSummary)
          || (['deepseek', 'doubao'].includes(actualProvider)
            && hasSufficientApiSearchEvidence(evidence, limit))))) {
          return normalizeResearchSnapshot({
            schemaVersion: RESEARCH_SCHEMA_VERSION,
            status: 'COMPLETED',
            query: normalizedQuery,
            searchedAt,
            provider: actualProvider,
            summary: evidence.summary,
            attempts,
            sources: evidence.sources,
          });
        }
        const candidate = { actualProvider, evidence, authorityScore };
        if (!bestFallback
          || evidence.sources.length > bestFallback.evidence.sources.length) {
          bestFallback = candidate;
        }
      } catch (error) {
        if (isSearchCancellation(error)) throw error;
        if (orderedProviders.length === 1 && codexErrorCode(error)) throw error;
        unavailableProviders.add(provider);
        attempts.push({ provider, status: 'FAILED', error: redactedError(error) });
      }
    }
  }
  if (bestFallback) {
    return normalizeResearchSnapshot({
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      status: 'COMPLETED',
      query: normalizedQuery,
      searchedAt,
      provider: bestFallback.actualProvider,
      summary: bestFallback.evidence.summary,
      attempts,
      sources: bestFallback.evidence.sources,
    });
  }
  return normalizeResearchSnapshot({
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    status: 'FAILED',
    query: normalizedQuery,
    searchedAt,
    provider: null,
    summary: null,
    attempts,
    sources: [],
  });
}

export function researchSourceUrls(snapshot) {
  const normalized = normalizeResearchSnapshot(snapshot);
  return normalized.sources.map((source) => source.url);
}

export function attachResearchToTask(task, snapshot) {
  const normalized = normalizeResearchSnapshot(snapshot);
  if (normalized.status !== 'COMPLETED') {
    throw new TypeError('only completed research can be attached to a task');
  }
  return {
    ...task,
    input: {
      ...(task?.input ?? {}),
      webResearch: {
        searchedAt: normalized.searchedAt,
        provider: normalized.provider,
        summary: normalized.summary?.slice(0, 2_000) ?? null,
        sources: normalized.sources.map((source) => ({
          ...source,
          title: source.title.slice(0, 200),
          snippet: source.snippet.slice(0, 800),
          siteName: source.siteName.slice(0, 100),
        })),
      },
    },
  };
}
