import { normalizeTaskId } from './domain.mjs';
import { normalizeAssigneeUserId } from './task-assignment-domain.mjs';
import { normalizeAutoAssignmentLimit } from './task-auto-assignment-domain.mjs';

export const AUTO_ASSIGNMENT_ACTOR = 'system:auto-assignment';
export const AUTO_ASSIGNMENT_MAX_PER_RUN = 500;
export const AUTO_ASSIGNABLE_TASK_STATES = Object.freeze([
  'COPY_REVIEW_PENDING',
]);

const AUTO_ASSIGNMENT_LOCK_KEYS = Object.freeze([4310, 8205]);
const AUTO_ASSIGNMENT_REASON = '自动补充至作业员配额';

function normalizeMaxAssignments(value) {
  if (!Number.isInteger(value) || value < 1 || value > AUTO_ASSIGNMENT_MAX_PER_RUN) {
    throw new RangeError(`maxAssignments must be an integer from 1 to ${AUTO_ASSIGNMENT_MAX_PER_RUN}`);
  }
  return value;
}

function normalizeCurrentTaskCount(value, username) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`currentTaskCount for ${username} must be a non-negative integer`);
  }
  return count;
}

function normalizeEventRank(value, username) {
  if (value === null || value === undefined) return null;
  try {
    const rank = BigInt(value);
    if (rank < 1n) throw new Error('rank must be positive');
    return rank;
  } catch {
    throw new TypeError(`lastAutoEventId for ${username} must be a positive integer or null`);
  }
}

function compareWorkerPriority(left, right) {
  const proportionalLoad = left.projectedTaskCount * right.assignmentLimit
    - right.projectedTaskCount * left.assignmentLimit;
  if (proportionalLoad !== 0) return proportionalLoad;
  if (left.lastServedRank === null && right.lastServedRank !== null) return -1;
  if (left.lastServedRank !== null && right.lastServedRank === null) return 1;
  if (left.lastServedRank !== null && right.lastServedRank !== null
    && left.lastServedRank !== right.lastServedRank) {
    return left.lastServedRank < right.lastServedRank ? -1 : 1;
  }
  return left.username.localeCompare(right.username);
}

export function planAutoAssignments({ workers, tasks, maxAssignments = AUTO_ASSIGNMENT_MAX_PER_RUN }) {
  if (!Array.isArray(workers)) throw new TypeError('workers must be an array');
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  const limit = normalizeMaxAssignments(maxAssignments);
  const candidates = workers.map((worker) => {
    const username = normalizeAssigneeUserId(worker?.username, { allowNull: false });
    const assignmentLimit = normalizeAutoAssignmentLimit(worker?.assignmentLimit);
    const currentTaskCount = normalizeCurrentTaskCount(worker?.currentTaskCount, username);
    return {
      username,
      assignmentLimit,
      currentTaskCount,
      projectedTaskCount: currentTaskCount,
      lastServedRank: normalizeEventRank(worker?.lastAutoEventId, username),
    };
  });
  if (new Set(candidates.map((worker) => worker.username)).size !== candidates.length) {
    throw new TypeError('workers must not contain duplicate usernames');
  }
  const pendingTasks = tasks.map((task) => ({
    id: normalizeTaskId(task?.id ?? task?.taskId),
  }));
  if (new Set(pendingTasks.map((task) => task.id)).size !== pendingTasks.length) {
    throw new TypeError('tasks must not contain duplicate IDs');
  }
  pendingTasks.sort((left, right) => left.id - right.id);

  let latestRank = candidates.reduce((maximum, worker) => (
    worker.lastServedRank !== null && worker.lastServedRank > maximum
      ? worker.lastServedRank : maximum
  ), 0n);
  const assignments = [];
  for (const task of pendingTasks.slice(0, limit)) {
    const available = candidates
      .filter((worker) => worker.projectedTaskCount < worker.assignmentLimit)
      .sort(compareWorkerPriority);
    if (!available.length) break;
    const worker = available[0];
    assignments.push({ taskId: task.id, assignedToUserId: worker.username });
    worker.projectedTaskCount += 1;
    latestRank += 1n;
    worker.lastServedRank = latestRank;
  }
  return assignments;
}

function summary(outcome, {
  settingsVersion = null,
  eligibleWorkerCount = 0,
  capacityBefore = 0,
  assignedTaskIds = [],
  byWorker = [],
} = {}) {
  return {
    outcome,
    settingsVersion,
    eligibleWorkerCount,
    capacityBefore,
    assignedCount: assignedTaskIds.length,
    capacityAfter: Math.max(0, capacityBefore - assignedTaskIds.length),
    assignedTaskIds,
    byWorker,
  };
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runAutoAssignmentReplenishment(pool, {
  maxAssignments = AUTO_ASSIGNMENT_MAX_PER_RUN,
} = {}) {
  const safeMaxAssignments = normalizeMaxAssignments(maxAssignments);
  return transaction(pool, async (client) => {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
      AUTO_ASSIGNMENT_LOCK_KEYS,
    );
    if (lockResult.rows[0]?.acquired !== true) return summary('BUSY');

    const settingsResult = await client.query(`
      SELECT enabled, version
      FROM task_auto_assignment_settings
      WHERE singleton = 1
      FOR SHARE
    `);
    const settings = settingsResult.rows[0];
    if (!settings) throw new Error('automatic assignment settings are unavailable');
    const settingsVersion = Number(settings.version);
    if (settings.enabled !== true) return summary('DISABLED', { settingsVersion });

    // Lock account rows before pool rows. User deletion takes the same order
    // before its membership is removed by the foreign-key cascade.
    const userResult = await client.query(`
      SELECT app_user.username
      FROM app_users AS app_user
      WHERE app_user.role = 'USER'
        AND app_user.status = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM task_auto_assignment_workers AS membership
          WHERE membership.username = app_user.username
            AND membership.status = 'ACTIVE'
        )
      ORDER BY app_user.username
      FOR SHARE OF app_user
    `);
    const usernames = userResult.rows.map((row) => row.username);
    if (!usernames.length) {
      return summary('NO_ELIGIBLE_WORKERS', { settingsVersion });
    }

    // Acquire membership locks without reading task-derived metrics in this
    // statement. Under READ COMMITTED a SELECT snapshot is taken before a row
    // lock wait; counts must be read by the following statement after the lock.
    const lockedWorkerResult = await client.query(`
      SELECT pool.username, pool.assignment_limit
      FROM task_auto_assignment_workers AS pool
      WHERE pool.status = 'ACTIVE'
        AND pool.username = ANY($1::varchar[])
      ORDER BY pool.username
      FOR UPDATE OF pool
    `, [usernames]);
    if (!lockedWorkerResult.rows.length) {
      return summary('NO_ELIGIBLE_WORKERS', { settingsVersion });
    }
    const lockedUsernames = lockedWorkerResult.rows.map((row) => row.username);

    const workerResult = await client.query(`
      SELECT
        locked_pool.username,
        locked_pool.assignment_limit,
        (
          SELECT COUNT(*)
          FROM tasks AS assigned_task
          WHERE assigned_task.assigned_to_user_id = locked_pool.username
            AND assigned_task.state = 'COPY_REVIEW_PENDING'
            AND assigned_task.current_stage = 'COPY_REVIEW_PENDING'
            AND assigned_task.current_execution_id IS NULL
        ) AS current_task_count,
        fairness_cursor.last_auto_event_id
      FROM task_auto_assignment_workers AS locked_pool
      LEFT JOIN task_auto_assignment_cursors AS fairness_cursor
        ON fairness_cursor.username = locked_pool.username
      WHERE locked_pool.status = 'ACTIVE'
        AND locked_pool.username = ANY($1::varchar[])
      ORDER BY locked_pool.username
    `, [lockedUsernames]);
    if (workerResult.rows.length !== lockedWorkerResult.rows.length) {
      throw new Error('locked automatic assignment membership changed unexpectedly');
    }
    const workers = workerResult.rows.map((row) => ({
      username: row.username,
      assignmentLimit: Number(row.assignment_limit),
      currentTaskCount: Number(row.current_task_count),
      lastAutoEventId: row.last_auto_event_id,
    }));
    if (!workers.length) {
      return summary('NO_ELIGIBLE_WORKERS', { settingsVersion });
    }
    const capacityBefore = workers.reduce((total, worker) => (
      total + Math.max(0, worker.assignmentLimit - worker.currentTaskCount)
    ), 0);
    if (capacityBefore === 0) {
      return summary('AT_CAPACITY', {
        settingsVersion,
        eligibleWorkerCount: workers.length,
      });
    }

    const candidateLimit = Math.min(capacityBefore, safeMaxAssignments);
    const candidateResult = await client.query(`
      SELECT id
      FROM tasks
      WHERE assigned_to_user_id IS NULL
        AND state = ANY($1::varchar[])
        AND current_stage = 'COPY_REVIEW_PENDING'
        AND current_execution_id IS NULL
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT $2::integer
    `, [AUTO_ASSIGNABLE_TASK_STATES, candidateLimit]);
    if (!candidateResult.rows.length) {
      return summary('NO_PENDING_TASKS', {
        settingsVersion,
        eligibleWorkerCount: workers.length,
        capacityBefore,
      });
    }

    const assignments = planAutoAssignments({
      workers,
      tasks: candidateResult.rows,
      maxAssignments: safeMaxAssignments,
    });
    if (assignments.length !== candidateResult.rows.length) {
      throw new Error('automatic assignment plan did not cover every locked task');
    }
    const taskIds = assignments.map((assignment) => assignment.taskId);
    const assignees = assignments.map((assignment) => assignment.assignedToUserId);
    const updatedResult = await client.query(`
      WITH planned(task_id, assignee_username) AS (
        SELECT * FROM unnest($1::bigint[], $2::varchar[])
      )
      UPDATE tasks AS task
      SET assigned_to_user_id = planned.assignee_username,
          assignment_source = 'AUTO',
          assigned_at = now(),
          progress_message = CASE
            WHEN task.progress_message IS NULL OR task.progress_message IN (
                '等待管理员分配作业员',
                '等待分配负责人',
                '负责人待分配，等待文案执行机领取',
                '文案生成完成，等待分配负责人后审核'
              )
              THEN '文案生成完成，等待人工审核'
            ELSE task.progress_message
          END,
          updated_at = now()
      FROM planned
      WHERE task.id = planned.task_id
        AND task.assigned_to_user_id IS NULL
        AND task.state = ANY($3::varchar[])
        AND task.current_stage = 'COPY_REVIEW_PENDING'
        AND task.current_execution_id IS NULL
      RETURNING task.id, task.assigned_to_user_id
    `, [taskIds, assignees, AUTO_ASSIGNABLE_TASK_STATES]);
    const expectedAssignments = new Map(assignments.map((assignment) => [
      assignment.taskId,
      assignment.assignedToUserId,
    ]));
    if (updatedResult.rows.length !== assignments.length
      || updatedResult.rows.some((row) => (
        expectedAssignments.get(normalizeTaskId(row.id)) !== row.assigned_to_user_id
      ))) {
      throw new Error('automatic assignment changed while its tasks were locked');
    }

    const auditResult = await client.query(`
      INSERT INTO task_assignment_events(
        task_id, actor_username, previous_assignee_user_id,
        assignee_user_id, source, reason
      )
      SELECT assignment.task_id, $3, NULL,
        assignment.assignee_username, 'AUTO', $4
      FROM unnest($1::bigint[], $2::varchar[])
        WITH ORDINALITY AS assignment(task_id, assignee_username, ordinal)
      ORDER BY assignment.ordinal
      RETURNING id, task_id, assignee_user_id
    `, [taskIds, assignees, AUTO_ASSIGNMENT_ACTOR, AUTO_ASSIGNMENT_REASON]);
    const latestEventByAssignee = new Map();
    const auditedTaskIds = new Set();
    for (const row of auditResult.rows) {
      const taskId = normalizeTaskId(row.task_id);
      const assignee = normalizeAssigneeUserId(row.assignee_user_id, { allowNull: false });
      if (auditedTaskIds.has(taskId) || expectedAssignments.get(taskId) !== assignee) {
        throw new Error('automatic assignment audit is incomplete');
      }
      auditedTaskIds.add(taskId);
      const eventId = normalizeEventRank(row.id, assignee);
      const currentEventId = latestEventByAssignee.get(assignee);
      if (currentEventId === undefined || eventId > currentEventId) {
        latestEventByAssignee.set(assignee, eventId);
      }
    }
    if (auditedTaskIds.size !== assignments.length) {
      throw new Error('automatic assignment audit is incomplete');
    }

    const cursorEntries = [...latestEventByAssignee.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    const cursorUsernames = cursorEntries.map(([username]) => username);
    const cursorEventIds = cursorEntries.map(([, eventId]) => eventId.toString());
    const cursorResult = await client.query(`
      INSERT INTO task_auto_assignment_cursors AS current_cursor(
        username, last_auto_event_id
      )
      SELECT cursor_value.username, cursor_value.event_id
      FROM unnest($1::varchar[], $2::bigint[])
        AS cursor_value(username, event_id)
      ON CONFLICT(username) DO UPDATE SET
        last_auto_event_id = GREATEST(
          current_cursor.last_auto_event_id,
          excluded.last_auto_event_id
        ),
        updated_at = now()
      RETURNING username, last_auto_event_id
    `, [cursorUsernames, cursorEventIds]);
    const expectedCursorByUser = new Map(cursorEntries);
    if (cursorResult.rows.length !== cursorEntries.length
      || cursorResult.rows.some((row) => {
        const username = normalizeAssigneeUserId(row.username, { allowNull: false });
        return expectedCursorByUser.get(username) !== normalizeEventRank(row.last_auto_event_id, username);
      })) {
      throw new Error('automatic assignment fairness cursor is incomplete');
    }

    const assignedCounts = new Map();
    for (const assignee of assignees) {
      assignedCounts.set(assignee, (assignedCounts.get(assignee) ?? 0) + 1);
    }
    const byWorker = workers
      .filter((worker) => assignedCounts.has(worker.username))
      .map((worker) => ({
        username: worker.username,
        assignmentLimit: worker.assignmentLimit,
        beforeCount: worker.currentTaskCount,
        assignedCount: assignedCounts.get(worker.username),
        afterCount: worker.currentTaskCount + assignedCounts.get(worker.username),
      }));
    return summary('ASSIGNED', {
      settingsVersion,
      eligibleWorkerCount: workers.length,
      capacityBefore,
      assignedTaskIds: taskIds,
      byWorker,
    });
  });
}

function safeLog(log, method, message) {
  try {
    log?.[method]?.(message);
  } catch {
    // A logger failure must not stop continuous replenishment.
  }
}

export function startAutoAssignmentReplenishment(repository, {
  intervalMs = 5_000,
  log = console,
  runImmediately = true,
} = {}) {
  if (!repository || typeof repository.replenishAutoAssignments !== 'function') {
    throw new TypeError('repository.replenishAutoAssignments is required');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('intervalMs must be a positive integer');
  }
  if (typeof runImmediately !== 'boolean') throw new TypeError('runImmediately must be a boolean');
  let running = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(() => repository.replenishAutoAssignments())
      .then((result) => {
        if (result.assignedCount > 0) {
          safeLog(log, 'log', `Automatically assigned ${result.assignedCount} pending task(s).`);
        }
        return result;
      })
      .catch((error) => {
        safeLog(log, 'error', `Automatic assignment replenishment failed: ${error?.message ?? error}`);
        return null;
      })
      .finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  if (runImmediately) void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
