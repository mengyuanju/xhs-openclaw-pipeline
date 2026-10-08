import { observeLockedTaskRows, taskCountChange, taskCountScope, taskCountScopeKey, taskChangeAffectsCount } from './task-count-scopes.mjs';

const totals = new WeakMap();
const revisions = new WeakMap();
const adapters = new WeakMap();
const owners = new WeakMap();
const trackedClients = new WeakMap();
const scopes = new WeakMap();
const workSubscribers = new WeakMap();
const CACHE_LIMIT = 128;

function owner(pool) { return owners.get(pool) ?? pool; }

export function taskListFactVersion(pool) { return revisions.get(owner(pool)) ?? 0; }

export function taskCountScopeVersion(pool, scope) {
  pool = owner(pool);
  if (!scopes.has(pool)) scopes.set(pool,{ serial: 0, entries: new Map() });
  const registry = scopes.get(pool), key = taskCountScopeKey(scope);
  let entry = registry.entries.get(key);
  if (!entry) {
    if (registry.entries.size >= CACHE_LIMIT * 2) registry.entries.delete(registry.entries.keys().next().value);
    entry = { scope, id: ++registry.serial, revision: taskListFactVersion(pool) };
  } else registry.entries.delete(key);
  registry.entries.set(key,entry);
  return `${entry.id}:${entry.revision}`;
}

/** Advance only after the transaction containing a business change commits. */
export function commitTaskListChange(pool, changes = [null]) {
  commitChanges(pool, changes, []);
}

/** In-process wake signals observe committed writes, never a database poll. */
export function subscribeExecutionWorkChanges(pool, listener) {
  pool = owner(pool);
  if (!workSubscribers.has(pool)) workSubscribers.set(pool, new Set());
  const subscribers = workSubscribers.get(pool);
  subscribers.add(listener);
  return () => { subscribers.delete(listener); if (!subscribers.size) workSubscribers.delete(pool); };
}

function commitChanges(pool, changes, settingsChanges) {
  pool = owner(pool);
  if (changes.length) {
    revisions.set(pool, taskListFactVersion(pool) + 1);
    for (const entry of scopes.get(pool)?.entries.values() ?? []) {
      if (changes.some(change => taskChangeAffectsCount(change,entry.scope))) entry.revision = taskListFactVersion(pool);
    }
  }
  for (const listener of workSubscribers.get(pool) ?? []) {
    try { listener([...changes, ...settingsChanges]); }
    catch (error) { console.error('failed to notify committed execution work', error); }
  }
}

export function invalidateTaskTotals(pool) { totals.delete(owner(pool)); }

export async function readTaskTotal(pool, sql, values, { key, ttl, now, fresh, scopeUsernames }) {
  const compute = async () => ({ result: await pool.query(sql, values), computedAt: now() });
  if (fresh && key) totals.get(owner(pool))?.delete(key);
  if (fresh || ttl === 0 || !key) return compute();
  const identity = owner(pool);
  let cache = totals.get(identity);
  if (!cache) { cache = new Map(); totals.set(identity, cache); }
  const at = now();
  for (const [candidate, entry] of cache) if (entry.expiresAt <= at) cache.delete(candidate);
  const scope = taskCountScope(sql,values,{usernames:scopeUsernames}), version = taskCountScopeVersion(pool,scope);
  if (cache.get(key)?.version === version) return cache.get(key).promise;
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  const entry = { expiresAt: Infinity, promise: null, version };
  entry.promise = compute().then(value => {
    entry.expiresAt = value.computedAt + ttl;
    return value;
  }).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
  cache.set(key, entry);
  return entry.promise;
}

// These relations determine visible task membership, ownership, activity,
// review queues or the current workspace state. Executor leases, receipts,
// model traces, configuration and export bookkeeping are deliberately absent.
const FACT_WRITE = /\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|DELETE\s+FROM\s+)(?:public\.)?"?(tasks|app_users|task_assignment_events|task_assignment_records|task_reassignment_cases|copy_sampling_items|copy_sampling_freezes|copy_qa_batches_v2|copy_qa_batch_members_v2|copy_qa_batch_assignments_v2|image_sampling_items|image_sampling_freezes|image_edit_requests|copy_image_plan_regeneration_jobs|delivery_entries|delivery_item_owners|delivery_item_confirmations)"?\b/giu;
const LEASE_FIELDS = new Set(['lease_expires_at','lease_token','updated_at']);

function writesBusinessFacts(sql) {
  for (const match of sql.matchAll(FACT_WRITE)) {
    if (match[1].toLowerCase() !== 'image_edit_requests' || !/^UPDATE\b/iu.test(match[0])) return true;
    const assignments=sql.slice(match.index+match[0].length)
      .match(/^\s+(?:\w+\s+)?SET\s+([\s\S]*?)(?:\b(?:WHERE|FROM|RETURNING)\b|$)/iu)?.[1];
    const fields=assignments ? [...assignments.matchAll(/(?:^|,)\s*(\w+)\s*=/gu)].map(entry=>entry[1].toLowerCase()) : [];
    // Renewal changes neither review membership nor preview readiness. A status,
    // version, result or progress write still advances the business revision.
    if (!fields.some(field=>field==='lease_expires_at'||field==='lease_token')
      || fields.some(field=>!LEASE_FIELDS.has(field))) return true;
  }
  return false;
}

function changedFacts(sql, result) {
  const text = typeof sql === 'string' ? sql : sql?.text;
  if (typeof text !== 'string' || !writesBusinessFacts(text)) return false;
  if (Array.isArray(result)) return result.some(item => changedFacts(text, item));
  // pg always supplies rowCount. Fakes without it can still provide RETURNING rows.
  // For a writable CTE PostgreSQL reports only the final SELECT's row count.
  // An empty final page cannot prove the earlier writes changed zero facts.
  if (result?.command === 'SELECT') return true;
  return Number(result?.rowCount ?? result?.rows?.length ?? 0) > 0;
}

function changedSettings(sql, result) {
  const text = typeof sql === 'string' ? sql : sql?.text;
  if (typeof text !== 'string' || !/\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|DELETE\s+FROM\s+)(?:public\.)?"?global_settings"?\b/iu.test(text)) return false;
  if (Array.isArray(result)) return result.some(item => changedSettings(text, item));
  return result?.command === 'SELECT' || Number(result?.rowCount ?? result?.rows?.length ?? 0) > 0;
}

/** Track commits without changing pool identity or adding database queries. */
export function taskListFactClient(client, pool) {
  pool = owner(pool);
  if (trackedClients.get(client) === pool) return client;
  let inTransaction = false, changes = [], settingsChanges = [];
  const locked = new Map();
  const savepoints = new Map();
  const tracked = new Proxy(client, {
    get(target, key) {
      if (key !== 'query') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        const result = await target.query(...args);
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (/^\s*(?:BEGIN|START\s+TRANSACTION)\b/iu.test(sql)) { inTransaction = true; changes = []; settingsChanges = []; savepoints.clear(); locked.clear(); }
        else if (/^\s*COMMIT\b/iu.test(sql)) {
          // PostgreSQL accepts COMMIT on an aborted transaction but reports
          // ROLLBACK. Only its actual commit signal confirms a durable change.
          if ((changes.length || settingsChanges.length) && (result?.command === undefined || result.command === 'COMMIT')) commitChanges(pool,changes,settingsChanges);
          inTransaction = false; changes = []; settingsChanges = []; savepoints.clear(); locked.clear();
        } else if (/^\s*SAVEPOINT\s+/iu.test(sql)) {
          savepoints.set(sql.trim().split(/\s+/u).at(-1),{ length: changes.length, settingsLength: settingsChanges.length, locked: new Map(locked) });
        } else if (/^\s*ROLLBACK\s+TO\b/iu.test(sql)) {
          const saved = savepoints.get(sql.trim().split(/\s+/u).at(-1));
          if (saved) { changes.length = saved.length; settingsChanges.length = saved.settingsLength; locked.clear(); for (const [id,row] of saved.locked) locked.set(id,row); }
        } else if (/^\s*ROLLBACK\b/iu.test(sql)) { inTransaction = false; changes = []; settingsChanges = []; savepoints.clear(); locked.clear(); }
        else {
          const facts = changedFacts(args[0], result) ? [taskCountChange(sql,args[1] ?? args[0]?.values ?? [],result,locked)] : [];
          const settings = changedSettings(args[0], result) ? [{ table: 'global_settings' }] : [];
          if (inTransaction) {
            if (facts.length) { if (changes.length < 256) changes.push(...facts); else changes = [null]; }
            if (settings.length && settingsChanges.length === 0) settingsChanges.push(...settings);
          } else if (facts.length || settings.length) commitChanges(pool,facts,settings);
        }
        if (inTransaction) observeLockedTaskRows(sql,result,locked);
        return result;
      };
    },
  });
  trackedClients.set(tracked,pool);
  return tracked;
}

/** Domain mutations can share commit tracking while public repository.pool stays unchanged. */
export function taskListFactQueryable(pool) {
  if (owners.has(pool)) return pool;
  if (adapters.has(pool)) return adapters.get(pool);
  const client = taskListFactClient(pool, pool);
  const adapter = new Proxy(client, {
    get(target, key) {
      if (key === 'connect' && typeof pool.connect === 'function') return async () => taskListFactClient(await pool.connect(), pool);
      if (key === 'query' && typeof pool.query !== 'function') return undefined;
      return Reflect.get(target, key);
    },
  });
  owners.set(adapter, pool); adapters.set(pool, adapter);
  return adapter;
}
