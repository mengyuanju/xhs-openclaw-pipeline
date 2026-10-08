import {
  AUTO_ASSIGNABLE_TASK_STATES,
  AUTO_ASSIGNMENT_ACTOR,
  AUTO_ASSIGNMENT_WORKER_RECORD_SQL,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  FIXED_QUANTITY_ASSIGNMENT_REASON,
  assertActiveAssignableUser,
  assertAutoAssignmentVersion,
  autoAssignmentAdminEventFrom,
  autoAssignmentSettingsFrom,
  autoAssignmentWorkerFrom,
  autoCreateCopyQaBatchesV2,
  clearQueryPackageAssignments,
  hashUserPassword,
  lockAccountIdentity,
  lockAdministratorRoster,
  lockCurrentActor,
  managedUserFrom,
  normalizeAutoAssignmentEnabled,
  normalizeAutoAssignmentExpectedVersion,
  normalizeAutoAssignmentLimit,
  normalizeAutoAssignmentMode,
  normalizeAutoAssignmentWorkerStatus,
  normalizeCopySamplingRateOverride,
  normalizeTaskId,
  normalizedActorIdentity,
  normalizedDisplayName,
  normalizedUserRole,
  normalizedUsername,
  priorityOrderSql,
  publicUserFrom,
  readAutoAssignmentWorker,
  recordAccountSamplingPolicy,
  recordAutoAssignmentAdminEvent,
  transaction,
  verifyUserPassword
} from './repository-context.mjs';
import { StatisticsRepository } from './repository-statistics.mjs';

export class AccountRepository extends StatisticsRepository {
  async authenticateUser(rawUsername, password) {
    let username;
    try {
      username = normalizedUsername(rawUsername);
    } catch {
      return null;
    }
    const result = await this.pool.query(
      "SELECT * FROM app_users WHERE username = $1 AND status = 'ACTIVE'",
      [username],
    );
    const row = result.rows[0];
    if (!row || !await verifyUserPassword(password, row.password_hash)) return null;
    return publicUserFrom(row);
  }

  async getUserByUsername(rawUsername) {
    const username = normalizedUsername(rawUsername);
    const result = await this.pool.query('SELECT * FROM app_users WHERE username = $1', [username]);
    return publicUserFrom(result.rows[0]);
  }

  async listUsers({ status = null } = {}) {
    if (status !== null && !['ACTIVE', 'DISABLED'].includes(status)) throw new TypeError('status is invalid');
    const result = status
      ? await this.pool.query('SELECT * FROM app_users WHERE status = $1 ORDER BY id', [status])
      : await this.pool.query('SELECT * FROM app_users ORDER BY id');
    return result.rows.map(managedUserFrom);
  }

  async getUserByIdentity(rawActor) {
    const actor = normalizedActorIdentity(rawActor);
    const result = await this.pool.query(`
      SELECT * FROM app_users
      WHERE id = $1 AND username = $2 AND role = $3
        AND status = 'ACTIVE' AND credential_version = $4
    `, [actor.userId, actor.username, actor.role, actor.credentialVersion]);
    return publicUserFrom(result.rows[0]);
  }

  async getAutoAssignmentOverview() {
    const [settingsResult, workersResult, pendingResult, eventsResult] = await Promise.all([
      this.pool.query('SELECT * FROM task_auto_assignment_settings WHERE singleton = 1'),
      this.pool.query(`${AUTO_ASSIGNMENT_WORKER_RECORD_SQL}
        ORDER BY CASE pool.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, pool.username`),
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE state NOT IN ('REVIEWED', 'CANCELLED')
          ) AS count,
          COUNT(*) FILTER (
            WHERE state = 'COPY_REVIEW_PENDING'
              AND current_stage = 'COPY_REVIEW_PENDING'
              AND current_execution_id IS NULL
          ) AS auto_assignable_count
        FROM tasks
        WHERE assigned_to_user_id IS NULL
      `),
      this.pool.query(`
        SELECT * FROM task_auto_assignment_admin_events
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `),
    ]);
    const settings = autoAssignmentSettingsFrom(settingsResult.rows[0]);
    if (!settings) throw new ControlPlaneNotFoundError('automatic assignment settings not found');
    const unassignedTaskCount = Number(pendingResult.rows[0]?.count ?? 0);
    const autoAssignableTaskCount = Number(pendingResult.rows[0]?.auto_assignable_count ?? 0);
    return {
      settings,
      workers: workersResult.rows.map(autoAssignmentWorkerFrom),
      unassignedTaskCount,
      autoAssignableTaskCount,
      manualAttentionTaskCount: Math.max(0, unassignedTaskCount - autoAssignableTaskCount),
      events: eventsResult.rows.map(autoAssignmentAdminEventFrom),
    };
  }

  async getAutoAssignmentWorker(rawUsername) {
    const username = normalizedUsername(rawUsername);
    const worker = await readAutoAssignmentWorker(this.pool, username);
    if (!worker) throw new ControlPlaneNotFoundError('automatic assignment worker not found');
    return worker;
  }

  async updateAutoAssignmentSettings({
    enabled: rawEnabled,
    mode: rawMode,
    expectedVersion: rawExpectedVersion,
    actor: rawActor = null,
    actorUsername: rawActorUsername,
  }) {
    const enabled = normalizeAutoAssignmentEnabled(rawEnabled);
    const requestedMode = rawMode === undefined ? null : normalizeAutoAssignmentMode(rawMode);
    const expectedVersion = normalizeAutoAssignmentExpectedVersion(rawExpectedVersion);
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const actorUsername = actor?.username ?? normalizedUsername(rawActorUsername);
    return transaction(this.pool, async (client) => {
      if (actor !== null) {
        const locked = await lockCurrentActor(client, actor);
        if (locked.actor.role !== 'ADMIN') {
          throw new ControlPlaneAuthorizationError('only administrators can update automatic assignment settings');
        }
      }
      const currentResult = await client.query(
        'SELECT * FROM task_auto_assignment_settings WHERE singleton = 1 FOR UPDATE',
      );
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('automatic assignment settings not found');
      assertAutoAssignmentVersion(current.version, expectedVersion, 'automatic assignment settings');
      const currentMode = normalizeAutoAssignmentMode(current.mode ?? 'CONTINUOUS');
      const mode = requestedMode ?? currentMode;
      if (current.enabled === enabled && currentMode === mode) return autoAssignmentSettingsFrom(current);
      const updatedResult = await client.query(`
        UPDATE task_auto_assignment_settings
        SET enabled = $1, mode = $2, version = version + 1,
            updated_by_username = $3, updated_at = now()
        WHERE singleton = 1 AND version = $4
        RETURNING *
      `, [enabled, mode, actorUsername, expectedVersion]);
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ControlPlaneConflictError(
          'VERSION_CONFLICT',
          'automatic assignment settings were updated by another request',
        );
      }
      await recordAutoAssignmentAdminEvent(client, {
        actorUsername,
        action: 'SETTINGS_UPDATED',
        details: {
          previous: {
            enabled: current.enabled === true,
            mode: currentMode,
            version: Number(current.version),
          },
          next: {
            enabled: updated.enabled === true,
            mode: normalizeAutoAssignmentMode(updated.mode ?? mode),
            version: Number(updated.version),
          },
        },
      });
      return autoAssignmentSettingsFrom(updated);
    });
  }

  async putAutoAssignmentWorker(rawUsername, {
    status: rawStatus,
    assignmentLimit: rawAssignmentLimit,
    expectedVersion: rawExpectedVersion,
    accountId: rawAccountId = null,
    actor: rawActor = null,
    actorUsername: rawActorUsername,
  }) {
    const username = normalizedUsername(rawUsername);
    const status = normalizeAutoAssignmentWorkerStatus(rawStatus);
    const assignmentLimit = normalizeAutoAssignmentLimit(rawAssignmentLimit);
    const expectedVersion = normalizeAutoAssignmentExpectedVersion(rawExpectedVersion, { required: false });
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const actorUsername = actor?.username ?? normalizedUsername(rawActorUsername);
    const accountId = rawAccountId === null || rawAccountId === undefined
      ? null : normalizeTaskId(rawAccountId);
    if (actor !== null && accountId === null) {
      throw new TypeError('authenticated automatic assignment updates require a stable worker account id');
    }
    return transaction(this.pool, async (client) => {
      if (actor !== null) {
        const locked = await lockCurrentActor(client, actor);
        if (locked.actor.role !== 'ADMIN') {
          throw new ControlPlaneAuthorizationError('only administrators can manage automatic assignment workers');
        }
      }
      // Lock an eligible account before its pool row so a concurrent role/status
      // change cannot make an ACTIVE membership stale as it is written.
      if (accountId !== null) await lockAccountIdentity(client, username, accountId);
      if (status === 'ACTIVE') await assertActiveAssignableUser(client, username, accountId);
      const currentResult = await client.query(
        'SELECT * FROM task_auto_assignment_workers WHERE username = $1 FOR UPDATE',
        [username],
      );
      let current = currentResult.rows[0];
      if (!current) {
        if (expectedVersion !== null) {
          throw new ControlPlaneConflictError(
            'VERSION_CONFLICT',
            'automatic assignment worker no longer matches the requested version',
          );
        }
        if (status !== 'ACTIVE') await assertActiveAssignableUser(client, username, accountId);
        const insertedResult = await client.query(`
          INSERT INTO task_auto_assignment_workers(
            username, status, assignment_limit, created_by_username, updated_by_username
          ) VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT(username) DO NOTHING
          RETURNING *
        `, [username, status, assignmentLimit, actorUsername]);
        const inserted = insertedResult.rows[0];
        if (inserted) {
          await recordAutoAssignmentAdminEvent(client, {
            actorUsername,
            action: 'WORKER_ADDED',
            workerUsername: username,
            details: {
              next: { status, assignmentLimit, version: Number(inserted.version) },
            },
          });
          return readAutoAssignmentWorker(client, username);
        }

        // A concurrent identical PUT may have won the unique-key race. Reading
        // the committed row makes retries idempotent without creating two audits.
        const concurrentResult = await client.query(
          'SELECT * FROM task_auto_assignment_workers WHERE username = $1 FOR UPDATE',
          [username],
        );
        current = concurrentResult.rows[0];
        if (current && current.status === status
          && Number(current.assignment_limit) === assignmentLimit) {
          return readAutoAssignmentWorker(client, username);
        }
        throw new ControlPlaneConflictError(
          'VERSION_CONFLICT',
          'automatic assignment worker was created by another request',
        );
      }

      if (expectedVersion !== null) {
        assertAutoAssignmentVersion(current.version, expectedVersion, 'automatic assignment worker');
      }
      if (current.status === status && Number(current.assignment_limit) === assignmentLimit) {
        return readAutoAssignmentWorker(client, username);
      }
      if (expectedVersion === null) {
        throw new TypeError('expectedVersion is required when updating an automatic assignment worker');
      }
      const updatedResult = await client.query(`
        UPDATE task_auto_assignment_workers
        SET status = $2, assignment_limit = $3,
            version = version + 1, updated_by_username = $4, updated_at = now()
        WHERE username = $1 AND version = $5
        RETURNING *
      `, [username, status, assignmentLimit, actorUsername, expectedVersion]);
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ControlPlaneConflictError(
          'VERSION_CONFLICT',
          'automatic assignment worker was updated by another request',
        );
      }
      await recordAutoAssignmentAdminEvent(client, {
        actorUsername,
        action: 'WORKER_UPDATED',
        workerUsername: username,
        details: {
          previous: {
            status: current.status,
            assignmentLimit: Number(current.assignment_limit),
            version: Number(current.version),
          },
          next: {
            status: updated.status,
            assignmentLimit: Number(updated.assignment_limit),
            version: Number(updated.version),
          },
        },
      });
      return readAutoAssignmentWorker(client, username);
    });
  }

  async allocateAutoAssignmentWorker(rawUsername, {
    expectedVersion: rawExpectedVersion,
    accountId: rawAccountId,
    actor: rawActor,
  }) {
    const username = normalizedUsername(rawUsername);
    const expectedVersion = normalizeAutoAssignmentExpectedVersion(rawExpectedVersion);
    const accountId = normalizeTaskId(rawAccountId);
    const actor = normalizedActorIdentity(rawActor);
    return transaction(this.pool, async (client) => {
      const lockedActor = await lockCurrentActor(client, actor);
      if (lockedActor.actor.role !== 'ADMIN') {
        throw new ControlPlaneAuthorizationError('only administrators can run fixed-quantity assignment');
      }

      const settingsResult = await client.query(`
        SELECT enabled, mode, version
        FROM task_auto_assignment_settings
        WHERE singleton = 1
        FOR SHARE
      `);
      const settings = settingsResult.rows[0];
      if (!settings) throw new ControlPlaneNotFoundError('automatic assignment settings not found');
      if (settings.enabled !== true) {
        throw new ControlPlaneConflictError('AUTO_ASSIGNMENT_DISABLED', 'automatic assignment is disabled');
      }
      const mode = normalizeAutoAssignmentMode(settings.mode ?? 'CONTINUOUS');
      if (mode !== 'FIXED_QUANTITY') {
        throw new ControlPlaneConflictError(
          'AUTO_ASSIGNMENT_MODE_CHANGED',
          'automatic assignment is not in fixed-quantity mode',
        );
      }

      // Keep the account and membership stable while selecting and assigning
      // tasks. Manual assignment uses the same account -> member -> task order.
      await lockAccountIdentity(client, username, accountId);
      await assertActiveAssignableUser(client, username, accountId);
      const memberResult = await client.query(`
        SELECT *
        FROM task_auto_assignment_workers
        WHERE username = $1
        FOR UPDATE
      `, [username]);
      const member = memberResult.rows[0];
      if (!member) throw new ControlPlaneNotFoundError('automatic assignment worker not found');
      assertAutoAssignmentVersion(member.version, expectedVersion, 'automatic assignment worker');
      if (member.status !== 'ACTIVE') {
        throw new ControlPlaneConflictError(
          'AUTO_ASSIGNMENT_WORKER_PAUSED',
          'automatic assignment worker is paused',
        );
      }
      const requestedCount = normalizeAutoAssignmentLimit(Number(member.assignment_limit));
      const workerBefore = await readAutoAssignmentWorker(client, username);
      if (!workerBefore) throw new ControlPlaneNotFoundError('automatic assignment worker not found');

      const candidateResult = await client.query(`
        SELECT id
        FROM tasks
        WHERE assigned_to_user_id IS NULL
          AND state = ANY($1::varchar[])
          AND current_stage = 'COPY_REVIEW_PENDING'
          AND current_execution_id IS NULL
        AND priority_paused = false
        ORDER BY ${priorityOrderSql()}
        FOR UPDATE SKIP LOCKED
        LIMIT $2::integer
      `, [AUTO_ASSIGNABLE_TASK_STATES, requestedCount]);
      const taskIds = candidateResult.rows.map((row) => normalizeTaskId(row.id));
      if (!taskIds.length) {
        return {
          outcome: 'NO_PENDING_TASKS',
          mode,
          settingsVersion: Number(settings.version),
          username,
          requestedCount,
          assignedCount: 0,
          unfilledCount: requestedCount,
          assignedTaskIds: [],
          currentTaskCountBefore: workerBefore.currentTaskCount,
          currentTaskCountAfter: workerBefore.currentTaskCount,
          workerVersion: Number(member.version),
        };
      }

      const updatedResult = await client.query(`
        UPDATE tasks AS task
        SET assigned_to_user_id = $2,
            assignment_source = 'AUTO',
            assigned_at = now(),
            progress_message = CASE
              WHEN task.progress_message IS NULL OR task.progress_message IN (
                  '等待管理员分配标注',
                '等待管理员分配作业员',
                  '等待分配负责人',
                  '负责人待分配，等待文案执行机领取',
                  '文案生成完成，等待分配负责人后审核'
                )
                THEN '文案生成完成，等待人工审核'
              ELSE task.progress_message
            END,
            updated_at = now()
        WHERE task.id = ANY($1::bigint[])
          AND task.assigned_to_user_id IS NULL
          AND task.state = ANY($3::varchar[])
          AND task.current_stage = 'COPY_REVIEW_PENDING'
          AND task.current_execution_id IS NULL
        RETURNING task.id, task.assigned_to_user_id
      `, [taskIds, username, AUTO_ASSIGNABLE_TASK_STATES]);
      const updatedTaskIds = new Set(updatedResult.rows.map((row) => normalizeTaskId(row.id)));
      if (updatedTaskIds.size !== taskIds.length
        || taskIds.some((taskId) => !updatedTaskIds.has(taskId))
        || updatedResult.rows.some((row) => row.assigned_to_user_id !== username)) {
        throw new Error('fixed-quantity assignment changed while its tasks were locked');
      }

      const auditResult = await client.query(`
        INSERT INTO task_assignment_events(
          task_id, actor_username, previous_assignee_user_id,
          assignee_user_id, source, reason
        )
        SELECT selected.task_id, $2, NULL, $3, 'AUTO', $4
        FROM unnest($1::bigint[]) WITH ORDINALITY AS selected(task_id, ordinal)
        ORDER BY selected.ordinal
        RETURNING id, task_id, assignee_user_id
      `, [
        taskIds,
        AUTO_ASSIGNMENT_ACTOR,
        username,
        FIXED_QUANTITY_ASSIGNMENT_REASON,
      ]);
      const auditedTaskIds = new Set(auditResult.rows.map((row) => normalizeTaskId(row.task_id)));
      if (auditedTaskIds.size !== taskIds.length
        || taskIds.some((taskId) => !auditedTaskIds.has(taskId))
        || auditResult.rows.some((row) => row.assignee_user_id !== username)) {
        throw new Error('fixed-quantity assignment audit is incomplete');
      }
      const lastAutoEventId = auditResult.rows.reduce((latest, row) => {
        const eventId = BigInt(row.id);
        return eventId > latest ? eventId : latest;
      }, 0n);
      const cursorResult = await client.query(`
        INSERT INTO task_auto_assignment_cursors AS current_cursor(
          username, last_auto_event_id
        ) VALUES ($1, $2::bigint)
        ON CONFLICT(username) DO UPDATE SET
          last_auto_event_id = GREATEST(
            current_cursor.last_auto_event_id,
            excluded.last_auto_event_id
          ),
          updated_at = now()
        RETURNING username, last_auto_event_id
      `, [username, lastAutoEventId.toString()]);
      if (cursorResult.rows.length !== 1 || cursorResult.rows[0].username !== username
        || BigInt(cursorResult.rows[0].last_auto_event_id) < lastAutoEventId) {
        throw new Error('fixed-quantity assignment cursor is incomplete');
      }

      const nextMemberResult = await client.query(`
        UPDATE task_auto_assignment_workers
        SET version = version + 1,
            updated_by_username = $3,
            updated_at = now()
        WHERE username = $1 AND version = $2
        RETURNING version
      `, [username, expectedVersion, actor.username]);
      const nextMember = nextMemberResult.rows[0];
      if (!nextMember) {
        throw new ControlPlaneConflictError(
          'VERSION_CONFLICT',
          'automatic assignment worker was updated by another request',
        );
      }
      await recordAutoAssignmentAdminEvent(client, {
        actorUsername: actor.username,
        action: 'ALLOCATION_RUN',
        workerUsername: username,
        details: {
          mode,
          requestedCount,
          assignedCount: taskIds.length,
          unfilledCount: requestedCount - taskIds.length,
          assignedTaskIds: taskIds,
          previousVersion: Number(member.version),
          nextVersion: Number(nextMember.version),
        },
      });
      return {
        outcome: 'ASSIGNED',
        mode,
        settingsVersion: Number(settings.version),
        username,
        requestedCount,
        assignedCount: taskIds.length,
        unfilledCount: requestedCount - taskIds.length,
        assignedTaskIds: taskIds,
        currentTaskCountBefore: workerBefore.currentTaskCount,
        currentTaskCountAfter: workerBefore.currentTaskCount + taskIds.length,
        workerVersion: Number(nextMember.version),
      };
    });
  }

  async removeAutoAssignmentWorker(rawUsername, {
    expectedVersion: rawExpectedVersion,
    accountId: rawAccountId = null,
    actor: rawActor = null,
    actorUsername: rawActorUsername,
  }) {
    const username = normalizedUsername(rawUsername);
    const expectedVersion = normalizeAutoAssignmentExpectedVersion(rawExpectedVersion);
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const actorUsername = actor?.username ?? normalizedUsername(rawActorUsername);
    const accountId = rawAccountId === null || rawAccountId === undefined
      ? null : normalizeTaskId(rawAccountId);
    if (actor !== null && accountId === null) {
      throw new TypeError('authenticated automatic assignment updates require a stable worker account id');
    }
    return transaction(this.pool, async (client) => {
      if (actor !== null) {
        const locked = await lockCurrentActor(client, actor);
        if (locked.actor.role !== 'ADMIN') {
          throw new ControlPlaneAuthorizationError('only administrators can manage automatic assignment workers');
        }
      }
      if (accountId !== null) await lockAccountIdentity(client, username, accountId);
      const currentResult = await client.query(
        'SELECT * FROM task_auto_assignment_workers WHERE username = $1 FOR UPDATE',
        [username],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('automatic assignment worker not found');
      assertAutoAssignmentVersion(current.version, expectedVersion, 'automatic assignment worker');
      const deletedResult = await client.query(`
        DELETE FROM task_auto_assignment_workers
        WHERE username = $1 AND version = $2
        RETURNING *
      `, [username, expectedVersion]);
      if (!deletedResult.rows[0]) {
        throw new ControlPlaneConflictError(
          'VERSION_CONFLICT',
          'automatic assignment worker was updated by another request',
        );
      }
      await recordAutoAssignmentAdminEvent(client, {
        actorUsername,
        action: 'WORKER_REMOVED',
        workerUsername: username,
        details: {
          previous: {
            status: current.status,
            assignmentLimit: Number(current.assignment_limit),
            version: Number(current.version),
          },
        },
      });
      return { username, removed: true };
    });
  }

  async createUser({ username: rawUsername, displayName: rawDisplayName, role: rawRole, copyReviewEnabled = true, copyQcEnabled = false, imageQcEnabled = false, copySamplingRateBpsOverride = null, autoCopyBatchEnabled = true, autoCopyBatchSize = 10, copyFullInspection = false, defaultCopyQaPass = false }, { actor = null } = {}) {
    const username = normalizedUsername(rawUsername);
    const displayName = normalizedDisplayName(rawDisplayName);
    const role = normalizedUserRole(rawRole);
    const samplingRate = normalizeCopySamplingRateOverride(copySamplingRateBpsOverride);
    if (typeof autoCopyBatchEnabled !== 'boolean' || typeof copyFullInspection !== 'boolean'
      || !Number.isInteger(autoCopyBatchSize) || autoCopyBatchSize < 1 || autoCopyBatchSize > 5000) throw new TypeError('文案自动成批配置无效');
    if (typeof defaultCopyQaPass !== 'boolean') throw new TypeError('默认通过文案质检开关无效');
    if (typeof copyReviewEnabled !== 'boolean' || typeof copyQcEnabled !== 'boolean'
        || typeof imageQcEnabled !== 'boolean') throw new TypeError('permissions must be boolean');
    if (imageQcEnabled && role !== 'REVIEWER') {
      throw new TypeError('图片质检权限只能授予质检');
    }
    const passwordHash = await hashUserPassword('123456');
    try {
      return await transaction(this.pool, async (client) => {
        if (actor) {
          if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can create users');
          await lockCurrentActor(client, actor);
        }
        const result = await client.query(`
        INSERT INTO app_users(username, display_name, role, password_hash, must_change_password,
          copy_review_enabled, copy_qc_enabled, image_qc_enabled, copy_sampling_rate_bps_override,
          auto_copy_batch_enabled,auto_copy_batch_size,copy_full_inspection,default_copy_qa_pass)
        VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
        `, [username, displayName, role, passwordHash, copyReviewEnabled, copyQcEnabled, imageQcEnabled, samplingRate, autoCopyBatchEnabled, autoCopyBatchSize, copyFullInspection, defaultCopyQaPass]);
        await recordAccountSamplingPolicy(client, result.rows[0].id, null, samplingRate, actor);
        return managedUserFrom(result.rows[0]);
      });
    } catch (error) {
      if (error?.code === '23505') throw new ControlPlaneConflictError('USERNAME_EXISTS', 'username already exists');
      throw error;
    }
  }

  async updateUser(rawUserId, { displayName: rawDisplayName, role: rawRole, status, expectedVersion, copyReviewEnabled, copyQcEnabled, imageQcEnabled, copySamplingRateBpsOverride, autoCopyBatchEnabled, autoCopyBatchSize, copyFullInspection, defaultCopyQaPass, actorUsername = null }, { actor = null } = {}) {
    const userId = normalizeTaskId(rawUserId);
    const displayName = normalizedDisplayName(rawDisplayName);
    const role = normalizedUserRole(rawRole);
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new TypeError('status is invalid');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    if (copySamplingRateBpsOverride !== undefined) normalizeCopySamplingRateOverride(copySamplingRateBpsOverride);
    if (autoCopyBatchEnabled !== undefined && typeof autoCopyBatchEnabled !== 'boolean') throw new TypeError('自动成批开关无效');
    if (copyFullInspection !== undefined && typeof copyFullInspection !== 'boolean') throw new TypeError('全量质检设置无效');
    if (defaultCopyQaPass !== undefined && typeof defaultCopyQaPass !== 'boolean') throw new TypeError('默认通过文案质检开关无效');
    if (autoCopyBatchSize !== undefined && (!Number.isInteger(autoCopyBatchSize) || autoCopyBatchSize < 1 || autoCopyBatchSize > 5000)) throw new TypeError('自动成批数量须为 1–5000');
    return transaction(this.pool, async (client) => {
      await lockAdministratorRoster(client);
      if (actor) {
        if (actor.role !== 'ADMIN') throw new ControlPlaneAuthorizationError('only administrators can update users');
        await lockCurrentActor(client, actor);
      }
      const currentResult = await client.query('SELECT * FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('user not found');
      if (Number(current.version) !== expectedVersion) {
        throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      }
      if (current.role === 'ADMIN' && (role !== 'ADMIN' || status !== 'ACTIVE')) {
        const count = await client.query("SELECT COUNT(*) AS count FROM app_users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
        if (Number(count.rows[0].count) <= 1) {
          throw new ControlPlaneConflictError('LAST_ADMIN', 'the last active administrator cannot be disabled or demoted');
        }
      }
      if (role === 'ADMIN' || status !== 'ACTIVE') {
        const unfinished = await client.query(`
          SELECT id FROM tasks
          WHERE assigned_to_user_id = $1
            AND state NOT IN ('REVIEWED', 'CANCELLED')
          ORDER BY id
          LIMIT 1
          FOR UPDATE
        `, [current.username]);
        if (unfinished.rows[0]) {
          throw new ControlPlaneConflictError(
            'USER_HAS_ACTIVE_TASKS',
            '该账号仍有未完成任务，请先将任务转交其他负责人后再停用或改为管理员',
          );
        }
      }
      const reviewEnabled = copyReviewEnabled ?? current.copy_review_enabled ?? true;
      const previousSamplingRate = current.copy_sampling_rate_bps_override ?? null;
      const samplingRate = copySamplingRateBpsOverride === undefined ? previousSamplingRate : copySamplingRateBpsOverride;
      const qcEnabled = copyQcEnabled ?? current.copy_qc_enabled ?? false;
      const imageQualityEnabled = role === 'REVIEWER'
        ? imageQcEnabled ?? current.image_qc_enabled ?? false
        : false;
      if (typeof reviewEnabled !== 'boolean' || typeof qcEnabled !== 'boolean'
          || typeof imageQualityEnabled !== 'boolean') throw new TypeError('permissions must be boolean');
      if (imageQualityEnabled && role !== 'REVIEWER') {
        throw new TypeError('图片质检权限只能授予质检');
      }
      if (!reviewEnabled && current.copy_review_enabled) {
        // Released assignments remain visible to administrators for reassignment.
        await client.query(`UPDATE tasks SET assigned_to_user_id = NULL, assignment_source = NULL, assigned_at = NULL, updated_at = now()
          WHERE assigned_to_user_id = $1 AND state = 'COPY_REVIEW_PENDING'`, [current.username]);
        await clearQueryPackageAssignments(client, current);
      }
      const credentialChanged = current.role !== role || current.status !== status
        || reviewEnabled !== current.copy_review_enabled || qcEnabled !== current.copy_qc_enabled
        || imageQualityEnabled !== current.image_qc_enabled;
      const result = await client.query(`
        UPDATE app_users
        SET display_name = $1, role = $2, status = $3,
            copy_review_enabled = $7, copy_qc_enabled = $8, image_qc_enabled = $9,
            copy_sampling_rate_bps_override = $10,
            auto_copy_batch_enabled=$11,auto_copy_batch_size=$12,copy_full_inspection=$13,
            default_copy_qa_pass=$14,
            credential_version = credential_version + $4, version = version + 1, updated_at = now()
        WHERE id = $5 AND version = $6
        RETURNING *
      `, [displayName, role, status, credentialChanged ? 1 : 0, userId, expectedVersion,
        reviewEnabled, qcEnabled, imageQualityEnabled, samplingRate,
        autoCopyBatchEnabled ?? current.auto_copy_batch_enabled,
        autoCopyBatchSize ?? current.auto_copy_batch_size,
        copyFullInspection ?? current.copy_full_inspection,
        defaultCopyQaPass ?? current.default_copy_qa_pass ?? false]);
      if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      await recordAccountSamplingPolicy(client, userId, previousSamplingRate, samplingRate, actor ?? { username: actorUsername ?? 'system' });
      if (result.rows[0].auto_copy_batch_enabled && !result.rows[0].default_copy_qa_pass) await autoCreateCopyQaBatchesV2(client,userId);
      await client.query(`UPDATE tasks SET review_assigned_to_account_id = NULL,
          review_assigned_at = NULL, updated_at = now()
        WHERE state = 'MANUAL_ARCHIVE' AND review_assigned_to_account_id = $1
          AND NOT ($2 = 'ACTIVE' AND $3 = ANY(ARRAY['REVIEWER','USER']) AND $4::boolean)`,
      [userId, status, role, reviewEnabled]);
      await client.query(`UPDATE copy_sampling_items SET assigned_review_account_id = NULL,
          assigned_review_at = NULL, updated_at = now()
        WHERE selected AND status = 'PENDING' AND assigned_review_account_id = $1
          AND NOT ($2 = 'ACTIVE' AND $3 = ANY(ARRAY['REVIEWER','USER']) AND $4::boolean)`,
      [userId, status, role, qcEnabled]);
      await client.query("UPDATE tasks SET state = state WHERE state = 'MANUAL_ARCHIVE' AND review_assigned_to_account_id IS NULL");
      await client.query("UPDATE copy_sampling_items SET status = status WHERE selected AND status = 'PENDING' AND assigned_review_account_id IS NULL");
      await client.query(`UPDATE image_sampling_items SET assigned_review_account_id = NULL,
          assigned_review_at = NULL, updated_at = now()
        WHERE selected AND status = 'PENDING' AND assigned_review_account_id = $1
          AND NOT ($2 = 'ACTIVE' AND $3 = 'REVIEWER' AND $4::boolean)`,
      [userId, status, role, imageQualityEnabled]);
      await client.query("UPDATE image_sampling_items SET status = status WHERE selected AND status = 'PENDING' AND assigned_review_account_id IS NULL");
      await client.query(`INSERT INTO copy_quality_permission_events(account_id, actor_username, previous_permissions, permissions)
        VALUES ($1, $2, $3, $4)`, [userId, actorUsername,
        { review: current.copy_review_enabled, qc: current.copy_qc_enabled }, { review: reviewEnabled, qc: qcEnabled }]);
      await client.query(`INSERT INTO image_quality_permission_events(account_id, actor_username, previous_permissions, permissions)
        VALUES ($1, $2, $3, $4)`, [userId, actorUsername,
        { imageQc: current.image_qc_enabled === true }, { imageQc: imageQualityEnabled }]);
      if (status !== 'ACTIVE' || !['REVIEWER', 'USER'].includes(role)) {
        await clearQueryPackageAssignments(client, current);
      }
      return managedUserFrom(result.rows[0]);
    });
  }

  async updateOwnProfile(rawActor, { displayName: rawDisplayName, expectedVersion }) {
    const displayName = normalizedDisplayName(rawDisplayName);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    return transaction(this.pool, async (client) => {
      const { actor, row } = await lockCurrentActor(client, rawActor);
      if (Number(row.version) !== expectedVersion) {
        throw new ControlPlaneConflictError('VERSION_CONFLICT', 'profile was updated or is unavailable');
      }
      const result = await client.query(`
        UPDATE app_users SET display_name = $1, version = version + 1, updated_at = now()
        WHERE id = $2 AND version = $3
        RETURNING *
      `, [displayName, actor.userId, expectedVersion]);
      if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'profile was updated or is unavailable');
      return publicUserFrom(result.rows[0]);
    });
  }

  async deleteUser(rawUserId, { actorUsername: rawActorUsername, expectedVersion }) {
    const userId = normalizeTaskId(rawUserId);
    const actorUsername = normalizedUsername(rawActorUsername);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    return transaction(this.pool, async (client) => {
      await lockAdministratorRoster(client);
      const currentResult = await client.query('SELECT * FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('user not found');
      if (Number(current.version) !== expectedVersion) {
        throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      }
      if (current.username === actorUsername) {
        throw new ControlPlaneConflictError('SELF_DELETE', 'current administrator cannot delete their own account');
      }
      if (current.role === 'ADMIN' && current.status === 'ACTIVE') {
        const count = await client.query("SELECT COUNT(*) AS count FROM app_users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
        if (Number(count.rows[0].count) <= 1) {
          throw new ControlPlaneConflictError('LAST_ADMIN', 'the last active administrator cannot be deleted');
        }
      }
      const assignedTasks = await client.query(`
        SELECT id, state, task_kind FROM tasks
        WHERE assigned_to_user_id = $1
          OR id IN (SELECT task_id FROM standalone_image_workspaces WHERE owner_id = $2)
        ORDER BY id
        FOR UPDATE
      `, [current.username, userId]);
      // Standalone uploads stay in MANUAL_ARCHIVE for their entire lifetime.
      // Their edit requests, rather than the carrier task state, indicate work
      // still waiting for or using an executor.
      const unfinished = assignedTasks.rows.find((task) => task.task_kind !== 'STANDALONE_IMAGE_EDIT'
        && !['REVIEWED', 'CANCELLED'].includes(task.state));
      if (unfinished) {
        throw new ControlPlaneConflictError(
          'USER_HAS_ACTIVE_TASKS',
          '该账号仍有未完成任务，请先将任务转交其他负责人后再删除',
        );
      }
      const activeImageEdits = await client.query(`
        SELECT edit.id FROM image_edit_requests AS edit
        JOIN standalone_image_workspaces AS workspace ON workspace.task_id = edit.task_id
        WHERE workspace.owner_id = $1 AND edit.status IN ('QUEUED', 'RUNNING')
        ORDER BY edit.task_id, edit.id
        LIMIT 1
        FOR UPDATE OF edit
      `, [userId]);
      if (activeImageEdits.rows.length > 0) {
        throw new ControlPlaneConflictError(
          'USER_HAS_ACTIVE_TASKS',
          '该账号仍有图片编辑正在生成或等待生成，请先处理这些记录后再删除',
        );
      }
      if (assignedTasks.rows.length > 0) {
        await client.query(`
          INSERT INTO task_assignment_events(
            task_id, actor_username, previous_assignee_user_id,
            assignee_user_id, source, reason
          )
          SELECT assigned_task.id, $2::varchar(50), $1::varchar(50), NULL,
            'MANUAL', CASE WHEN assigned_task.task_kind = 'STANDALONE_IMAGE_EDIT'
              THEN '删除账号时解除独立图片编辑负责人'
              ELSE '删除账号时解除已结束任务负责人' END
          FROM tasks AS assigned_task
          WHERE assigned_task.assigned_to_user_id = $1::varchar(50)
        `, [current.username, actorUsername]);
        await client.query(`
          UPDATE tasks SET
            assigned_to_user_id = NULL,
            assignment_source = NULL,
            assigned_at = NULL,
            updated_at = now()
          WHERE assigned_to_user_id = $1
        `, [current.username]);
      }
      await clearQueryPackageAssignments(client, current);
      const result = await client.query(
        'DELETE FROM app_users WHERE id = $1 AND version = $2 RETURNING *',
        [userId, expectedVersion],
      );
      if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      return publicUserFrom(result.rows[0]);
    });
  }

  async changeOwnPassword(rawActor, { currentPassword, newPassword }) {
    return transaction(this.pool, async (client) => {
      const { actor, row } = await lockCurrentActor(client, rawActor);
      if (!await verifyUserPassword(currentPassword, row.password_hash)) {
        throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', '当前密码不正确');
      }
      if (newPassword === currentPassword) {
        throw new ControlPlaneConflictError('PASSWORD_REUSED', '新密码不能与当前密码相同');
      }
      const passwordHash = await hashUserPassword(newPassword);
      const result = await client.query(`
        UPDATE app_users SET password_hash = $1, must_change_password = false,
          credential_version = credential_version + 1, version = version + 1, updated_at = now()
        WHERE id = $2 RETURNING *
      `, [passwordHash, actor.userId]);
      return publicUserFrom(result.rows[0]);
    });
  }

  async setOwnDeletionPassword(rawActor, { currentPassword, deletionPassword }) {
    const deletionPasswordHash = await hashUserPassword(deletionPassword);
    return transaction(this.pool, async (client) => {
      const { actor, row } = await lockCurrentActor(client, rawActor);
      if (!await verifyUserPassword(currentPassword, row.password_hash)) {
        throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', '当前密码不正确');
      }
      if (deletionPassword === currentPassword) {
        throw new ControlPlaneConflictError('DELETION_PASSWORD_REUSED', '二级密码不能与登录密码相同');
      }
      const result = await client.query(`
        UPDATE app_users SET deletion_password_hash = $1, version = version + 1, updated_at = now()
        WHERE id = $2 RETURNING *
      `, [deletionPasswordHash, actor.userId]);
      return publicUserFrom(result.rows[0]);
    });
  }

  async resetUserPassword(rawUserId) {
    const userId = normalizeTaskId(rawUserId);
    const passwordHash = await hashUserPassword('123456');
    const result = await this.factPool.query(`
      UPDATE app_users SET password_hash = $1, must_change_password = true,
        credential_version = credential_version + 1, version = version + 1, updated_at = now()
      WHERE id = $2 RETURNING *
    `, [passwordHash, userId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('user not found');
    return publicUserFrom(result.rows[0]);
  }
}
