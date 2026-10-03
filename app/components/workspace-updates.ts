import { normalizeWorkspaceUpdate, workspaceUpdateMatches } from '../../src/workspace-invalidation.mjs';

const EVENT = 'xhs:workspace-updated';
const KEY = 'xhs:workspace-updated:v1';
export type WorkspaceUpdate = { scopes: string[]; taskIds?: number[] };
const clocks = new WeakMap<Window, { revision: number }>();

// Count receipt, before debouncing delivery. A request started after a mutation
// already covers its delayed notification; a mutation received in flight does not.
export function workspaceUpdateRevision() {
  if (typeof window === 'undefined') return 0;
  let clock = clocks.get(window);
  if (!clock) {
    clock = { revision: 0 };
    const current = clock;
    window.addEventListener(EVENT, () => { current.revision += 1; });
    window.addEventListener('storage', event => {
      if (event.key === KEY) current.revision += 1;
    });
    clocks.set(window, clock);
  }
  return clock.revision;
}

// Only an invalidation signal crosses tabs. Personal data stays in authenticated responses.
export function notifyWorkspaceUpdated(update?: WorkspaceUpdate) {
  if (typeof window === 'undefined') return;
  workspaceUpdateRevision();
  const normalized = normalizeWorkspaceUpdate(update);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: normalized }));
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...normalized, nonce: `${Date.now()}:${Math.random()}` })); } catch {}
}
export function subscribeWorkspaceUpdates(refresh: () => void, options: { scopes?: string[]; taskIds?: number[] } = {}) {
  workspaceUpdateRevision();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (update?: WorkspaceUpdate) => {
    if (!workspaceUpdateMatches(update, options)) return;
    clearTimeout(timer); timer = setTimeout(refresh, 300);
  };
  const changed = (event: Event) => schedule((event as CustomEvent).detail);
  const storage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    try { schedule(JSON.parse(event.newValue ?? 'null')); } catch { schedule(); }
  };
  window.addEventListener(EVENT, changed);
  window.addEventListener('storage', storage);
  return () => { clearTimeout(timer); window.removeEventListener(EVENT, changed); window.removeEventListener('storage', storage); };
}
