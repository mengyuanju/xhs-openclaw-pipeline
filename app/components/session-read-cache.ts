export type ReadSnapshot<T> = { data: T | null; error: Error | null; loading: boolean; updatedAt: number };

/** Memory only. Session changes abort old flights and cannot reuse their data. */
export function createSessionReadCache<T>({ read, scope, ttlMs, now = Date.now }: {
  read: (signal: AbortSignal) => Promise<T>;
  scope: () => unknown;
  ttlMs: number;
  now?: () => number;
}) {
  let session = scope();
  let revision = 0;
  let snapshot: ReadSnapshot<T> = { data: null, error: null, loading: false, updatedAt: 0 };
  let flight: { revision: number; controller: AbortController; promise: Promise<T> } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  function syncScope() {
    const current = scope();
    if (current === session) return;
    session = current;
    revision += 1;
    flight?.controller.abort();
    flight = null;
    snapshot = { data: null, error: null, loading: false, updatedAt: 0 };
  }
  function invalidate() { syncScope(); revision += 1; snapshot = { ...snapshot, updatedAt: 0 }; }
  function seed(data: T) {
    syncScope();
    if (snapshot.data !== null || flight) return;
    snapshot = { data, error: null, loading: false, updatedAt: now() };
    emit();
  }
  async function load({ fresh = false }: { fresh?: boolean } = {}): Promise<T> {
    syncScope();
    if (fresh) invalidate();
    if (flight) {
      const current = flight;
      // Invalidation received after a read started still needs one newer read.
      if (current.revision !== revision) {
        try { await current.promise; } catch { /* The subsequent read can recover. */ }
        return load();
      }
      return current.promise;
    }
    if (snapshot.data !== null && snapshot.updatedAt > 0 && now() - snapshot.updatedAt < ttlMs) return snapshot.data;
    const expectedSession = session;
    const current: { revision: number; controller: AbortController; promise: Promise<T> } = {
      revision, controller: new AbortController(), promise: Promise.resolve(null as T),
    };
    flight = current;
    snapshot = { ...snapshot, error: null, loading: true };
    emit();
    current.promise = (async () => {
      try {
        const data = await read(current.controller.signal);
        syncScope();
        if (expectedSession !== session || flight !== current) throw new Error('登录账号已变化，请刷新页面');
        snapshot = { data, error: null, loading: false, updatedAt: current.revision === revision ? now() : 0 };
        return data;
      } catch (error) {
        if (flight === current) {
          const status = (error as { status?: number } | null)?.status;
          snapshot = { ...snapshot, ...([401, 403].includes(status ?? 0) ? { data: null, updatedAt: 0 } : {}),
            error: error instanceof Error ? error : new Error('数据读取失败'), loading: false };
        }
        throw error;
      } finally {
        if (flight === current) { flight = null; emit(); }
      }
    })();
    return current.promise;
  }
  return {
    load, seed, invalidate,
    getSnapshot() { syncScope(); return snapshot; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
