// This acceptance test always creates its own local PostgreSQL cluster and HTTP
// server. It never loads .env, reads DATABASE_URL, contacts a model, or connects
// to the development services on ports 4310/3001.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('isolated HTTP: account creation, opt-in assignment, visibility, fair claims and refill', {
  timeout: 90_000,
}, async (t) => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to a local PostgreSQL bin directory');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-auto-assignment-http-pg-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const commandLog = join(temporaryRoot, 'commands.log');
  let postgresStarted = false;
  let pool;
  let http;
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

  const createdAlice = await request('/v1/users', {
    method: 'POST', actor: admin,
    body: { username: 'flow.alice', displayName: 'Flow Alice', role: 'USER' },
    expectedStatus: 201,
  });
  const createdBob = await request('/v1/users', {
    method: 'POST', actor: admin,
    body: { username: 'flow.bob', displayName: 'Flow Bob', role: 'USER' },
    expectedStatus: 201,
  });
  assert.equal(createdAlice.mustChangePassword, true);
  assert.equal(createdBob.mustChangePassword, true);

  const alice = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'flow.alice', password: DEFAULT_PASSWORD },
  });
  const bob = await request('/v1/auth/login', {
    method: 'POST', body: { username: 'flow.bob', password: DEFAULT_PASSWORD },
  });
  assert.equal(alice.role, 'USER');
  assert.equal(bob.role, 'USER');

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

  const initialPool = await request('/v1/auto-assignment', { actor: admin });
  assert.equal(initialPool.settings.enabled, false);
  assert.deepEqual(initialPool.workers, []);

  await request('/v1/auto-assignment/workers/flow.alice', {
    method: 'PUT', actor: admin,
    body: { status: 'ACTIVE', assignmentLimit: 2 },
  });
  await request('/v1/auto-assignment/workers/flow.bob', {
    method: 'PUT', actor: admin,
    body: { status: 'ACTIVE', assignmentLimit: 1 },
  });

  const aliceTasks = await request('/v1/tasks', {
    method: 'POST', actor: alice,
    body: {
      nodeId: 'http-flow',
      tasks: [{ query: 'Alice 旧任务 1' }, { query: 'Alice 旧任务 2' }],
    },
    expectedStatus: 201,
  });
  const pendingTasks = await request('/v1/tasks', {
    method: 'POST', actor: admin,
    body: {
      nodeId: 'http-flow',
      assignedToUserId: null,
      skipCopyReview: true,
      tasks: [{ query: '待分配任务 1' }, { query: '待分配任务 2' }],
    },
    expectedStatus: 201,
  });
  assert.ok(pendingTasks.every((task) => task.assignedToUserId === null));

  const schedulerErrors = [];
  stopReplenishment = startAutoAssignmentReplenishment(repository, {
    intervalMs: 20,
    log: {
      log() {},
      error(message) { schedulerErrors.push(message); },
    },
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const stillDisabled = await request('/v1/tasks?unassigned=true&sortBy=createdAt&sortOrder=asc', {
    actor: admin,
  });
  assert.deepEqual(stillDisabled.map((task) => task.id), pendingTasks.map((task) => task.id));

  await request('/v1/auto-assignment/settings', {
    method: 'PATCH', actor: admin,
    body: { enabled: true, expectedVersion: initialPool.settings.version },
  });

  const bobAfterAssignment = await waitUntil(
    () => request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: bob }),
    (tasks) => tasks.length === 1,
    'automatic assignment did not fill Bob\'s allowance',
  );
  assert.deepEqual(bobAfterAssignment.map((task) => task.id), [pendingTasks[0].id]);
  assert.equal(bobAfterAssignment[0].assignmentSource, 'AUTO');

  const aliceVisible = await request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: alice });
  assert.deepEqual(aliceVisible.map((task) => task.id), aliceTasks.map((task) => task.id));
  await request(`/v1/tasks/${pendingTasks[0].id}`, {
    actor: alice, expectedStatus: 403,
  });
  await request(`/v1/tasks/${pendingTasks[1].id}`, {
    actor: bob, expectedStatus: 403,
  });
  await request('/v1/auto-assignment', { actor: bob, expectedStatus: 403 });

  const pendingAfterFill = await request('/v1/tasks?unassigned=true', { actor: admin });
  assert.deepEqual(pendingAfterFill.map((task) => task.id), [pendingTasks[1].id]);

  const firstCopyBatch = await request('/v1/executions/claim-copy-batch', {
    method: 'POST',
    body: { nodeId: 'http-flow', limit: 2, requestId: requestIdAt() },
  });
  assert.deepEqual(firstCopyBatch.claims.map(({ task }) => ({
    id: task.id,
    assignee: task.assignedToUserId,
  })), [
    { id: aliceTasks[0].id, assignee: 'flow.alice' },
    { id: pendingTasks[0].id, assignee: 'flow.bob' },
  ]);

  const bobCopyClaim = firstCopyBatch.claims.find(
    ({ task }) => task.assignedToUserId === 'flow.bob',
  );
  const completedCopy = await request(
    `/v1/executions/${bobCopyClaim.execution.id}/complete-copy`,
    { method: 'POST', body: { result: validCopy } },
  );
  assert.equal(completedCopy.task.state, 'IMAGE_QUEUED');
  assert.equal(completedCopy.revision.approvalMode, 'ADMIN_BYPASS');

  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  const heldAtCapacity = await request('/v1/tasks?unassigned=true', { actor: admin });
  assert.deepEqual(heldAtCapacity.map((task) => task.id), [pendingTasks[1].id]);

  const imageClaim = await request('/v1/executions/claim-image', {
    method: 'POST',
    body: { nodeId: 'http-flow', imageControlsVersion: 1, layoutCatalogVersion: 2 },
  });
  assert.equal(imageClaim.task.id, pendingTasks[0].id);
  assert.equal(imageClaim.task.assignedToUserId, 'flow.bob');

  const completedImage = await request(
    `/v1/executions/${imageClaim.execution.id}/complete-image`,
    { method: 'POST', body: { result: { images: [] } } },
  );
  assert.equal(completedImage.state, 'MANUAL_ARCHIVE');
  assert.equal(completedImage.currentExecutionId, null);

  await waitUntil(
    () => request('/v1/tasks?sortBy=createdAt&sortOrder=asc', { actor: bob }),
    (tasks) => tasks.some((task) => task.id === pendingTasks[1].id
      && task.assignedToUserId === 'flow.bob'
      && task.assignmentSource === 'AUTO'),
    'automatic assignment did not refill Bob after MANUAL_ARCHIVE',
  );
  const refilledTask = await request(`/v1/tasks/${pendingTasks[1].id}`, { actor: bob });
  assert.equal(refilledTask.assignedToUserId, 'flow.bob');

  const secondCopyBatch = await request('/v1/executions/claim-copy-batch', {
    method: 'POST',
    body: { nodeId: 'http-flow', limit: 2, requestId: requestIdAt() },
  });
  assert.deepEqual(secondCopyBatch.claims.map(({ task }) => ({
    id: task.id,
    assignee: task.assignedToUserId,
  })), [
    { id: aliceTasks[1].id, assignee: 'flow.alice' },
    { id: pendingTasks[1].id, assignee: 'flow.bob' },
  ]);

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
