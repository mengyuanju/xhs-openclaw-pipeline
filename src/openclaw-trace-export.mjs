import { isDeepStrictEqual } from 'node:util';

const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|session[_-]?secret|password|password[_-]?hash|private[_-]?key|device[_-]?auth[_-]?token|gateway[_-]?token|encrypted[_-]?content)$/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CHINA_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const CHINA_ID = /(?<!\d)\d{17}[0-9X](?!\d)/giu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function redactString(value, userProfile) {
  let redacted = value;
  if (userProfile) {
    redacted = redacted.replace(new RegExp(escapeRegExp(userProfile), 'giu'), '%USERPROFILE%');
  }
  return redacted
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/giu, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b((?:XHS_SESSION_SECRET|OPENAI_API_KEY|OPENCLAW_GATEWAY_TOKEN)\s*[:=]\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(CHINA_PHONE, '[REDACTED_PHONE]')
    .replace(CHINA_ID, '[REDACTED_ID]');
}

export function redactSensitive(value, { userProfile = process.env.USERPROFILE } = {}) {
  if (typeof value === 'string') return redactString(value, userProfile);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, { userProfile }));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_FIELD.test(key)
      ? '[REDACTED]'
      : redactSensitive(item, { userProfile }),
  ]));
}

function jsonEquivalent(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.trim() === right.trim()) return true;
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

export function matchSessionsToPhases({ generation, sessions }) {
  if (!generation) return [];
  const available = new Set(sessions.map((_session, index) => index));
  const specifications = [
    ['query_review', 'query_review_ms', 'query_review_json'],
    ['research', 'research_ms', null],
    ['original_generation', 'original_generation_ms', 'original_post_json'],
    ['original_review', 'original_review_ms', 'original_text_review_json'],
    ['reviewed_generation', 'reviewed_generation_ms', 'reviewed_post_json'],
    ['reviewed_review', 'reviewed_review_ms', 'reviewed_text_review_json'],
  ];

  return specifications.flatMap(([phase, durationField, responseField]) => {
    const durationMs = Number(generation[durationField]);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
    if (phase === 'research') {
      return [{
        phase,
        durationMs,
        sessionId: null,
        persistedAt: 'business_snapshot_only',
      }];
    }

    const sessionIndex = [...available].find((index) =>
      jsonEquivalent(sessions[index].assistantText, generation[responseField]));
    const session = sessionIndex === undefined ? null : sessions[sessionIndex];
    if (sessionIndex !== undefined) available.delete(sessionIndex);
    return [{
      phase,
      durationMs,
      sessionId: session?.sessionId ?? null,
      persistedAt: session ? 'openclaw_session' : 'missing',
    }];
  });
}

export function summarizeUsage(sessions) {
  const summary = {
    sessions: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  for (const session of sessions) {
    if (!session?.usage || typeof session.usage !== 'object') continue;
    summary.sessions += 1;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      const value = Number(session.usage[key]);
      if (Number.isFinite(value)) summary[key] += value;
    }
  }
  return summary;
}
