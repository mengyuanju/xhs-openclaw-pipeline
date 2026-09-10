const XIAOHONGSHU_ORIGIN = 'https://www.xiaohongshu.com';
const NOTE_PATH = /^\/(?:explore|search_result|discovery\/item)\/([a-zA-Z0-9_-]{8,128})\/?$/u;
// Xiaohongshu emits URL-safe base64 tokens with optional trailing padding.
// URLSearchParams decodes `%3D` to `=`, so rejecting padding silently turns a
// signed search-result URL into an unreliable bare note URL.
const XSEC_TOKEN = /^(?=.{1,1024}$)[a-zA-Z0-9_-]+={0,2}$/u;
const XSEC_SOURCE = /^[a-zA-Z0-9_-]{1,100}$/u;

export const XIAOHONGSHU_SEARCH_SETTINGS_KEY = 'xhs_query_search';
export const XIAOHONGSHU_SEARCH_PROTOCOL_VERSION = 3;
export const XIAOHONGSHU_SEARCH_DEFAULT_LIMIT = 3;
export const XIAOHONGSHU_SEARCH_MAX_LIMIT = 10;
export const DEFAULT_XIAOHONGSHU_SEARCH_SETTINGS = Object.freeze({
  resultLimit: XIAOHONGSHU_SEARCH_DEFAULT_LIMIT,
});
export const XIAOHONGSHU_BLOCK_REASONS = Object.freeze([
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
]);

export function normalizeXiaohongshuSearchResultLimit(value) {
  if (!Number.isInteger(value)
      || value < 1
      || value > XIAOHONGSHU_SEARCH_MAX_LIMIT) {
    throw new RangeError(`resultLimit must be an integer from 1 to ${XIAOHONGSHU_SEARCH_MAX_LIMIT}`);
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

export function normalizeXiaohongshuSearchSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Xiaohongshu search settings must be an object');
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'resultLimit')) {
    throw new TypeError('Xiaohongshu search settings contain unsupported fields');
  }
  const resultLimit = input.resultLimit === undefined
    ? XIAOHONGSHU_SEARCH_DEFAULT_LIMIT
    : input.resultLimit;
  return { resultLimit: normalizeXiaohongshuSearchResultLimit(resultLimit) };
}

function normalizedQuery(value) {
  if (typeof value !== 'string') throw new TypeError('query must be a string');
  const query = value.replace(/\s+/gu, ' ').trim();
  if (!query || [...query].length > 500) {
    throw new RangeError('query must contain between 1 and 500 characters');
  }
  return query;
}

function normalizedTitle(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const title = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...title].slice(0, 500).join('');
}

export function parseXiaohongshuLikeCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '赞') return 0;
  const normalized = text.replace(/[\s,，]/gu, '').replace(/\+$/u, '').replace(/赞$/u, '');
  const match = /^(\d+(?:\.\d+)?)(亿|万|千|[wk])?$/iu.exec(normalized);
  if (!match || (!match[2] && match[1].includes('.'))) return null;
  const factor = {
    亿: 100_000_000, 万: 10_000, 千: 1_000, w: 10_000, k: 1_000,
  }[match[2]?.toLowerCase()] ?? 1;
  const count = Math.round(Number(match[1]) * factor);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function rankXiaohongshuCandidatesByLikes(rawCandidates, {
  requireAccessParameters = false,
  limit,
} = {}) {
  if (!Array.isArray(rawCandidates)) return [];
  const candidatesByNoteId = new Map();
  rawCandidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    let link;
    try { link = normalizeXiaohongshuLink(candidate); } catch { return; }
    const likeCount = parseXiaohongshuLikeCount(candidate.likeCount);
    const hasAccessParameters = hasXsecPair(link.url);
    const existing = candidatesByNoteId.get(link.noteId);
    if (!existing) {
      candidatesByNoteId.set(link.noteId, {
        ...link, likeCount, hasAccessParameters, index,
      });
      return;
    }
    if (!existing.hasAccessParameters && hasAccessParameters) {
      existing.url = link.url;
      existing.hasAccessParameters = true;
    }
    if (!existing.title && link.title) existing.title = link.title;
    if (likeCount !== null && (existing.likeCount === null || likeCount > existing.likeCount)) {
      existing.likeCount = likeCount;
    }
  });
  const ranked = [...candidatesByNoteId.values()]
    .filter((candidate) => candidate.likeCount !== null
      && (!requireAccessParameters || candidate.hasAccessParameters))
    .sort((left, right) => right.likeCount - left.likeCount || left.index - right.index)
    .map(({ noteId, url, title, likeCount }) => ({ noteId, url, title, likeCount }));
  if (limit === undefined) return ranked;
  return ranked.slice(0, boundedInteger(limit, 'limit', 1, XIAOHONGSHU_SEARCH_MAX_LIMIT));
}

export function xiaohongshuSearchUrl(rawQuery) {
  const url = new URL('/search_result', XIAOHONGSHU_ORIGIN);
  url.searchParams.set('keyword', normalizedQuery(rawQuery));
  url.searchParams.set('source', 'web_search_result_notes');
  return url.toString();
}

export function normalizeXiaohongshuLink(rawLink) {
  if (!rawLink || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
    throw new TypeError('Xiaohongshu link must be an object');
  }
  const rawUrl = String(rawLink.url ?? '').trim();
  if (!rawUrl || rawUrl.length > 2_048) throw new RangeError('Xiaohongshu URL is invalid');
  const url = new URL(rawUrl, XIAOHONGSHU_ORIGIN);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.xiaohongshu.com'
      || url.port || url.username || url.password) {
    throw new TypeError('Xiaohongshu URL must use https://www.xiaohongshu.com');
  }
  const match = NOTE_PATH.exec(url.pathname);
  if (!match) throw new TypeError('Xiaohongshu URL must point to a note');
  const noteId = match[1];
  if (rawLink.noteId !== undefined && String(rawLink.noteId) !== noteId) {
    throw new TypeError('Xiaohongshu noteId does not match its URL');
  }
  url.hash = '';
  const xsecTokens = url.searchParams.getAll('xsec_token');
  const xsecSources = url.searchParams.getAll('xsec_source');
  url.search = '';
  if (xsecTokens.length === 1 && xsecSources.length === 1
      && XSEC_TOKEN.test(xsecTokens[0]) && XSEC_SOURCE.test(xsecSources[0])) {
    url.searchParams.set('xsec_token', xsecTokens[0]);
    url.searchParams.set('xsec_source', xsecSources[0]);
  }
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > 2_048) throw new RangeError('Xiaohongshu URL is too long');
  return { noteId, url: normalizedUrl, title: normalizedTitle(rawLink.title) };
}

function hasXsecPair(url) {
  const parsed = new URL(url);
  return parsed.searchParams.has('xsec_token') && parsed.searchParams.has('xsec_source');
}

export function normalizeXiaohongshuLinks(rawLinks, {
  limit = XIAOHONGSHU_SEARCH_DEFAULT_LIMIT,
  requireAccessParameters = false,
} = {}) {
  if (!Array.isArray(rawLinks) || rawLinks.length > 100) {
    throw new RangeError('Xiaohongshu links must be an array with at most 100 candidates');
  }
  const maximum = boundedInteger(limit, 'limit', 1, XIAOHONGSHU_SEARCH_MAX_LIMIT);
  const indexesByNoteId = new Map();
  const links = [];
  for (const candidate of rawLinks) {
    let link;
    try { link = normalizeXiaohongshuLink(candidate); } catch { continue; }
    const candidateHasToken = hasXsecPair(link.url);
    if (requireAccessParameters && !candidateHasToken) continue;
    const existingIndex = indexesByNoteId.get(link.noteId);
    if (existingIndex !== undefined) {
      const existing = links[existingIndex];
      const existingHasToken = hasXsecPair(existing.url);
      if (!existingHasToken && candidateHasToken) {
        links[existingIndex] = { ...link, title: link.title ?? existing.title, rank: existing.rank };
      } else if (!existing.title && link.title) {
        links[existingIndex] = { ...existing, title: link.title };
      }
      continue;
    }
    if (links.length >= maximum) continue;
    indexesByNoteId.set(link.noteId, links.length);
    links.push({ ...link, rank: links.length + 1 });
  }
  return links;
}

export class XiaohongshuSearchBlockedError extends Error {
  constructor(reason) {
    if (!XIAOHONGSHU_BLOCK_REASONS.includes(reason)) {
      throw new TypeError('invalid Xiaohongshu search block reason');
    }
    super(reason === 'CAPTCHA_REQUIRED' ? '小红书要求人工完成安全验证' : '小红书账号需要人工登录');
    this.name = 'XiaohongshuSearchBlockedError';
    this.code = reason;
  }
}
