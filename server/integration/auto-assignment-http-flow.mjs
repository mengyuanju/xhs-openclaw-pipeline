// This acceptance test always creates its own local PostgreSQL cluster and HTTP
// server. It never loads .env, reads DATABASE_URL, contacts a model, or connects
// to the development services on ports 4310/3001.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { migrateDatabase } from '../src/database-migrations.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  AUTO_ASSIGNMENT_ACTOR,
  startAutoAssignmentReplenishment,
} from '../src/task-auto-assignment-runner.mjs';
import { requestIdAt } from '../tests/fixtures/claim-request-id.mjs';

const DEFAULT_PASSWORD = '123456';
const jsonHeaders = Object.freeze({ 'content-type': 'application/json' });
const validCopy = {
  reviewed: {
    copy: {
      title: '桌面整理',
      body: '整理桌面。'.repeat(90),
      tags: ['#收纳', '#桌面', '#整理'],
    },
    imagePlan: Array.from({ length: 3 }, (_, index) => ({
      kind: index === 0 ? 'hero' : 'steps',
      headline: '整理桌面',
      subtitle: '物品分区摆放',
      bullets: ['清理杂物', '整理线材'],
      prompt: '明亮整洁的桌面，展示物品分区收纳。',
    })),
  },
};

function actorHeaders(user) {
  return {
    'X-Actor-User-Id': String(user.id),
    'X-Actor-Username': user.username,
    'X-Actor-Role': user.role,
    'X-Actor-Credential-Version': String(user.credentialVersion),
  };
}

async function listen(app) {
  return new Promise((resolveServer, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolveServer(server));
    server.once('error', reject);
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function waitUntil(action, predicate, message, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await action();
    if (predicate(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`${message}; latest=${JSON.stringify(latest)}`);
}

test('isolated HTTP: account lifecycle, delayed review assignment, visibility and refill', {
  timeout: 120_000,
}, async (t) => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to a local PostgreSQL bin directory');
  assert.ok(process.env.TEST_NEXT_DIST_DIR, 'set TEST_NEXT_DIST_DIR to an isolated production Next build');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-auto-assignment-http-pg-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const commandLog = join(temporaryRoot, 'commands.log');
  let postgresStarted = false;
  let pool;
  let http;
  let nextProcess;
  let stopReplenishment;

  async function command(name, args) {
    const descriptor = openSync(commandLog, 'a');
    try {
      const executable = join(
        process.env.TEST_POSTGRES_BIN,
        name + (process.platform === 'win32' ? '.exe' : ''),
      );
      const child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', descriptor, descriptor],
      });
      const code = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', resolveExit);
      });
      assert.equal(code, 0, await readFile(commandLog, 'utf8'));
    } finally {
      closeSync(descriptor);
    }
  }

  t.after(async () => {
    await stopReplenishment?.();
    if (nextProcess && nextProcess.exitCode === null) {
      const exited = new Promise((resolveExit) => nextProcess.once('exit', resolveExit));
      nextProcess.kill();
      await Promise.race([
        exited,
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      ]);
    }
    await closeServer(http);
    await pool?.end();
    if (postgresStarted) {
      await command('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']);
    }
    const temporaryPath = relative(resolve(tmpdir()), temporaryRoot);
    assert.ok(temporaryPath && !temporaryPath.startsWith('..') && !temporaryPath.includes(':'));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const portProbe = createServer();
  await new Promise((ready) => portProbe.listen(0, '127.0.0.1', ready));
  const postgresPort = portProbe.address().port;
  await new Promise((closed) => portProbe.close(closed));

  await command('initdb', [
    '-D', dataDirectory,
    '-A', 'trust',
    '-U', 'postgres',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  await command('pg_ctl', [
    '-D', dataDirectory,
    '-l', join(temporaryRoot, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${postgresPort}`,
    '-w', 'start',
  ]);
  postgresStarted = true;
  t.diagnostic('disposable local PostgreSQL started');

  pool = new pg.Pool({
    host: '127.0.0.1',
    port: postgresPort,
    user: 'postgres',
    database: 'postgres',
    max: 12,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    lock_timeout: 3_000,
  });
  await migrateDatabase(pool);
  assert.deepEqual(await migrateDatabase(pool), []);

  const repository = new PostgresControlPlaneRepository({ pool });
  const unexpectedModelCall = async () => {
    assert.fail('the assignment acceptance test must not invoke a model');
  };
  const app = createControlPlaneApp({
    repository,
    storageRoot: join(temporaryRoot, 'assets'),
    analyzeCopy: unexpectedModelCall,
    analyzeVisual: unexpectedModelCall,
  });
  http = await listen(app);
  const root = `http://127.0.0.1:${http.address().port}`;

  async function request(path, {
    method = 'GET',
    actor = null,
    body,
    expectedStatus = 200,
  } = {}) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        ...(actor ? actorHeaders(actor) : {}),
        ...(body === undefined ? {} : jsonHeaders),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload.data ?? payload.error;
  }

  const admin = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'admin', password: DEFAULT_PASSWORD },
  });
  assert.deepEqual({ username: admin.username, role: admin.role }, {
    username: 'admin', role: 'ADMIN',
  });

  const nextPortProbe = createServer();
  await new Promise((ready) => nextPortProbe.listen(0, '127.0.0.1', ready));
  const nextPort = nextPortProbe.address().port;
  await new Promise((closed) => nextPortProbe.close(closed));
  const nextLog = openSync(join(temporaryRoot, 'next.log'), 'a');
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
      CONTROL_PLANE_URL: root,
      EXECUTOR_NODE_ID: 'http-flow',
      XHS_SESSION_SECRET: randomBytes(32).toString('hex'),
      XHS_DB_PATH: join(temporaryRoot, 'web-queue.db'),
      XHS_OUTPUT_ROOT: join(temporaryRoot, 'web-output'),
    },
  });
  closeSync(nextLog);
  const nextRoot = `http://127.0.0.1:${nextPort}`;
  await waitUntil(
    async () => {
      if (nextProcess.exitCode !== null) {
        return { ready: false, exited: nextProcess.exitCode };
      }
      return fetch(`${nextRoot}/login`).then((response) => ({ ready: response.ok })).catch(() => ({ ready: false }));
    },
    (status) => status.ready === true,
    `isolated Next proxy did not start; log=${join(temporaryRoot, 'next.log')}`,
    { timeoutMs: 30_000 },
  );

  async function nextSession(username) {
    const response = await fetch(`${nextRoot}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: nextRoot },
      body: JSON.stringify({ username, password: DEFAULT_PASSWORD }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `Next login ${username}: ${JSON.stringify(payload)}`);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, `Next login ${username} must issue a session cookie`);
    return cookie;
  }

  async function nextRequest(path, {
    method = 'GET',
    cookie,
    body,
    expectedStatus = 200,
  } = {}) {
    const response = await fetch(`${nextRoot}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(!['GET', 'HEAD'].includes(method) ? { origin: nextRoot } : {}),
        ...(body === undefined ? {} : jsonHeaders),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload.data ?? payload.error;
  }

  const anonymousTasks = await nextRequest('/api/control-plane/v1/tasks?mine=true', {
    expectedStatus: 401,
  });
  assert.equal(anonymousTasks.code, 'AUTH_REQUIRED');
  const adminCookie = await nextSession('admin');

  // Exercise every direct session-backed Next adapter. The control plane has
  // strict actor authentication enabled, so 200 proves all four identity
  // fields, including the immutable user id, reached the center.
  for (const path of ['/api/prompts', '/api/human-quality-settings', '/api/web-search-settings']) {
    await nextRequest(path, { cookie: adminCookie });
  }
  const profileResponse = await fetch(`${nextRoot}/profile`, {
    headers: { cookie: adminCookie },
    redirect: 'manual',
  });
  assert.equal(profileResponse.status, 200, 'central-user profile request must carry the complete actor identity');

  const createdAlice = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.alice', displayName: 'Flow Alice', role: 'USER' },
    expectedStatus: 201,
  });
  const createdBob = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.bob', displayName: 'Flow Bob', role: 'USER' },
    expectedStatus: 201,
  });
  const createdReviewer = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.reviewer', displayName: 'Flow Reviewer', role: 'REVIEWER' },
    expectedStatus: 201,
  });
  const createdSecondaryAdmin = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.admin2', displayName: 'Flow Secondary Admin', role: 'ADMIN' },
    expectedStatus: 201,
  });
  assert.equal(createdAlice.mustChangePassword, true);
  assert.equal(createdBob.mustChangePassword, true);
  assert.equal(createdReviewer.mustChangePassword, true);

  const alice = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'flow.alice', password: DEFAULT_PASSWORD },
  });
  const bob = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'flow.bob', password: DEFAULT_PASSWORD },
  });
  assert.equal(alice.role, 'USER');
  assert.equal(bob.role, 'USER');
  const reviewer = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'flow.reviewer', password: DEFAULT_PASSWORD },
  });
  assert.equal(reviewer.role, 'REVIEWER');
  const aliceCookie = await nextSession('flow.alice');
  const bobCookie = await nextSession('flow.bob');
  const reviewerCookie = await nextSession('flow.reviewer');
  const secondaryAdminCookie = await nextSession('flow.admin2');

  await request('/v1/nodes', {
    method: 'POST',
    body: {
      nodeId: 'http-flow',
      nodeName: 'HTTP Flow Executor',
      imageWorkerEnabled: true,
      copyConcurrency: 3,
      imageConcurrency: 1,
    },
  });

  const initialPool = await nextRequest('/api/control-plane/v1/auto-assignment', {
    cookie: adminCookie,
  });
  assert.equal(initialPool.settings.enabled, false);
  assert.deepEqual(initialPool.workers, []);

  const stalePoolTarget = await nextRequest('/api/control-plane/v1/auto-assignment/workers/flow.alice', {
    method: 'PUT', cookie: adminCookie,
    body: { accountId: createdBob.id, status: 'ACTIVE', assignmentLimit: 2 },
    expectedStatus: 409,
  });
  assert.equal(stalePoolTarget.code, 'ASSIGNEE_UNAVAILABLE');

  await nextRequest('/api/control-plane/v1/auto-assignment/workers/flow.alice', {
    method: 'PUT', cookie: adminCookie,
    body: { accountId: createdAlice.id, status: 'ACTIVE', assignmentLimit: 2 },
  });
  const poolWithAlice = await nextRequest('/api/control-plane/v1/auto-assignment', {
    cookie: adminCookie,
  });
  const alicePoolEntry = poolWithAlice.workers.find((worker) => worker.username === 'flow.alice');
  assert.equal(alicePoolEntry.accountId, createdAlice.id);
  await nextRequest('/api/control-plane/v1/auto-assignment/workers/flow.alice', {
    method: 'DELETE', cookie: adminCookie,
    body: { accountId: createdAlice.id, expectedVersion: alicePoolEntry.version },
  });
  const poolWithoutAlice = await nextRequest('/api/control-plane/v1/auto-assignment', {
    cookie: adminCookie,
  });
  assert.equal(poolWithoutAlice.workers.some((worker) => worker.username === 'flow.alice'), false);
  await nextRequest('/api/control-plane/v1/auto-assignment/workers/flow.alice', {
    method: 'PUT', cookie: adminCookie,
    body: { accountId: createdAlice.id, status: 'ACTIVE', assignmentLimit: 2 },
  });
  await nextRequest('/api/control-plane/v1/auto-assignment/workers/flow.bob', {
    method: 'PUT', cookie: adminCookie,
    body: { accountId: createdBob.id, status: 'ACTIVE', assignmentLimit: 1 },
  });

  const staleManualTarget = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: adminCookie,
    body: {
      nodeId: 'http-flow',
      assignedToUserId: 'flow.bob',
      assignedToAccountId: createdAlice.id,
      skipCopyReview: true,
      tasks: [{ query: '错误账号组合不得创建' }],
    },
    expectedStatus: 409,
  });
  assert.equal(staleManualTarget.code, 'ASSIGNEE_UNAVAILABLE');
  const missingBypassAssignee = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: adminCookie,
    body: {
      nodeId: 'http-flow',
      skipCopyReview: true,
      tasks: [{ query: '免审核任务必须明确负责人' }],
    },
    expectedStatus: 409,
  });
  assert.equal(missingBypassAssignee.code, 'SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED');

  const pendingTasks = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: adminCookie,
    body: {
      nodeId: 'http-flow',
      assignedToUserId: null,
      tasks: [{ query: '待分配任务 1' }, { query: '待分配任务 2' }],
    },
    expectedStatus: 201,
  });
  assert.ok(pendingTasks.every((task) => task.assignedToUserId === null));

  const manualRouteTasks = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: adminCookie,
    body: {
      nodeId: 'http-flow', assignedToUserId: null,
      tasks: [{ query: '单条改派链路' }, { query: '批量改派链路' }],
    },
    expectedStatus: 201,
  });
  const staleSingleAssignment = await nextRequest(
    `/api/control-plane/v1/tasks/${manualRouteTasks[0].id}/assignee`,
    {
      method: 'PATCH', cookie: adminCookie,
      body: { assignedToUserId: 'flow.bob', assignedToAccountId: createdAlice.id },
      expectedStatus: 409,
    },
  );
  assert.equal(staleSingleAssignment.code, 'ASSIGNEE_UNAVAILABLE');
  const staleBatchAssignment = await nextRequest('/api/control-plane/v1/tasks/batch-assignee', {
    method: 'POST', cookie: adminCookie,
    body: {
      taskIds: [manualRouteTasks[1].id],
      assignedToUserId: 'flow.alice',
      assignedToAccountId: createdBob.id,
    },
    expectedStatus: 409,
  });
  assert.equal(staleBatchAssignment.code, 'ASSIGNEE_UNAVAILABLE');
  const prematureSingleAssignment = await nextRequest(
    `/api/control-plane/v1/tasks/${manualRouteTasks[0].id}/assignee`,
    {
      method: 'PATCH', cookie: adminCookie,
      body: { assignedToUserId: 'flow.alice', assignedToAccountId: createdAlice.id },
      expectedStatus: 409,
    },
  );
  assert.equal(prematureSingleAssignment.code, 'TASK_NOT_READY_FOR_ASSIGNMENT');
  const prematureBatchAssignment = await nextRequest('/api/control-plane/v1/tasks/batch-assignee', {
    method: 'POST', cookie: adminCookie,
    body: {
      taskIds: [manualRouteTasks[1].id],
      assignedToUserId: 'flow.bob',
      assignedToAccountId: createdBob.id,
    },
    expectedStatus: 409,
  });
  assert.equal(prematureBatchAssignment.code, 'TASK_NOT_READY_FOR_ASSIGNMENT');

  const aliceTasks = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: aliceCookie,
    body: {
      nodeId: 'http-flow',
      tasks: [{ query: 'Alice 旧任务 1' }, { query: 'Alice 旧任务 2' }],
    },
    expectedStatus: 201,
  });
  async function nextPersonalTasks(username, cookie) {
    const response = await fetch(`${nextRoot}/api/control-plane/v1/tasks?mine=true&sortBy=createdAt&sortOrder=asc`, {
      headers: { cookie },
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `Next personal tasks ${username}: ${JSON.stringify(payload)}`);
    return payload.data;
  }

  const aliceThroughNext = await nextPersonalTasks('flow.alice', aliceCookie);
  assert.deepEqual(aliceThroughNext.map((task) => task.id), aliceTasks.map((task) => task.id));
  assert.ok(aliceThroughNext.every((task) => task.assignedToUserId === null));
  assert.deepEqual(await nextPersonalTasks('flow.reviewer', reviewerCookie), []);
  const adminThroughNext = await nextPersonalTasks('admin', adminCookie);
  assert.deepEqual(
    adminThroughNext.map((task) => task.id),
    [...pendingTasks, ...manualRouteTasks].map((task) => task.id),
  );
  assert.ok(adminThroughNext.every((task) => task.assignedToUserId === null));
  const reviewerStatistics = await nextRequest('/api/workbench-statistics?scope=personal&period=today', {
    cookie: reviewerCookie,
  });
  assert.equal(reviewerStatistics.summary.total, 0);
  const reviewerOtherTasks = await nextRequest('/api/control-plane/v1/tasks?assignedToUserId=flow.bob', {
    cookie: reviewerCookie,
    expectedStatus: 403,
  });
  assert.equal(reviewerOtherTasks.code, 'FORBIDDEN');

  const [originalReviewerTask] = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: reviewerCookie,
    body: { nodeId: 'http-flow', tasks: [{ query: '同名账号旧任务' }] },
    expectedStatus: 201,
  });
  await nextRequest(`/api/control-plane/v1/tasks/${originalReviewerTask.id}/cancel`, {
    method: 'POST', cookie: reviewerCookie, body: {},
  });

  await nextRequest(`/api/control-plane/v1/users/${createdReviewer.id}`, {
    method: 'DELETE', cookie: adminCookie,
    body: { expectedVersion: createdReviewer.version },
  });
  const replacementReviewer = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.reviewer', displayName: 'Flow Reviewer Replacement', role: 'REVIEWER' },
    expectedStatus: 201,
  });
  assert.notEqual(replacementReviewer.id, createdReviewer.id);
  assert.equal(replacementReviewer.credentialVersion, 1);

  const staleReviewer = await nextRequest('/api/control-plane/v1/tasks?mine=true', {
    cookie: reviewerCookie,
    expectedStatus: 401,
  });
  assert.equal(staleReviewer.code, 'SESSION_STALE');
  const staleStatistics = await nextRequest('/api/workbench-statistics?scope=personal&period=today', {
    cookie: reviewerCookie,
    expectedStatus: 401,
  });
  assert.equal(staleStatistics.code, 'STATISTICS_ACCESS_DENIED');
  const staleQualitySettings = await nextRequest('/api/human-quality-settings', {
    cookie: reviewerCookie,
    expectedStatus: 401,
  });
  assert.equal(staleQualitySettings.code, 'SESSION_STALE');
  const visualForm = new FormData();
  visualForm.set('file', new File([Buffer.from([0])], 'stale.png', { type: 'image/png' }));
  const staleVisualResponse = await fetch(`${nextRoot}/api/visual-analyses`, {
    method: 'POST',
    headers: { cookie: reviewerCookie, origin: nextRoot },
    body: visualForm,
  });
  const staleVisual = await staleVisualResponse.json();
  assert.equal(staleVisualResponse.status, 401, JSON.stringify(staleVisual));
  assert.equal(staleVisual.error.code, 'SESSION_STALE');
  const staleKnowledgeAsset = await nextRequest('/api/knowledge-assets/1', {
    cookie: reviewerCookie,
    expectedStatus: 401,
  });
  assert.equal(staleKnowledgeAsset.code, 'SESSION_STALE');
  const staleProfile = await fetch(`${nextRoot}/profile`, {
    headers: { cookie: reviewerCookie },
    redirect: 'manual',
  });
  assert.equal(staleProfile.status, 307);
  assert.equal(staleProfile.headers.get('location'), '/login?reauth=1&next=%2Fprofile');
  const replacementReviewerCookie = await nextSession('flow.reviewer');
  assert.deepEqual(await nextPersonalTasks('flow.reviewer', replacementReviewerCookie), []);
  const [replacementReviewerTask] = await nextRequest('/api/control-plane/v1/tasks', {
    method: 'POST', cookie: replacementReviewerCookie,
    body: { nodeId: 'http-flow', tasks: [{ query: '同名账号新任务' }] },
    expectedStatus: 201,
  });
  const replacementCreatorPage = await nextRequest(
    `/api/control-plane/v1/tasks?createdByUserId=flow.reviewer&createdByAccountId=${replacementReviewer.id}&includeTotal=true`,
    { cookie: adminCookie },
  );
  assert.equal(replacementCreatorPage.total, 1);
  assert.deepEqual(replacementCreatorPage.items.map((task) => task.id), [replacementReviewerTask.id]);
  assert.equal(replacementCreatorPage.items[0].createdByAccountId, replacementReviewer.id);
  const deletedCreatorPage = await nextRequest(
    `/api/control-plane/v1/tasks?createdByUserId=flow.reviewer&createdByAccountId=${createdReviewer.id}&includeTotal=true`,
    { cookie: adminCookie },
  );
  assert.equal(deletedCreatorPage.total, 0);
  assert.deepEqual(deletedCreatorPage.items, []);
  const historicalCreatorPage = await nextRequest(
    `/api/control-plane/v1/tasks?taskId=${originalReviewerTask.id}&includeTotal=true`,
    { cookie: adminCookie },
  );
  assert.equal(historicalCreatorPage.total, 1);
  assert.equal(historicalCreatorPage.items[0].createdByAccountId, null);
  assert.equal(historicalCreatorPage.items[0].createdByDisplayName, null);
  await nextRequest(`/api/control-plane/v1/tasks/${replacementReviewerTask.id}/cancel`, {
    method: 'POST', cookie: replacementReviewerCookie, body: {},
  });

  await nextRequest(`/api/control-plane/v1/users/${createdSecondaryAdmin.id}`, {
    method: 'DELETE', cookie: adminCookie,
    body: { expectedVersion: createdSecondaryAdmin.version },
  });
  const replacementSecondaryAdmin = await nextRequest('/api/control-plane/v1/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'flow.admin2', displayName: 'Flow Secondary Admin Replacement', role: 'ADMIN' },
    expectedStatus: 201,
  });
  assert.notEqual(replacementSecondaryAdmin.id, createdSecondaryAdmin.id);
  for (const path of ['/api/prompts', '/api/web-search-settings']) {
    const staleAdmin = await nextRequest(path, {
      cookie: secondaryAdminCookie,
      expectedStatus: 401,
    });
    assert.equal(staleAdmin.code, 'SESSION_STALE');
  }

  const schedulerErrors = [];
  stopReplenishment = startAutoAssignmentReplenishment(repository, {
    intervalMs: 20,
    log: {
      log() {},
      error(message) { schedulerErrors.push(message); },
    },
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const stillDisabled = await request('/v1/tasks?unassigned=true&state=COPY_QUEUED&sortBy=createdAt&sortOrder=asc', {
    actor: admin,
  });
  const queuedTasks = [...pendingTasks, ...manualRouteTasks, ...aliceTasks];
  assert.deepEqual(stillDisabled.map((task) => task.id), queuedTasks.map((task) => task.id));

  const copyCompletions = new Map();
  for (let offset = 0; offset < queuedTasks.length; offset += 3) {
    const expectedTasks = queuedTasks.slice(offset, offset + 3);
    const copyBatch = await request('/v1/executions/claim-copy-batch', {
      method: 'POST',
      body: { nodeId: 'http-flow', limit: 3, requestId: requestIdAt() },
    });
    assert.deepEqual(copyBatch.claims.map(({ task }) => ({
      id: task.id,
      assignee: task.assignedToUserId,
    })), expectedTasks.map((task) => ({ id: task.id, assignee: null })));
    for (const claim of copyBatch.claims) {
      const completed = await request(
        `/v1/executions/${claim.execution.id}/complete-copy`,
        { method: 'POST', body: { result: validCopy } },
      );
      assert.equal(completed.task.state, 'COPY_REVIEW_PENDING');
      assert.equal(completed.task.currentStage, 'COPY_REVIEW_PENDING');
      assert.equal(completed.task.assignedToUserId, null);
      copyCompletions.set(claim.task.id, completed);
    }
  }

  const singleAssigned = await nextRequest(
    `/api/control-plane/v1/tasks/${manualRouteTasks[0].id}/assignee`,
    {
      method: 'PATCH', cookie: adminCookie,
      body: { assignedToUserId: 'flow.alice', assignedToAccountId: createdAlice.id },
    },
  );
  assert.equal(singleAssigned.assignedToUserId, 'flow.alice');
  const batchAssigned = await nextRequest('/api/control-plane/v1/tasks/batch-assignee', {
    method: 'POST', cookie: adminCookie,
    body: {
      taskIds: [manualRouteTasks[1].id],
      assignedToUserId: 'flow.bob',
      assignedToAccountId: createdBob.id,
    },
  });
  assert.deepEqual(batchAssigned.map((task) => task.id), [manualRouteTasks[1].id]);
  assert.equal(batchAssigned[0].assignedToUserId, 'flow.bob');
  const singleAssignmentPage = await nextRequest(
    `/api/control-plane/v1/tasks?taskId=${manualRouteTasks[0].id}`,
    { cookie: adminCookie },
  );
  const batchAssignmentPage = await nextRequest(
    `/api/control-plane/v1/tasks?taskId=${manualRouteTasks[1].id}`,
    { cookie: adminCookie },
  );
  assert.equal(singleAssignmentPage[0].assignedToAccountId, createdAlice.id);
  assert.equal(batchAssignmentPage[0].assignedToAccountId, createdBob.id);
  const returnedToPool = await nextRequest('/api/control-plane/v1/tasks/batch-assignee', {
    method: 'POST', cookie: adminCookie,
    body: {
      taskIds: manualRouteTasks.map((task) => task.id),
      assignedToUserId: null,
      assignedToAccountId: null,
    },
  });
  assert.ok(returnedToPool.every((task) => task.assignedToUserId === null));
  for (const task of manualRouteTasks) {
    await nextRequest(`/api/control-plane/v1/tasks/${task.id}/cancel`, {
      method: 'POST', cookie: adminCookie, body: {},
    });
  }

  const aliceAssigned = await nextRequest('/api/control-plane/v1/tasks/batch-assignee', {
    method: 'POST', cookie: adminCookie,
    body: {
      taskIds: aliceTasks.map((task) => task.id),
      assignedToUserId: 'flow.alice',
      assignedToAccountId: createdAlice.id,
    },
  });
  assert.deepEqual(aliceAssigned.map((task) => task.id), aliceTasks.map((task) => task.id));
  assert.ok(aliceAssigned.every((task) => task.assignedToUserId === 'flow.alice'));
  const blockedWorkerDisable = await nextRequest(`/api/control-plane/v1/users/${createdAlice.id}`, {
    method: 'PATCH', cookie: adminCookie,
    body: {
      displayName: createdAlice.displayName,
      role: 'USER',
      status: 'DISABLED',
      expectedVersion: createdAlice.version,
    },
    expectedStatus: 409,
  });
  assert.equal(blockedWorkerDisable.code, 'USER_HAS_ACTIVE_TASKS');

  await nextRequest('/api/control-plane/v1/auto-assignment/settings', {
    method: 'PATCH', cookie: adminCookie,
    body: { enabled: true, expectedVersion: initialPool.settings.version },
  });

  const bobAfterAssignment = await waitUntil(
    () => request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: bob }),
    (tasks) => tasks.length === 1,
    'automatic assignment did not fill Bob\'s allowance',
  );
  assert.deepEqual(bobAfterAssignment.map((task) => task.id), [pendingTasks[0].id]);
  assert.equal(bobAfterAssignment[0].assignmentSource, 'AUTO');
  const bobThroughNext = await nextPersonalTasks('flow.bob', bobCookie);
  assert.deepEqual(bobThroughNext.map((task) => task.id), [pendingTasks[0].id]);
  assert.equal(bobThroughNext[0].assignmentSource, 'AUTO');

  const aliceVisible = await request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: alice });
  assert.deepEqual(aliceVisible.map((task) => task.id), aliceTasks.map((task) => task.id));
  assert.ok(aliceVisible.every((task) => task.assignedToUserId === 'flow.alice'));
  await request(`/v1/tasks/${pendingTasks[0].id}`, {
    actor: alice, expectedStatus: 403,
  });
  await request(`/v1/tasks/${pendingTasks[1].id}`, {
    actor: bob, expectedStatus: 403,
  });
  await request('/v1/auto-assignment', { actor: bob, expectedStatus: 403 });

  const pendingAfterFill = await request('/v1/tasks?unassigned=true&state=COPY_REVIEW_PENDING', { actor: admin });
  assert.deepEqual(pendingAfterFill.map((task) => task.id), [pendingTasks[1].id]);

  const completedCopy = copyCompletions.get(pendingTasks[0].id);
  const approvedCopy = await request(`/v1/tasks/${pendingTasks[0].id}/approve-copy`, {
    method: 'POST',
    actor: bob,
    body: {
      revisionId: completedCopy.revision.id,
      nodeId: 'http-flow',
      decision: 'APPROVE',
      originalScore: 2.5,
      note: '验收测试通过文案审核后立即释放作业容量',
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
    },
  });
  assert.equal(approvedCopy.state, 'IMAGE_QUEUED');

  await waitUntil(
    () => request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: bob }),
    (tasks) => tasks.some((task) => task.id === pendingTasks[1].id
      && task.assignedToUserId === 'flow.bob'
      && task.assignmentSource === 'AUTO'),
    'automatic assignment did not refill Bob after copy review approval',
  );
  const refilledTask = await request(`/v1/tasks/${pendingTasks[1].id}`, { actor: bob });
  assert.equal(refilledTask.assignedToUserId, 'flow.bob');

  const imageClaim = await request('/v1/executions/claim-image', {
    method: 'POST',
    body: { nodeId: 'http-flow', imageControlsVersion: 1, layoutCatalogVersion: 2 },
  });
  assert.equal(imageClaim.task.id, pendingTasks[0].id);
  assert.equal(imageClaim.task.assignedToUserId, 'flow.bob');

  const automaticEvents = (await pool.query(`
    SELECT task_id, actor_username, assignee_user_id, source
    FROM task_assignment_events
    WHERE source = 'AUTO'
    ORDER BY id
  `)).rows;
  assert.deepEqual(automaticEvents.map((event) => ({
    taskId: Number(event.task_id),
    actor: event.actor_username,
    assignee: event.assignee_user_id,
    source: event.source,
  })), [
    {
      taskId: pendingTasks[0].id,
      actor: AUTO_ASSIGNMENT_ACTOR,
      assignee: 'flow.bob',
      source: 'AUTO',
    },
    {
      taskId: pendingTasks[1].id,
      actor: AUTO_ASSIGNMENT_ACTOR,
      assignee: 'flow.bob',
      source: 'AUTO',
    },
  ]);
  assert.deepEqual(schedulerErrors, []);
});
