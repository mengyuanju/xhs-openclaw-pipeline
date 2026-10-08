import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

const cookieName = 'xhs_admin_session';
const lockDatabase = 'xhs:session-coordination:v1';
const seconds = () => Math.floor(Date.now() / 1_000);

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function requestGate() {
  return { entered: deferred(), release: deferred() };
}

async function waitForGate(gate, description) {
  let timer;
  try {
    await Promise.race([
      gate.entered.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 5_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function removeFixtureDirectory(directory) {
  const target = resolve(directory);
  const parent = resolve(tmpdir());
  assert.ok(target.startsWith(`${parent}${sep}`) && target !== parent,
    'fixture cleanup must remain inside the OS temporary directory');
  assert.ok(target.split(sep).at(-1).startsWith('session-renewal-browser-'));
  await rm(target, { recursive: true, force: true });
}

test('session renewal browser: trusted activity and cross-tab cookie writes remain coordinated', {
  skip: process.env.RUN_SESSION_RENEWAL_BROWSER !== '1', timeout: 90_000,
}, async t => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'session-renewal-browser-'));
  const sessions = new Map();
  const requests = [], errors = [], serverErrors = [];
  const gates = new Map();
  let browser, server, origin;
  let sequence = 0;

  function issueSession(userId = 1, { nearExpiry = true, sessionId, absoluteExpiresAt } = {}) {
    const token = `fixture-${++sequence}`;
    const metadata = {
      sessionId: sessionId ?? randomBytes(16).toString('base64url'),
      userId,
      expiresAt: seconds() + (nearExpiry ? 1_800 : 28_800),
      absoluteExpiresAt: absoluteExpiresAt ?? seconds() + 604_800,
      renewable: true,
      serverTime: seconds(),
    };
    sessions.set(token, metadata);
    return { token, metadata };
  }

  function tokenFrom(request) {
    return (request.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }

  function json(response, data, status = 200) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(status >= 400 ? { error: data } : { data }));
  }

  async function pauseAt(path) {
    const gate = gates.get(path);
    if (!gate) return;
    gate.entered.resolve();
    await gate.release.promise;
  }

  async function newContext({ fallback = false, keeper = true, blockedIndexedDB = false } = {}) {
    const seeded = issueSession();
    const context = await browser.newContext({ viewport: { width: 1_000, height: 700 } });
    await context.addInitScript(({ fallback, blockedIndexedDB }) => {
      const realNow = Date.now.bind(Date);
      window.__fixtureClockOffset = 0;
      Date.now = () => realNow() + window.__fixtureClockOffset;
      const interval = window.setInterval.bind(window);
      window.setInterval = (handler, ms, ...args) => interval(handler, ms === 300_000 ? 100 : ms, ...args);
      if (fallback) {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      }
      if (blockedIndexedDB) {
        window.__fixtureIndexedDBAttempts = 0;
        Object.defineProperty(indexedDB, 'open', {
          configurable: true,
          value: () => {
            window.__fixtureIndexedDBAttempts++;
            throw new DOMException('IndexedDB is disabled for this fixture', 'SecurityError');
          },
        });
      }
    }, { fallback, blockedIndexedDB });
    await context.addCookies([{
      name: cookieName, value: seeded.token, url: origin, httpOnly: true, sameSite: 'Strict',
    }]);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace?keeper=${keeper ? 1 : 0}`);
    await page.waitForFunction(() => window.fixture?.ready);
    return { context, page, seeded };
  }

  async function secondPage(context, { keeper = true } = {}) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace?keeper=${keeper ? 1 : 0}`);
    await page.waitForFunction(() => window.fixture?.ready);
    return page;
  }

  async function startRequest(page, label, path, init = {}, { business = false } = {}) {
    await page.evaluate(({ label, path, init, business }) => {
      window.fixture.start(label, path, init, business);
    }, { label, path, init, business });
  }

  async function resultFor(page, label) {
    await page.waitForFunction(label => window.fixture?.results[label], label);
    return page.evaluate(label => window.fixture.results[label], label);
  }

  const countSince = (start, path) => requests.slice(start).filter(request => request.path === path).length;
  const currentCookie = async context => (await context.cookies()).find(cookie => cookie.name === cookieName);

  try {
    await build({
      stdin: {
        contents: `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SessionKeeper } from './app/components/session-keeper';
          import { apiRequest } from './app/components/api-client';
          import { fetchWithSessionCoordination, subscribeSession, renewBrowserSession,
            browserSessionGeneration } from './app/components/session-client';
          import { createSessionCookieLock } from './src/admin/session-cookie-lock.mjs';
          import { createIndexedSessionLeaseStore } from './src/admin/session-indexed-lock.mjs';
          const initial = window.__initialSession;
          const keeper = new URLSearchParams(location.search).get('keeper') !== '0';
          window.fixture = {
            ready: false, events: [], results: {}, initial, controllers: {},
            start(label, path, init, business) {
              const request = business ? apiRequest(path, init)
                : fetchWithSessionCoordination(path, init).then(async response => ({ status: response.status, payload: await response.json() }));
              request.then(value => { window.fixture.results[label] = { ok: true, value }; },
                error => { window.fixture.results[label] = { ok: false, status: error.status, code: error.code, name: error.name, message: error.message }; });
            },
            startAbortable(label, path, init) {
              const controller = new AbortController();
              window.fixture.controllers[label] = controller;
              window.fixture.start(label, path, { ...init, signal: controller.signal }, false);
            },
            abort(label) { window.fixture.controllers[label].abort(); },
            holdLock() {
              const withLock = createSessionCookieLock({ locks: navigator.locks,
                leaseStore: createIndexedSessionLeaseStore(indexedDB) });
              window.fixture.holding = false;
              withLock(() => {
                window.fixture.holding = true;
                return new Promise(resolve => { window.fixture.releaseLock = resolve; });
              }, { shared: true }).finally(() => { window.fixture.holding = false; });
            },
            renew(label) {
              renewBrowserSession(initial, () => true).then(value => { window.fixture.results[label] = { ok: true, value }; },
                error => { window.fixture.results[label] = { ok: false, status: error.status }; });
            },
            replaceSession(metadata) {
              return subscribeSession(metadata, event => window.fixture.events.push(event));
            },
            generation: browserSessionGeneration,
          };
          function App() {
            const [keepSession, setKeepSession] = useState(keeper);
            window.fixture.stopKeeper = () => setKeepSession(false);
            useEffect(() => {
              const unsubscribe = subscribeSession(initial, event => window.fixture.events.push(event));
              window.fixture.ready = true;
              return unsubscribe;
            }, []);
            useEffect(() => { window.fixture.keeperMounted = keepSession; }, [keepSession]);
            return <>
              {keepSession && <SessionKeeper session={initial} />}
              <button id="activity">真实交互</button><input aria-label="活动输入" />
            </>;
          }
          createRoot(document.getElementById('root')).render(<App />);
        `,
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser',
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    });
    const js = await readFile(join(directory, 'bundle.js'));
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://fixture');
        if (url.pathname === '/bundle.js') {
          response.setHeader('content-type', 'application/javascript'); response.end(js); return;
        }
        const token = tokenFrom(request);
        const session = sessions.get(token);
        if (!url.pathname.startsWith('/api/')) {
          response.setHeader('content-type', 'text/html');
          response.end(`<!doctype html><html><meta charset="utf-8"><body><div id="root"></div>
            <script>window.__initialSession=${JSON.stringify(session ?? null)}</script><script src="/bundle.js"></script></body></html>`);
          return;
        }
        let rawBody = ''; for await (const chunk of request) rawBody += chunk;
        const body = rawBody ? JSON.parse(rawBody) : null;
        requests.push({ method: request.method, path: url.pathname, token, sessionId: session?.sessionId, body });
        await pauseAt(url.pathname);
        if (url.pathname === '/api/ordinary') { json(response, { ok: true }); return; }
        if (url.pathname === '/api/slow-401') { json(response, { code: 'SESSION_STALE', message: '旧会话已失效' }, 401); return; }
        if (url.pathname === '/api/auth/session') {
          if (!session) json(response, { code: 'AUTH_REQUIRED', message: '请登录' }, 401);
          else json(response, { ...session, serverTime: seconds() });
          return;
        }
        if (url.pathname === '/api/auth/renew') {
          if (!session || session.sessionId !== body?.expectedSessionId) {
            json(response, { code: 'SESSION_CHANGED', message: '会话已变化' }, 409); return;
          }
          const renewed = issueSession(session.userId, {
            nearExpiry: false, sessionId: session.sessionId, absoluteExpiresAt: session.absoluteExpiresAt,
          });
          response.setHeader('set-cookie', `${cookieName}=${renewed.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
          json(response, { ...renewed.metadata, renewed: true }); return;
        }
        if (url.pathname === '/api/auth/login') {
          const loggedIn = issueSession(body?.userId ?? 2, { nearExpiry: false });
          response.setHeader('set-cookie', `${cookieName}=${loggedIn.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
          json(response, { authenticated: true, session: loggedIn.metadata }); return;
        }
        if (url.pathname === '/api/auth/logout') {
          if (session && body?.expectedSessionId && body.expectedSessionId !== session.sessionId) {
            json(response, { code: 'SESSION_CHANGED', message: '会话已变化' }, 409); return;
          }
          response.setHeader('set-cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
          json(response, { authenticated: false }); return;
        }
        if (url.pathname === '/api/control-plane/v1/profile/password') {
          // The center changes credentials; the web client must clear the corresponding cookie under its auth lock.
          json(response, { changed: true }); return;
        }
        json(response, { code: 'NOT_FOUND', message: url.pathname }, 404);
      } catch (error) {
        serverErrors.push(error.message);
        if (!response.headersSent) json(response, { code: 'FIXTURE_ERROR', message: error.message }, 500);
        else response.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.SESSION_RENEWAL_BROWSER_CHANNEL ?? 'msedge' });

    for (const fallback of [false, true]) {
      const mode = fallback ? 'IndexedDB without Web Locks or randomUUID' : 'native Web Locks';

      await t.test(`${mode}: trusted activity renews once; idle, synthetic events, ordinary requests, and duplicate tabs do not`, async () => {
        const start = requests.length;
        const { context, page, seeded } = await newContext({ fallback });
        try {
          assert.equal(await page.evaluate(() => typeof navigator.locks?.request === 'function'), !fallback);
          if (fallback) {
            assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
            assert.equal(await page.evaluate(() => typeof crypto.getRandomValues), 'function');
          }
          await page.evaluate(async () => {
            for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove']) {
              document.dispatchEvent(new Event(type, { bubbles: true }));
            }
            window.dispatchEvent(new Event('focus'));
            for (let index = 0; index < 4; index++) await fetch('/api/ordinary');
          });
          await page.waitForTimeout(350);
          assert.equal(countSince(start, '/api/auth/renew'), 0);
          assert.equal((await currentCookie(context)).value, seeded.token);

          const renewGate = requestGate(); gates.set('/api/auth/renew', renewGate);
          const other = await secondPage(context);
          await page.bringToFront();
          await page.keyboard.press('ArrowDown');
          await waitForGate(renewGate, 'the first activity renewal');
          // The second tab exercises the same production renew function while the first holds the cookie lock.
          await other.evaluate(() => window.fixture.renew('parallel'));
          await page.waitForTimeout(100);
          assert.equal(countSince(start, '/api/auth/renew'), 1);
          renewGate.release.resolve(); gates.delete('/api/auth/renew');
          await resultFor(other, 'parallel');
          await page.waitForFunction(() => window.fixture.events.some(event => event.type === 'updated' && event.session.expiresAt - event.session.serverTime > 3_600));
          assert.equal(countSince(start, '/api/auth/renew'), 1, 'the waiting tab must see the newly renewed cookie under the shared lock');
          const cookie = await currentCookie(context);
          assert.notEqual(cookie.value, seeded.token);
          assert.equal(cookie.httpOnly, true);
          assert.ok(cookie.expires > Date.now() / 1_000 + 28_700);
          await page.getByRole('button', { name: '真实交互' }).click({ clickCount: 4 });
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(250);
          assert.equal(countSince(start, '/api/auth/renew'), 1);

          // Put the cached expiry back within one hour, with the last trusted activity now seven hours old.
          await page.evaluate(() => { window.__fixtureClockOffset = 7 * 60 * 60 * 1_000 + 1_000; });
          await page.waitForTimeout(250);
          assert.equal(countSince(start, '/api/auth/renew'), 1, 'idle timer checks must not count as user activity');
          if (fallback) {
            const names = await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name));
            assert.ok(names.includes(lockDatabase), 'the actual browser IndexedDB lease store must have been used');
          }
        } finally {
          gates.get('/api/auth/renew')?.release.resolve(); gates.delete('/api/auth/renew');
          await context.close();
        }
      });

      await t.test(`${mode}: in-flight renewal completes before logout and login writes`, async () => {
        const start = requests.length;
        const { context, page } = await newContext({ fallback, keeper: false });
        const other = await secondPage(context, { keeper: false });
        try {
          const renewGate = requestGate(); gates.set('/api/auth/renew', renewGate);
          const loginGate = requestGate(); gates.set('/api/auth/login', loginGate);
          await page.evaluate(() => window.fixture.renew('renew'));
          await waitForGate(renewGate, 'renewal before auth mutations');
          await startRequest(other, 'logout', '/api/auth/logout', { method: 'POST' });
          const loginInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 2 }) };
          await startRequest(other, 'login', '/api/auth/login', loginInit);
          await other.waitForTimeout(120);
          assert.equal(countSince(start, '/api/auth/logout'), 0, 'logout must wait for the earlier Set-Cookie response');
          assert.equal(countSince(start, '/api/auth/login'), 0, 'login must also wait for the in-flight renewal');
          renewGate.release.resolve(); gates.delete('/api/auth/renew');
          assert.equal((await resultFor(page, 'renew')).ok, true);
          assert.equal((await resultFor(other, 'logout')).value.status, 200);
          await waitForGate(loginGate, 'login after logout');
          assert.equal(await currentCookie(context), undefined);
          await page.waitForTimeout(150);
          assert.equal(await currentCookie(context), undefined, 'a late renewal must not restore a logged-out cookie');
          loginGate.release.resolve(); gates.delete('/api/auth/login');
          const loggedIn = await resultFor(other, 'login');
          assert.equal(loggedIn.value.status, 200);
          const token = (await currentCookie(context)).value;
          assert.equal(sessions.get(token).userId, 2);
          assert.deepEqual(requests.slice(start).filter(request => ['/api/auth/renew', '/api/auth/logout', '/api/auth/login'].includes(request.path))
            .map(request => request.path), ['/api/auth/renew', '/api/auth/logout', '/api/auth/login']);
        } finally {
          gates.get('/api/auth/renew')?.release.resolve(); gates.delete('/api/auth/renew');
          gates.get('/api/auth/login')?.release.resolve(); gates.delete('/api/auth/login');
          await context.close();
        }
      });

      await t.test(`${mode}: old business 401 and queued password change cannot invalidate a new login`, async () => {
        const start = requests.length;
        const { context, page, seeded } = await newContext({ fallback, keeper: false });
        const other = await secondPage(context, { keeper: false });
        try {
          const staleGate = requestGate(); gates.set('/api/slow-401', staleGate);
          await startRequest(page, 'business', '/api/slow-401', {}, { business: true });
          await waitForGate(staleGate, 'old business request');
          const loginGate = requestGate(); gates.set('/api/auth/login', loginGate);
          const loginInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 2 }) };
          await startRequest(other, 'login', '/api/auth/login', loginInit);
          await waitForGate(loginGate, 'new login before queued password change');
          await startRequest(page, 'password', '/api/control-plane/v1/profile/password', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ currentPassword: 'fixture-old', newPassword: 'fixture-new-password' }),
          });
          await page.waitForTimeout(120);
          assert.equal(countSince(start, '/api/control-plane/v1/profile/password'), 0);
          loginGate.release.resolve(); gates.delete('/api/auth/login');
          const loggedIn = await resultFor(other, 'login');
          const newSession = loggedIn.value.payload.data.session;
          await page.waitForFunction(sid => window.fixture.events.some(event => event.type === 'updated' && event.sessionId === sid), newSession.sessionId);
          const password = await resultFor(page, 'password');
          assert.equal(password.value.status, 409);
          assert.equal(password.value.payload.error.code, 'SESSION_CHANGED');
          assert.equal(countSince(start, '/api/control-plane/v1/profile/password'), 0,
            'the queued password change must stop locally before reaching the center for account B');
          staleGate.release.resolve(); gates.delete('/api/slow-401');
          const business = await resultFor(page, 'business');
          assert.equal(business.ok, false);
          assert.equal(business.status, 401);
          assert.equal(business.code, 'SESSION_STALE');
          assert.ok(page.url().includes('/workspace?'), 'the old 401 must not redirect the new session to login');
          assert.equal(sessions.get((await currentCookie(context)).value).userId, 2);
          const events = await page.evaluate(() => window.fixture.events);
          assert.ok(events.some(event => event.sessionId === newSession.sessionId && event.type === 'updated'));
          assert.equal(events.some(event => event.sessionId === newSession.sessionId && event.type === 'ended'), false);
          assert.notEqual(newSession.sessionId, seeded.metadata.sessionId);
        } finally {
          gates.get('/api/auth/login')?.release.resolve(); gates.delete('/api/auth/login');
          gates.get('/api/slow-401')?.release.resolve(); gates.delete('/api/slow-401');
          await context.close();
        }
      });

      await t.test(`${mode}: successful password change completes guarded logout before a competing login`, async () => {
        const start = requests.length;
        const { context, page, seeded } = await newContext({ fallback, keeper: false });
        const other = await secondPage(context, { keeper: false });
        try {
          const logoutGate = requestGate(); gates.set('/api/auth/logout', logoutGate);
          await startRequest(page, 'password', '/api/control-plane/v1/profile/password', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ currentPassword: 'fixture-old', newPassword: 'fixture-new-password' }),
          });
          await waitForGate(logoutGate, 'guarded password cleanup');
          const cleanup = requests.slice(start).find(request => request.path === '/api/auth/logout');
          assert.equal(cleanup.body.expectedSessionId, seeded.metadata.sessionId,
            'password cleanup must target the captured account A session');
          assert.equal(cleanup.sessionId, seeded.metadata.sessionId);
          await startRequest(other, 'login', '/api/auth/login', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 2 }),
          });
          await page.waitForTimeout(120);
          assert.equal(countSince(start, '/api/auth/login'), 0,
            'the password change must retain its cookie lock through guarded logout cleanup');
          logoutGate.release.resolve(); gates.delete('/api/auth/logout');
          assert.equal((await resultFor(page, 'password')).value.status, 200);
          const loggedIn = await resultFor(other, 'login');
          assert.equal(loggedIn.value.status, 200);
          const finalToken = (await currentCookie(context)).value;
          assert.equal(sessions.get(finalToken).userId, 2);
          await page.waitForTimeout(150);
          assert.equal((await currentCookie(context)).value, finalToken, 'account A cleanup must never clear B after login');
          assert.deepEqual(requests.slice(start).filter(request => [
            '/api/control-plane/v1/profile/password', '/api/auth/logout', '/api/auth/login',
          ].includes(request.path)).map(request => request.path), [
            '/api/control-plane/v1/profile/password', '/api/auth/logout', '/api/auth/login',
          ]);
          assert.equal(countSince(start, '/api/auth/logout'), 1, 'password handling performs one guarded cleanup');
        } finally {
          gates.get('/api/auth/logout')?.release.resolve(); gates.delete('/api/auth/logout');
          await context.close();
        }
      });

      await t.test(`${mode}: a new SSR subscription advances generation before an old business 401`, async () => {
        const start = requests.length;
        const { context, page } = await newContext({ fallback, keeper: false });
        try {
          const staleGate = requestGate(); gates.set('/api/slow-401', staleGate);
          const previousGeneration = await page.evaluate(() => window.fixture.generation());
          await startRequest(page, 'business', '/api/slow-401', {}, { business: true });
          await waitForGate(staleGate, 'old request before SSR replacement');
          const replacement = issueSession(2, { nearExpiry: false });
          await context.addCookies([{
            name: cookieName, value: replacement.token, url: origin, httpOnly: true, sameSite: 'Strict',
          }]);
          await page.evaluate(metadata => window.fixture.replaceSession(metadata), replacement.metadata);
          const nextGeneration = await page.evaluate(() => window.fixture.generation());
          assert.notEqual(nextGeneration, previousGeneration,
            'SSR session identity changes must advance the request generation without a login broadcast');
          staleGate.release.resolve(); gates.delete('/api/slow-401');
          const business = await resultFor(page, 'business');
          assert.equal(business.ok, false);
          assert.equal(business.status, 401);
          assert.equal(business.code, 'SESSION_STALE');
          assert.ok(page.url().includes('/workspace?'));
          assert.equal((await currentCookie(context)).value, replacement.token);
          assert.equal(countSince(start, '/api/auth/login'), 0);
          const events = await page.evaluate(() => window.fixture.events);
          assert.equal(events.some(event => event.type === 'ended' && event.sessionId === replacement.metadata.sessionId), false);
        } finally {
          gates.get('/api/slow-401')?.release.resolve(); gates.delete('/api/slow-401');
          await context.close();
        }
      });

      await t.test(`${mode}: aborting a queued logout rejects promptly and never sends HTTP after the holder leaves`, async () => {
        const start = requests.length;
        const { context, page, seeded } = await newContext({ fallback, keeper: false });
        const other = await secondPage(context, { keeper: false });
        try {
          await page.evaluate(() => window.fixture.holdLock());
          await page.waitForFunction(() => window.fixture.holding);
          await other.evaluate(() => window.fixture.startAbortable('logout', '/api/auth/logout', { method: 'POST' }));
          await other.waitForTimeout(100);
          assert.equal(countSince(start, '/api/auth/logout'), 0);
          const abortedAt = Date.now();
          await other.evaluate(() => window.fixture.abort('logout'));
          await other.waitForFunction(() => window.fixture.results.logout, null, { timeout: 2_000 });
          const aborted = await resultFor(other, 'logout');
          assert.equal(aborted.ok, false);
          assert.equal(aborted.name, 'AbortError');
          assert.ok(Date.now() - abortedAt < 2_000, 'cancellation must not wait for the shared lock holder');
          await page.evaluate(() => window.fixture.releaseLock());
          await page.waitForFunction(() => !window.fixture.holding);
          await other.waitForTimeout(250);
          assert.equal(countSince(start, '/api/auth/logout'), 0, 'a cancelled queued action must never run later');
          assert.equal((await currentCookie(context)).value, seeded.token);
        } finally {
          await page.evaluate(() => window.fixture.releaseLock?.()).catch(() => {});
          await context.close();
        }
      });
    }

    await t.test('disabled Web Locks and IndexedDB: trusted activity cannot renew, while manual login still works', async () => {
      const start = requests.length;
      const { context, page, seeded } = await newContext({ fallback: true, blockedIndexedDB: true });
      try {
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() => window.__fixtureIndexedDBAttempts > 0);
        await page.waitForTimeout(200);
        assert.equal(countSince(start, '/api/auth/renew'), 0);
        assert.equal((await currentCookie(context)).value, seeded.token);
        await page.evaluate(() => window.fixture.renew('blocked-renew'));
        assert.equal((await resultFor(page, 'blocked-renew')).ok, false);
        assert.equal(countSince(start, '/api/auth/renew'), 0, 'uncoordinated automatic renewals must remain disabled');

        await page.evaluate(() => window.fixture.stopKeeper());
        await page.waitForFunction(() => window.fixture.keeperMounted === false);
        await startRequest(page, 'login', '/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 2 }),
        });
        const loggedIn = await resultFor(page, 'login');
        assert.equal(loggedIn.value.status, 200);
        assert.equal(loggedIn.value.payload.data.session.userId, 2);
        assert.equal(countSince(start, '/api/auth/login'), 1, 'manual login remains available when shared browser storage is blocked');
        assert.equal(sessions.get((await currentCookie(context)).value).userId, 2);
        assert.equal(countSince(start, '/api/auth/renew'), 0);
      } finally { await context.close(); }
    });
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(errors, []);
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    await removeFixtureDirectory(directory);
  }
});
