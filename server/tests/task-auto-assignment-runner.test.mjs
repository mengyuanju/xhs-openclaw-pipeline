import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  AUTO_ASSIGNMENT_ACTOR,
  planAutoAssignments,
  runAutoAssignmentReplenishment,
  startAutoAssignmentReplenishment,
} from '../src/task-auto-assignment-runner.mjs';

function fakePool(handler) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      const call = { sql: String(sql), values };
      calls.push(call);
      return handler(call, calls);
    },
    release() { released = true; },
  };
  return {
    pool: { connect: async () => client },
    calls,
    get released() { return released; },
  };
}

function taskRow(id, patch = {}) {
  return {
    id,
    query: `任务${id}`,
    input: {},
    requested_image_count: 'auto',
    state: 'COPY_QUEUED',
    created_by_node_id: 'node-a',
    created_by_user_id: 'admin',
    assigned_to_user_id: null,
    assignment_source: null,
    assigned_at: null,
    progress_percent: 0,
    progress_message: '等待管理员分配作业员',
    ...patch,
  };
}

test('planner fills proportionally and rotates equal loads by the durable AUTO audit order', () => {
  const assignments = planAutoAssignments({
    workers: [
      { username: 'alice', assignmentLimit: 3, currentTaskCount: 0, lastAutoEventId: 10 },
      { username: 'bob', assignmentLimit: 3, currentTaskCount: 0, lastAutoEventId: null },
      { username: 'carol', assignmentLimit: 3, currentTaskCount: 0, lastAutoEventId: 5 },
    ],
    tasks: [6, 3, 1, 5, 2, 4].map((id) => ({ id })),
  });
  assert.deepEqual(assignments, [
    { taskId: 1, assignedToUserId: 'bob' },
    { taskId: 2, assignedToUserId: 'carol' },
    { taskId: 3, assignedToUserId: 'alice' },
    { taskId: 4, assignedToUserId: 'bob' },
    { taskId: 5, assignedToUserId: 'carol' },
    { taskId: 6, assignedToUserId: 'alice' },
  ]);

  const bounded = planAutoAssignments({
    workers: [
      { username: 'full.worker', assignmentLimit: 2, currentTaskCount: 2, lastAutoEventId: null },
      { username: 'open.worker', assignmentLimit: 2, currentTaskCount: 1, lastAutoEventId: null },
    ],
    tasks: [{ id: 7 }, { id: 8 }],
  });
  assert.deepEqual(bounded, [{ taskId: 7, assignedToUserId: 'open.worker' }]);
  assert.throws(() => planAutoAssignments({ workers: [], tasks: [], maxAssignments: 501 }), /500/u);
});

test('0019 indexes the AUTO audit cursor without rewriting task or member data', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0019_auto_assignment_runner');
  assert.ok(migration);
  assert.match(migration.sql, /task_assignment_events\(assignee_user_id, id DESC\)/u);
  assert.match(migration.sql, /WHERE source = 'AUTO' AND assignee_user_id IS NOT NULL/u);
  assert.doesNotMatch(migration.sql, /UPDATE|DELETE|TRUNCATE|DROP|INSERT/u);
});

test('disabled settings are a transactionally locked no-op before members or tasks are read', async () => {
  const database = fakePool(({ sql }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('FROM task_auto_assignment_settings')) return { rows: [{ enabled: false, version: 4 }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await runAutoAssignmentReplenishment(database.pool);
  assert.deepEqual(result, {
    outcome: 'DISABLED', settingsVersion: 4, eligibleWorkerCount: 0,
    capacityBefore: 0, assignedCount: 0, capacityAfter: 0,
    assignedTaskIds: [], byWorker: [],
  });
  assert.ok(database.calls.every(({ sql }) => !sql.includes('task_auto_assignment_workers')));
  assert.ok(database.calls.every(({ sql }) => !/UPDATE tasks/u.test(sql)));
  assert.equal(database.calls.at(-1).sql, 'COMMIT');
  assert.equal(database.released, true);
});

test('a center that cannot acquire the advisory transaction lock skips without waiting', async () => {
  const database = fakePool(({ sql }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: false }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await runAutoAssignmentReplenishment(database.pool);
  assert.equal(result.outcome, 'BUSY');
  assert.equal(database.calls.some(({ sql }) => sql.includes('task_auto_assignment_settings')), false);
  assert.equal(database.calls.at(-1).sql, 'COMMIT');
});

test('runner locks settings, active users, pool members and pending tasks in order, then audits AUTO assignments', async () => {
  let updatedSql = '';
  let candidateSql = '';
  let memberLockSql = '';
  let workerMetricsSql = '';
  let userSql = '';
  let auditValues;
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('FROM task_auto_assignment_settings')) return { rows: [{ enabled: true, version: 7 }] };
    if (sql.includes('FROM app_users AS app_user')) {
      userSql = sql;
      return { rows: [{ username: 'alice' }, { username: 'bob' }] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS pool')) {
      memberLockSql = sql;
      return { rows: [
        { username: 'alice', assignment_limit: 2 },
        { username: 'bob', assignment_limit: 2 },
      ] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS locked_pool')) {
      workerMetricsSql = sql;
      return { rows: [
        { username: 'alice', assignment_limit: 2, current_task_count: '0', last_auto_event_id: '10' },
        { username: 'bob', assignment_limit: 2, current_task_count: '0', last_auto_event_id: null },
      ] };
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      candidateSql = sql;
      assert.equal(values[0], 4);
      return { rows: [{ id: '101' }, { id: '102' }, { id: '103' }] };
    }
    if (sql.includes('UPDATE tasks AS task')) {
      updatedSql = sql;
      return { rows: values[0].map((id, index) => ({ id, assigned_to_user_id: values[1][index] })) };
    }
    if (sql.includes('INSERT INTO task_assignment_events')) {
      auditValues = values;
      return { rows: values[0].map((taskId) => ({ task_id: taskId })) };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  const result = await runAutoAssignmentReplenishment(database.pool);
  assert.equal(result.outcome, 'ASSIGNED');
  assert.equal(result.assignedCount, 3);
  assert.deepEqual(result.assignedTaskIds, [101, 102, 103]);
  assert.deepEqual(result.byWorker, [
    { username: 'alice', assignmentLimit: 2, beforeCount: 0, assignedCount: 1, afterCount: 1 },
    { username: 'bob', assignmentLimit: 2, beforeCount: 0, assignedCount: 2, afterCount: 2 },
  ]);
  assert.match(userSql, /role = 'USER'[\s\S]*status = 'ACTIVE'[\s\S]*membership.status = 'ACTIVE'/u);
  assert.match(userSql, /FOR SHARE OF app_user/u);
  assert.match(memberLockSql, /pool.status = 'ACTIVE'[\s\S]*FOR UPDATE OF pool/u);
  assert.doesNotMatch(memberLockSql, /FROM tasks|task_assignment_events/u);
  assert.match(workerMetricsSql, /state NOT IN \('MANUAL_ARCHIVE', 'REVIEWED', 'CANCELLED'\)/u);
  assert.doesNotMatch(workerMetricsSql, /COPY_FAILED|IMAGE_FAILED/u);
  assert.match(workerMetricsSql, /assignment_event.source = 'AUTO'[\s\S]*ORDER BY assignment_event.id DESC/u);
  assert.doesNotMatch(workerMetricsSql, /FOR UPDATE/u);
  assert.match(candidateSql, /assigned_to_user_id IS NULL[\s\S]*state = 'COPY_QUEUED'[\s\S]*current_execution_id IS NULL/u);
  assert.match(candidateSql, /ORDER BY id[\s\S]*FOR UPDATE SKIP LOCKED/u);
  assert.match(updatedSql, /assignment_source = 'AUTO'/u);
  assert.match(updatedSql, /assigned_to_user_id IS NULL[\s\S]*state = 'COPY_QUEUED'[\s\S]*current_execution_id IS NULL/u);
  assert.equal(auditValues[2], AUTO_ASSIGNMENT_ACTOR);
  assert.deepEqual(auditValues[1], ['bob', 'alice', 'bob']);

  const lockOrder = [
    'task_auto_assignment_settings',
    'FROM app_users AS app_user',
    'FOR UPDATE OF pool',
    'FROM task_auto_assignment_workers AS locked_pool',
    'FOR UPDATE SKIP LOCKED',
  ].map((fragment) => database.calls.findIndex(({ sql }) => sql.includes(fragment)));
  assert.deepEqual(lockOrder, [...lockOrder].sort((left, right) => left - right));
  assert.equal(database.calls.at(-1).sql, 'COMMIT');
  assert.equal(database.released, true);
});

test('runner caps each transaction at 500 assignments even when total capacity is larger', async () => {
  let candidateLimit = null;
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('FROM task_auto_assignment_settings')) return { rows: [{ enabled: true, version: 1 }] };
    if (sql.includes('FROM app_users AS app_user')) {
      return { rows: [{ username: 'alice' }, { username: 'bob' }] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS pool')) {
      return { rows: [
        { username: 'alice', assignment_limit: 500 },
        { username: 'bob', assignment_limit: 500 },
      ] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS locked_pool')) {
      return { rows: [
        { username: 'alice', assignment_limit: 500, current_task_count: '0', last_auto_event_id: null },
        { username: 'bob', assignment_limit: 500, current_task_count: '0', last_auto_event_id: null },
      ] };
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      candidateLimit = values[0];
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await runAutoAssignmentReplenishment(database.pool);
  assert.equal(result.outcome, 'NO_PENDING_TASKS');
  assert.equal(result.capacityBefore, 1_000);
  assert.equal(candidateLimit, 500);
});

test('worker metrics use a new statement after a waited member lock', async () => {
  let memberLockFinished = false;
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('FROM task_auto_assignment_settings')) return { rows: [{ enabled: true, version: 1 }] };
    if (sql.includes('FROM app_users AS app_user')) return { rows: [{ username: 'alice' }] };
    if (sql.includes('FROM task_auto_assignment_workers AS pool')) {
      assert.doesNotMatch(sql, /FROM tasks|task_assignment_events/u);
      memberLockFinished = true;
      return { rows: [{ username: 'alice', assignment_limit: 2 }] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS locked_pool')) {
      assert.equal(memberLockFinished, true);
      return { rows: [{ username: 'alice', assignment_limit: 2,
        current_task_count: '1', last_auto_event_id: null }] };
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      assert.equal(values[0], 1, 'a manual assignment committed before the member lock must consume capacity');
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await runAutoAssignmentReplenishment(database.pool);
  assert.equal(result.outcome, 'NO_PENDING_TASKS');
  assert.equal(result.capacityBefore, 1);
  const lockIndex = database.calls.findIndex(({ sql }) => sql.includes('FOR UPDATE OF pool'));
  const metricsIndex = database.calls.findIndex(({ sql }) => sql.includes('AS locked_pool'));
  assert.ok(lockIndex > 0 && metricsIndex > lockIndex);
});

test('a changed locked batch rolls the whole transaction back before writing audit rows', async () => {
  let audited = false;
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('FROM task_auto_assignment_settings')) return { rows: [{ enabled: true, version: 1 }] };
    if (sql.includes('FROM app_users AS app_user')) return { rows: [{ username: 'alice' }] };
    if (sql.includes('FROM task_auto_assignment_workers AS pool')) {
      return { rows: [{ username: 'alice', assignment_limit: 2 }] };
    }
    if (sql.includes('FROM task_auto_assignment_workers AS locked_pool')) {
      return { rows: [{ username: 'alice', assignment_limit: 2,
        current_task_count: '0', last_auto_event_id: null }] };
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [{ id: '1' }, { id: '2' }] };
    if (sql.includes('UPDATE tasks AS task')) {
      return { rows: [{ id: values[0][0], assigned_to_user_id: values[1][0] }] };
    }
    if (sql.includes('INSERT INTO task_assignment_events')) {
      audited = true;
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(runAutoAssignmentReplenishment(database.pool), /changed while its tasks were locked/u);
  assert.equal(audited, false);
  assert.equal(database.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(database.released, true);
});

test('manual assignment locks a target pool member before task rows without enforcing its limit', async () => {
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes("status = 'ACTIVE' AND role = 'USER'")) return { rows: [{ username: 'alice' }] };
    if (sql.includes('SELECT username FROM task_auto_assignment_workers')) return { rows: [{ username: 'alice' }] };
    if (sql.includes('SELECT * FROM tasks WHERE id = ANY')) return { rows: [taskRow(9)] };
    if (sql.includes('UPDATE tasks SET')) return { rows: [taskRow(9, {
      assigned_to_user_id: values[1], assignment_source: 'MANUAL', assigned_at: new Date(),
    })] };
    if (sql.includes('INSERT INTO task_assignment_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const repository = new PostgresControlPlaneRepository({ pool: database.pool });
  const task = await repository.assignTask(9, {
    assignedToUserId: 'alice', actorUserId: 'admin', reason: '管理员明确超额也允许',
  });
  assert.equal(task.assignedToUserId, 'alice');
  const userLock = database.calls.findIndex(({ sql }) => sql.includes("status = 'ACTIVE' AND role = 'USER'"));
  const memberLock = database.calls.findIndex(({ sql }) => sql.includes('SELECT username FROM task_auto_assignment_workers'));
  const taskLock = database.calls.findIndex(({ sql }) => sql.includes('SELECT * FROM tasks WHERE id = ANY'));
  assert.ok(userLock > 0 && userLock < memberLock && memberLock < taskLock);
  assert.match(database.calls[userLock].sql, /FOR UPDATE/u);
  assert.equal(database.calls.some(({ sql }) => sql.includes('assignment_limit')), false);
});

test('SELF task creation locks its account and pool member before inserting the task', async () => {
  const database = fakePool(({ sql, values }) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('INSERT INTO executor_nodes')) return { rows: [] };
    if (sql.includes('SELECT username FROM app_users')) return { rows: [{ username: 'alice' }] };
    if (sql.includes('SELECT username FROM task_auto_assignment_workers')) return { rows: [{ username: 'alice' }] };
    if (sql.includes('INSERT INTO tasks')) return { rows: [taskRow(12, {
      created_by_user_id: 'alice', assigned_to_user_id: values[6],
      assignment_source: values[7], assigned_at: new Date(),
    })] };
    if (sql.includes('INSERT INTO task_assignment_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const repository = new PostgresControlPlaneRepository({ pool: database.pool });
  const [task] = await repository.createTasks({
    nodeId: 'node-a', createdByUserId: 'alice', assignedToUserId: 'alice',
    assignmentSource: 'SELF', tasks: [{ query: '用户自建任务' }],
  });
  assert.equal(task.assignedToUserId, 'alice');
  const userLock = database.calls.findIndex(({ sql }) => sql.includes('SELECT username FROM app_users'));
  const memberLock = database.calls.findIndex(({ sql }) => sql.includes('SELECT username FROM task_auto_assignment_workers'));
  const taskInsert = database.calls.findIndex(({ sql }) => sql.includes('INSERT INTO tasks'));
  assert.ok(userLock > 0 && userLock < memberLock && memberLock < taskInsert);
  assert.match(database.calls[userLock].sql, /FOR UPDATE/u);
  assert.match(database.calls[userLock].sql, /status = 'ACTIVE'/u);
  assert.doesNotMatch(database.calls[userLock].sql, /role = 'USER'/u);
});

test('SELF task creation rejects a missing or inactive account before locking the pool or inserting tasks', async () => {
  let poolLocked = false;
  let taskInserted = false;
  const database = fakePool(({ sql }) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('INSERT INTO executor_nodes')) return { rows: [] };
    if (sql.includes('SELECT username FROM app_users')) return { rows: [] };
    if (sql.includes('SELECT username FROM task_auto_assignment_workers')) {
      poolLocked = true;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO tasks')) {
      taskInserted = true;
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const repository = new PostgresControlPlaneRepository({ pool: database.pool });

  await assert.rejects(repository.createTasks({
    nodeId: 'node-a', createdByUserId: 'disabled-user', assignedToUserId: 'disabled-user',
    assignmentSource: 'SELF', tasks: [{ query: '不应写入' }],
  }), error => error?.code === 'ASSIGNEE_UNAVAILABLE');
  assert.equal(poolLocked, false);
  assert.equal(taskInserted, false);
  assert.equal(database.calls.at(-1).sql, 'ROLLBACK');
});

test('scheduler starts immediately, never overlaps, continues after errors and stop waits for a running scan', async () => {
  const firstEntered = Promise.withResolvers();
  const firstFinish = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const errors = [];
  let calls = 0;
  const repository = { async replenishAutoAssignments() {
    calls += 1;
    if (calls === 1) {
      firstEntered.resolve();
      await firstFinish.promise;
      throw new Error('temporary database outage');
    }
    secondEntered.resolve();
    return { assignedCount: 0 };
  } };
  const stop = startAutoAssignmentReplenishment(repository, {
    intervalMs: 5,
    log: { log() {}, error(message) { errors.push(message); } },
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await firstEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    firstFinish.resolve();
    await secondEntered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls >= 2);
    assert.equal(errors.length, 1);

    const runningEntered = Promise.withResolvers();
    const runningFinish = Promise.withResolvers();
    repository.replenishAutoAssignments = async () => {
      calls += 1;
      runningEntered.resolve();
      await runningFinish.promise;
      return { assignedCount: 0 };
    };
    await runningEntered.promise;
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    runningFinish.resolve();
    await stopping;
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, stoppedAt);
  } finally {
    firstFinish.resolve();
    await stop();
    clearTimeout(keepAlive);
  }
});

test('CLI starts and stops replenishment with the center process lifecycle', async () => {
  const source = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(source, /startAutoAssignmentReplenishment\(repository\)/u);
  assert.match(source, /Promise\.all\(\[stopRecovery\(\), stopAutoAssignment\(\)\]\)/u);
  assert.match(source, /if \(stoppingPromise\) return stoppingPromise/u);
  assert.match(source, /stoppingPromise = \(async \(\) =>/u);
});
