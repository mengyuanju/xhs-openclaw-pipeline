// This acceptance test always creates its own local cluster and never reads DATABASE_URL/.env.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';

import pg from 'pg';

import { migrateDatabase } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { AUTO_ASSIGNMENT_ACTOR } from '../src/task-auto-assignment-runner.mjs';
import { requestIdAt } from '../tests/fixtures/claim-request-id.mjs';

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

test('isolated PostgreSQL: pending pool, opt-in replenishment, fair claims and refill after completion', {
  timeout: 90_000,
}, async (t) => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to a local PostgreSQL bin directory');
  const root = await mkdtemp(join(tmpdir(), 'xhs-auto-assignment-pg-'));
  const data = join(root, 'data');
  const commandLog = join(root, 'commands.log');
  let started = false;
  let pool;

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
    await pool?.end();
    if (started) await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    const temporaryPath = relative(resolve(tmpdir()), root);
    assert.ok(temporaryPath && !temporaryPath.startsWith('..') && !temporaryPath.includes(':'));
    await rm(root, { recursive: true, force: true });
  });

  const listener = createServer();
  await new Promise((ready) => listener.listen(0, '127.0.0.1', ready));
  const port = listener.address().port;
  await new Promise((closed) => listener.close(closed));
  await command('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C']);
  await command('pg_ctl', [
    '-D', data,
    '-l', join(root, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port}`,
    '-w', 'start',
  ]);
  started = true;
  t.diagnostic('disposable local PostgreSQL started');

  pool = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'postgres',
    max: 12,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    lock_timeout: 3_000,
  });
  await migrateDatabase(pool);
  assert.deepEqual(await migrateDatabase(pool), []);

  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES
      ('flow-admin', 'Flow Administrator', 'ADMIN', 'unused-in-test', 'ACTIVE', false),
      ('alice', 'Alice', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('bob', 'Bob', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('carol', 'Carol', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('dave', 'Dave', 'USER', 'unused-in-test', 'ACTIVE', false)
  `);

  const repository = new PostgresControlPlaneRepository({ pool });
  await repository.registerNode({
    nodeId: 'flow',
    imageWorkerEnabled: true,
    copyConcurrency: 3,
    imageConcurrency: 1,
  });
  await repository.putAutoAssignmentWorker('alice', {
    status: 'ACTIVE', assignmentLimit: 2, actorUsername: 'flow-admin',
  });
  await repository.putAutoAssignmentWorker('bob', {
    status: 'ACTIVE', assignmentLimit: 1, actorUsername: 'flow-admin',
  });
  await repository.putAutoAssignmentWorker('carol', {
    status: 'PAUSED', assignmentLimit: 5, actorUsername: 'flow-admin',
  });

  // Alice represents the first worker who already filled their own allowance.
  const aliceTasks = await repository.createTasks({
    nodeId: 'flow',
    createdByUserId: 'alice',
    tasks: [{ query: 'Alice 旧任务 1' }, { query: 'Alice 旧任务 2' }],
  });
  const pendingTasks = await repository.createTasks({
    nodeId: 'flow',
    createdByUserId: 'flow-admin',
    assignedToUserId: null,
    skipCopyReview: true,
    tasks: [{ query: '待分配任务 1' }, { query: '待分配任务 2' }],
  });

  const disabled = await repository.replenishAutoAssignments();
  assert.equal(disabled.outcome, 'DISABLED');
  assert.deepEqual((await pool.query(`
    SELECT assigned_to_user_id FROM tasks
    WHERE id = ANY($1::bigint[]) ORDER BY id
  `, [pendingTasks.map((task) => task.id)])).rows, [
    { assigned_to_user_id: null },
    { assigned_to_user_id: null },
  ]);

  const enabled = await repository.updateAutoAssignmentSettings({
    enabled: true,
    expectedVersion: 1,
    actorUsername: 'flow-admin',
  });
  assert.equal(enabled.enabled, true);

  const initialRuns = await Promise.all([
    repository.replenishAutoAssignments(),
    repository.replenishAutoAssignments(),
  ]);
  assert.equal(initialRuns.reduce((total, result) => total + result.assignedCount, 0), 1);
  const initialAssignment = initialRuns.find((result) => result.assignedCount === 1);
  assert.deepEqual(initialAssignment?.assignedTaskIds, [pendingTasks[0].id]);
  assert.deepEqual(initialAssignment?.byWorker, [{
    username: 'bob',
    assignmentLimit: 1,
    beforeCount: 0,
    assignedCount: 1,
    afterCount: 1,
  }]);

  const afterInitialFill = (await pool.query(`
    SELECT id, assigned_to_user_id, assignment_source
    FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id
  `, [pendingTasks.map((task) => task.id)])).rows;
  assert.deepEqual(afterInitialFill.map((task) => ({
    id: Number(task.id),
    assignee: task.assigned_to_user_id,
    source: task.assignment_source,
  })), [
    { id: pendingTasks[0].id, assignee: 'bob', source: 'AUTO' },
    { id: pendingTasks[1].id, assignee: null, source: null },
  ]);

  // Fair selection takes one oldest task per owner before Alice's second old task.
  const firstCopyBatch = await repository.claimCopyBatch({
    nodeId: 'flow',
    limit: 2,
    requestId: requestIdAt(),
  });
  assert.deepEqual(firstCopyBatch.claims.map(({ task }) => ({
    id: task.id,
    assignee: task.assignedToUserId,
  })), [
    { id: aliceTasks[0].id, assignee: 'alice' },
    { id: pendingTasks[0].id, assignee: 'bob' },
  ]);

  const bobCopyClaim = firstCopyBatch.claims.find(({ task }) => task.assignedToUserId === 'bob');
  const completedCopy = await repository.completeCopy(bobCopyClaim.execution.id, validCopy);
  assert.equal(completedCopy.task.state, 'IMAGE_QUEUED');
  assert.equal(completedCopy.revision.approvalMode, 'ADMIN_BYPASS');

  const heldWhileImagePending = await repository.replenishAutoAssignments();
  assert.equal(heldWhileImagePending.outcome, 'AT_CAPACITY');
  assert.equal((await repository.getTask(pendingTasks[1].id)).assignedToUserId, null);

  const imageClaim = await repository.claimImage('flow', 1, 2);
  assert.equal(imageClaim.task.id, pendingTasks[0].id);
  assert.equal(imageClaim.task.assignedToUserId, 'bob');
  const completedImage = await repository.completeImage(imageClaim.execution.id, { images: [] });
  assert.equal(completedImage.state, 'MANUAL_ARCHIVE');
  assert.equal(completedImage.currentExecutionId, null);

  const replenished = await repository.replenishAutoAssignments();
  assert.equal(replenished.outcome, 'ASSIGNED');
  assert.deepEqual(replenished.assignedTaskIds, [pendingTasks[1].id]);
  assert.deepEqual(replenished.byWorker, [{
    username: 'bob',
    assignmentLimit: 1,
    beforeCount: 0,
    assignedCount: 1,
    afterCount: 1,
  }]);

  // The persisted COPY cursor wraps after Bob and again serves one task per owner.
  const secondCopyBatch = await repository.claimCopyBatch({
    nodeId: 'flow',
    limit: 2,
    requestId: requestIdAt(),
  });
  assert.deepEqual(secondCopyBatch.claims.map(({ task }) => ({
    id: task.id,
    assignee: task.assignedToUserId,
  })), [
    { id: aliceTasks[1].id, assignee: 'alice' },
    { id: pendingTasks[1].id, assignee: 'bob' },
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
    { taskId: pendingTasks[0].id, actor: AUTO_ASSIGNMENT_ACTOR, assignee: 'bob', source: 'AUTO' },
    { taskId: pendingTasks[1].id, actor: AUTO_ASSIGNMENT_ACTOR, assignee: 'bob', source: 'AUTO' },
  ]);

  const finalState = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE assigned_to_user_id IS NULL AND state = 'COPY_QUEUED') AS pending,
      COUNT(*) FILTER (WHERE assigned_to_user_id IN ('carol', 'dave')) AS ineligible_assignments
    FROM tasks
  `)).rows[0];
  assert.equal(Number(finalState.pending), 0);
  assert.equal(Number(finalState.ineligible_assignments), 0);

  const cursors = (await pool.query(`
    SELECT kind, last_assignee_user_id
    FROM execution_claim_cursors ORDER BY kind
  `)).rows;
  assert.deepEqual(cursors, [
    { kind: 'COPY', last_assignee_user_id: 'bob' },
    { kind: 'IMAGE', last_assignee_user_id: 'bob' },
  ]);
});
