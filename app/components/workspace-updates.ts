const EVENT = 'xhs:workspace-updated';
const KEY = 'xhs:workspace-updated:v1';

// Only an invalidation signal crosses tabs. Personal data stays in authenticated responses.
export function notifyWorkspaceUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EVENT));
  try { window.localStorage.setItem(KEY, `${Date.now()}:${Math.random()}`); } catch {}
}
export function subscribeWorkspaceUpdates(refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
  const storage = (event: StorageEvent) => { if (event.key === KEY) schedule(); };
  window.addEventListener(EVENT, schedule);
  window.addEventListener('storage', storage);
  return () => { clearTimeout(timer); window.removeEventListener(EVENT, schedule); window.removeEventListener('storage', storage); };
}
