// This upgrade test owns a disposable PostgreSQL cluster. It never loads .env,
// contacts a model, or connects to the development control-plane database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

async function applyThrough(pool, lastMigrationId) {
  const migrations = await loadMigrations();
  const lastIndex = migrations.findIndex((migration) => migration.id === lastMigrationId);
  assert.ok(lastIndex >= 0, `migration ${lastMigrationId} must exist`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO public');
    const applied = await applyMigrations(client, migrations.slice(0, lastIndex + 1));
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test('isolated PostgreSQL: assignment integrity and fairness survive upgrade and task deletion', {
  timeout: 90_000,
}, async (t) => {
  assert.ok(process.env.TEST_POSTGRES_BIN, 'set TEST_POSTGRES_BIN to a local PostgreSQL bin directory');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-assignment-upgrade-pg-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const commandLog = join(temporaryRoot, 'commands.log');
  let postgresStarted = false;
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

  pool = new pg.Pool({
    host: '127.0.0.1',
    port: postgresPort,
    user: 'postgres',
    database: 'postgres',
    max: 8,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    lock_timeout: 3_000,
  });
  await applyThrough(pool, '0016_human_quality_assessments');
  const repository = new PostgresControlPlaneRepository({ pool });
  // Seed through the 0016 schema rather than the current repository method,
  // which may reference columns introduced by later migrations.
  await pool.query(`
    INSERT INTO executor_nodes(
      id, name, image_worker_enabled, copy_concurrency, image_concurrency
    ) VALUES ($1, $2, $3, $4, $5)
  `, ['upgrade-test', 'upgrade-test', true, 2, 2]);

  // Reproduce the identity ambiguity present when 0017 was deployed: an old
  // account was deleted, then its username was reused before 0017 backfilled
  // creator usernames into assignment ownership.
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password,
      created_at, updated_at
    ) VALUES
      ('reused.worker', 'Original Reused Worker', 'USER', 'unused-in-test', 'ACTIVE', false,
        '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
      ('cursor.worker', 'Original Cursor Worker', 'USER', 'unused-in-test', 'ACTIVE', false,
        '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
  `);
  const historicalRows = (await pool.query(`
    INSERT INTO tasks(
      query, created_by_node_id, copy_executor_node_id, created_by_user_id,
      progress_message, created_at, updated_at
    ) VALUES
      ('0017 错分的旧账号任务', 'upgrade-test', 'upgrade-test', 'reused.worker',
        '等待文案执行机领取', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z'),
      ('与替代账号同时间的歧义任务', 'upgrade-test', 'upgrade-test', 'reused.worker',
        '等待文案执行机领取', '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z'),
      ('明确人工分给替代账号的任务', 'upgrade-test', 'upgrade-test', 'reused.worker',
        '等待文案执行机领取', '2025-01-03T00:00:00Z', '2025-01-03T00:00:00Z'),
      ('旧账号自动分配游标任务', 'upgrade-test', 'upgrade-test', 'cursor.worker',
        '等待文案执行机领取', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z')
    RETURNING id, query
  `)).rows;
  const historicalId = (query) => Number(historicalRows.find((row) => row.query === query).id);
  const pre17MisassignedId = historicalId('0017 错分的旧账号任务');
  const equalTimestampId = historicalId('与替代账号同时间的歧义任务');
  const explicitManualId = historicalId('明确人工分给替代账号的任务');
  const oldCursorTaskId = historicalId('旧账号自动分配游标任务');
  const originalReusedAccountId = Number((await pool.query(`
    SELECT id FROM app_users WHERE username = 'reused.worker'
  `)).rows[0].id);

  await pool.query("DELETE FROM app_users WHERE username = 'reused.worker'");
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password,
      created_at, updated_at
    ) VALUES ('reused.worker', 'Replacement Reused Worker', 'USER', 'unused-in-test', 'ACTIVE', false,
      '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z')
  `);

  assert.deepEqual(await applyThrough(pool, '0017_task_assignment'), ['0017_task_assignment']);
  const incorrectlyBackfilled = await pool.query(`
    SELECT id, assigned_to_user_id, assignment_source
    FROM tasks
    WHERE id = ANY($1::bigint[])
    ORDER BY id
  `, [[pre17MisassignedId, equalTimestampId, explicitManualId]]);
  assert.equal(incorrectlyBackfilled.rows.every((row) => (
    row.assigned_to_user_id === 'reused.worker' && row.assignment_source === 'SELF'
  )), true);

  // A later explicit administrator decision must win over temporal inference.
  await pool.query(`
    UPDATE tasks SET assignment_source = 'MANUAL', assigned_at = '2025-02-02T00:00:00Z'
    WHERE id = $1
  `, [explicitManualId]);
  await pool.query(`
    INSERT INTO task_assignment_events(
      task_id, actor_username, previous_assignee_user_id,
      assignee_user_id, source, reason, created_at
    ) VALUES ($1, 'admin', NULL, 'reused.worker', 'MANUAL',
      '管理员确认由同名新账号接手', '2025-02-02T00:00:00Z')
  `, [explicitManualId]);

  // An AUTO event belongs to the original account and must not seed a fairness
  // cursor for a replacement account with the same username. Equality is
  // deliberately ambiguous because PostgreSQL now() is transaction-scoped.
  await pool.query(`
    UPDATE tasks SET assignment_source = 'AUTO', assigned_at = '2025-02-01T00:00:00Z'
    WHERE id = $1
  `, [oldCursorTaskId]);
  await pool.query(`
    INSERT INTO task_assignment_events(
      task_id, actor_username, previous_assignee_user_id,
      assignee_user_id, source, reason, created_at
    ) VALUES ($1, 'system:auto-assignment', NULL, 'cursor.worker', 'AUTO',
      '旧账号自动分配记录（与替代账号创建时间相等）', '2025-02-01T00:00:00Z')
  `, [oldCursorTaskId]);
  await pool.query("DELETE FROM app_users WHERE username = 'cursor.worker'");
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password,
      created_at, updated_at
    ) VALUES ('cursor.worker', 'Replacement Cursor Worker', 'USER', 'unused-in-test', 'ACTIVE', false,
      '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z')
  `);

  assert.deepEqual(await applyThrough(pool, '0020_execution_claim_fairness'), [
    '0018_auto_assignment_pool',
    '0019_auto_assignment_runner',
    '0020_execution_claim_fairness',
  ]);
  await repository.putAutoAssignmentWorker('cursor.worker', {
    status: 'PAUSED',
    assignmentLimit: 1,
    actorUsername: 'admin',
  });
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES
      ('legacy.worker', 'Legacy Worker', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('post17.worker', 'Post-0017 Worker', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('pool.worker', 'Pool Worker', 'USER', 'unused-in-test', 'ACTIVE', false)
  `);

  const [legacyWrite] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'legacy.worker',
    assignedToUserId: null,
    tasks: [{ query: '旧程序在 0017 后写入的任务' }],
  });
  const [explicitlyUnassigned] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'legacy.worker',
    assignedToUserId: 'legacy.worker',
    assignmentSource: 'SELF',
    tasks: [{ query: '管理员明确撤回的任务' }],
  });
  await repository.assignTask(explicitlyUnassigned.id, {
    assignedToUserId: null,
    actorUserId: 'admin',
    reason: '明确进入待分配池',
  });
  const [legacyImage] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '管理员历史生图任务' }],
  });
  await pool.query(`
    UPDATE tasks SET
      state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
      progress_message = '文案审核通过，等待图片执行机领取'
    WHERE id = $1
  `, [legacyImage.id]);
  const [legacyImageFailed] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '管理员历史生图失败任务' }],
  });
  const [legacyImageExhausted] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '管理员历史生图重试耗尽任务' }],
  });
  const [legacyManualArchive] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '管理员历史待终审任务' }],
  });
  await pool.query(`
    UPDATE tasks SET
      state = CASE id
        WHEN $1 THEN 'IMAGE_FAILED'
        WHEN $2 THEN 'COPY_REVIEW_PENDING'
        WHEN $3 THEN 'MANUAL_ARCHIVE'
      END,
      current_stage = CASE id
        WHEN $1 THEN 'IMAGE_FAILED'
        WHEN $2 THEN 'IMAGE_RETRY_EXHAUSTED'
        WHEN $3 THEN 'MANUAL_ARCHIVE'
      END,
      error = CASE WHEN id IN ($1, $2) THEN 'legacy image failure' ELSE NULL END,
      current_execution_id = NULL
    WHERE id IN ($1, $2, $3)
  `, [legacyImageFailed.id, legacyImageExhausted.id, legacyManualArchive.id]);
  const [deletedOwnerTask] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'post17.worker',
    assignedToUserId: 'post17.worker',
    assignmentSource: 'SELF',
    tasks: [{ query: '负责人被旧逻辑删除的任务' }],
  });
  await pool.query("DELETE FROM app_users WHERE username = 'post17.worker'");
  const beforeRepair = await pool.query(`
    SELECT assigned_to_user_id, assignment_source, assigned_at
    FROM tasks WHERE id = $1
  `, [deletedOwnerTask.id]);
  assert.equal(beforeRepair.rows[0].assigned_to_user_id, null);
  assert.equal(beforeRepair.rows[0].assignment_source, 'SELF');
  assert.ok(beforeRepair.rows[0].assigned_at);
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES ('post17.worker', 'Replacement Post-0017 Worker', 'USER', 'unused-in-test', 'ACTIVE', false)
  `);

  assert.deepEqual(await applyThrough(pool, '0021_task_assignment_integrity'), ['0021_task_assignment_integrity']);
  assert.deepEqual(await applyThrough(pool, '0021_task_assignment_integrity'), []);

  const repaired = await pool.query(`
    SELECT id, state, assigned_to_user_id, assignment_source, assigned_at, progress_message
    FROM tasks
    WHERE id = ANY($1::bigint[])
    ORDER BY id
  `, [[
    legacyWrite.id,
    explicitlyUnassigned.id,
    legacyImage.id,
    deletedOwnerTask.id,
    pre17MisassignedId,
    equalTimestampId,
    explicitManualId,
    oldCursorTaskId,
  ]]);
  const byId = new Map(repaired.rows.map((row) => [Number(row.id), row]));
  assert.equal(byId.get(legacyWrite.id).assigned_to_user_id, 'legacy.worker');
  assert.equal(byId.get(legacyWrite.id).assignment_source, 'SELF');
  assert.ok(byId.get(legacyWrite.id).assigned_at);
  assert.equal(byId.get(legacyWrite.id).progress_message, '等待文案执行机领取');
  assert.equal(byId.get(explicitlyUnassigned.id).assigned_to_user_id, null);
  assert.equal(byId.get(legacyImage.id).assigned_to_user_id, null);
  assert.equal(byId.get(legacyImage.id).state, 'IMAGE_QUEUED');
  assert.equal(byId.get(deletedOwnerTask.id).assigned_to_user_id, null);
  assert.equal(byId.get(deletedOwnerTask.id).assignment_source, null);
  assert.equal(byId.get(deletedOwnerTask.id).assigned_at, null);
  assert.equal(byId.get(pre17MisassignedId).assigned_to_user_id, null);
  assert.equal(byId.get(pre17MisassignedId).assignment_source, null);
  assert.equal(byId.get(pre17MisassignedId).assigned_at, null);
  assert.equal(byId.get(pre17MisassignedId).progress_message, '等待分配负责人');
  assert.equal(byId.get(equalTimestampId).assigned_to_user_id, null);
  assert.equal(byId.get(equalTimestampId).assignment_source, null);
  assert.equal(byId.get(equalTimestampId).assigned_at, null);
  assert.equal(byId.get(equalTimestampId).progress_message, '等待分配负责人');
  assert.equal(byId.get(explicitManualId).assigned_to_user_id, 'reused.worker');
  assert.equal(byId.get(explicitManualId).assignment_source, 'MANUAL');
  assert.ok(byId.get(explicitManualId).assigned_at);
  assert.equal(byId.get(oldCursorTaskId).assigned_to_user_id, null);
  assert.equal(byId.get(oldCursorTaskId).assignment_source, null);
  assert.equal(byId.get(oldCursorTaskId).assigned_at, null);
  assert.equal((await pool.query(`
    SELECT display_name FROM app_users WHERE username = 'post17.worker'
  `)).rows[0].display_name, 'Replacement Post-0017 Worker');
  const replacementAssignments = await repository.listTasks({
    assignedToUserId: 'reused.worker',
  });
  assert.deepEqual(replacementAssignments.map((task) => task.id), [explicitManualId]);
  assert.equal(replacementAssignments[0].createdByDisplayName, null);
  assert.equal(replacementAssignments[0].createdByRole, null);
  assert.equal(replacementAssignments[0].assignedToDisplayName, 'Replacement Reused Worker');

  const [replacementCreatedTask] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'reused.worker',
    assignedToUserId: 'reused.worker',
    assignmentSource: 'SELF',
    tasks: [{ query: '替代账号新建的任务' }],
  });
  const replacementAccountId = Number((await pool.query(`
    SELECT id FROM app_users WHERE username = 'reused.worker'
  `)).rows[0].id);
  const replacementCreatedPage = await repository.listTasks({
    createdByUserId: 'reused.worker',
    createdByAccountId: replacementAccountId,
    includeTotal: true,
  });
  assert.equal(replacementCreatedPage.total, 1);
  assert.deepEqual(replacementCreatedPage.items.map((task) => task.id), [replacementCreatedTask.id]);
  assert.equal(replacementCreatedPage.items[0].createdByAccountId, replacementAccountId);
  assert.equal(replacementCreatedPage.items[0].createdByDisplayName, 'Replacement Reused Worker');
  const deletedGenerationPage = await repository.listTasks({
    createdByUserId: 'reused.worker',
    createdByAccountId: originalReusedAccountId,
    includeTotal: true,
  });
  assert.equal(deletedGenerationPage.total, 0);
  assert.deepEqual(deletedGenerationPage.items, []);

  const visibleLegacyImage = await repository.listTasks({
    states: 'IMAGE_QUEUED',
    unassignedOnly: true,
  });
  assert.deepEqual(visibleLegacyImage.map((task) => task.id), [legacyImage.id]);

  await assert.rejects(
    pool.query("DELETE FROM app_users WHERE username = 'legacy.worker'"),
    { code: '23001' },
  );
  await assert.rejects(
    pool.query(`
      UPDATE tasks SET assignment_source = 'AUTO'
      WHERE id = $1
    `, [legacyImage.id]),
    { code: '23514' },
  );

  assert.deepEqual(await applyThrough(pool, '0022_auto_assignment_cursor'), ['0022_auto_assignment_cursor']);
  assert.deepEqual(await applyThrough(pool, '0022_auto_assignment_cursor'), []);
  assert.equal((await pool.query(`
    SELECT COUNT(*) AS count
    FROM task_auto_assignment_cursors
    WHERE username = 'cursor.worker'
  `)).rows[0].count, '0');

  assert.deepEqual(await applyThrough(pool, '0023_executor_node_retirement'), [
    '0023_executor_node_retirement',
  ]);
  assert.equal((await pool.query(`
    SELECT retired_at
    FROM executor_nodes
    WHERE id = 'upgrade-test'
  `)).rows[0].retired_at, null);
  assert.deepEqual(await applyThrough(pool, '0023_executor_node_retirement'), []);

  await repository.putAutoAssignmentWorker('pool.worker', {
    status: 'ACTIVE',
    assignmentLimit: 10,
    actorUsername: 'admin',
  });
  await repository.updateAutoAssignmentSettings({
    enabled: true,
    expectedVersion: 1,
    actorUsername: 'admin',
  });
  const [normalReviewTask] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '正常待文案审核任务' }],
  });
  await pool.query(`
    UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING',
      current_execution_id = NULL, progress_message = '文案生成完成，等待分配负责人后审核'
    WHERE id = $1
  `, [normalReviewTask.id]);
  const replenished = await repository.replenishAutoAssignments();
  assert.equal(replenished.outcome, 'ASSIGNED');
  assert.deepEqual(replenished.assignedTaskIds, [normalReviewTask.id]);
  const assignedImage = await repository.getTask(legacyImage.id);
  assert.equal(assignedImage.state, 'IMAGE_QUEUED');
  assert.equal(assignedImage.assignedToUserId, null);
  assert.equal(assignedImage.assignmentSource, null);
  const assignedFailure = await repository.getTask(legacyImageFailed.id);
  assert.equal(assignedFailure.assignedToUserId, null);
  assert.equal(assignedFailure.state, 'IMAGE_FAILED');
  assert.equal(assignedFailure.error, 'legacy image failure');
  const assignedExhausted = await repository.getTask(legacyImageExhausted.id);
  assert.equal(assignedExhausted.assignedToUserId, null);
  assert.equal(assignedExhausted.state, 'COPY_REVIEW_PENDING');
  assert.equal(assignedExhausted.currentStage, 'IMAGE_RETRY_EXHAUSTED');
  assert.equal(assignedExhausted.error, 'legacy image failure');
  const deferredArchive = await repository.getTask(legacyManualArchive.id);
  assert.equal(deferredArchive.assignedToUserId, null);
  assert.equal(deferredArchive.state, 'MANUAL_ARCHIVE');
  const overviewAfterRepair = await repository.getAutoAssignmentOverview();
  assert.ok(overviewAfterRepair.unassignedTaskCount >= 4);
  assert.equal(overviewAfterRepair.autoAssignableTaskCount, 0);
  assert.equal(overviewAfterRepair.manualAttentionTaskCount, overviewAfterRepair.unassignedTaskCount);
  const manuallyAssignedArchive = await repository.assignTask(legacyManualArchive.id, {
    assignedToUserId: 'pool.worker',
    actorUserId: 'admin',
    reason: '历史终审任务人工归属',
  });
  assert.equal(manuallyAssignedArchive.progressMessage, '图片生成完成，等待人工归档');

  await pool.query(`
    UPDATE task_auto_assignment_workers
    SET status = 'PAUSED', version = version + 1, updated_at = now()
    WHERE username = 'pool.worker'
  `);
  await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES
      ('fair.alice', 'Fair Alice', 'USER', 'unused-in-test', 'ACTIVE', false),
      ('fair.bob', 'Fair Bob', 'USER', 'unused-in-test', 'ACTIVE', false)
  `);
  await repository.putAutoAssignmentWorker('fair.alice', {
    status: 'ACTIVE', assignmentLimit: 1, actorUsername: 'admin',
  });
  await repository.putAutoAssignmentWorker('fair.bob', {
    status: 'ACTIVE', assignmentLimit: 1, actorUsername: 'admin',
  });

  const [firstFairTask] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '公平游标任务一' }],
  });
  await pool.query(`
    UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING',
      current_execution_id = NULL
    WHERE id = $1
  `, [firstFairTask.id]);
  const firstFairRun = await repository.replenishAutoAssignments();
  assert.deepEqual(firstFairRun.assignedTaskIds, [firstFairTask.id]);
  assert.equal((await repository.getTask(firstFairTask.id)).assignedToUserId, 'fair.alice');
  const cursorBeforeDeletion = (await pool.query(`
    SELECT last_auto_event_id
    FROM task_auto_assignment_cursors
    WHERE username = 'fair.alice'
  `)).rows[0].last_auto_event_id;

  await pool.query("UPDATE tasks SET state = 'CANCELLED' WHERE id = $1", [firstFairTask.id]);
  await pool.query('DELETE FROM tasks WHERE id = $1', [firstFairTask.id]);
  assert.equal(Number((await pool.query(`
    SELECT COUNT(*) AS count FROM task_assignment_events WHERE task_id = $1
  `, [firstFairTask.id])).rows[0].count), 0);
  assert.equal((await pool.query(`
    SELECT last_auto_event_id
    FROM task_auto_assignment_cursors
    WHERE username = 'fair.alice'
  `)).rows[0].last_auto_event_id, cursorBeforeDeletion);

  const [secondFairTask] = await repository.createTasks({
    nodeId: 'upgrade-test',
    createdByUserId: 'admin',
    assignedToUserId: null,
    tasks: [{ query: '公平游标任务二' }],
  });
  await pool.query(`
    UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING',
      current_execution_id = NULL
    WHERE id = $1
  `, [secondFairTask.id]);
  const secondFairRun = await repository.replenishAutoAssignments();
  assert.deepEqual(secondFairRun.assignedTaskIds, [secondFairTask.id]);
  assert.equal((await repository.getTask(secondFairTask.id)).assignedToUserId, 'fair.bob');

  // Different account rows must still share the last-administrator invariant.
  await pool.query("UPDATE app_users SET status = 'DISABLED' WHERE username = 'admin'");
  const raceAdmins = (await pool.query(`
    INSERT INTO app_users(
      username, display_name, role, password_hash, status, must_change_password
    ) VALUES
      ('race.admin.a', 'Race Admin A', 'ADMIN', 'unused-in-test', 'ACTIVE', false),
      ('race.admin.b', 'Race Admin B', 'ADMIN', 'unused-in-test', 'ACTIVE', false)
    RETURNING id, username, version
  `)).rows;
  const raceA = raceAdmins.find((user) => user.username === 'race.admin.a');
  const raceB = raceAdmins.find((user) => user.username === 'race.admin.b');
  const competingDeletes = await Promise.allSettled([
    repository.deleteUser(Number(raceA.id), {
      actorUsername: raceB.username,
      expectedVersion: Number(raceA.version),
    }),
    repository.deleteUser(Number(raceB.id), {
      actorUsername: raceA.username,
      expectedVersion: Number(raceB.version),
    }),
  ]);
  assert.equal(competingDeletes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedDelete = competingDeletes.find((result) => result.status === 'rejected');
  assert.equal(rejectedDelete?.reason?.code, 'LAST_ADMIN');
  assert.equal(Number((await pool.query(`
    SELECT COUNT(*) AS count FROM app_users
    WHERE role = 'ADMIN' AND status = 'ACTIVE'
  `)).rows[0].count), 1);
});
