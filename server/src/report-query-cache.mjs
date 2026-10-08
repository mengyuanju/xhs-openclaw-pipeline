import { ControlPlaneConflictError } from './domain.mjs';

// Versions are database-local reporting facts, rather than cluster-wide XIDs.
// Progress, executor heartbeats and model traces do not invalidate aggregates.
export function reportActorKey(actor) {
  return JSON.stringify([actor.role, actor.userId, actor.username,
    actor.credentialVersion ?? actor.version ?? 1]);
}

export function createReportQueryCache({ ttlMs = 30_000, maxEntries = 128,
  maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  };
  const prune = () => {
    for (const [key, entry] of entries) if (!entry.pending && entry.expires <= now()) remove(key);
  };
  return {
    async read(key, load, { forceRefresh = false } = {}) {
      prune();
      // A manual refresh bypasses a completed result. A calculation already in
      // flight is fresh work and remains shared instead of occupying two slots.
      if (forceRefresh && entries.get(key) && !entries.get(key).pending) remove(key);
      const existing = entries.get(key);
      if (existing) return structuredClone(await existing.promise);
      while (entries.size >= maxEntries) {
        const oldest = [...entries].find(([, entry]) => !entry.pending);
        if (!oldest) throw new ControlPlaneConflictError('REPORT_BUSY', '报表查询较多，请稍后重试');
        remove(oldest[0]);
      }
      const entry = { bytes: 0, pending: true, expires: Infinity, promise: null };
      entry.promise = Promise.resolve().then(load).then(value => {
        entry.pending = false;
        entry.expires = now() + ttlMs;
        const retained = structuredClone(value);
        if (entries.get(key) !== entry) return retained;
        const size = Buffer.byteLength(JSON.stringify(retained), 'utf8');
        if (size > maxBytes) remove(key);
        else {
          entry.bytes = size; bytes += size;
          while (bytes > maxBytes) {
            const oldest = [...entries].find(([, candidate]) => !candidate.pending);
            if (!oldest) break;
            remove(oldest[0]);
          }
        }
        return retained;
      }).catch(error => { if (entries.get(key) === entry) remove(key); throw error; });
      entries.set(key, entry);
      return structuredClone(await entry.promise);
    },
    clear() { entries.clear(); bytes = 0; },
    get size() { prune(); return entries.size; },
    get bytes() { return bytes; },
  };
}

const caches = new WeakMap();
const flights = new WeakMap();
const heavyQueries = new WeakMap();
export function acquireReportQuerySlot(pool) {
  const active=heavyQueries.get(pool)??0;
  if(active>=2)throw new ControlPlaneConflictError('REPORT_BUSY','报表查询较多，请稍后重试');
  heavyQueries.set(pool,active+1);
  let released=false;
  return ()=>{if(!released){released=true;heavyQueries.set(pool,(heavyQueries.get(pool)??1)-1);}};
}
export async function runHeavyReportQuery(pool,operation) {
  const release=acquireReportQuerySlot(pool);
  try{return await operation();}finally{release();}
}
export async function runReportSingleFlight(pool,namespace,scope,operation) {
  if(!flights.has(pool))flights.set(pool,new Map());
  const pending=flights.get(pool),key=JSON.stringify([namespace,scope]);
  if(pending.has(key))return structuredClone(await pending.get(key));
  if(pending.size>=128)throw new ControlPlaneConflictError('REPORT_BUSY','报表查询较多，请稍后重试');
  const promise=Promise.resolve().then(operation);
  pending.set(key,promise);
  try{return structuredClone(await promise);}
  finally {if(pending.get(key)===promise)pending.delete(key);}
}

export async function readReportFactVersion(client, sources) {
  const row=(await client.query(`SELECT coalesce(string_agg(source||':'||shard||':'||revision,',' ORDER BY source,shard),'baseline')
    AS snapshot_version FROM report_fact_versions WHERE source=ANY($1::text[])`,[sources])).rows[0];
  return row?.snapshot_version;
}

export const OPERATOR_REPORT_SOURCES=['operator_performance_events','operator_stage_events','operator_quality_samples',
  'account_quality_records','account_quality_events','quality_review_activity_events','quality_review_coverage_events',
  'app_users','tasks','copy_sampling_items','copy_sampling_freezes','copy_qa_batch_members_v2','copy_qa_batches_v2',
  'image_sampling_items','image_sampling_freezes','image_edit_requests','copy_image_plan_regeneration_jobs'];

export const TASK_REPORT_SOURCES=[...OPERATOR_REPORT_SOURCES,'task_assignment_events','task_assignment_records',
  'task_reassignment_cases','task_reassignment_assessment_records','human_quality_assessments','copy_approval_events',
  'copy_revisions','image_approval_events','copy_qa_return_events_v2','copy_sampling_events','image_sampling_events',
  'copy_qa_admin_direct_approvals','delivery_entries','delivery_batch_items','delivery_batches','delivery_item_owners',
  'delivery_item_confirmations'];

export const DELIVERY_REPORT_SOURCES=['tasks','app_users','delivery_entries','delivery_batch_items','delivery_batches',
  'delivery_item_owners','delivery_item_confirmations','delivery_item_download_events','delivery_archive_items','delivery_archive_jobs'];
export function readCachedReportAggregate(pool, namespace, actor, filters, snapshotVersion, load, options = {}) {
  // Fakes/older servers without a snapshot identifier must never reuse facts.
  if (typeof snapshotVersion !== 'string' || !snapshotVersion) return load();
  if (!caches.has(pool)) caches.set(pool, createReportQueryCache());
  const key = JSON.stringify([namespace, reportActorKey(actor), filters, snapshotVersion]);
  return caches.get(pool).read(key, load, options);
}

const exportsInProgress = new WeakMap();
export async function runLimitedReportExport(pool, operation, { maximum = 2 } = {}) {
  const active = exportsInProgress.get(pool) ?? 0;
  if (active >= maximum) throw new ControlPlaneConflictError('REPORT_EXPORT_BUSY', '已有报表正在导出，请稍后重试');
  exportsInProgress.set(pool, active + 1);
  try { return await operation(); }
  finally { exportsInProgress.set(pool, (exportsInProgress.get(pool) ?? 1) - 1); }
}
