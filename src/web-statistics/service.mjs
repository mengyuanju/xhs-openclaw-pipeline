import { ApiError } from '../admin/http.mjs';
import { compactDetail, compactTask, normalizeRange, summarizeCounts, summarizeEfficiency } from './summary.mjs';
import { createReadScheduler } from './read-scheduler.mjs';

const PAGE_SIZE = 200;
const COUNTS_TTL = 60_000;
const DETAIL_TTL = 300_000;
const RETRY_DELAY = 30_000;
const DETAIL_CONCURRENCY = 8;
const DETAIL_BATCH_SIZE = 32;
const identity = task => JSON.stringify([task.state, task.currentImageRunId, task.currentCopyRevisionId]);
const signature = task => JSON.stringify([identity(task), task.updatedAt]);
const timestamp = value => value ? Date.parse(value) : NaN;

function actorFrom(session) {
  const role = session?.roles?.[0];
  const username = session?.username || (session?.subject === 'admin' ? 'admin' : '');
  const userId = Number(session?.userId);
  if (!Number.isSafeInteger(userId) || userId < 1 || !username
    || !['USER', 'REVIEWER', 'ADMIN'].includes(role)) {
    throw new ApiError(403, 'FORBIDDEN', '当前账号不能访问作业统计');
  }
  return { userId, username, role, version: Number(session.credentialVersion) || 1 };
}

function freshEntry() {
  return { rows: null, updatedAt: 0, scan: null, countsFlight: null, detailFlight: null,
    identityFlight: null, error: null, nextRetry: 0, lastTouched: 0,
    details: new Map(), detailErrors: new Map() };
}

export function createStatisticsService({ fetchImpl = fetch, now = Date.now, sleep,
  maxTasks = 20_000, maxScopes = 12, detailConcurrency = DETAIL_CONCURRENCY,
  detailBatchSize = DETAIL_BATCH_SIZE } = {}) {
  const entries = new Map();
  const scheduleCounts = createReadScheduler({ now, sleep });
  const scheduleDetails = createReadScheduler({ now, sleep, intervalMs: 0, maxConcurrent: detailConcurrency,
    maxQueued: detailBatchSize, maxWaitMs: 30_000 });

  async function request(root, actor, path, schedule = scheduleCounts) {
    return schedule(async () => {
      let response;
      try {
        response = await fetchImpl(`${root.replace(/\/$/u, '')}${path}`, {
          method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(8000),
          headers: { 'X-Actor-User-Id': String(actor.userId),
            'X-Actor-Username': actor.username, 'X-Actor-Role': actor.role,
            'X-Actor-Credential-Version': String(actor.version) },
        });
      } catch { throw new Error('中心暂时不可用，保留上次完整统计'); }
      if ([401, 403].includes(response.status)) throw new ApiError(response.status, 'STATISTICS_ACCESS_DENIED', '账号权限已变化，请重新登录');
      if (!response.ok) throw new Error('统计读取失败，稍后可重试');
      const payload = await response.json();
      if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('中心统计数据格式不完整');
      return payload.data;
    });
  }

  function entryFor(key) {
    if (!entries.has(key)) {
      if (entries.size >= maxScopes) {
        const oldest = [...entries].filter(([, entry]) => !entry.countsFlight && !entry.detailFlight)
          .sort((a, b) => a[1].lastTouched - b[1].lastTouched)[0];
        if (!oldest) throw new ApiError(503, 'STATISTICS_BUSY', '统计读取繁忙，请稍后重试');
        entries.delete(oldest[0]);
      }
      entries.set(key, freshEntry());
    }
    const entry = entries.get(key);
    entry.lastTouched = now();
    return entry;
  }

  function fail(entry, error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      Object.assign(entry, freshEntry());
      throw error;
    }
    entry.error = error.code === 'STATISTICS_TOO_LARGE'
      ? `统计未完整：当前范围超过 ${maxTasks.toLocaleString('zh-CN')} 项读取上限，需要另行规划大规模报表。`
      : '统计未完整：中心暂不可用或分页数据正在变化，请稍后刷新。';
    entry.nextRetry = now() + RETRY_DELAY;
    entry.scan = null;
  }

  async function validateCachedIdentity(entry, root, actor) {
    if (!entry.identityFlight) {
      entry.identityFlight = request(root, actor, '/v1/profile', action => action());
    }
    try {
      await entry.identityFlight;
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) fail(entry, error);
      throw new ApiError(503, 'STATISTICS_IDENTITY_UNVERIFIED', '暂时无法确认账号状态，请稍后重试');
    } finally {
      entry.identityFlight = null;
    }
  }

  async function advanceCounts(entry, root, actor, scope) {
    if (entry.countsFlight) return entry.countsFlight;
    entry.countsFlight = (async () => {
      try {
        entry.scan ??= { rows: new Map(), offset: 0, total: null, restarts: 0 };
        const scan = entry.scan;
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(scan.offset), includeTotal: 'true' });
        if (scope === 'personal') query.set('assignedToUserId', actor.username);
        const page = await request(root, actor, `/v1/tasks?${query}`);
        if (page?.total > maxTasks) throw Object.assign(new Error('统计范围过大'), { code: 'STATISTICS_TOO_LARGE' });
        if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0
          || page.total > maxTasks || page.offset !== scan.offset || page.items.length > PAGE_SIZE) {
          throw new Error('任务分页无法完整统计');
        }
        const rows = page.items.map(compactTask);
        if (scope === 'personal' && rows.some(task => task.assignedToUserId !== actor.username)) {
          throw new ApiError(403, 'STATISTICS_ACCESS_DENIED', '中心未正确隔离个人任务');
        }
        const changed = scan.total !== null && page.total !== scan.total;
        const duplicate = rows.some(task => scan.rows.has(task.id)) || new Set(rows.map(task => task.id)).size !== rows.length;
        if (changed || duplicate) {
          if (scan.restarts >= 2) throw new Error('任务分页持续变化');
          entry.scan = { rows: new Map(), offset: 0, total: null, restarts: scan.restarts + 1 };
          return;
        }
        scan.total = page.total;
        for (const task of rows) scan.rows.set(task.id, task);
        scan.offset += rows.length;
        if (scan.offset < scan.total && rows.length === 0) throw new Error('任务分页缺失');
        if (scan.offset >= scan.total) {
          if (scan.rows.size !== scan.total) throw new Error('任务分页数量不一致');
          entry.rows = [...scan.rows.values()];
          entry.updatedAt = now();
          entry.scan = null;
          entry.error = null;
          entry.nextRetry = 0;
          const ids = new Set(entry.rows.map(task => task.id));
          for (const id of entry.details.keys()) if (!ids.has(id)) entry.details.delete(id);
          for (const id of entry.detailErrors.keys()) if (!ids.has(id)) entry.detailErrors.delete(id);
        }
      } catch (error) { fail(entry, error); }
    })();
    try { await entry.countsFlight; } finally { entry.countsFlight = null; }
  }

  function reusable(entry, task) {
    const cached = entry.details.get(task.id);
    return cached && (cached.signature === signature(task)
      || (cached.identity === identity(task) && now() - cached.readAt < DETAIL_TTL));
  }

  async function advanceDetails(entry, root, actor, candidates) {
    if (entry.detailFlight) return entry.detailFlight;
    const batch = candidates.filter(task => !reusable(entry, task)
      && (entry.detailErrors.get(task.id)?.retryAt ?? 0) <= now()).slice(0, detailBatchSize);
    if (!batch.length) return;
    entry.detailFlight = (async () => {
      let accessError = null;
      await Promise.all(batch.map(async task => {
        try {
          const detail = await request(root, actor, `/v1/tasks/${task.id}`, scheduleDetails);
          if (detail?.id !== task.id) throw new Error('任务明细不匹配');
          entry.details.set(task.id, { signature: signature(task), identity: identity(task), readAt: now(), value: compactDetail(detail) });
          entry.detailErrors.delete(task.id);
        } catch (error) {
          if (error instanceof ApiError && [401, 403].includes(error.status)) accessError ??= error;
          else entry.detailErrors.set(task.id, { retryAt: now() + RETRY_DELAY });
        }
      }));
      if (accessError) fail(entry, accessError);
    })();
    try { await entry.detailFlight; } finally { entry.detailFlight = null; }
  }

  return {
    async read({ root, session, scope = 'personal', period = 'today', from, to, username = '',
      createdByAccountId = null, role = '', details = false, refresh = false }) {
      const actor = actorFrom(session);
      if (!['personal', 'admin'].includes(scope)) throw new ApiError(400, 'INVALID_INPUT', '统计范围无效');
      if ((scope === 'admin' || details) && actor.role !== 'ADMIN') throw new ApiError(403, 'FORBIDDEN', '仅管理员可以查看团队和效率统计');
      if (details && scope !== 'admin') throw new ApiError(400, 'INVALID_INPUT', '个人统计不提供执行明细');
      const accountFilter = createdByAccountId === null || createdByAccountId === undefined
        ? null : Number(createdByAccountId);
      const accountFilterInvalid = accountFilter !== null
        && (!Number.isSafeInteger(accountFilter) || accountFilter < 1);
      const accountFilterMismatched = Boolean(username && username !== '__unassigned__') !== (accountFilter !== null);
      if (accountFilterInvalid || scope === 'admin' && accountFilterMismatched) {
        throw new ApiError(400, 'INVALID_INPUT', '作业员筛选缺少稳定账号身份，请重新选择作业员');
      }
      if (!root) throw new ApiError(503, 'CONTROL_PLANE_NOT_CONFIGURED', '请先配置中心服务');
      let range;
      try { range = normalizeRange({ period, from, to }, now()); } catch (error) { throw new ApiError(400, 'INVALID_INPUT', error.message); }
      const key = JSON.stringify([root, actor.userId, actor.username, actor.role, actor.version, scope]);
      const entry = entryFor(key);
      const forceDue = refresh && now() - entry.updatedAt >= 15_000;
      const countsDue = entry.scan || !entry.rows || now() - entry.updatedAt >= COUNTS_TTL || forceDue;
      const refreshCounts = countsDue && now() >= entry.nextRetry;
      if (entry.rows) await validateCachedIdentity(entry, root, actor);
      if (refreshCounts) await advanceCounts(entry, root, actor, scope);
      const rows = entry.rows ?? [];
      const filtered = scope === 'personal' ? rows : rows.filter(task => (!username || (username === '__unassigned__'
        ? task.createdByUserId === null
        : task.createdByUserId === username && task.createdByAccountId === accountFilter)) && (!role || task.createdByRole === role));
      const allSummary = entry.rows ? summarizeCounts(rows, range, now()) : null;
      const summary = !entry.rows ? null : scope === 'admin' && (username || role) ? summarizeCounts(filtered, range, now()) : allSummary;
      const creators = scope === 'admin' && allSummary ? allSummary.people
        .filter(person => person.accountId !== null || person.username === null)
        .map(person => ({ accountId: person.accountId,
          username: person.username, displayName: person.displayName, role: person.role })) : undefined;
      if (scope === 'personal' && summary) { delete summary.people; delete summary.stale; }
      let detailSummary = null;
      let detailRetryAfterMs = COUNTS_TTL;
      if (details && entry.rows) {
        // updatedAt is written whenever an execution changes; older rows cannot finish in this range.
        const candidates = filtered.filter(task => !Number.isFinite(timestamp(task.updatedAt)) || timestamp(task.updatedAt) >= range.startMs);
        if (!countsDue) await advanceDetails(entry, root, actor, candidates);
        const ready = candidates.filter(task => reusable(entry, task));
        const pending = candidates.filter(task => !reusable(entry, task));
        const values = new Map(ready.map(task => [task.id, entry.details.get(task.id).value]));
        const failed = candidates.filter(task => entry.detailErrors.has(task.id)).length;
        const times = ready.map(task => entry.details.get(task.id).readAt);
        const nextDetailRetry = pending.map(task => entry.detailErrors.get(task.id)?.retryAt ?? now()).toSorted((a, b) => a - b)[0];
        detailRetryAfterMs = nextDetailRetry == null ? COUNTS_TTL : Math.max(1500, nextDetailRetry - now());
        detailSummary = { ...summarizeEfficiency(filtered, values, range), total: candidates.length, loaded: ready.length,
          state: ready.length === candidates.length ? 'ready' : failed ? 'partial' : 'loading', failed,
          updatedAt: times.length ? new Date(Math.min(...times)).toISOString() : null };
      }
      return {
        scope, range, summary, creators, details: detailSummary,
        state: entry.error ? 'error' : entry.scan ? entry.rows ? 'refreshing' : 'loading' : entry.rows ? 'ready' : 'loading',
        progress: { loaded: entry.scan?.rows.size ?? rows.length, total: entry.scan?.total ?? (entry.rows ? rows.length : null) },
        updatedAt: entry.rows ? new Date(entry.updatedAt).toISOString() : null, notice: entry.error,
        retryAfterMs: entry.error ? Math.max(1000, entry.nextRetry - now())
          : entry.scan ? 1500 : details && detailSummary?.state !== 'ready' ? detailRetryAfterMs : COUNTS_TTL,
      };
    },
  };
}
