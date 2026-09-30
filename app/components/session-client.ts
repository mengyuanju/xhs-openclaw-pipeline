'use client';

import { parseSessionMetadata } from '../../src/admin/session-activity.mjs';
import { createSessionCookieLock } from '../../src/admin/session-cookie-lock.mjs';
import { createIndexedSessionLeaseStore } from '../../src/admin/session-indexed-lock.mjs';
import { SESSION_RENEW_BEFORE_SECONDS } from '../../src/admin/session-policy.mjs';

export type SessionMetadata = {
  sessionId: string;
  userId: number | null;
  expiresAt: number;
  absoluteExpiresAt: number;
  renewable: boolean;
  serverTime?: number;
};

type SessionEvent = {
  type: 'updated' | 'ended';
  sessionId: string;
  session: SessionMetadata | null;
  remote: boolean;
};
const STATE_KEY = 'xhs:session-state:v1';
const COOKIE_MUTATIONS = new Set(['/api/auth/login', '/api/auth/logout', '/api/control-plane/v1/profile/password']);
let runtime: ReturnType<typeof createRuntime> | undefined;
let redirecting = false;

class SessionRequestError extends Error {
  constructor(public status: number) { super('Session request failed'); }
}

function browserStorage() {
  try {
    const storage = window.localStorage;
    const probe = `${STATE_KEY}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch { return undefined; }
}

function createRuntime() {
  const storage = browserStorage();
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(STATE_KEY);
  const listeners = new Set<(event: SessionEvent) => void>();
  let current: SessionMetadata | null = null;
  let paused = 0;
  let generation = 0;
  let leaseStore;
  try { leaseStore = createIndexedSessionLeaseStore(window.indexedDB); } catch { /* Automatic renewal stays disabled without a shared lock. */ }
  const withLock = createSessionCookieLock({ locks: navigator.locks, leaseStore });

  function receive(value: unknown, remote: boolean) {
    const event = value as Partial<SessionEvent> | null;
    if (!event || !['updated', 'ended'].includes(event.type ?? '') || typeof event.sessionId !== 'string') return;
    const session = event.type === 'updated' ? parseSessionMetadata(event.session) : null;
    if (event.type === 'updated' && (!session || session.sessionId !== event.sessionId)) return;
    if (session) {
      if (current?.sessionId !== session.sessionId) generation++;
      current = session;
    } else {
      if (current && current.sessionId !== event.sessionId) return;
      if (current?.sessionId === event.sessionId) { generation++; current = null; }
    }
    const parsed = { type: event.type, sessionId: event.sessionId, session, remote } as SessionEvent;
    listeners.forEach(listener => listener(parsed));
  }

  function publish(type: SessionEvent['type'], session: SessionMetadata) {
    const event = { type, sessionId: session.sessionId, session: type === 'updated' ? session : null };
    try { storage?.setItem(STATE_KEY, JSON.stringify(event)); } catch { /* BroadcastChannel remains available. */ }
    channel?.postMessage(event);
    receive(event, false);
  }

  if (channel) channel.onmessage = event => receive(event.data, true);
  window.addEventListener('storage', event => {
    if (event.key !== STATE_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue), true); } catch { /* Ignore unrelated/untrusted storage data. */ }
  });
  return {
    withLock, publish,
    get current() { return current; },
    set current(value: SessionMetadata | null) {
      if (current?.sessionId !== value?.sessionId) generation++;
      current = value;
    },
    get paused() { return paused > 0; },
    get generation() { return generation; },
    pause: () => { paused++; },
    resume: () => { paused--; },
    subscribe(listener: (event: SessionEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function browserRuntime() { return runtime ??= createRuntime(); }

export function redirectToSessionLogin() {
  if (redirecting || window.location.pathname === '/login') return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?reauth=1&next=${encodeURIComponent(next)}`);
}

export function browserSessionGeneration() {
  return typeof window === 'undefined' ? null : browserRuntime().generation;
}

export function invalidateBrowserSession(expectedGeneration?: number | null) {
  const state = browserRuntime();
  if (expectedGeneration != null && state.generation !== expectedGeneration) return false;
  if (state.current) state.publish('ended', state.current);
  redirectToSessionLogin();
  return true;
}

export function subscribeSession(initial: SessionMetadata, listener: (event: SessionEvent) => void) {
  const state = browserRuntime();
  state.current = initial;
  return state.subscribe(listener);
}

async function readMetadata(response: Response): Promise<SessionMetadata> {
  if (!response.ok) throw new SessionRequestError(response.status);
  const payload = await response.json();
  const metadata = parseSessionMetadata(payload?.data);
  if (!metadata) throw new SessionRequestError(503);
  return metadata;
}

async function clearChangedPasswordCookie(expected: SessionMetadata) {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSessionId: expected.sessionId }),
      cache: 'no-store', signal: AbortSignal.timeout(4_000),
    });
  } catch { /* The changed credential version already invalidates this session. */ }
}

export function renewBrowserSession(expected: SessionMetadata, active: () => boolean) {
  const state = browserRuntime();
  return state.withLock(async () => {
    if (state.paused || !active()) return null;
    // Re-read the HttpOnly cookie under the shared lock; broadcasts are only hints.
    const latest = await readMetadata(await fetch('/api/auth/session', {
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    }));
    if (latest.sessionId !== expected.sessionId || latest.userId !== expected.userId) throw new SessionRequestError(409);
    if (state.paused || !active()) return null;
    const now = latest.serverTime ?? Math.floor(Date.now() / 1000);
    if (!latest.renewable || latest.expiresAt - now > SESSION_RENEW_BEFORE_SECONDS) {
      state.publish('updated', latest);
      return latest;
    }
    const renewed = await readMetadata(await fetch('/api/auth/renew', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSessionId: latest.sessionId }),
      cache: 'no-store', signal: AbortSignal.timeout(15_000),
    }));
    state.publish('updated', renewed);
    return renewed;
  }, { shared: true });
}

/** Serialize every application action that can replace or clear the login cookie. */
export async function fetchWithSessionCoordination(url: string, init?: RequestInit): Promise<Response> {
  const pathname = url.split('?')[0];
  if (typeof window === 'undefined' || !COOKIE_MUTATIONS.has(pathname)) return fetch(url, init);
  const state = browserRuntime();
  const expected = state.current;
  state.pause();
  try {
    return await state.withLock(async () => {
      let options = init;
      if (pathname === '/api/control-plane/v1/profile/password') {
        const metadataTimeout = AbortSignal.timeout(10_000);
        const latest = await readMetadata(await fetch('/api/auth/session', {
          cache: 'no-store', signal: init?.signal ? AbortSignal.any([init.signal, metadataTimeout]) : metadataTimeout,
        }));
        if (!expected || latest.sessionId !== expected.sessionId || latest.userId !== expected.userId) {
          return Response.json({ error: { code: 'SESSION_CHANGED', message: '登录账号已变化，请刷新页面' } }, { status: 409 });
        }
      }
      if (pathname === '/api/auth/logout' && expected) {
        options = { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'content-type': 'application/json' },
          body: JSON.stringify({ expectedSessionId: expected.sessionId }) };
      }
      const timeout = AbortSignal.timeout(15_000);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetch(url, { ...options, signal });
      if (pathname === '/api/control-plane/v1/profile/password' && response.ok && expected) {
        // Keep password rotation and cookie cleanup together so another login cannot intervene.
        await clearChangedPasswordCookie(expected);
      }
      if (pathname === '/api/auth/login' && response.ok) {
        const payload = await response.clone().json().catch(() => null);
        const metadata = parseSessionMetadata(payload?.data?.session);
        if (metadata) state.publish('updated', metadata);
      } else if (expected && (response.ok || (pathname === '/api/auth/logout' && response.status === 401))) {
        state.publish('ended', expected);
      }
      return response;
    }, { signal: init?.signal ?? undefined });
  } finally { state.resume(); }
}
