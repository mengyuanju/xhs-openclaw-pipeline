/** Coalesces editor/background reads while keeping immutable browser-session scopes separate. */
export function createImageEditStateReader({ read, scope, now = Date.now, ttlMs = 1000, legacyTtlMs = 15000 }) {
  const entries = new Map();
  /** @param {{taskId:number,standalone?:boolean,ids?:string[],fresh?:boolean}} query */
  return async function state({ taskId, standalone = false, ids = [], fresh = false }) {
    const key = `${scope()}:${standalone ? 'standalone' : 'task'}:${taskId}`;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 128) entries.delete(entries.keys().next().value);
      entry = { pending: null, started: false, value: null, time: 0, wanted: new Set(), checkedIds: new Set() };
      entries.set(key, entry);
    }
    const requested = [...new Set(ids)];
    const contains = value => value?.status === 'DELETED'
      || requested.every(id => value?.items?.some(item => item.id === id) || entry.checkedIds.has(id));
    if (!fresh && entry.value && now() - entry.time < (entry.value.legacy ? legacyTtlMs : ttlMs) && contains(entry.value)) return entry.value;
    requested.forEach(id => entry.wanted.add(id));
    if (entry.pending) {
      const outdatedFlight = fresh && entry.started;
      const value = await entry.pending;
      // Opening after a claim/mutation cannot confirm an older in-flight QUEUED
      // receipt. Requests collected before the read starts still share one flight.
      if(outdatedFlight)return state({taskId,standalone,ids:requested,fresh:true});
      if (contains(value)) return value;
      return state({ taskId, standalone, ids: requested });
    }
    const operation = (async () => {
      // Editor and notification requests in the same turn contribute IDs to one read.
      await new Promise(done => setTimeout(done, 0));
      entry.started = true;
      const wanted = [...entry.wanted]; entry.wanted.clear();
      if (wanted.length > 100) throw new TypeError('At most 100 edit states per shared request');
      // Keep older tracked IDs across editor-only polls, so alternating readers
      // do not drop and re-add those rows or spuriously change the signature.
      for(const id of entry.checkedIds)if(wanted.length<100&&!wanted.includes(id))wanted.push(id);
      const value = await read({ taskId, standalone, ids: wanted });
      entry.value = value; entry.time = now(); entry.checkedIds = new Set(wanted);
      return value;
    })();
    entry.pending = operation;
    try { return await operation; }
    finally { if (entry.pending === operation) {entry.pending = null;entry.started = false;} }
  };
}

export function imageEditStateSignature(items) {
  return JSON.stringify(items.map(item => [item.id,item.version,item.status,item.error ?? null]));
}

export function imageEditPollDelay(state, visible = true) {
  if (!visible) return 30_000;
  if (state?.legacy) return 15_000;
  return state?.items?.some(item => ['QUEUED','RUNNING'].includes(item.status)) ? 4000 : 15_000;
}
