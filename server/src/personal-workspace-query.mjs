import { PERSONAL_WORK_CATEGORIES } from '../../src/personal-workspace.mjs';
import { taskCountScopeVersion } from './task-list-facts.mjs';
import { taskCountScope } from './task-count-scopes.mjs';

const caches = new WeakMap();
const COUNTS_TTL_MS = 5_000;
const MAX_COUNT_SCOPES = 128;

function cacheFor(pool) {
  if (!caches.has(pool)) caches.set(pool, { entries: new Map(), flights: new Map(), generation: 0 });
  return caches.get(pool);
}

// Permission changes and legacy repositories invalidate these scoped counts.
export function invalidatePersonalWorkspaceCounts(pool) {
  const cache = caches.get(pool);
  if (cache) { cache.generation++; cache.entries.clear(); cache.flights.clear(); }
}

function literal(value) { return `'${value.replaceAll("'", "''")}'`; }

// Match JavaScript trim/\s, including Unicode spaces at either end.
function personalQueryIdentitySql(column) {
  const whitespace = '[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';
  return `lower(regexp_replace(regexp_replace(${column},'^${whitespace}+|${whitespace}+$','','g'),'${whitespace}+',' ','g'))`;
}

function categoryPredicate(category, alias = 'f') {
  if (category === 'queued') return `${alias}.state IN ('COPY_QUEUED','IMAGE_QUEUED')`;
  if (category === 'running') return `${alias}.state IN ('COPY_RUNNING','IMAGE_RUNNING')`;
  return `(${literal(category)} = ANY(${alias}.categories) OR ${alias}.state = ${literal(category)})`;
}

export function personalCurrentQuery({ factsSql, actor, filters, now = Date.now(), historical = false }) {
  const values = [actor.userId, [], actor.role, filters.personalScope, !historical];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const cheap = [];
  if (actor.username && !historical) {
    const username = bind(actor.username);
    cheap.push(filters.personalScope === 'ASSIGNED' ? `task.assigned_to_user_id=${username}`
      : filters.personalScope === 'CREATED' ? `task.created_by_user_id=${username}`
      : `(task.assigned_to_user_id=${username} OR task.created_by_user_id=${username})`);
  }
  const keyword = filters.query.replace(/^#/u, '').toLocaleLowerCase('zh-CN');
  const contains = value => `%${value.replace(/[\\%_]/gu, character => `\\${character}`)}%`;
  // Escaped LIKE preserves literal search and can reuse the existing trigram indexes.
  if (keyword) cheap.push(/^\d+$/u.test(keyword)
    ? `task.id::text=${bind(keyword)}`
    : `lower(task.query) LIKE ${bind(contains(keyword))} ESCAPE '\\'`);
  if (filters.queryPackageName) cheap.push(`lower(coalesce(task.source_query_package_name,'')) LIKE ${bind(contains(filters.queryPackageName.toLocaleLowerCase('zh-CN')))} ESCAPE '\\'`);
  if (filters.priorityMode) cheap.push(`task.priority_mode=${bind(filters.priorityMode)}`);
  if (filters.createdFrom && !historical) cheap.push(`task.created_at>=${bind(`${filters.createdFrom}T00:00:00+08:00`)}::timestamptz`);
  if (filters.createdTo && !historical) cheap.push(`task.created_at<(${bind(`${filters.createdTo}T00:00:00+08:00`)}::timestamptz+interval '1 day')`);
  const at = bind(new Date(now).toISOString());
  const source = factsSql({ unbounded: true, classificationOnly: true,
    repeated: filters.repeated, personalScope: historical ? undefined : filters.personalScope,
    bind, at, additionalWhere: cheap.length ? ` AND ${cheap.join(' AND ')}` : '' });
  const ctes = `WITH facts AS (${source}),
    base_flags AS (
      SELECT f.*,
        coalesce(state NOT IN ('REVIEWED','CANCELLED'),true) AS active,
        coalesce(current_stage='IMAGE_RETRY_EXHAUSTED',false) AS exhausted,
        coalesce(plan_status IN ('QUEUED','RUNNING'),false) AS plan_running,
        coalesce(plan_status='SUCCEEDED',false) AS plan_ready,
        coalesce(queued,0)+coalesce(running,0)>0 AS repair_running,
        coalesce(state='COPY_REVIEW_PENDING' AND coalesce(current_stage,'')<>'IMAGE_RETRY_EXHAUSTED'
          AND CASE WHEN mandatory_copy_qc_origin IN ('QA_RETURN','FINAL_REWORK') THEN mandatory_copy_qc_origin
            ELSE revision_origin END IN ('QA_RETURN','FINAL_REWORK'),false) AS copy_rework,
        coalesce(state='IMAGE_REWORK_PENDING' OR state='MANUAL_ARCHIVE' AND mandatory_image_qc,false) AS image_rework
      FROM facts f
    ), work_flags AS (
      SELECT f.*,
        copy_rework OR image_rework AS rework,
        coalesce(state='COPY_REVIEW_PENDING' AND NOT (copy_rework OR image_rework) AND NOT exhausted,false) AS copy_initial,
        coalesce(state='MANUAL_ARCHIVE' AND NOT (copy_rework OR image_rework),false) AS image_initial,
        coalesce(state IN ('COPY_FAILED','IMAGE_FAILED') OR exhausted,false) AS anomaly,
        active AND (coalesce(plan_status='FAILED',false) OR coalesce(failed,0)>0) AS background_failed,
        active AND (coalesce(ready,0)>0 OR plan_ready) AS previews,
        CASE WHEN copy_rework OR image_rework THEN CASE WHEN rework_target='BOTH' THEN 'BOTH'
          WHEN copy_rework THEN 'COPY' ELSE 'IMAGE' END END AS rework_type,
        CASE WHEN copy_rework OR image_rework THEN CASE WHEN plan_running OR repair_running THEN 'PROCESSING'
          WHEN coalesce(ready,0)>0 OR plan_ready THEN 'CONFIRM' ELSE 'EDIT' END END AS rework_progress,
        CASE WHEN copy_rework OR image_rework THEN coalesce(rework_source,CASE WHEN image_rework THEN 'IMAGE_QA'
          WHEN CASE WHEN mandatory_copy_qc_origin IN ('QA_RETURN','FINAL_REWORK') THEN mandatory_copy_qc_origin
            ELSE revision_origin END='FINAL_REWORK' THEN 'FINAL_REWORK' ELSE 'COPY_QA' END) END AS work_rework_source
      FROM base_flags f
    ), human_flags AS (
      SELECT f.*, (copy_initial OR image_initial OR rework OR anomaly OR background_failed OR previews)
        AND (NOT (plan_running OR repair_running) OR previews OR background_failed) AS needs_human,
        CASE WHEN previews THEN CASE WHEN plan_ready THEN coalesce(plan_ready_at,queue_entered_at)
          ELSE coalesce(preview_ready_at,queue_entered_at) END ELSE queue_entered_at END AS waiting_since
      FROM work_flags f
    ), classified AS (
      SELECT f.*, CASE WHEN needs_human AND waiting_since IS NOT NULL
        THEN greatest(0,extract(epoch FROM (${at}::timestamptz-waiting_since))/3600) END AS waiting_hours,
        array_remove(ARRAY['ALL',
          CASE WHEN coalesce(is_assigned,false) AND needs_human THEN 'actionable' END,
          CASE WHEN copy_initial OR image_initial THEN 'review' END,
          CASE WHEN copy_initial THEN 'copyInitial' END, CASE WHEN image_initial THEN 'imageInitial' END,
          CASE WHEN rework THEN 'rework' END, CASE WHEN rework_type='COPY' THEN 'copyRework' END,
          CASE WHEN rework_type='IMAGE' THEN 'imageRework' END, CASE WHEN rework_type='BOTH' THEN 'bothRework' END,
          CASE WHEN state IN ('COPY_QUEUED','COPY_RUNNING','IMAGE_QUEUED','IMAGE_RUNNING') THEN 'production' END,
          CASE WHEN state IN ('COPY_QC_PENDING','IMAGE_QC_PENDING') THEN 'qa' END,
          CASE WHEN anomaly THEN 'anomaly' END, CASE WHEN previews THEN 'previews' END,
          CASE WHEN active AND plan_running THEN 'planRunning' END,
          CASE WHEN active AND repair_running THEN 'repairRunning' END,
          CASE WHEN background_failed THEN 'backgroundFailed' END,
          CASE WHEN state='COPY_QC_PENDING' AND mandatory_copy_qc OR state='IMAGE_QC_PENDING' AND mandatory_image_qc THEN 'recheck' END,
          CASE WHEN state='REVIEWED' AND delivery_ready THEN 'ready' END,
          CASE WHEN state='REVIEWED' THEN 'completed' END, CASE WHEN state='CANCELLED' THEN 'cancelled' END,
          CASE WHEN needs_human AND waiting_since<=${at}::timestamptz-interval '24 hours' THEN 'longWaiting' END
        ],NULL) AS categories,
        ${filters.deduplicateQuery ? personalQueryIdentitySql('f.query') : 'NULL::text'} AS query_identity
      FROM human_flags f
    )`;
  const extra = [];
  if (filters.reworkType) extra.push(`f.rework_type=${bind(filters.reworkType)}`);
  if (filters.reworkProgress) extra.push(`f.rework_progress=${bind(filters.reworkProgress)}`);
  if (filters.reworkSource) extra.push(`f.work_rework_source=${bind(filters.reworkSource)}`);
  if (filters.longWaiting) extra.push(`'longWaiting'=ANY(f.categories)`);
  if (filters.repeated) extra.push(historical ? 'f.history_repeated' : `coalesce(f.rework_rounds,0)>=2`);
  // Counts do not need generated content, notes, task text, or page-order fields.
  // A narrow materialized relation lets PostgreSQL prune those expressions and
  // their joins before materializing a person's entire ownership scope.
  const filtered = `${ctes}, filtered AS MATERIALIZED (SELECT f.id,f.state,f.categories,f.query_identity,
    f.rework_progress,f.rework,f.waiting_hours,f.queued,f.running FROM classified f${extra.length ? ` WHERE ${extra.join(' AND ')}` : ''})`;
  const amount = filters.deduplicateQuery ? 'DISTINCT f.query_identity' : '*';
  const countSql = `${filtered} SELECT
    ${PERSONAL_WORK_CATEGORIES.map(category => `count(${amount}) FILTER(WHERE ${categoryPredicate(category)}) AS "${category}"`).join(',\n')},
    count(${amount}) FILTER(WHERE ${categoryPredicate('queued')}) AS "_queued",
    count(${amount}) FILTER(WHERE ${categoryPredicate('running')}) AS "_running",
    count(*) FILTER(WHERE rework_progress='EDIT') AS "_reworkEdit",
    count(*) FILTER(WHERE rework_progress='PROCESSING') AS "_reworkProcessing",
    count(*) FILTER(WHERE rework_progress='CONFIRM') AS "_reworkConfirm",
    count(*) FILTER(WHERE rework AND 'longWaiting'=ANY(categories)) AS "_reworkLongWaiting",
    coalesce(max(waiting_hours) FILTER(WHERE rework),0) AS "_longestHours",
    coalesce(sum(coalesce(queued,0)+coalesce(running,0)),0) AS "_imageRequests",
    count(*) FILTER(WHERE 'actionable'=ANY(categories) AND waiting_hours IS NULL) AS "_missingDates",
    (SELECT coalesce(jsonb_object_agg(state,n),'{}'::jsonb) FROM (
      SELECT state,count(${filters.deduplicateQuery ? 'DISTINCT query_identity' : '*'}) AS n FROM filtered GROUP BY state
    ) grouped) AS "_states"
    FROM filtered f`;
  const selected = `SELECT f.* FROM classified f WHERE ${[...extra, categoryPredicate(filters.category)].join(' AND ')}`;
  const matching = filters.deduplicateQuery
    ? `SELECT DISTINCT ON (query_identity) * FROM (${selected}) matching ORDER BY query_identity,created_at DESC,id DESC`
    : selected;
  const waiting = filters.sort === 'waiting:desc' || filters.category === 'rework' && filters.sort === 'priority:desc';
  const order = historical ? 'newest_event_at DESC,id DESC' : waiting ? 'waiting_hours DESC NULLS LAST,id ASC'
    : filters.sort.startsWith('id:') ? `id ${filters.sort.endsWith('asc') ? 'ASC' : 'DESC'}`
    : filters.sort.startsWith('createdAt:') ? `created_at ${filters.sort.endsWith('asc') ? 'ASC' : 'DESC'},id ${filters.sort.endsWith('asc') ? 'ASC' : 'DESC'}`
    : `(priority_mode='PAUSE') ASC,priority_sort_at ASC,id ASC`;
  const simpleCategories = { ALL: 'true', production: "task.state IN ('COPY_QUEUED','COPY_RUNNING','IMAGE_QUEUED','IMAGE_RUNNING')",
    qa: "task.state IN ('COPY_QC_PENDING','IMAGE_QC_PENDING')", completed: "task.state='REVIEWED'", cancelled: "task.state='CANCELLED'",
    queued: "task.state IN ('COPY_QUEUED','IMAGE_QUEUED')", running: "task.state IN ('COPY_RUNNING','IMAGE_RUNNING')" };
  const simpleCategory = simpleCategories[filters.category]
    ?? (/^(?:COPY_|IMAGE_|MANUAL_ARCHIVE$|REVIEWED$|CANCELLED$)/u.test(filters.category) ? `task.state=${literal(filters.category)}` : null);
  let pageSql = `${ctes} SELECT id FROM (${matching}) selected ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
  // Ordinary pages select narrow IDs before looking up plans, edits, return history,
  // or generated content. Complex work categories use the equivalent classifier.
  if (!historical && !waiting && !extra.length && simpleCategory) {
    const simple = factsSql({ idsOnly: true,
      additionalWhere: ` AND ${[...cheap, simpleCategory].join(' AND ')}` });
    const narrow = `SELECT f.*,${filters.deduplicateQuery ? personalQueryIdentitySql('f.query') : 'NULL::text'} AS query_identity FROM (${simple}) f`;
    const selectedIds = filters.deduplicateQuery
      ? `SELECT DISTINCT ON(query_identity) * FROM (${narrow}) f ORDER BY query_identity,created_at DESC,id DESC`
      : narrow;
    const simpleOrder = filters.sort === 'priority:desc' ? 'priority_paused ASC,priority_sort_at ASC,id ASC' : order;
    // The classifier's now parameter is also typed on this otherwise time-free path.
    pageSql = `SELECT id FROM (${selectedIds}) selected WHERE ${at}::timestamptz IS NOT NULL
      ORDER BY ${simpleOrder} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
  }
  return { values, countSql,
    pageSql };
}

function cacheKey(actor, filters) {
  const { category, sort, page, pageSize, range, ...scope } = filters;
  if (filters.mode !== 'CURRENT') scope.range = range;
  return JSON.stringify([actor.userId, actor.username, actor.role, actor.credentialVersion ?? actor.version ?? 1, scope]);
}

export async function readPersonalCurrentPage(client, pool, input, { now = Date.now(), ttlMs = COUNTS_TTL_MS, countsOnly = false } = {}) {
  const { actor, filters } = input;
  const query = personalCurrentQuery({ ...input, now });
  const cache = cacheFor(pool), key = cacheKey(actor, filters);
  const scope = taskCountScope(query.countSql,query.values,{usernames:
    filters.mode === 'CURRENT' && actor.username ? [actor.username] : []});
  const factVersion = taskCountScopeVersion(pool,scope), flightKey = `${key}:${factVersion}`;
  let entry = ttlMs > 0 ? cache.entries.get(key) : null;
  if (!entry || entry.expires <= now || entry.factVersion !== factVersion) {
    const generation = cache.generation;
    let flight = ttlMs > 0 ? cache.flights.get(flightKey) : null;
    if (!flight) {
      flight = client.query(query.countSql, query.values);
      if (ttlMs > 0 && cache.flights.size < MAX_COUNT_SCOPES) cache.flights.set(flightKey, flight);
    }
    let result;
    try { result = (await flight).rows[0]; }
    finally { if (cache.flights.get(flightKey) === flight) cache.flights.delete(flightKey); }
    if (!result) throw new Error('个人作业计数响应不完整');
    entry = { result, expires: now + ttlMs, factVersion };
    if (cache.generation === generation && taskCountScopeVersion(pool,scope) === factVersion && ttlMs > 0) {
      while (cache.entries.size >= MAX_COUNT_SCOPES) cache.entries.delete(cache.entries.keys().next().value);
      cache.entries.set(key, entry);
    }
  }
  const counts = Object.fromEntries(PERSONAL_WORK_CATEGORIES.map(category => [category, Number(entry.result[category] ?? 0)]));
  const total = filters.category === 'queued' ? Number(entry.result._queued ?? 0)
    : filters.category === 'running' ? Number(entry.result._running ?? 0)
    : counts[filters.category] ?? Number(entry.result._states?.[filters.category] ?? 0);
  const page = Math.min(filters.page, Math.max(1, Math.ceil(total / filters.pageSize)));
  const offset = (page - 1) * filters.pageSize;
  const rows = total && !countsOnly ? (await client.query(query.pageSql, [...query.values, filters.pageSize, offset])).rows : [];
  if (rows.length > filters.pageSize) throw new Error('个人作业分页超过读取上限');
  const value = key => Number(entry.result[key] ?? 0);
  return { ids: rows.map(row => Number(row.id)), total, limit: filters.pageSize, offset, counts,
    workSummary: {
      rework: { copy: counts.copyRework, image: counts.imageRework, both: counts.bothRework,
        edit: value('_reworkEdit'), processing: value('_reworkProcessing'), confirm: value('_reworkConfirm'),
        longWaiting: value('_reworkLongWaiting'), longestHours: value('_longestHours') },
      background: { plan: counts.planRunning, repair: counts.repairRunning, previews: counts.previews,
        failed: counts.backgroundFailed, imageRequests: value('_imageRequests') }, missingDates: value('_missingDates'),
    } };
}
