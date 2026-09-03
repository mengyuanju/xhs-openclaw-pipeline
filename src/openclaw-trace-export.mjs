import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|session[_-]?secret|password|password[_-]?hash|private[_-]?key|device[_-]?auth[_-]?token|gateway[_-]?token|encrypted[_-]?content)$/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const JWT = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/gu;
const CHINA_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const CHINA_ID = /(?<!\d)\d{17}[0-9X](?!\d)/giu;

export class OpenClawTraceNotFoundError extends Error {
  constructor() {
    super('standalone copy generation job was not found');
    this.name = 'OpenClawTraceNotFoundError';
  }
}

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
    .replace(JWT, '[REDACTED_JWT]')
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
    const parsedLeft = JSON.parse(left);
    const parsedRight = JSON.parse(right);
    return isDeepStrictEqual(parsedLeft, parsedRight)
      || jsonSubset(parsedLeft, parsedRight)
      || jsonSubset(parsedRight, parsedLeft);
  } catch {
    return false;
  }
}

function jsonSubset(subset, superset) {
  if (isDeepStrictEqual(subset, superset)) return true;
  if (Array.isArray(subset) || Array.isArray(superset)) {
    return Array.isArray(subset) && Array.isArray(superset)
      && subset.length === superset.length
      && subset.every((item, index) => jsonSubset(item, superset[index]));
  }
  if (!subset || !superset || typeof subset !== 'object' || typeof superset !== 'object') {
    return false;
  }
  return Object.entries(subset).every(([key, value]) =>
    Object.hasOwn(superset, key) && jsonSubset(value, superset[key]));
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

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceDescriptor(path) {
  const stats = statSync(path);
  return {
    path: resolve(path),
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    sha256: sha256File(path),
  };
}

function databaseSources(path) {
  return [path, `${path}-wal`, `${path}-shm`]
    .filter((candidate) => existsSync(/* turbopackIgnore: true */ candidate))
    .map(sourceDescriptor);
}

function parseJsonLines(path) {
  const content = readFileSync(path, 'utf8');
  if (content.trim() === '') return [];
  return content.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [{
        type: 'parse_error',
        lineNumber: index + 1,
        bytes: Buffer.byteLength(line, 'utf8'),
        sha256: createHash('sha256').update(line).digest('hex'),
      }];
    }
  });
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    if (typeof item?.content === 'string') return item.content;
    return '';
  }).filter(Boolean).join('\n');
}

function elapsedMs(startedAt, finishedAt) {
  const startMs = Date.parse(startedAt ?? '');
  const finishMs = Date.parse(finishedAt ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return null;
  return finishMs - startMs;
}

function sessionFromRecords({ records, trajectory, sessionId, sources, metadata = {} }) {
  const sessionRecord = records.find((row) => row?.type === 'session') ?? null;
  const messages = records.filter((row) => row?.type === 'message');
  const userMessage = messages.find((row) => row?.message?.role === 'user')?.message ?? null;
  const assistantMessage = [...messages].reverse()
    .find((row) => row?.message?.role === 'assistant')?.message ?? null;
  const started = trajectory.find((row) => row?.type === 'session.started') ?? null;
  const completed = [...trajectory].reverse().find((row) => row?.type === 'model.completed') ?? null;
  const ended = [...trajectory].reverse().find((row) => row?.type === 'session.ended') ?? null;
  const startedAt = started?.ts ?? metadata.startedAt
    ?? sessionRecord?.timestamp ?? messages[0]?.timestamp ?? null;
  const endedAt = ended?.ts ?? completed?.ts ?? metadata.endedAt
    ?? messages.at(-1)?.timestamp ?? null;

  return {
    sessionId,
    startedAt,
    endedAt,
    durationMs: elapsedMs(startedAt, endedAt),
    runId: started?.runId ?? completed?.runId ?? null,
    threadId: started?.data?.threadId ?? completed?.data?.threadId ?? null,
    turnId: completed?.data?.turnId ?? ended?.data?.turnId ?? null,
    provider: assistantMessage?.provider ?? started?.provider ?? metadata.provider ?? null,
    model: assistantMessage?.model ?? started?.modelId ?? metadata.model ?? null,
    modelApi: assistantMessage?.api ?? started?.modelApi ?? null,
    usage: assistantMessage?.usage ?? completed?.data?.usage ?? null,
    stopReason: assistantMessage?.stopReason ?? null,
    userText: messageText(userMessage),
    assistantText: messageText(assistantMessage),
    records,
    trajectory,
    sources,
  };
}

function readSession(path) {
  const records = parseJsonLines(path);
  const sessionRecord = records.find((row) => row?.type === 'session') ?? null;
  const trajectoryPath = path.replace(/\.jsonl$/u, '.trajectory.jsonl');
  const trajectory = existsSync(trajectoryPath) ? parseJsonLines(trajectoryPath) : [];
  return sessionFromRecords({
    records,
    trajectory,
    sessionId: String(sessionRecord?.id ?? basename(path, '.jsonl')),
    sources: [
      sourceDescriptor(path),
      ...(existsSync(trajectoryPath) ? [sourceDescriptor(trajectoryPath)] : []),
    ],
  });
}

function parseStoredJsonRows(rows) {
  return rows.map((row) => {
    try {
      return JSON.parse(row.event_json);
    } catch {
      return {
        type: 'parse_error',
        sequence: row.seq,
        bytes: Buffer.byteLength(String(row.event_json ?? ''), 'utf8'),
        sha256: createHash('sha256').update(String(row.event_json ?? '')).digest('hex'),
      };
    }
  });
}

function isoTimestamp(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readSqliteSessions(path, { startMs, finishMs }) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!tableExists(db, 'session_windows')
      || !tableExists(db, 'transcript_events')) return [];
    const transcript = db.prepare(`
      SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq
    `);
    const trajectory = tableExists(db, 'trajectory_runtime_events')
      ? db.prepare(`
        SELECT seq, event_json FROM trajectory_runtime_events WHERE session_id = ? ORDER BY seq
      `)
      : null;
    const sources = databaseSources(path);
    return db.prepare(`
      SELECT session_id, started_at, ended_at, created_at, updated_at, model_provider, model
      FROM session_windows
      WHERE session_id LIKE 'xhs-%'
        AND COALESCE(started_at, created_at) >= ?
        AND COALESCE(started_at, created_at) <= ?
      ORDER BY COALESCE(started_at, created_at)
    `).all(
      Number.isFinite(startMs) ? startMs - 2_000 : Number.MIN_SAFE_INTEGER,
      Number.isFinite(finishMs) ? finishMs + 2_000 : Number.MAX_SAFE_INTEGER,
    ).map((row) => sessionFromRecords({
      records: parseStoredJsonRows(transcript.all(row.session_id)),
      trajectory: trajectory ? parseStoredJsonRows(trajectory.all(row.session_id)) : [],
      sessionId: String(row.session_id),
      sources,
      metadata: {
        startedAt: isoTimestamp(row.started_at ?? row.created_at),
        endedAt: isoTimestamp(row.ended_at ?? row.updated_at),
        provider: row.model_provider,
        model: row.model,
      },
    }));
  } finally {
    db.close();
  }
}

function sessionsForWindow({ openClawRoot, startedAt, finishedAt, query }) {
  const startMs = Date.parse(startedAt ?? '');
  const finishMs = Date.parse(finishedAt ?? '');
  const sessionRoot = join(openClawRoot, 'agents', 'main', 'sessions');
  const legacySessions = existsSync(sessionRoot)
    ? readdirSync(sessionRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && /^xhs-[a-z0-9-]+\.jsonl$/u.test(entry.name)
        && !entry.name.endsWith('.trajectory.jsonl'))
      .map((entry) => readSession(join(sessionRoot, entry.name)))
    : [];
  const agentDatabasePath = join(
    openClawRoot,
    'agents',
    'main',
    'agent',
    'openclaw-agent.sqlite',
  );
  const sessions = [...new Map([
    ...legacySessions,
    ...readSqliteSessions(agentDatabasePath, { startMs, finishMs }),
  ].map((session) => [session.sessionId, session])).values()];
  const candidates = sessions.filter((session) => {
      const sessionMs = Date.parse(session.startedAt ?? '');
      return Number.isFinite(sessionMs)
        && (!Number.isFinite(startMs) || sessionMs >= startMs - 2_000)
        && (!Number.isFinite(finishMs) || sessionMs <= finishMs + 2_000);
    })
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const queryMatches = candidates.filter((session) => session.userText.includes(query));
  return queryMatches.length > 0 ? queryMatches : candidates;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function parseJsonColumns(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!key.endsWith('_json') || typeof value !== 'string') return [key, value];
    try {
      return [key, JSON.parse(value)];
    } catch {
      return [key, {
        parseError: true,
        bytes: Buffer.byteLength(value, 'utf8'),
        sha256: createHash('sha256').update(value).digest('hex'),
      }];
    }
  }));
}

/**
 * @param {{ databasePath: string; limit?: number }} options
 */
export function listOpenClawCodexTraceJobs({ databasePath, limit = 20 }) {
  if (typeof databasePath !== 'string' || !existsSync(databasePath)) {
    throw new TypeError('databasePath must point to an existing SQLite database');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('limit must be an integer between 1 and 50');
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(db, 'standalone_copy_generation_jobs')) return [];
    return db.prepare(`
      SELECT id, query, status, generation_id, created_at, finished_at
      FROM standalone_copy_generation_jobs
      WHERE status = 'COMPLETED' AND generation_id IS NOT NULL
      ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({
      id: Number(row.id),
      query: row.query,
      status: row.status,
      generationId: Number(row.generation_id),
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }));
  } finally {
    db.close();
  }
}

function readBusinessRecords(databasePath, jobId) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(db, 'standalone_copy_generation_jobs')) {
      throw new Error('standalone copy generation jobs table is missing');
    }
    const rawJob = jobId === null || jobId === undefined
      ? db.prepare('SELECT * FROM standalone_copy_generation_jobs ORDER BY id DESC LIMIT 1').get()
      : db.prepare('SELECT * FROM standalone_copy_generation_jobs WHERE id = ?').get(jobId);
    if (!rawJob) throw new OpenClawTraceNotFoundError();
    const rawGeneration = rawJob.generation_id === null || rawJob.generation_id === undefined
      ? null
      : db.prepare('SELECT * FROM standalone_copy_generations WHERE id = ?').get(rawJob.generation_id);
    return {
      rawJob,
      rawGeneration,
      job: parseJsonColumns(rawJob),
      generation: parseJsonColumns(rawGeneration),
    };
  } finally {
    db.close();
  }
}

const AUDIT_COLUMNS = [
  'sequence',
  'event_id',
  'source_id',
  'source_sequence',
  'occurred_at',
  'kind',
  'action',
  'status',
  'error_code',
  'actor_type',
  'actor_id',
  'agent_id',
  'session_key',
  'session_id',
  'run_id',
  'tool_call_id',
  'tool_name',
];

function readOpenClawAudit({ statePath, startedAt, finishedAt }) {
  if (!existsSync(statePath)) return { events: [], captureEvents: 0, captureSessions: 0 };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const startedAtMs = Date.parse(startedAt);
    const finishedAtMs = Date.parse(finishedAt);
    const events = tableExists(db, 'audit_events')
      ? db.prepare(`
          SELECT ${AUDIT_COLUMNS.join(', ')} FROM audit_events
          WHERE (typeof(occurred_at) IN ('integer', 'real') AND occurred_at >= ? AND occurred_at <= ?)
             OR (typeof(occurred_at) = 'text' AND occurred_at >= ? AND occurred_at <= ?)
          ORDER BY sequence
        `).all(startedAtMs, finishedAtMs, startedAt, finishedAt)
      : [];
    const count = (table) => tableExists(db, table)
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
      : 0;
    return {
      events,
      captureEvents: count('capture_events'),
      captureSessions: count('capture_sessions'),
    };
  } finally {
    db.close();
  }
}

function readCodexThreads({ codexHome, sessions }) {
  const statePath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(statePath)) return { threads: [], sources: [] };
  const db = new DatabaseSync(statePath, { readOnly: true });
  const sources = databaseSources(statePath);
  let threads = [];
  try {
    if (tableExists(db, 'threads')) {
      threads = [...new Set(sessions.map((session) => session.threadId).filter(Boolean))]
        .map((threadId) => db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId))
        .filter(Boolean)
        .map((thread) => {
          const rolloutPath = thread.rollout_path;
          const hasRollout = typeof rolloutPath === 'string' && existsSync(rolloutPath);
          if (hasRollout) sources.push(sourceDescriptor(rolloutPath));
          return {
            thread,
            records: hasRollout ? parseJsonLines(rolloutPath) : [],
            logs: [],
          };
        });
    }
  } finally {
    db.close();
  }

  const logsPath = join(codexHome, 'logs_2.sqlite');
  if (existsSync(logsPath) && threads.length > 0) {
    sources.push(...databaseSources(logsPath));
    const logsDb = new DatabaseSync(logsPath, { readOnly: true });
    try {
      if (tableExists(logsDb, 'logs')) {
        const getLogs = logsDb.prepare('SELECT * FROM logs WHERE thread_id = ? ORDER BY id');
        for (const record of threads) record.logs = getLogs.all(record.thread.id);
      }
    } finally {
      logsDb.close();
    }
  }
  return { threads, sources };
}

function uniqueSources(sources) {
  return [...new Map(sources.map((source) => [source.path, source])).values()];
}

function enrichPhases(phases, sessions, generation) {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  return phases.map((phase) => {
    const session = byId.get(phase.sessionId) ?? null;
    const research = phase.phase === 'research' ? generation?.research_snapshot_json ?? null : null;
    return {
      ...phase,
      startedAt: session?.startedAt ?? research?.searchedAt ?? null,
      finishedAt: session?.endedAt ?? null,
      observedSessionDurationMs: session?.durationMs ?? null,
      openclawRunId: session?.runId ?? null,
      codexThreadId: session?.threadId ?? null,
      codexTurnId: session?.turnId ?? null,
      provider: session?.provider ?? research?.provider ?? null,
      model: session?.model ?? null,
      modelApi: session?.modelApi ?? null,
      usage: session?.usage ?? null,
      sourceCount: Array.isArray(research?.sources) ? research.sources.length : null,
    };
  });
}

/**
 * @param {{
 *   databasePath: string;
 *   openClawRoot: string;
 *   jobId?: number | null;
 *   capturedAt?: string;
 *   userProfile?: string;
 * }} options
 */
export function collectOpenClawCodexTrace({
  databasePath,
  openClawRoot,
  jobId = null,
  capturedAt = new Date().toISOString(),
  userProfile = process.env.USERPROFILE,
}) {
  if (typeof databasePath !== 'string' || !existsSync(databasePath)) {
    throw new TypeError('databasePath must point to an existing SQLite database');
  }
  if (typeof openClawRoot !== 'string' || !existsSync(openClawRoot)) {
    throw new TypeError('openClawRoot must point to an existing OpenClaw home');
  }
  if (jobId !== null && (!Number.isInteger(jobId) || jobId < 1)) {
    throw new TypeError('jobId must be a positive integer');
  }

  const business = readBusinessRecords(databasePath, jobId);
  const finishedAt = business.rawJob.finished_at ?? capturedAt;
  const sessions = sessionsForWindow({
    openClawRoot,
    startedAt: business.rawJob.created_at,
    finishedAt,
    query: business.rawJob.query,
  });
  const phases = matchSessionsToPhases({
    generation: business.rawGeneration,
    sessions,
  });
  const matchedSessionIds = new Set(phases.map((phase) => phase.sessionId).filter(Boolean));
  const matchedSessions = sessions.filter((session) => matchedSessionIds.has(session.sessionId));
  const openClawStatePath = join(openClawRoot, 'state', 'openclaw.sqlite');
  const audit = readOpenClawAudit({
    statePath: openClawStatePath,
    startedAt: business.rawJob.created_at,
    finishedAt,
  });
  const codexHome = join(openClawRoot, 'agents', 'main', 'agent', 'codex-home');
  const codex = readCodexThreads({ codexHome, sessions: matchedSessions });
  const sources = uniqueSources([
    ...databaseSources(databasePath),
    ...(existsSync(openClawStatePath) ? databaseSources(openClawStatePath) : []),
    ...matchedSessions.flatMap((session) => session.sources),
    ...codex.sources,
  ]);
  const sessionPhases = phases.filter((phase) => phase.phase !== 'research');
  const allSessionPhasesCaptured = sessionPhases.length > 0
    && sessionPhases.every((phase) => phase.persistedAt === 'openclaw_session');
  const allTrajectoriesCaptured = allSessionPhasesCaptured
    && matchedSessions.every((session) => session.trajectory.length > 0);
  const auditedSessionIds = new Set(audit.events.map((event) => event.session_id).filter(Boolean));
  const allSessionsAudited = allSessionPhasesCaptured
    && matchedSessions.every((session) => auditedSessionIds.has(session.sessionId));
  const codexThreadsById = new Map(codex.threads.map((record) => [record.thread.id, record]));
  const allCodexRolloutsCaptured = allSessionPhasesCaptured
    && matchedSessions.every((session) => {
      const thread = codexThreadsById.get(session.threadId);
      return thread && thread.records.length > 0;
    });

  const report = {
    schemaVersion: 1,
    capturedAt,
    scope: {
      kind: 'standalone_copy_generation_job',
      jobId: Number(business.rawJob.id),
    },
    business: {
      job: business.job,
      generation: business.generation,
    },
    chain: {
      startedAt: business.rawJob.created_at,
      finishedAt,
      durationMs: elapsedMs(business.rawJob.created_at, finishedAt),
      phases: enrichPhases(phases, matchedSessions, business.generation),
      usage: summarizeUsage(matchedSessions),
    },
    openclaw: {
      sessions: matchedSessions.map(({ sources: _sources, ...session }) => session),
      auditEvents: audit.events,
    },
    codex: {
      threads: codex.threads,
    },
    coverage: {
      business: {
        requestAndResult: true,
        phaseTimings: business.rawGeneration?.total_ms !== null
          && business.rawGeneration?.total_ms !== undefined,
      },
      openclaw: {
        sessionMessages: allSessionPhasesCaptured,
        trajectories: allTrajectoriesCaptured,
        auditEvents: allSessionsAudited,
      },
      codex: {
        rollouts: allCodexRolloutsCaptured,
      },
      research: {
        businessSnapshot: Boolean(business.rawGeneration?.research_snapshot_json),
        rawCapabilityEnvelope: false,
        tokenUsage: false,
      },
      network: {
        rawHttpCapture: audit.captureEvents > 0,
        captureEventCount: audit.captureEvents,
        captureSessionCount: audit.captureSessions,
      },
    },
    sources,
  };
  return redactSensitive(report, { userProfile });
}

function markdownCell(value) {
  return String(value ?? '—').replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
}

function traceSummary(report) {
  const lines = [
    '# OpenClaw → Codex 全链路导出',
    '',
    `- job #${report.business.job.id}：${report.business.job.status}`,
    `- Query：${report.business.job.query}`,
    `- 采集时间：${report.capturedAt}`,
    `- 业务总耗时：${report.chain.durationMs ?? '未知'}ms`,
    '',
    '| 阶段 | 业务耗时 | OpenClaw session | Codex thread | Token |',
    '| --- | ---: | --- | --- | ---: |',
    ...report.chain.phases.map((phase) => `| ${markdownCell(phase.phase)} | ${markdownCell(phase.durationMs)}ms | ${markdownCell(phase.sessionId)} | ${markdownCell(phase.codexThreadId)} | ${markdownCell(phase.usage?.totalTokens)} |`),
    '',
    `Token 合计：${report.chain.usage.totalTokens}（input ${report.chain.usage.input} / output ${report.chain.usage.output} / cacheRead ${report.chain.usage.cacheRead}）`,
    '',
    '## 覆盖与断点',
    '',
    `- 业务请求、结果和阶段耗时：${report.coverage.business.requestAndResult ? '已采集' : '缺失'}`,
    `- OpenClaw 会话与 trajectory：${report.coverage.openclaw.sessionMessages && report.coverage.openclaw.trajectories ? '已采集' : '不完整'}`,
    `- Codex rollout：${report.coverage.codex.rollouts ? '已采集' : '不完整'}`,
    `- 研究原始 capability envelope：${report.coverage.research.rawCapabilityEnvelope ? '已采集' : '未持久化；仅有业务研究快照'}`,
    `- 原始 HTTP 报文：${report.coverage.network.rawHttpCapture ? '已采集' : '未启用 capture'}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function writeOpenClawCodexTrace({ report, outputRoot }) {
  if (!report?.business?.job?.id) throw new TypeError('report is invalid');
  if (typeof outputRoot !== 'string' || outputRoot.trim() === '') {
    throw new TypeError('outputRoot must be a non-empty path');
  }
  const timestamp = String(report.capturedAt).replace(/[:.]/gu, '-');
  const outputDirectory = resolve(outputRoot, `openclaw-codex-trace-job-${report.business.job.id}-${timestamp}`);
  mkdirSync(outputDirectory, { recursive: true });
  const jsonPath = join(outputDirectory, 'trace.json');
  const summaryPath = join(outputDirectory, 'summary.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(summaryPath, traceSummary(report), 'utf8');
  return { outputDirectory, jsonPath, summaryPath };
}
