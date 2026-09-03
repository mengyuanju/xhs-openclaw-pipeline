import { isIP } from 'node:net';

const RESEARCH_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDERS = ['codex'];
const MAX_SOURCES = 5;
const MAX_ATTEMPTS = 5;

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
    hostname = new URL(source?.url).hostname.toLowerCase();
  } catch {
    return 0;
  }
  if (/(?:^|\.)gov(?:\.|$)/u.test(hostname)) return 3;
  if (/(?:^|\.)edu(?:\.|$)/u.test(hostname)) return 2;
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
    if (Array.isArray(result?.[key])) items.push(...result[key]);
  }
  if (Array.isArray(result?.searches)) items.push(...result.searches);
  return items;
}

function normalizeSources(result, provider, retrievedAt) {
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
  for (const url of urlsFromText(summary)) candidates.push({ url });

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
    if (sources.length === MAX_SOURCES) break;
  }
  sources.sort((left, right) => sourceAuthorityScore(right) - sourceAuthorityScore(left));
  return { summary: summary || null, sources };
}

function hasGroundedSummary(evidence, provider) {
  // Codex Hosted Search returns a synthesized answer with citation URLs, but its
  // citation records do not include per-source snippets.
  return Boolean(evidence?.summary
    && evidence.sources.length > 0
    && (provider === 'codex'
      || evidence.sources.some((source) => typeof source.snippet === 'string' && source.snippet)));
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
  providers = DEFAULT_PROVIDERS,
  limit = MAX_SOURCES,
  now = () => new Date().toISOString(),
}) {
  if (!client?.runWebSearch) throw new TypeError('OpenClaw web search client is required');
  const normalizedQuery = String(query ?? '').replace(/\s+/gu, ' ').trim().slice(0, 500);
  if (!normalizedQuery) throw new RangeError('research query is required');
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 5) {
    throw new RangeError('research providers are invalid');
  }
  const searchedAt = normalizedTimestamp(now(), 'research searchedAt');
  const attempts = [];
  const unavailableProviders = new Set();
  const authorityQuery = `${normalizedQuery} 官方 标准 技术规范`.slice(0, 500);
  const queryVariants = [...new Set([normalizedQuery, authorityQuery])];
  let bestFallback = null;
  searchLoop:
  for (const searchQuery of queryVariants) {
    for (const rawProvider of providers) {
      if (attempts.length >= MAX_ATTEMPTS) break searchLoop;
      const provider = normalizedProvider(rawProvider);
      if (unavailableProviders.has(provider)) continue;
      try {
        const response = await client.runWebSearch({ query: searchQuery, provider, limit });
        const actualProvider = normalizedProvider(response?.provider ?? provider);
        const evidence = normalizeSources(response?.result, actualProvider, searchedAt);
        if (evidence.sources.length === 0) {
          attempts.push({
            provider,
            status: 'FAILED',
            error: 'web search returned no public sources',
          });
          continue;
        }
        const authorityScore = Math.max(...evidence.sources.map(sourceAuthorityScore));
        const groundedSummary = hasGroundedSummary(evidence, actualProvider);
        if (authorityScore === 0 && !groundedSummary) {
          attempts.push({
            provider,
            status: 'FAILED',
            error: 'web search returned no authoritative or grounded evidence',
          });
          continue;
        }
        attempts.push({ provider, status: 'COMPLETED', error: null });
        if (authorityScore > 0 || (actualProvider === 'codex' && groundedSummary)) {
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
