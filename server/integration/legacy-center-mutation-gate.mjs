// This acceptance test starts a production Next server against a synthetic V1
// center. It uses no PostgreSQL, repository data, credentials or model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

async function listen(server) {
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function waitUntil(action, predicate, message, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await action();
    if (predicate(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`${message}; latest=${JSON.stringify(latest)}`);
}

test('production Next refuses assignment writes before forwarding them to a legacy center', {
  timeout: 60_000,
}, async (t) => {
  assert.ok(process.env.TEST_NEXT_DIST_DIR, 'set TEST_NEXT_DIST_DIR to a production Next build');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-legacy-center-gate-'));
  const nextLogPath = join(temporaryRoot, 'next.log');
  const user = {
    id: 1,
    username: 'admin',
    displayName: 'Legacy Gate Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    credentialVersion: 1,
    mustChangePassword: false,
  };
  const mutationHits = [];
  let healthHits = 0;
  let nextProcess;

  const legacyCenter = createHttpServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/v1/auth/login' && request.method === 'POST') {
      for await (const _chunk of request) { /* consume the bounded login body */ }
      response.end(JSON.stringify({ data: user }));
      return;
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      healthHits += 1;
      response.end(JSON.stringify({
        data: {
          ok: true,
          capabilities: { taskAssignmentVersion: 1, autoAssignmentPoolVersion: 1 },
        },
      }));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) mutationHits.push(`${request.method} ${url.pathname}`);
    for await (const _chunk of request) { /* consume any unexpectedly forwarded body */ }
    response.end(JSON.stringify({ data: { acceptedByLegacyCenter: true } }));
  });
  await listen(legacyCenter);

  t.after(async () => {
    if (nextProcess && nextProcess.exitCode === null) {
      const exited = new Promise((resolveExit) => nextProcess.once('exit', resolveExit));
      nextProcess.kill();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    }
    await closeServer(legacyCenter);
    const temporaryPath = relative(resolve(tmpdir()), temporaryRoot);
    assert.ok(temporaryPath && !temporaryPath.startsWith('..') && !temporaryPath.includes(':'));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const portProbe = createNetServer();
  await listen(portProbe);
  const nextPort = portProbe.address().port;
  await closeServer(portProbe);
  const nextLog = openSync(nextLogPath, 'a');
  nextProcess = spawn(process.execPath, [
    'node_modules/next/dist/bin/next',
    'start',
    '-H', '127.0.0.1',
    '-p', String(nextPort),
  ], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', nextLog, nextLog],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      XHS_NEXT_DIST_DIR: process.env.TEST_NEXT_DIST_DIR,
      CONTROL_PLANE_URL: `http://127.0.0.1:${legacyCenter.address().port}`,
      EXECUTOR_NODE_ID: 'legacy-gate',
      XHS_SESSION_SECRET: randomBytes(32).toString('hex'),
      XHS_DB_PATH: join(temporaryRoot, 'web-queue.db'),
      XHS_OUTPUT_ROOT: join(temporaryRoot, 'web-output'),
    },
  });
  closeSync(nextLog);
  const nextRoot = `http://127.0.0.1:${nextPort}`;
  await waitUntil(
    async () => {
      if (nextProcess.exitCode !== null) return { ready: false, exitCode: nextProcess.exitCode };
      return fetch(`${nextRoot}/login`).then((result) => ({ ready: result.ok })).catch(() => ({ ready: false }));
    },
    (status) => status.ready === true,
    `production Next did not start; log=${await readFile(nextLogPath, 'utf8').catch(() => '')}`,
  );

  const login = await fetch(`${nextRoot}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: nextRoot },
    body: JSON.stringify({ username: 'admin', password: 'synthetic-test-password' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await login.json()));
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);

  for (const requestCase of [
    ['/api/control-plane/v1/tasks', 'POST', {
      nodeId: 'legacy-gate', assignedToUserId: null, tasks: [{ query: '不得转发' }],
    }],
    ['/api/control-plane/v1/tasks/1/assignee', 'PATCH', {
      assignedToUserId: 'alice', assignedToAccountId: 2,
    }],
    ['/api/control-plane/v1/tasks/batch-assignee', 'POST', {
      taskIds: [1], assignedToUserId: 'alice', assignedToAccountId: 2,
    }],
    ['/api/control-plane/v1/auto-assignment/workers/alice', 'DELETE', {
      accountId: 2, expectedVersion: 1,
    }],
  ]) {
    const [path, method, body] = requestCase;
    const response = await fetch(`${nextRoot}${path}`, {
      method,
      headers: { cookie, origin: nextRoot, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 503, `${method} ${path}: ${JSON.stringify(payload)}`);
    assert.equal(payload.error.code, 'CONTROL_PLANE_UPGRADE_REQUIRED');
  }

  assert.equal(healthHits, 4);
  assert.deepEqual(mutationHits, []);
});
