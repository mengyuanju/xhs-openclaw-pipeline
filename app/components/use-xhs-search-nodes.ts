'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from './api-client';
import { browserSessionGeneration } from './session-client';
import { createSessionReadCache, type ReadSnapshot } from './session-read-cache';
import type { XhsSearchNodeStatus } from './xhs-search-status';

const POLL_MS = 15_000;
const cache = createSessionReadCache<XhsSearchNodeStatus[]>({
  scope: browserSessionGeneration, ttlMs: POLL_MS,
  read: signal => apiRequest('/api/control-plane/v1/xhs-search-statuses', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store',
  }),
});
let watchers = 0;
let stopPolling: (() => void) | null = null;

function watch() {
  watchers += 1;
  if (watchers === 1) {
    const visible = () => { if (document.visibilityState === 'visible') void cache.load().catch(() => {}); };
    const timer = window.setInterval(visible, POLL_MS);
    document.addEventListener('visibilitychange', visible);
    stopPolling = () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }
  return () => { watchers -= 1; if (!watchers) { stopPolling?.(); stopPolling = null; } };
}

export function useXhsSearchNodes(enabled = true, initialNodes?: XhsSearchNodeStatus[], deferInitialRead = false) {
  const [snapshot, setSnapshot] = useState<ReadSnapshot<XhsSearchNodeStatus[]>>({
    data: initialNodes ?? null, error: null, loading: false, updatedAt: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    // The executor page supplies its authenticated SSR data. Its global reminder
    // defers the first read until this seed arrives in the same mount commit.
    if (initialNodes) cache.seed(initialNodes);
    const update = () => setSnapshot(cache.getSnapshot());
    update();
    const unsubscribe = cache.subscribe(update);
    const unwatch = watch();
    if (!deferInitialRead && document.visibilityState === 'visible') void cache.load().catch(() => {});
    return () => { unsubscribe(); unwatch(); };
  }, [enabled, initialNodes, deferInitialRead]);
  const refresh = useCallback(() => cache.load({ fresh: true }), []);
  return { nodes: enabled ? snapshot.data ?? [] : [], error: enabled ? snapshot.error : null, refresh };
}
