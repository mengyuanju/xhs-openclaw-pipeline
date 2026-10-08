// Run against an isolated build: TEST_NEXT_DIST_DIR must name its dist directory.
// The only upstream is a local fake center; every credential and account is synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ADMIN_SESSION_COOKIE, createSessionToken, verifySessionToken } from '../../src/admin/auth.mjs';
import { ADMIN_SESSION_SECONDS, SESSION_ABSOLUTE_SECONDS } from '../../src/admin/session-policy.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const accountFixtures = [
  { id: 71, username: 'renewal-user', role: 'USER', mustChangePassword: false },
  { id: 72, username: 'renewal-reviewer', role: 'REVIEWER', mustChangePassword: false },
  { id: 73, username: 'renewal-initial', role: 'USER', mustChangePassword: true },
].map(user => ({
  ...user,
  displayName: `Fixture ${user.role}`,
  status: 'ACTIVE',
  credentialVersion: 3,
  copyReviewEnabled: true,
  copyQcEnabled: user.role === 'REVIEWER',
  imageQcEnabled: user.role === 'REVIEWER',
}));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function actorFrom(user) {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    roles: [user.role],
    credentialVersion: user.credentialVersion,
    mustChangePassword: user.mustChangePassword,
    copyReviewEnabled: user.copyReviewEnabled,
    copyQcEnabled: user.copyQcEnabled,
    imageQcEnabled: user.imageQcEnabled,
  };
}

function sessionCookie(token) {
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

function cookieToken(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'Expected a session cookie');
  const prefix = `${ADMIN_SESSION_COOKIE}=`;
  assert.ok(value.startsWith(prefix), 'Expected the authentication cookie');
  return value.slice(prefix.length).split(';', 1)[0];
}

function assertCookieCleared(response) {
  assert.equal(cookieToken(response), '');
  assert.match(response.headers.get('set-cookie'), /(?:^|;\s*)Max-Age=0(?:;|$)/u);
}

async function readResponse(response, { status = 200, tokens = [], secret } = {}) {
  const text = await response.text();
  assert.equal(response.status, status, `Unexpected status: ${text}`);
  assert.match(response.headers.get('cache-control') || '', /(?:^|[,\s])no-store(?:$|[,\s])/u);
  for (const token of tokens) assert.ok(!text.includes(token), 'The JSON response must not disclose a token');
  if (secret) assert.ok(!text.includes(secret), 'The JSON response must not disclose the session secret');
  assert.doesNotMatch(text, /"(?:token|accessToken|refreshToken|password|passwordHash|sessionSecret|signature|jti)"\s*:/u);
  return JSON.parse(text);
}

function assertMetadata(metadata, session, user, { renewal = false } = {}) {
  assert.ok(metadata && typeof metadata === 'object');
  assert.match(metadata.sessionId, /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(metadata.sessionId, session.sessionId);
  assert.equal(metadata.userId, user.id);
  assert.equal(metadata.expiresAt, session.expiresAt);
  assert.equal(metadata.absoluteExpiresAt, session.absoluteExpiresAt);
  assert.equal(typeof metadata.renewable, 'boolean');
  if (metadata.serverTime !== undefined) assert.ok(Number.isSafeInteger(metadata.serverTime));
  for (const key of Object.keys(metadata)) {
    assert.ok(['sessionId', 'userId', 'expiresAt', 'absoluteExpiresAt', 'renewable', 'serverTime',
      ...(renewal ? ['renewed'] : [])].includes(key),
      `Unexpected public session field: ${key}`);
  }
}

test('production Next session metadata and renewal preserve identity, expiry and invalidation', {
  timeout: 60_000,
}, async (t) => {
  const distDirectory = process.env.TEST_NEXT_DIST_DIR;
  assert.ok(distDirectory, 'Build with XHS_NEXT_DIST_DIR and set TEST_NEXT_DIST_DIR before running this test');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-session-next-'));
  const secret = randomBytes(32).toString('hex');
  const profileRequests = [];
  const unexpectedRequests = [];
  let profileStatus = 200;
  let child;
  let logs = '';
  const center = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && pathname === '/v1/auth/login') {
      let body = '';
      for await (const chunk of request) body += chunk;
      let credentials;
      try { credentials = JSON.parse(body); } catch { credentials = null; }
      const user = accountFixtures.find(candidate => candidate.username === credentials?.username);
      const allowed = user && credentials?.password === 'fixture-password';
      response.writeHead(allowed ? 200 : 401);
      response.end(JSON.stringify(allowed ? { data: user } : { error: { code: 'INVALID_CREDENTIALS' } }));
      return;
    }
    if (request.method === 'GET' && pathname === '/v1/profile') {
      const user = accountFixtures.find(candidate => candidate.username === request.headers['x-actor-username']);
      const identity = {
        userId: request.headers['x-actor-user-id'],
        username: request.headers['x-actor-username'],
        role: request.headers['x-actor-role'],
        credentialVersion: request.headers['x-actor-credential-version'],
      };
      profileRequests.push(identity);
      const current = user && identity.userId === String(user.id) && identity.role === user.role
        && identity.credentialVersion === String(user.credentialVersion);
      const status = current ? profileStatus : 401;
      response.writeHead(status);
      response.end(JSON.stringify(status === 200 ? { data: user } : {
        error: { code: status === 401 ? 'SESSION_STALE' : 'CONTROL_PLANE_UNAVAILABLE' },
      }));
      return;
    }
    unexpectedRequests.push(`${request.method} ${pathname}`);
    response.writeHead(404);
    response.end(JSON.stringify({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }));
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill();
      await exited;
    }
    center.closeAllConnections();
    await new Promise(done => center.close(done));
    const withinTemp = relative(resolve(tmpdir()), resolve(temporaryRoot));
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !withinTemp.includes(':'));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const centerPort = await listen(center);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(done => probe.close(done));
  child = spawn(process.execPath, [join(projectRoot, 'node_modules/next/dist/bin/next'),
    'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      XHS_NEXT_DIST_DIR: distDirectory,
      CONTROL_PLANE_URL: `http://127.0.0.1:${centerPort}`,
      EXECUTOR_NODE_ID: 'session-regression',
      XHS_SESSION_SECRET: secret,
      XHS_DB_PATH: join(temporaryRoot, 'queue.db'),
      XHS_OUTPUT_ROOT: join(temporaryRoot, 'output'),
      XHS_ASSET_ROOT: join(temporaryRoot, 'assets'),
      XHS_KNOWLEDGE_ROOT: join(temporaryRoot, 'knowledge'),
    },
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  child.on('error', error => { logs += error.message; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, logs);
    ready = await fetch(`${base}/login`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.ok).catch(() => false);
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, logs);

  function fixtureToken(user = accountFixtures[0], { nowSeconds = Math.floor(Date.now() / 1000)
    - ADMIN_SESSION_SECONDS + 30 * 60, authenticatedAt = nowSeconds, actor = actorFrom(user) } = {}) {
    return createSessionToken(secret, { nowSeconds, actor, renewal: { authenticatedAt } });
  }

  function metadataRequest(token) {
    return fetch(`${base}/api/auth/session`, {
      headers: { cookie: sessionCookie(token) },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  }

  function renewRequest(token, { expectedSessionId = verifySessionToken(token, secret)?.sessionId,
    origin = base, extra = {} } = {}) {
    return fetch(`${base}/api/auth/renew`, {
      method: 'POST',
      headers: { cookie: sessionCookie(token), origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSessionId, ...extra }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  }

  function logoutRequest(token, { expectedSessionId, origin = base } = {}) {
    const guarded = typeof expectedSessionId === 'string';
    return fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie(token), origin,
        ...(guarded ? { 'content-type': 'application/json' } : {}) },
      ...(guarded ? { body: JSON.stringify({ expectedSessionId }) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  }

  for (const user of accountFixtures) {
    await t.test(`${user.username}: login issues a v3 session and GET metadata stays read-only`, async () => {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: 'fixture-password' }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = cookieToken(login);
      const session = verifySessionToken(token, secret);
      assert.ok(session);
      assert.equal(JSON.parse(Buffer.from(token.split('.', 1)[0], 'base64url')).v, 3);
      assert.equal(session.authenticatedAt, session.issuedAt);
      assert.equal(session.expiresAt - session.issuedAt, ADMIN_SESSION_SECONDS);
      assert.equal(session.absoluteExpiresAt - session.authenticatedAt, SESSION_ABSOLUTE_SECONDS);
      const payload = await readResponse(login, { tokens: [token], secret });
      assert.equal(payload.data.mustChangePassword, user.mustChangePassword);
      assertMetadata(payload.data.session, session, user);

      const count = profileRequests.length;
      const response = await metadataRequest(token);
      const metadata = await readResponse(response, { tokens: [token], secret });
      assert.equal(response.headers.get('set-cookie'), null);
      assertMetadata(metadata.data, session, user);
      assert.equal(profileRequests.length, count, 'Reading metadata must not call the center');
    });
    await t.test(`${user.username}: renewal reaches the fake center with the complete actor identity`, async () => {
      const token = fixtureToken(user);
      const previous = verifySessionToken(token, secret);
      const before = Math.floor(Date.now() / 1000);
      const count = profileRequests.length;
      const response = await renewRequest(token);
      const renewedToken = cookieToken(response);
      const renewed = verifySessionToken(renewedToken, secret);
      const payload = await readResponse(response, { tokens: [token, renewedToken], secret });
      assert.equal(payload.data.renewed, true);
      assert.ok(renewed);
      assert.equal(renewed.sessionId, previous.sessionId);
      assert.equal(renewed.authenticatedAt, previous.authenticatedAt);
      assert.equal(renewed.absoluteExpiresAt, previous.absoluteExpiresAt);
      assert.equal(renewed.userId, user.id);
      assert.equal(renewed.credentialVersion, user.credentialVersion);
      assert.equal(renewed.issuedAt >= before, true);
      assert.equal(renewed.expiresAt - renewed.issuedAt, ADMIN_SESSION_SECONDS);
      assertMetadata(payload.data, renewed, user, { renewal: true });
      assert.match(response.headers.get('set-cookie'), /(?:^|;\s*)HttpOnly(?:;|$)/u);
      assert.match(response.headers.get('set-cookie'), /(?:^|;\s*)SameSite=Strict(?:;|$)/u);
      assert.equal(profileRequests.length, count + 1);
      assert.deepEqual(profileRequests.at(-1), {
        userId: String(user.id), username: user.username, role: user.role,
        credentialVersion: String(user.credentialVersion),
      });
    });
  }

  await t.test('legacy user sessions migrate without resetting their original login time', async () => {
    const user = accountFixtures[0];
    const nowSeconds = Math.floor(Date.now() / 1000) - ADMIN_SESSION_SECONDS + 30 * 60;
    const token = createSessionToken(secret, { nowSeconds, actor: actorFrom(user) });
    const previous = verifySessionToken(token, secret, { includeMetadata: true });
    const metadata = await metadataRequest(token);
    const metadataPayload = await readResponse(metadata, { tokens: [token], secret });
    assert.equal(metadata.headers.get('set-cookie'), null);
    assertMetadata(metadataPayload.data, previous, user);
    assert.equal(metadataPayload.data.renewable, true);
    const response = await renewRequest(token, { expectedSessionId: previous.sessionId });
    const renewedToken = cookieToken(response);
    const renewed = verifySessionToken(renewedToken, secret);
    const payload = await readResponse(response, { tokens: [token, renewedToken], secret });
    assert.equal(payload.data.renewed, true);
    assert.equal(JSON.parse(Buffer.from(renewedToken.split('.', 1)[0], 'base64url')).v, 3);
    assert.equal(renewed.sessionId, previous.sessionId);
    assert.equal(renewed.authenticatedAt, previous.issuedAt);
    assert.equal(renewed.absoluteExpiresAt, previous.issuedAt + SESSION_ABSOLUTE_SECONDS);
    assertMetadata(payload.data, renewed, user, { renewal: true });
  });

  await t.test('renewal before the last hour leaves the cookie and center untouched', async () => {
    const token = fixtureToken(accountFixtures[0], { nowSeconds: Math.floor(Date.now() / 1000) });
    const count = profileRequests.length;
    const response = await renewRequest(token);
    const payload = await readResponse(response, { tokens: [token], secret });
    assert.equal(payload.data.renewed, false);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('renewal stops at seven days and serializes the shortened cookie lifetime', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const authenticatedAt = nowSeconds - SESSION_ABSOLUTE_SECONDS + 30 * 60;
    const token = fixtureToken(accountFixtures[0], {
      nowSeconds: nowSeconds - ADMIN_SESSION_SECONDS + 15 * 60, authenticatedAt,
    });
    const previous = verifySessionToken(token, secret);
    const response = await renewRequest(token);
    const renewedToken = cookieToken(response);
    const renewed = verifySessionToken(renewedToken, secret);
    const payload = await readResponse(response, { tokens: [token, renewedToken], secret });
    assert.equal(payload.data.renewed, true);
    assert.ok(renewed);
    assert.equal(renewed.authenticatedAt, authenticatedAt);
    assert.equal(renewed.expiresAt, authenticatedAt + SESSION_ABSOLUTE_SECONDS);
    assert.ok(renewed.expiresAt > previous.expiresAt);
    const maxAge = Number(/(?:^|;\s*)Max-Age=(\d+)(?:;|$)/u.exec(response.headers.get('set-cookie'))?.[1]);
    assert.ok(Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 30 * 60);
    assert.ok(Math.abs(maxAge - (renewed.expiresAt - renewed.issuedAt)) <= 2);
    assertMetadata(payload.data, renewed, accountFixtures[0], { renewal: true });

    const count = profileRequests.length;
    const secondResponse = await renewRequest(renewedToken);
    const secondPayload = await readResponse(secondResponse, { tokens: [renewedToken], secret });
    assert.equal(secondPayload.data.renewed, false);
    assert.equal(secondResponse.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('a mismatched session ID rejects a stale tab without changing the cookie', async () => {
    const token = fixtureToken();
    const count = profileRequests.length;
    const response = await renewRequest(token, { expectedSessionId: randomBytes(16).toString('base64url') });
    await readResponse(response, { status: 409, tokens: [token], secret });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('cross-origin renewal is rejected before the center is called', async () => {
    const token = fixtureToken();
    const count = profileRequests.length;
    const response = await renewRequest(token, { origin: 'https://foreign.example' });
    await readResponse(response, { status: 403, tokens: [token], secret });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('strict renewal input rejects extra fields without a cookie mutation', async () => {
    const token = fixtureToken();
    const count = profileRequests.length;
    const response = await renewRequest(token, { extra: { credentialVersion: 1000 } });
    await readResponse(response, { status: 400, tokens: [token], secret });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('expired sessions cannot read metadata or renew', async () => {
    const token = fixtureToken(accountFixtures[0], { nowSeconds: Math.floor(Date.now() / 1000)
      - ADMIN_SESSION_SECONDS - 1 });
    const count = profileRequests.length;
    const metadata = await metadataRequest(token);
    await readResponse(metadata, { status: 401, tokens: [token], secret });
    assert.equal(metadata.headers.get('set-cookie'), null);
    const response = await renewRequest(token, { expectedSessionId: randomBytes(16).toString('base64url') });
    await readResponse(response, { status: 401, tokens: [token], secret });
    const cleared = response.headers.get('set-cookie');
    if (cleared !== null) assertCookieCleared(response);
    assert.equal(profileRequests.length, count);
  });

  await t.test('the center rejecting current identity clears the old session cookie', async () => {
    const token = fixtureToken();
    profileStatus = 401;
    try {
      const response = await renewRequest(token);
      await readResponse(response, { status: 401, tokens: [token], secret });
      assertCookieCleared(response);
    } finally {
      profileStatus = 200;
    }
  });

  await t.test('a stale credential version cannot obtain a new signed session', async () => {
    const user = accountFixtures[0];
    const token = fixtureToken(user, { actor: { ...actorFrom(user), credentialVersion: user.credentialVersion - 1 } });
    const response = await renewRequest(token);
    await readResponse(response, { status: 401, tokens: [token], secret });
    assertCookieCleared(response);
  });

  await t.test('a center outage preserves the cookie and remains retryable', async () => {
    const token = fixtureToken();
    profileStatus = 503;
    try {
      const response = await renewRequest(token);
      await readResponse(response, { status: 503, tokens: [token], secret });
      assert.equal(response.headers.get('set-cookie'), null);
    } finally {
      profileStatus = 200;
    }
    const response = await renewRequest(token);
    const renewedToken = cookieToken(response);
    const payload = await readResponse(response, { tokens: [token, renewedToken], secret });
    assert.equal(payload.data.renewed, true);
  });

  const accountAToken = fixtureToken(accountFixtures[0]);
  const accountBToken = fixtureToken(accountFixtures[1]);
  const accountASession = verifySessionToken(accountAToken, secret);
  const accountBSession = verifySessionToken(accountBToken, secret);
  assert.notEqual(accountASession.sessionId, accountBSession.sessionId);

  await t.test('a stale tab cannot clear the cookie after switching accounts', async () => {
    const count = profileRequests.length;
    const response = await logoutRequest(accountBToken, { expectedSessionId: accountASession.sessionId });
    const payload = await readResponse(response, { status: 409, tokens: [accountAToken, accountBToken], secret });
    assert.equal(payload.error.code, 'SESSION_CHANGED');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  await t.test('logout clears the cookie when the current session matches the expected ID', async () => {
    const count = profileRequests.length;
    const response = await logoutRequest(accountBToken, { expectedSessionId: accountBSession.sessionId });
    const payload = await readResponse(response, { tokens: [accountBToken], secret });
    assert.equal(payload.data.authenticated, false);
    assertCookieCleared(response);
    assert.equal(profileRequests.length, count);
  });

  await t.test('legacy logout clients without a request body can still clear the cookie', async () => {
    const count = profileRequests.length;
    const response = await logoutRequest(accountBToken);
    const payload = await readResponse(response, { tokens: [accountBToken], secret });
    assert.equal(payload.data.authenticated, false);
    assertCookieCleared(response);
    assert.equal(profileRequests.length, count);
  });

  await t.test('cross-origin logout cannot clear the current cookie', async () => {
    const count = profileRequests.length;
    const response = await logoutRequest(accountBToken, {
      expectedSessionId: accountBSession.sessionId, origin: 'https://foreign.example',
    });
    await readResponse(response, { status: 403, tokens: [accountBToken], secret });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(profileRequests.length, count);
  });

  assert.deepEqual(unexpectedRequests, []);
  assert.doesNotMatch(logs, /ERR_INVALID_ARG_TYPE|unhandledRejection/iu);
});
