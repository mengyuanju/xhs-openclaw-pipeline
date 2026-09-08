import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertImageResultSettings, reviseTaskImages } from './image-revisions.mjs';
import { IMAGE_FORMATS, hasImageControls } from './image-options.mjs';
import { normalizeLayoutPresets } from './layout-library.mjs';
import { BUILTIN_LAYOUT_CATALOG, normalizeLayoutCatalog } from './layout-catalog.mjs';
import { changeLayoutCatalog, layoutCatalogRecord } from './layout-catalog-settings.mjs';
import { parseVisualPlanOutput } from '../../src/visual-plan.mjs';
import { assertLockedImageText, imageTextHash } from '../../src/locked-image-plan.mjs';
import { migrateDatabase } from './database-migrations.mjs';
import { claimRequestExpiry } from './claim-request.mjs';
import { saveModelCall, listModelCalls, getModelCall } from './model-call-traces.mjs';
import { hashUserPassword, verifyUserPassword } from './user-auth.mjs';
import { heartbeatExecutions, recoverStaleExecutions } from './execution-recovery.mjs';

import pg from 'pg';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  TASK_STATES,
  normalizeConcurrency,
  normalizeCopyReviewEdits,
  normalizeCreatorUserId,
  normalizeTaskCreatorRole,
  normalizeCreateTask,
  normalizeJson,
  normalizeNodeId,
  normalizeNodeName,
  normalizeProgress,
  normalizeTaskBatch,
  normalizeTaskId,
  normalizeUuid,
  redactExecutionError,
} from './domain.mjs';

const { Pool } = pg;
const MAX_IMAGE_ATTEMPTS = 3;

function hasLayoutCatalog(snapshot) {
  return Boolean(snapshot?.productionSettings?.production?.value?.layoutCatalog);
}

function visualPlanPost(snapshot) {
  const content = snapshot?.copyRevision?.content;
  if (!content || typeof content !== 'object') throw new TypeError('approved copy revision is unavailable');
  const copy = content.copy ?? content.reviewed?.copy ?? content.post ?? content;
  return { ...copy, imagePlan: content.imagePlan ?? content.reviewed?.imagePlan ?? content.post?.imagePlan };
}

function assertLayoutCapability(snapshot, version) {
  if (hasLayoutCatalog(snapshot) && version !== 2) {
    throw new ControlPlaneConflictError('LAYOUT_CATALOG_UNSUPPORTED', '执行机需要升级以支持版本2布局目录');
  }
}

async function withSavedVisualPlan(client, executionId, snapshot) {
  if (!hasLayoutCatalog(snapshot)) return snapshot;
  const run = await client.query('SELECT result FROM image_runs WHERE execution_id = $1 FOR UPDATE', [executionId]);
  const visualPlan = run.rows[0]?.result?.visualPlan;
  return visualPlan?.value ? { ...snapshot, visualPlanCheckpoint: visualPlan } : snapshot;
}

function taskStateOrder(column) {
  if (!['state', 'page.state'].includes(column)) throw new TypeError('task state order column is invalid');
  return `CASE
    WHEN ${column} = 'COPY_REVIEW_PENDING' THEN 1
    WHEN ${column} = 'MANUAL_ARCHIVE' THEN 2
    WHEN ${column} = 'COPY_RUNNING' THEN 3
    WHEN ${column} = 'IMAGE_RUNNING' THEN 4
    WHEN ${column} IN ('COPY_FAILED', 'IMAGE_FAILED') THEN 5
    WHEN ${column} IN ('COPY_QUEUED', 'IMAGE_QUEUED') THEN 6
    WHEN ${column} = 'REVIEWED' THEN 7
    WHEN ${column} = 'CANCELLED' THEN 8
    ELSE 9
  END`;
}

function taskFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    query: row.query,
    input: row.input,
    requestedImageCount: row.requested_image_count === 'auto'
      ? 'auto'
      : Number(row.requested_image_count),
    aiDisclosureEnabled: row.ai_disclosure_enabled ?? true,
    skipCopyReview: row.skip_copy_review === true,
    state: row.state,
    imageReviewedAt: row.image_reviewed_at ?? null,
    imageReviewedByUserId: row.image_reviewed_by_user_id ?? null,
    createdByNodeId: row.created_by_node_id,
    createdByUserId: row.created_by_user_id ?? null,
    createdByRole: row.creator_role ?? null,
    createdByDisplayName: row.creator_display_name ?? (row.created_by_user_id === 'admin' ? '系统管理员' : null),
    copyExecutorNodeId: row.copy_executor_node_id,
    imageExecutorNodeId: row.image_executor_node_id ?? null,
    imageExecutorNodeName: row.image_executor_node_name ?? null,
    currentCopyRevisionId: row.current_copy_revision_id === null
      ? null
      : Number(row.current_copy_revision_id),
    currentImageRunId: row.current_image_run_id,
    currentExecutionId: row.current_execution_id,
    currentStage: row.current_stage,
    progressPercent: Number(row.progress_percent),
    progressMessage: row.progress_message,
    executionStartedAt: row.execution_started_at,
    lastActivityAt: row.last_activity_at,
    finishedAt: row.finished_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const USER_ROLES = Object.freeze(['ADMIN', 'REVIEWER', 'USER']);

function normalizedUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/u.test(username)) {
    throw new TypeError('username must contain 3 to 50 lowercase letters, numbers, dots, underscores or hyphens');
  }
  return username;
}

function normalizedDisplayName(value) {
  const displayName = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!displayName || [...displayName].length > 80) throw new TypeError('displayName must contain 1 to 80 characters');
  return displayName;
}

function normalizedUserRole(value) {
  const role = String(value ?? '').toUpperCase();
  if (!USER_ROLES.includes(role)) throw new TypeError('role is invalid');
  return role;
}

function publicUserFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password,
    credentialVersion: Number(row.credential_version),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function executionFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: Number(row.task_id),
    kind: row.kind,
    nodeId: row.node_id,
    status: row.status,
    stage: row.stage,
    progressPercent: Number(row.progress_percent),
    progressMessage: row.progress_message,
    progressDetails: row.progress_details,
    snapshot: row.snapshot,
    error: row.error,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    finishedAt: row.finished_at,
  };
}

function nodeFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    imageWorkerEnabled: row.image_worker_enabled,
    copyConcurrency: row.copy_concurrency ?? 1,
    imageConcurrency: row.image_concurrency ?? 1,
    online: Boolean(row.online),
    copyQueuedCount: Number(row.copy_queued_count ?? 0),
    copyRunningCount: Number(row.copy_running_count ?? 0),
    imageRunningCount: Number(row.image_running_count ?? 0),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentWithReviewEdits(content, edits, { baseRevisionId, nodeId }) {
  const original = normalizeJson(content, 'copy revision content', 5_000_000);
  const reviewed = original.reviewed && typeof original.reviewed === 'object' && !Array.isArray(original.reviewed)
    ? { ...original.reviewed, copy: edits.copy, imagePlan: edits.imagePlan }
    : original.reviewed;
  return {
    ...original,
    copy: edits.copy,
    imagePlan: edits.imagePlan,
    ...(edits.imageSettings ? { imageSettings: edits.imageSettings } : {}),
    ...(reviewed ? { reviewed } : {}),
    manualReview: {
      edited: true,
      baseRevisionId,
      reviewedByNodeId: nodeId,
      submittedAt: new Date().toISOString(),
    },
  };
}

function revisionFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    executionId: row.execution_id,
    revision: Number(row.revision),
    content: row.content,
    approvedAt: row.approved_at,
    approvalMode: row.approval_mode ?? (row.approved_at ? 'MANUAL' : null),
    approvedByNodeId: row.approved_by_node_id,
    createdAt: row.created_at,
  };
}

function normalizedTaskStates(state, states) {
  const values = states === null || states === undefined
    ? (state === null || state === undefined ? [] : [state])
    : Array.isArray(states) ? states : String(states).split(',');
  const normalized = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (normalized.some((value) => !TASK_STATES.includes(value))) {
    throw new TypeError('task state filter is invalid');
  }
  return normalized;
}

function normalizedTaskQuery(value) {
  if (value === null || value === undefined) return null;
  const query = String(value).trim();
  if ([...query].length > 500) throw new RangeError('task query filter cannot exceed 500 characters');
  return query || null;
}

// Queries are entered by people, so insignificant casing and whitespace should
// not produce separate rows when the task list is de-duplicated.
function taskQueryIdentity(column = 'query') {
  return `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
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

async function configurationSnapshots(client, tasks, kind) {
  if (!tasks.length) return new Map();
  // pg serializes one connection; overlapping query() calls are deprecated.
  const settings = await client.query(`SELECT key, value, version FROM global_settings ORDER BY key`);
  const prompts = await client.query(`
      SELECT t.kind, t.name, v.id AS version_id, v.version, v.content, v.content_sha256
      FROM prompt_templates t
      LEFT JOIN prompt_versions v ON v.template_id = t.id AND v.status = 'PUBLISHED'
      ORDER BY t.kind
    `);
  const knowledge = await client.query(`
      SELECT i.id, i.kind, i.name, v.id AS version_id, v.version, v.content,
             v.storage_path, v.content_sha256
      FROM knowledge_items i
      JOIN knowledge_versions v ON v.item_id = i.id AND v.status = 'PUBLISHED'
      WHERE i.status = 'ACTIVE'
      ORDER BY i.kind, i.id
    `);
  const revision = kind === 'IMAGE'
    ? await client.query('SELECT * FROM copy_revisions WHERE id = ANY($1::bigint[])', [tasks.map(task => task.current_copy_revision_id)])
    : { rows: [] };
  const shared = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    productionSettings: Object.fromEntries(
      settings.rows.map((row) => [row.key, { version: Number(row.version), value: row.value }]),
    ),
    prompts: Object.fromEntries(prompts.rows.map((row) => [row.kind, row.version_id === null
      ? null
      : {
          name: row.name,
          versionId: Number(row.version_id),
          version: Number(row.version),
          content: row.content,
          sha256: row.content_sha256,
        }])),
    knowledge: knowledge.rows.map((row) => ({
      itemId: Number(row.id),
      kind: row.kind,
      name: row.name,
      versionId: Number(row.version_id),
      version: Number(row.version),
      content: row.content,
      storagePath: row.storage_path,
      sha256: row.content_sha256,
    })),
  };
  const revisions = new Map(revision.rows.map(row => [String(row.id), revisionFrom(row)]));
  return new Map(tasks.map(task => [task.id, {
    ...shared,
    task: {
      id: Number(task.id), query: task.query, input: task.input,
      requestedImageCount: task.requested_image_count === 'auto' ? 'auto' : Number(task.requested_image_count),
      aiDisclosureEnabled: task.ai_disclosure_enabled ?? true,
    },
    copyRevision: revisions.get(String(task.current_copy_revision_id)) ?? null,
  }]));
}

async function lockedExecution(client, executionId) {
  const result = await client.query(`
    SELECT e.*, t.current_execution_id, t.state AS task_state,
      t.skip_copy_review, t.created_by_node_id, t.ai_disclosure_enabled
    FROM task_executions e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.id = $1
    FOR UPDATE OF e, t
  `, [executionId]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('execution not found');
  const row = result.rows[0];
  if (row.status !== 'RUNNING' || row.current_execution_id !== executionId) {
    throw new ControlPlaneConflictError(
      'STALE_EXECUTION',
      'execution is no longer current and cannot update this task',
    );
  }
  return row;
}

async function queueApprovedCopy(client, taskId, revisionId, aiDisclosureEnabled, message = '文案审核通过，等待图片执行机领取') {
  const updated = await client.query(`
    UPDATE tasks SET
      state = 'IMAGE_QUEUED', current_copy_revision_id = $2,
      ai_disclosure_enabled = $3,
      current_execution_id = NULL, current_image_run_id = NULL,
      current_stage = 'IMAGE_QUEUED', progress_percent = 0,
      progress_message = $4,
      execution_started_at = NULL, last_activity_at = now(), finished_at = NULL,
      error = NULL, pending_snapshot = NULL, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [taskId, revisionId, aiDisclosureEnabled, message]);
  return taskFrom(updated.rows[0]);
}

export class PostgresControlPlaneRepository {
  heartbeatExecutions(input) { return heartbeatExecutions(this.pool, input); }
  recoverStaleExecutions() { return recoverStaleExecutions(this.pool); }
  recordModelCall(executionId, callId, input) { return saveModelCall(this.pool, executionId, callId, input); }
  listModelCalls(taskId, options) { return listModelCalls(this.pool, taskId, options); }
  getModelCall(taskId, callId) { return getModelCall(this.pool, taskId, callId); }

  constructor({ connectionString, pool } = {}) {
    if (!pool && !connectionString) throw new TypeError('PostgreSQL connection string is required');
    this.pool = pool ?? new Pool({ connectionString, max: 10 });
    this.ownsPool = !pool;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async initialize() {
    await migrateDatabase(this.pool);
    await this.pool.query(`UPDATE global_settings SET value = value || jsonb_build_object('layoutCatalog', $1::jsonb), version = version + 1, updated_at = now()
      WHERE key = 'production' AND NOT (value ? 'layoutCatalog')`, [JSON.stringify(BUILTIN_LAYOUT_CATALOG)]);
  }

  async health() {
    const result = await this.pool.query('SELECT now() AS now');
    return { ok: true, databaseTime: result.rows[0].now,
      capabilities: { executionHeartbeats: true, executionRetryControl: true, imageResume: true, executorConcurrency: true, adminTaskFilters: true, imageControlsVersion: 1 } };
  }

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
    return result.rows.map(publicUserFrom);
  }

  async createUser({ username: rawUsername, displayName: rawDisplayName, role: rawRole }) {
    const username = normalizedUsername(rawUsername);
    const displayName = normalizedDisplayName(rawDisplayName);
    const role = normalizedUserRole(rawRole);
    const passwordHash = await hashUserPassword('123456');
    try {
      const result = await this.pool.query(`
        INSERT INTO app_users(username, display_name, role, password_hash, must_change_password)
        VALUES ($1, $2, $3, $4, true)
        RETURNING *
      `, [username, displayName, role, passwordHash]);
      return publicUserFrom(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') throw new ControlPlaneConflictError('USERNAME_EXISTS', 'username already exists');
      throw error;
    }
  }

  async updateUser(rawUserId, { displayName: rawDisplayName, role: rawRole, status, expectedVersion }) {
    const userId = normalizeTaskId(rawUserId);
    const displayName = normalizedDisplayName(rawDisplayName);
    const role = normalizedUserRole(rawRole);
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new TypeError('status is invalid');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    return transaction(this.pool, async (client) => {
      const currentResult = await client.query('SELECT * FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('user not found');
      if (current.role === 'ADMIN' && (role !== 'ADMIN' || status !== 'ACTIVE')) {
        const count = await client.query("SELECT COUNT(*) AS count FROM app_users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
        if (Number(count.rows[0].count) <= 1) {
          throw new ControlPlaneConflictError('LAST_ADMIN', 'the last active administrator cannot be disabled or demoted');
        }
      }
      const credentialChanged = current.role !== role || current.status !== status;
      const result = await client.query(`
        UPDATE app_users
        SET display_name = $1, role = $2, status = $3,
            credential_version = credential_version + $4, version = version + 1, updated_at = now()
        WHERE id = $5 AND version = $6
        RETURNING *
      `, [displayName, role, status, credentialChanged ? 1 : 0, userId, expectedVersion]);
      if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      return publicUserFrom(result.rows[0]);
    });
  }

  async updateOwnProfile(rawUsername, { displayName: rawDisplayName, expectedVersion }) {
    const username = normalizedUsername(rawUsername);
    const displayName = normalizedDisplayName(rawDisplayName);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    const result = await this.pool.query(`
      UPDATE app_users SET display_name = $1, version = version + 1, updated_at = now()
      WHERE username = $2 AND version = $3 AND status = 'ACTIVE'
      RETURNING *
    `, [displayName, username, expectedVersion]);
    if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'profile was updated or is unavailable');
    return publicUserFrom(result.rows[0]);
  }

  async deleteUser(rawUserId, { actorUsername: rawActorUsername, expectedVersion }) {
    const userId = normalizeTaskId(rawUserId);
    const actorUsername = normalizedUsername(rawActorUsername);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is invalid');
    return transaction(this.pool, async (client) => {
      const currentResult = await client.query('SELECT * FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('user not found');
      if (current.username === actorUsername) {
        throw new ControlPlaneConflictError('SELF_DELETE', 'current administrator cannot delete their own account');
      }
      if (current.role === 'ADMIN' && current.status === 'ACTIVE') {
        const count = await client.query("SELECT COUNT(*) AS count FROM app_users WHERE role = 'ADMIN' AND status = 'ACTIVE'");
        if (Number(count.rows[0].count) <= 1) {
          throw new ControlPlaneConflictError('LAST_ADMIN', 'the last active administrator cannot be deleted');
        }
      }
      const result = await client.query(
        'DELETE FROM app_users WHERE id = $1 AND version = $2 RETURNING *',
        [userId, expectedVersion],
      );
      if (!result.rows[0]) throw new ControlPlaneConflictError('VERSION_CONFLICT', 'user was updated by another request');
      return publicUserFrom(result.rows[0]);
    });
  }

  async changeOwnPassword(rawUsername, { currentPassword, newPassword }) {
    const username = normalizedUsername(rawUsername);
    const current = await this.pool.query(
      "SELECT * FROM app_users WHERE username = $1 AND status = 'ACTIVE'",
      [username],
    );
    if (!current.rows[0] || !await verifyUserPassword(currentPassword, current.rows[0].password_hash)) {
      throw new ControlPlaneConflictError('CURRENT_PASSWORD_INVALID', 'current password is incorrect');
    }
    const passwordHash = await hashUserPassword(newPassword);
    const result = await this.pool.query(`
      UPDATE app_users SET password_hash = $1, must_change_password = false,
        credential_version = credential_version + 1, version = version + 1, updated_at = now()
      WHERE username = $2 RETURNING *
    `, [passwordHash, username]);
    return publicUserFrom(result.rows[0]);
  }

  async resetUserPassword(rawUserId) {
    const userId = normalizeTaskId(rawUserId);
    const passwordHash = await hashUserPassword('123456');
    const result = await this.pool.query(`
      UPDATE app_users SET password_hash = $1, must_change_password = true,
        credential_version = credential_version + 1, version = version + 1, updated_at = now()
      WHERE id = $2 RETURNING *
    `, [passwordHash, userId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('user not found');
    return publicUserFrom(result.rows[0]);
  }

  async registerNode({ nodeId: rawNodeId, name: rawName, imageWorkerEnabled = false, copyConcurrency, imageConcurrency }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const name = normalizeNodeName(rawName, nodeId);
    if (copyConcurrency !== undefined) normalizeConcurrency(copyConcurrency, 'copyConcurrency');
    if (imageConcurrency !== undefined) normalizeConcurrency(imageConcurrency, 'imageConcurrency');
    if (typeof imageWorkerEnabled !== 'boolean') {
      throw new TypeError('imageWorkerEnabled must be a boolean');
    }
    const result = await this.pool.query(`
      INSERT INTO executor_nodes(id, name, image_worker_enabled, copy_concurrency, image_concurrency)
      VALUES ($1, $2, $3, COALESCE($4, 1), COALESCE($5, 1))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        image_worker_enabled = excluded.image_worker_enabled,
        copy_concurrency = COALESCE($4, executor_nodes.copy_concurrency),
        image_concurrency = COALESCE($5, executor_nodes.image_concurrency),
        last_seen_at = now(),
        updated_at = now()
      RETURNING *
    `, [nodeId, name, imageWorkerEnabled, copyConcurrency ?? null, imageConcurrency ?? null]);
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      imageWorkerEnabled: row.image_worker_enabled,
      copyConcurrency: row.copy_concurrency ?? 1,
      imageConcurrency: row.image_concurrency ?? 1,
      lastSeenAt: row.last_seen_at,
    };
  }

  async listNodes() {
    const result = await this.pool.query(`
      SELECT
        n.*,
        n.last_seen_at >= now() - interval '90 seconds' AS online,
        (SELECT COUNT(*) FROM tasks t
          WHERE t.copy_executor_node_id = n.id AND t.state = 'COPY_QUEUED') AS copy_queued_count,
        (SELECT COUNT(*) FROM tasks t
          WHERE t.copy_executor_node_id = n.id AND t.state = 'COPY_RUNNING') AS copy_running_count,
        (SELECT COUNT(*) FROM task_executions e
          JOIN tasks t ON t.current_execution_id = e.id
          WHERE e.node_id = n.id AND e.kind = 'IMAGE' AND e.status = 'RUNNING'
            AND t.state = 'IMAGE_RUNNING') AS image_running_count
      FROM executor_nodes n
      ORDER BY online DESC, n.name, n.id
    `);
    return result.rows.map(nodeFrom);
  }

  async createTasks({ nodeId: rawNodeId, createdByUserId: rawCreator = null, tasks: rawTasks, skipCopyReview = false }) {
    if (typeof skipCopyReview !== 'boolean') throw new TypeError('skipCopyReview must be a boolean');
    const nodeId = normalizeNodeId(rawNodeId);
    const createdByUserId = rawCreator === null ? null : normalizeCreatorUserId(rawCreator);
    const tasks = normalizeTaskBatch(rawTasks);
    return transaction(this.pool, async (client) => {
      await client.query(`
        INSERT INTO executor_nodes(id, name, image_worker_enabled, last_seen_at)
        VALUES ($1, $1, false, 'epoch'::timestamptz)
        ON CONFLICT(id) DO NOTHING
      `, [nodeId]);
      const created = [];
      for (const task of tasks) {
        const result = await client.query(`
          INSERT INTO tasks(
            query, input, requested_image_count, created_by_node_id, created_by_user_id,
            skip_copy_review, current_stage, progress_message
          ) VALUES ($1, $2, $3, $4, $5, $6, 'COPY_QUEUED', '等待文案执行机领取')
          RETURNING *
        `, [task.query, task.input, String(task.imageCount), nodeId, createdByUserId, skipCopyReview]);
        created.push(taskFrom(result.rows[0]));
      }
      return created;
    });
  }

  async listTasks({
    state = null,
    states = null,
    nodeId = null,
    createdByUserId = null,
    createdByRole = null,
    query = null,
    deduplicateQuery = false,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (typeof includeTotal !== 'boolean') throw new TypeError('includeTotal must be a boolean');
    if (typeof deduplicateQuery !== 'boolean') throw new TypeError('deduplicateQuery must be a boolean');
    const values = [];
    const filters = [];
    const stateFilters = normalizedTaskStates(state, states);
    if (stateFilters.length > 0) {
      values.push(stateFilters);
      filters.push(`state = ANY($${values.length}::varchar[])`);
    }
    if (nodeId !== null) {
      values.push(normalizeNodeId(nodeId));
      filters.push(`copy_executor_node_id = $${values.length}`);
    }
    if (createdByUserId !== null) {
      values.push(normalizeCreatorUserId(createdByUserId));
      filters.push(`created_by_user_id = $${values.length}`);
    }
    const creatorRole = normalizeTaskCreatorRole(createdByRole);
    if (creatorRole === 'UNKNOWN') {
      filters.push('NOT EXISTS (SELECT 1 FROM app_users role_creator WHERE role_creator.username = tasks.created_by_user_id)');
    } else if (creatorRole !== null) {
      values.push(creatorRole);
      filters.push(`EXISTS (SELECT 1 FROM app_users role_creator
        WHERE role_creator.username = tasks.created_by_user_id AND role_creator.role = $${values.length})`);
    }
    const searchQuery = normalizedTaskQuery(query);
    if (searchQuery !== null) {
      values.push(searchQuery);
      filters.push(`strpos(lower(query), lower($${values.length})) > 0`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const queryIdentity = taskQueryIdentity('query');
    const taskPage = deduplicateQuery ? `
        SELECT * FROM (
          SELECT DISTINCT ON (${queryIdentity}) * FROM tasks
          ${where}
          ORDER BY ${queryIdentity}, created_at DESC, id DESC
        ) deduplicated_tasks
      ` : `
        SELECT * FROM tasks
        ${where}
      `;
    const countSql = deduplicateQuery
      ? `SELECT COUNT(DISTINCT ${queryIdentity}) AS total FROM tasks ${where}`
      : `SELECT COUNT(*) AS total FROM tasks ${where}`;
    const pageValues = [...values, safeLimit, safeOffset];
    const [result, countResult] = await Promise.all([
      this.pool.query(`
      SELECT page.*, COALESCE(e.node_id, successful_image.node_id) AS image_executor_node_id,
        n.name AS image_executor_node_name, creator.display_name AS creator_display_name,
        creator.role AS creator_role
      FROM (
        ${taskPage}
        ORDER BY ${taskStateOrder('state')}, created_at DESC, id DESC
        LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}
      ) page
      LEFT JOIN task_executions e ON e.id = page.current_execution_id
        AND e.kind = 'IMAGE' AND e.status = 'RUNNING' AND page.state = 'IMAGE_RUNNING'
      LEFT JOIN image_runs delivered_run ON delivered_run.id = page.current_image_run_id
        AND delivered_run.task_id = page.id AND delivered_run.status = 'COMPLETED'
        AND page.state IN ('MANUAL_ARCHIVE', 'REVIEWED')
      LEFT JOIN task_executions successful_image ON successful_image.id = delivered_run.execution_id
        AND successful_image.task_id = page.id
        AND successful_image.kind = 'IMAGE' AND successful_image.status = 'SUCCEEDED'
      LEFT JOIN executor_nodes n ON n.id = COALESCE(e.node_id, successful_image.node_id)
      LEFT JOIN app_users creator ON creator.username = page.created_by_user_id
      ORDER BY ${taskStateOrder('page.state')}, page.created_at DESC, page.id DESC
    `, pageValues),
      includeTotal
        ? this.pool.query(countSql, values)
        : Promise.resolve(null),
    ]);
    const items = result.rows.map(taskFrom);
    if (!includeTotal) return items;
    return {
      items,
      total: Number(countResult.rows[0].total),
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  async taskCounts({ nodeId: rawNodeId }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE copy_executor_node_id = $1 AND state IN ('COPY_QUEUED', 'COPY_RUNNING')
        ) AS local_copy,
        COUNT(*) FILTER (WHERE state IN ('COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED')) AS all_copy,
        COUNT(*) FILTER (WHERE state = 'COPY_REVIEW_PENDING') AS copy_review,
        COUNT(*) FILTER (WHERE state IN ('IMAGE_QUEUED', 'IMAGE_RUNNING')) AS image_work,
        COUNT(*) FILTER (WHERE state = 'MANUAL_ARCHIVE') AS manual_archive
      FROM tasks
      WHERE state <> 'CANCELLED'
    `, [nodeId]);
    const row = result.rows[0];
    return {
      localCopy: Number(row.local_copy),
      allCopy: Number(row.all_copy),
      copyReview: Number(row.copy_review),
      imageWork: Number(row.image_work),
      manualArchive: Number(row.manual_archive),
    };
  }

  async getTaskAccess(rawTaskId) {
    const result = await this.pool.query('SELECT id, created_by_user_id FROM tasks WHERE id = $1', [normalizeTaskId(rawTaskId)]);
    const row = result.rows[0];
    return row ? { id: Number(row.id), createdByUserId: row.created_by_user_id } : null;
  }

  async getTask(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const [task, executions, revisions, imageRuns, assets] = await Promise.all([
      this.pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]),
      this.pool.query(`
        SELECT * FROM task_executions WHERE task_id = $1 ORDER BY started_at DESC
      `, [taskId]),
      this.pool.query(`
        SELECT * FROM copy_revisions WHERE task_id = $1 ORDER BY revision DESC
      `, [taskId]),
      this.pool.query(`
        SELECT * FROM image_runs WHERE task_id = $1 ORDER BY created_at DESC
      `, [taskId]),
      this.pool.query(`
        SELECT id, task_id, image_run_id, media_type, byte_size, sha256, original_name, created_at
        FROM assets WHERE task_id = $1 ORDER BY id
      `, [taskId]),
    ]);
    if (!task.rows[0]) return null;
    return {
      ...taskFrom(task.rows[0]),
      executions: executions.rows.map(executionFrom),
      copyRevisions: revisions.rows.map(revisionFrom),
      imageRuns: imageRuns.rows.map((row) => ({
        id: row.id,
        taskId: Number(row.task_id),
        executionId: row.execution_id,
        copyRevisionId: Number(row.copy_revision_id),
        status: row.status,
        result: row.result,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      })),
      assets: assets.rows.map((row) => ({
        id: Number(row.id),
        taskId: Number(row.task_id),
        imageRunId: row.image_run_id,
        mediaType: row.media_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        originalName: row.original_name,
        url: `/v1/assets/${row.id}`,
        createdAt: row.created_at,
      })),
    };
  }

  async claimCopy(rawNodeId) {
    return (await this.#claim({ kind: 'COPY', nodeId: rawNodeId, limit: 1 })).claims[0] ?? null;
  }

  async claimImage(rawNodeId, imageControlsVersion = 0, layoutCatalogVersion = 0) {
    return (await this.#claim({ kind: 'IMAGE', nodeId: rawNodeId, limit: 1, imageControlsVersion, layoutCatalogVersion })).claims[0] ?? null;
  }

  async claimCopyBatch({ nodeId, limit, requestId }) {
    return this.#claim({ kind: 'COPY', nodeId, limit, requestId: normalizeUuid(requestId, 'requestId') });
  }

  async claimImageBatch({ nodeId, limit, requestId, imageControlsVersion = 0, layoutCatalogVersion = 0 }) {
    return this.#claim({ kind: 'IMAGE', nodeId, limit, requestId: normalizeUuid(requestId, 'requestId'), imageControlsVersion, layoutCatalogVersion });
  }

  async #claim({ kind, nodeId: rawNodeId, limit, requestId, imageControlsVersion = 0, layoutCatalogVersion = 0 }) {
    const nodeId = normalizeNodeId(rawNodeId);
    normalizeConcurrency(limit, 'limit');
    return transaction(this.pool, async (client) => {
      const node = await client.query(`
        SELECT * FROM executor_nodes WHERE id = $1 FOR UPDATE
      `, [nodeId]);
      if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
      await client.query(`UPDATE executor_nodes SET last_seen_at = now() WHERE id = $1`, [nodeId]);
      // Reconcile an uncertain request even after image work has been disabled.
      if (requestId) {
        const receipt = (await client.query(`SELECT * FROM execution_claim_requests
          WHERE node_id = $1 AND kind = $2 AND request_id = $3`, [nodeId, kind, requestId])).rows[0];
        if (receipt) {
          if (receipt.requested_limit !== limit) {
            throw new ControlPlaneConflictError('CLAIM_REQUEST_MISMATCH', 'requestId was already used with another limit');
          }
          const records = receipt.execution_ids.length ? (await client.query(`
            SELECT e.*, row_to_json(t) AS task FROM task_executions e
            JOIN tasks t ON t.id = e.task_id WHERE e.id = ANY($1::uuid[])
            ORDER BY array_position($1::uuid[], e.id)
          `, [receipt.execution_ids])).rows : [];
          if (kind === 'IMAGE') for (const row of records) assertLayoutCapability(row.snapshot, layoutCatalogVersion);
          return { requestId, claims: records.map(row => ({ task: taskFrom(row.task), execution: executionFrom(row) })) };
        }
      }
      const expiresAt = requestId ? claimRequestExpiry(requestId) : null;
      if (requestId) {
        // The node lock serializes claims/GC. Terminal executions never return to RUNNING.
        // A bounded batch avoids extending the claim transaction after long downtime.
        await client.query(`DELETE FROM execution_claim_requests r USING (
          SELECT request_id FROM execution_claim_requests old
          WHERE node_id = $1 AND kind = $2 AND expires_at <= $3
            AND NOT EXISTS (SELECT 1 FROM task_executions e
              WHERE e.id = ANY(old.execution_ids) AND e.status = 'RUNNING')
          ORDER BY expires_at LIMIT 100
        ) expired WHERE r.node_id = $1 AND r.kind = $2 AND r.request_id = expired.request_id`, [nodeId, kind, new Date()]);
      }
      if (kind === 'IMAGE' && !node.rows[0].image_worker_enabled) {
        throw new ControlPlaneConflictError(
          'IMAGE_WORKER_DISABLED',
          'this executor node is not enabled for image work',
        );
      }
      const active = await client.query(`
        SELECT COUNT(*) AS count FROM task_executions
        WHERE node_id = $1 AND kind = $2 AND status = 'RUNNING'
      `, [nodeId, kind]);
      const capacity = (kind === 'COPY' ? node.rows[0].copy_concurrency : node.rows[0].image_concurrency) ?? 1;
      const available = Math.min(limit, Math.max(0, capacity - Number(active.rows[0]?.count ?? 0)));
      const queuedState = kind === 'COPY' ? 'COPY_QUEUED' : 'IMAGE_QUEUED';
      const runningState = kind === 'COPY' ? 'COPY_RUNNING' : 'IMAGE_RUNNING';
      const ownership = kind === 'COPY' ? ''
        : "AND (pending_snapshot->'imageRetry'->>'nodeId' IS NULL OR pending_snapshot->'imageRetry'->>'nodeId' = $2) AND (pending_snapshot->'imageRecovery'->>'nodeId' IS NULL OR pending_snapshot->'imageRecovery'->>'nodeId' = $2)";
      // Retry on the original image node, with a cooldown between complete executions.
      const retryDelay = kind === 'IMAGE'
        ? "AND (error IS NULL OR last_activity_at <= now() - interval '5 seconds')" : '';
      const order = kind === 'IMAGE' ? 'last_activity_at NULLS FIRST, id' : 'id';
      const parameters = kind === 'COPY'
        ? [queuedState, available]
        : [queuedState, nodeId, available];
      const limitParameter = kind === 'COPY' ? '$2' : '$3';
      const candidate = available ? await client.query(`
        SELECT * FROM tasks
        WHERE state = $1 ${ownership} ${retryDelay}
        ORDER BY ${order}
        FOR UPDATE SKIP LOCKED
        LIMIT ${limitParameter}
      `, parameters) : { rows: [] };
      const snapshots = await configurationSnapshots(client, candidate.rows.filter(task => task.pending_snapshot == null), kind);
      const claims = [];
      for (const task of candidate.rows) {
        const executionId = randomUUID();
        const snapshot = task.pending_snapshot
          ?? snapshots.get(task.id);
        if (kind === 'IMAGE') assertLayoutCapability(snapshot, layoutCatalogVersion);
        if (kind === 'IMAGE' && hasImageControls(snapshot?.copyRevision?.content) && imageControlsVersion !== 1) {
          throw new ControlPlaneConflictError('IMAGE_CONTROLS_UPGRADE_REQUIRED', '当前任务使用新版图片配置，请更新图片执行机后再领取');
        }
        const stage = kind === 'COPY' ? 'STARTING_COPY' : 'STARTING_IMAGE';
        await client.query(`
          INSERT INTO task_executions(
            id, task_id, kind, node_id, stage, progress_message, snapshot
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [executionId, task.id, kind, nodeId, stage, '执行机已领取任务', snapshot]);
        if (kind === 'IMAGE') {
          await client.query(`
            INSERT INTO image_runs(id, task_id, execution_id, copy_revision_id)
            VALUES ($1, $2, $1, $3)
          `, [executionId, task.id, task.current_copy_revision_id]);
        }
        const updated = await client.query(`
          UPDATE tasks SET
            state = $1,
            current_execution_id = $2,
            copy_executor_node_id = CASE WHEN $3 = 'COPY' THEN $7 ELSE copy_executor_node_id END,
            current_image_run_id = CASE WHEN $3 = 'IMAGE' THEN $2 ELSE current_image_run_id END,
            current_stage = $4,
            progress_percent = 0,
            progress_message = '执行机已领取任务',
            execution_started_at = now(),
            last_activity_at = now(),
            finished_at = NULL,
            error = NULL,
            pending_snapshot = NULL,
            updated_at = now()
          WHERE id = $5 AND state = $6
          RETURNING *
        `, [runningState, executionId, kind, stage, task.id, queuedState, nodeId]);
        claims.push({
          task: taskFrom(updated.rows[0]),
          execution: executionFrom((await client.query(
            'SELECT * FROM task_executions WHERE id = $1',
            [executionId],
          )).rows[0]),
        });
      }
      if (requestId) {
        await client.query(`INSERT INTO execution_claim_requests(node_id, kind, request_id, requested_limit, execution_ids, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)`, [nodeId, kind, requestId, limit, claims.map(claim => claim.execution.id), expiresAt]);
      }
      return { requestId, claims };
    });
  }

  async saveVisualPlan(rawExecutionId, input) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const data = normalizeJson(input, 'visual plan', 1_000_000);
    return transaction(this.pool, async client => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'IMAGE') throw new TypeError('execution is not an image execution');
      const post = visualPlanPost(execution.snapshot);
      const value = parseVisualPlanOutput(JSON.stringify(data.value), { post, layoutCatalog: execution.snapshot?.productionSettings?.production?.value?.layoutCatalog ?? null });
      assertLockedImageText(value, post);
      value.textContractSha256 = imageTextHash(post);
      const checkpoint = execution.snapshot?.visualPlanCheckpoint?.value;
      if (checkpoint && !isDeepStrictEqual(checkpoint, value)) {
        throw new ControlPlaneConflictError('VISUAL_PLAN_CONFLICT', '恢复运行必须复用中心已冻结的视觉规划');
      }
      const visualPlan = { value, model: typeof data.model === 'string' ? data.model.slice(0, 200) : null, degraded: data.degraded === true, warning: data.warning ?? null,
        planningMode: value.planningMode ?? 'MODEL', savedAt: new Date().toISOString() };
      const existing = await client.query('SELECT result FROM image_runs WHERE execution_id = $1 FOR UPDATE', [executionId]);
      if (!existing.rows[0]) throw new ControlPlaneNotFoundError('image run not found');
      if (existing.rows[0]?.result?.visualPlan?.value && !isDeepStrictEqual(existing.rows[0].result.visualPlan.value, value)) {
        throw new ControlPlaneConflictError('VISUAL_PLAN_CONFLICT', '本次运行已保存不同的规划，请创建新的图片运行');
      }
      if (!existing.rows[0]?.result?.visualPlan?.value) await client.query("UPDATE image_runs SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE execution_id = $1", [executionId, { visualPlan }]);
      return { saved: true, textContractSha256: value.textContractSha256 };
    });
  }

  async updateProgress(rawExecutionId, rawProgress) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const progress = normalizeProgress(rawProgress);
    return transaction(this.pool, async (client) => {
      const activeExecution = await lockedExecution(client, executionId);
      const updated = await client.query(`
        UPDATE task_executions SET
          stage = $2,
          progress_percent = $3,
          progress_message = $4,
          progress_details = $5,
          last_activity_at = now()
        WHERE id = $1
        RETURNING *
      `, [
        executionId,
        progress.stage,
        progress.progressPercent,
        progress.message,
        progress.details,
      ]);
      await client.query(`
        UPDATE tasks SET
          current_stage = $2,
          progress_percent = $3,
          progress_message = $4,
          last_activity_at = now(),
          updated_at = now()
        WHERE current_execution_id = $1
      `, [executionId, progress.stage, progress.progressPercent, progress.message]);
      await client.query(`UPDATE executor_nodes SET last_seen_at = now() WHERE id = $1`, [activeExecution.node_id]);
      return executionFrom(updated.rows[0]);
    });
  }

  async completeCopy(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = normalizeJson(rawResult, 'copy result', 5_000_000);
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'COPY') throw new TypeError('execution is not a copy execution');
      let bypass = execution.skip_copy_review === true;
      let message = '文案生成完成，等待人工审核';
      if (bypass) {
        try {
          normalizeCopyReviewEdits({
            copy: result?.copy ?? result?.reviewed?.copy ?? result?.post,
            imagePlan: result?.imagePlan ?? result?.reviewed?.imagePlan ?? result?.post?.imagePlan,
          });
          message = '管理员免审核，等待图片执行机领取';
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
          bypass = false;
          message = '文案格式校验未通过，等待人工审核';
        }
      }
      const revisionNumber = Number((await client.query(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM copy_revisions WHERE task_id = $1
      `, [execution.task_id])).rows[0].revision);
      const revision = await client.query(`
        INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at, approved_by_node_id, approval_mode)
        VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END,
          CASE WHEN $5 THEN $6 ELSE NULL END, CASE WHEN $5 THEN 'ADMIN_BYPASS' ELSE NULL END)
        RETURNING *
      `, [execution.task_id, executionId, revisionNumber, result, bypass, execution.created_by_node_id]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = $2, last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, message]);
      if (bypass) {
        const task = await queueApprovedCopy(client, execution.task_id, revision.rows[0].id,
          execution.ai_disclosure_enabled ?? true, message);
        return { task, revision: revisionFrom(revision.rows[0]) };
      }
      const task = await client.query(`
        UPDATE tasks SET
          state = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2,
          current_execution_id = NULL, current_stage = 'COPY_REVIEW_PENDING',
          progress_percent = 100, progress_message = $4,
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $3
        RETURNING *
      `, [execution.task_id, revision.rows[0].id, executionId, message]);
      return { task: taskFrom(task.rows[0]), revision: revisionFrom(revision.rows[0]) };
    });
  }

  async approveCopy(rawTaskId, {
    revisionId: rawRevisionId,
    nodeId: rawNodeId,
    edits: rawEdits,
    aiDisclosureEnabled: rawAiDisclosureEnabled,
  }) {
    const taskId = normalizeTaskId(rawTaskId);
    const revisionId = normalizeTaskId(rawRevisionId);
    const nodeId = normalizeNodeId(rawNodeId);
    const edits = rawEdits === undefined ? null : normalizeCopyReviewEdits(rawEdits);
    if (rawAiDisclosureEnabled !== undefined && typeof rawAiDisclosureEnabled !== 'boolean') {
      throw new TypeError('aiDisclosureEnabled must be a boolean');
    }
    return transaction(this.pool, async (client) => {
      const taskResult = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.state !== 'COPY_REVIEW_PENDING') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'task is not waiting for copy review');
      }
      const aiDisclosureEnabled = rawAiDisclosureEnabled ?? task.ai_disclosure_enabled ?? true;
      if (Number(task.current_copy_revision_id) !== revisionId) {
        throw new ControlPlaneConflictError('STALE_COPY_REVISION', 'copy revision is no longer current');
      }
      const revision = await client.query(`
        SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE
      `, [revisionId, taskId]);
      if (!revision.rows[0]) throw new ControlPlaneNotFoundError('copy revision not found');
      const node = await client.query('SELECT id FROM executor_nodes WHERE id = $1', [nodeId]);
      if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
      let approvedRevisionId = revisionId;
      if (edits) {
        const revisionNumber = Number((await client.query(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM copy_revisions WHERE task_id = $1
        `, [taskId])).rows[0].revision);
        const reviewedContent = contentWithReviewEdits(revision.rows[0].content, edits, {
          baseRevisionId: revisionId,
          nodeId,
        });
        const reviewedRevision = await client.query(`
          INSERT INTO copy_revisions(
            task_id, execution_id, revision, content, approved_at, approved_by_node_id, approval_mode
          ) VALUES ($1, NULL, $2, $3, now(), $4, 'MANUAL')
          RETURNING *
        `, [taskId, revisionNumber, reviewedContent, nodeId]);
        approvedRevisionId = Number(reviewedRevision.rows[0].id);
      } else {
        await client.query(`
          UPDATE copy_revisions SET approved_at = now(), approved_by_node_id = $2, approval_mode = 'MANUAL' WHERE id = $1
        `, [revisionId, nodeId]);
      }
      return queueApprovedCopy(client, taskId, approvedRevisionId, aiDisclosureEnabled);
    });
  }

  async completeImage(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = normalizeJson(rawResult, 'image result', 10_000_000);
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'IMAGE') throw new TypeError('execution is not an image execution');
      assertImageResultSettings(execution.snapshot?.copyRevision?.content, result);
      // Local reprocessing reuses the source run and does not create a new visual plan.
      if (hasLayoutCatalog(execution.snapshot) && !execution.snapshot.copyRevision?.content?.imageReprocess) {
        const run = await client.query('SELECT result FROM image_runs WHERE execution_id = $1 FOR UPDATE', [executionId]);
        if (!run.rows[0]?.result?.visualPlan?.value) {
          throw new ControlPlaneConflictError('VISUAL_PLAN_REQUIRED', '视觉规划尚未校验入库，无法完成本次图片运行');
        }
      }
      await client.query(`
        UPDATE image_runs SET status = 'COMPLETED', result = COALESCE(result, '{}'::jsonb) || $2::jsonb
          || CASE WHEN result ? 'visualPlan' THEN jsonb_build_object('visualPlan', result->'visualPlan') ELSE '{}'::jsonb END, finished_at = now()
        WHERE id = $1
      `, [executionId, result]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = '图片生成完成，等待人工归档', last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId]);
      const task = await client.query(`
        UPDATE tasks SET
          state = 'MANUAL_ARCHIVE', current_execution_id = NULL,
          current_stage = 'MANUAL_ARCHIVE', progress_percent = 100,
          progress_message = '图片生成完成，等待人工归档',
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $2
        RETURNING *
      `, [execution.task_id, executionId]);
      return taskFrom(task.rows[0]);
    });
  }

  async failExecution(rawExecutionId, rawError, { autoRetry = true } = {}) {
    if (typeof autoRetry !== 'boolean') throw new TypeError('autoRetry must be a boolean');
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const message = redactExecutionError(rawError);
    // Both progress columns are varchar(500); keep longer diagnostics in error (text).
    const progressMessage = [...message].slice(0, 500).join('');
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      const isImage = execution.kind === 'IMAGE';
      const manual = isImage && !autoRetry;
      // The executor reports only after its entire run (including internal retries) fails.
      // Persist the budget in the next execution's snapshot, not in process-local memory.
      const failedAttempts = isImage ? (execution.snapshot?.imageRetry?.failedAttempts ?? 0) + 1 : 0;
      const exhausted = isImage && failedAttempts >= MAX_IMAGE_ATTEMPTS;
      const nextState = isImage ? (manual ? 'IMAGE_FAILED' : exhausted ? 'COPY_REVIEW_PENDING' : 'IMAGE_QUEUED') : 'COPY_FAILED';
      const retrySnapshot = isImage && !exhausted && !manual ? {
        ...await withSavedVisualPlan(client, executionId, execution.snapshot),
        imageRetry: { failedAttempts, nodeId: execution.node_id },
        ...(hasLayoutCatalog(execution.snapshot) ? { imageRecovery: { nodeId: execution.node_id,
          runIds: [...new Set([executionId, ...(execution.snapshot.imageRecovery?.runIds ?? [])])] } } : {}),
      } : null;
      const taskMessage = isImage
        ? manual ? '执行失败，已停止自动重试；请检查错误详情与检查点后人工续跑'
          : exhausted ? '生图3次失败，已停止自动重试，等待人工文案审核'
          : `生图第${failedAttempts}次失败，等待原执行机重试（最多${MAX_IMAGE_ATTEMPTS}次）`
        : progressMessage;
      await client.query(`
        UPDATE task_executions SET
          status = 'FAILED', progress_message = $2,
          error = $3, last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, progressMessage, message]);
      if (isImage) {
        await client.query(`
          UPDATE image_runs SET status = 'FAILED', finished_at = now() WHERE id = $1
        `, [executionId]);
      }
      const lifecycle = isImage
        ? `current_stage = $7, progress_percent = $8,
           current_image_run_id = ${exhausted || manual ? 'current_image_run_id' : 'NULL'}, pending_snapshot = $6,
           execution_started_at = $9, finished_at = ${exhausted || manual ? 'now()' : 'NULL'},`
        : 'current_stage = $6, finished_at = now(),';
      const values = [execution.task_id, nextState, taskMessage, message, executionId];
      // Terminal failures retain the last actual stage, progress and start time.
      // A queued retry starts a new lifecycle and therefore resets only those fields.
      if (isImage) values.push(retrySnapshot,
        manual ? execution.stage ?? 'FAILED' : exhausted ? 'IMAGE_RETRY_EXHAUSTED' : 'IMAGE_QUEUED',
        manual || exhausted ? Number(execution.progress_percent ?? 0) : 0,
        manual || exhausted ? execution.started_at ?? null : null);
      else values.push(execution.stage ?? 'FAILED');
      const task = await client.query(`
        UPDATE tasks SET
          state = $2, current_execution_id = NULL, ${lifecycle}
          progress_message = $3, error = $4, last_activity_at = now(),
          updated_at = now()
        WHERE id = $1 AND current_execution_id = $5
        RETURNING *
      `, values);
      return taskFrom(task.rows[0]);
    });
  }

  async reviewImages(rawTaskId, { imageRunId: rawImageRunId, decision, reviewerUserId: rawReviewerUserId }) {
    const taskId = normalizeTaskId(rawTaskId);
    const imageRunId = normalizeUuid(rawImageRunId, 'imageRunId');
    const reviewerUserId = normalizeCreatorUserId(rawReviewerUserId);
    if (!['APPROVE', 'RETRY', 'DISCARD'].includes(decision)) throw new TypeError('image review decision is invalid');
    const retry = decision === 'RETRY';
    const approved = decision === 'APPROVE';
    const state = approved ? 'REVIEWED' : retry ? 'IMAGE_QUEUED' : 'CANCELLED';
    const message = approved ? '图片审核通过，任务已完成'
      : retry ? '审核员要求重新生成图片，等待图片执行机领取' : '任务已被审核员废弃';
    return transaction(this.pool, async (client) => {
      const result = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = result.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.state !== 'MANUAL_ARCHIVE') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', '任务已不在人工归档阶段，请刷新后重试');
      }
      if (task.current_image_run_id !== imageRunId) {
        throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '图片版本已变化，请刷新后重新审核');
      }
      if (approved) {
        const run = await client.query(`
          SELECT id FROM image_runs WHERE id = $1 AND task_id = $2
            AND copy_revision_id = $3 AND status = 'COMPLETED'
        `, [imageRunId, taskId, task.current_copy_revision_id]);
        if (!run.rows[0]) throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '当前文案对应的图片尚未生成完成');
      }
      const updated = await client.query(`
        UPDATE tasks SET
          state = $2, current_stage = $2, progress_message = $3,
          current_execution_id = NULL, pending_snapshot = NULL, error = NULL,
          current_image_run_id = ${retry ? 'NULL' : 'current_image_run_id'},
          progress_percent = ${retry ? 0 : 100},
          execution_started_at = ${retry ? 'NULL' : 'execution_started_at'},
          finished_at = ${retry ? 'NULL' : 'COALESCE(finished_at, now())'},
          image_reviewed_at = ${approved ? 'now()' : 'NULL'},
          image_reviewed_by_user_id = $4,
          last_activity_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [taskId, state, message, approved ? reviewerUserId : null]);
      return taskFrom(updated.rows[0]);
    });
  }

  async retryTask(rawTaskId, { useLatestConfig = false } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    if (typeof useLatestConfig !== 'boolean') throw new TypeError('useLatestConfig must be a boolean');
    return transaction(this.pool, async (client) => {
      const result = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = result.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      const isCopy = ['COPY_RUNNING', 'COPY_FAILED'].includes(task.state);
      const isImage = ['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state);
      if (!isCopy && !isImage) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only running or failed work can be retried');
      }
      let snapshot = null;
      let sourceExecution = null;
      if (task.current_execution_id) {
        const execution = await client.query(`
          SELECT * FROM task_executions WHERE id = $1 FOR UPDATE
        `, [task.current_execution_id]);
        if (execution.rows[0]?.status === 'RUNNING') {
          sourceExecution = execution.rows[0];
          snapshot = execution.rows[0].snapshot;
          await client.query(`
            UPDATE task_executions SET
              status = 'ABANDONED', stage = 'ABANDONED',
              progress_message = '已人工作废，等待重新执行',
              last_activity_at = now(), finished_at = now()
            WHERE id = $1
          `, [task.current_execution_id]);
          if (execution.rows[0].kind === 'IMAGE') {
            await client.query(`
              UPDATE image_runs SET status = 'ABANDONED', finished_at = now()
              WHERE id = $1
            `, [task.current_execution_id]);
          }
        }
      } else if (!useLatestConfig) {
        const previous = await client.query(`
          SELECT id, node_id, snapshot FROM task_executions
          WHERE task_id = $1 AND kind = $2
          ORDER BY started_at DESC LIMIT 1
        `, [taskId, isCopy ? 'COPY' : 'IMAGE']);
        snapshot = previous.rows[0]?.snapshot ?? null;
        sourceExecution = previous.rows[0];
      }
      if (isImage && !useLatestConfig) {
        if (!snapshot || !sourceExecution?.id || !sourceExecution.node_id) {
          throw new ControlPlaneConflictError('IMAGE_RECOVERY_UNAVAILABLE', '原生图执行快照缺失，无法安全续跑；请恢复快照或明确使用最新配置重新生成');
        }
        snapshot = await withSavedVisualPlan(client, sourceExecution.id, snapshot);
        const priorRunIds = snapshot.imageRecovery?.runIds ?? [];
        snapshot = { ...snapshot, imageRecovery: {
          nodeId: sourceExecution.node_id,
          runIds: [...new Set([sourceExecution.id, ...priorRunIds])],
        } };
      }
      const nextState = isCopy ? 'COPY_QUEUED' : 'IMAGE_QUEUED';
      const values = [taskId, nextState, useLatestConfig ? null : snapshot];
      const updated = await client.query(`
        UPDATE tasks SET
          state = $2, current_execution_id = NULL, current_stage = $2,
          ${isCopy ? 'copy_executor_node_id = NULL,' : ''}
          progress_percent = 0, progress_message = ${isCopy ? "'等待文案执行机领取'" : "'等待重新执行'"},
          pending_snapshot = $3, execution_started_at = NULL,
          last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, values);
      return taskFrom(updated.rows[0]);
    });
  }

  async reviseImages(taskId, input, actorUsername) {
    return transaction(this.pool, async client => taskFrom(await reviseTaskImages(client, taskId, input, actorUsername)));
  }

  async requeueImageTask(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    return transaction(this.pool, async (client) => {
      const result = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = result.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (!['IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE'].includes(task.state)) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'task does not have approved copy that can be queued for image generation');
      }
      const revision = task.current_copy_revision_id === null ? { rows: [] } : await client.query(`
        SELECT id FROM copy_revisions
        WHERE id = $1 AND task_id = $2 AND approved_at IS NOT NULL
        FOR UPDATE
      `, [task.current_copy_revision_id, taskId]);
      if (!revision.rows[0]) {
        throw new ControlPlaneConflictError('IMAGE_RETRY_UNAVAILABLE', '文案尚未审核通过，不能进入待生图队列');
      }
      if (task.current_execution_id) {
        const execution = await client.query(`
          SELECT * FROM task_executions WHERE id = $1 FOR UPDATE
        `, [task.current_execution_id]);
        if (execution.rows[0]?.status === 'RUNNING') {
          if (execution.rows[0].kind !== 'IMAGE') {
            throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'current execution is not an image execution');
          }
          await client.query(`
            UPDATE task_executions SET
              status = 'ABANDONED', stage = 'ABANDONED',
              progress_message = '已人工重试，等待重新生图',
              last_activity_at = now(), finished_at = now()
            WHERE id = $1
          `, [task.current_execution_id]);
          await client.query(`
            UPDATE image_runs SET status = 'ABANDONED', finished_at = now()
            WHERE id = $1 AND status = 'RUNNING'
          `, [task.current_execution_id]);
        }
      }
      const updated = await client.query(`
        UPDATE tasks SET
          state = 'IMAGE_QUEUED', current_execution_id = NULL,
          current_image_run_id = NULL, current_stage = 'IMAGE_QUEUED',
          progress_percent = 0, progress_message = '已人工重试，等待图片执行机领取',
          pending_snapshot = NULL, execution_started_at = NULL,
          last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId]);
      return taskFrom(updated.rows[0]);
    });
  }

  async cancelTask(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    return transaction(this.pool, async (client) => {
      const result = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = result.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.state === 'CANCELLED') return taskFrom(task);
      if (task.current_execution_id) {
        const execution = await client.query(`
          SELECT * FROM task_executions WHERE id = $1 FOR UPDATE
        `, [task.current_execution_id]);
        if (execution.rows[0]?.status === 'RUNNING') {
          await client.query(`
            UPDATE task_executions SET
              status = 'ABANDONED', stage = 'ABANDONED',
              progress_message = '任务已被人工废弃',
              last_activity_at = now(), finished_at = now()
            WHERE id = $1
          `, [task.current_execution_id]);
          if (execution.rows[0].kind === 'IMAGE') {
            await client.query(`
              UPDATE image_runs SET status = 'ABANDONED', finished_at = now()
              WHERE id = $1 AND status = 'RUNNING'
            `, [task.current_execution_id]);
          }
        }
      }
      const updated = await client.query(`
        UPDATE tasks SET
          state = 'CANCELLED', current_execution_id = NULL, current_stage = 'CANCELLED',
          progress_message = '任务已被人工废弃', last_activity_at = now(),
          finished_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId]);
      return taskFrom(updated.rows[0]);
    });
  }

  async upsertSetting(rawKey, rawValue) {
    const key = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9._-]{0,99}$/u.test(key)) throw new TypeError('setting key is invalid');
    const value = normalizeJson(rawValue, 'setting value', 1_000_000);
    if (key === 'production' && value?.layoutPresets !== undefined) value.layoutPresets = normalizeLayoutPresets(value.layoutPresets);
    if (key === 'production' && value?.layoutCatalog !== undefined) {
      value.layoutCatalog = normalizeLayoutCatalog(value.layoutCatalog);
      const current = await this.getLayoutCatalog();
      if (current.revision !== layoutCatalogRecord(value).revision) throw new TypeError('请在布局模板库中更新目录，避免覆盖其他编辑');
    }
    const result = await this.pool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET
        value = CASE WHEN excluded.key = 'production' AND global_settings.value ? 'layoutCatalog'
          THEN excluded.value || jsonb_build_object('layoutCatalog', global_settings.value->'layoutCatalog') ELSE excluded.value END,
        version = global_settings.version + 1, updated_at = now()
      RETURNING *
    `, [key, value]);
    return {
      key: result.rows[0].key,
      value: result.rows[0].value,
      version: Number(result.rows[0].version),
      updatedAt: result.rows[0].updated_at,
    };
  }

  async listSettings() {
    const result = await this.pool.query('SELECT * FROM global_settings ORDER BY key');
    return result.rows.map((row) => ({
      key: row.key,
      value: row.value,
      version: Number(row.version),
      updatedAt: row.updated_at,
    }));
  }

  async getLayoutCatalog() {
    const result = await this.pool.query("SELECT value FROM global_settings WHERE key = 'production'");
    return layoutCatalogRecord(result.rows[0]?.value ?? {});
  }

  async updateLayoutCatalog(input, options = {}) {
    return transaction(this.pool, async client => {
      await client.query("INSERT INTO global_settings(key, value) VALUES ('production', '{}'::jsonb) ON CONFLICT(key) DO NOTHING");
      const current = await client.query("SELECT value FROM global_settings WHERE key = 'production' FOR UPDATE");
      const changed = changeLayoutCatalog(current.rows[0].value, input, options);
      if (JSON.stringify(changed.settings) !== JSON.stringify(current.rows[0].value)) {
        await client.query("UPDATE global_settings SET value = $1, version = version + 1, updated_at = now() WHERE key = 'production'", [changed.settings]);
      }
      return changed.record;
    });
  }

  async seedSetting(rawKey, rawValue) {
    const key = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9._-]{0,99}$/u.test(key)) throw new TypeError('setting key is invalid');
    const value = normalizeJson(rawValue, 'setting value', 1_000_000);
    const result = await this.pool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO NOTHING
      RETURNING *
    `, [key, value]);
    return result.rows[0] !== undefined;
  }

  async createPromptVersion({ kind: rawKind, name: rawName, content: rawContent }) {
    const kind = String(rawKind ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,79}$/u.test(kind)) throw new TypeError('prompt kind is invalid');
    const name = String(rawName ?? kind).trim();
    const content = String(rawContent ?? '');
    if (!name || [...name].length > 160) throw new TypeError('prompt name is invalid');
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 500_000) {
      throw new TypeError('prompt content is invalid');
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    return transaction(this.pool, async (client) => {
      const template = await client.query(`
        INSERT INTO prompt_templates(kind, name) VALUES ($1, $2)
        ON CONFLICT(kind) DO UPDATE SET name = excluded.name, updated_at = now()
        RETURNING *
      `, [kind, name]);
      const version = Number((await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM prompt_versions WHERE template_id = $1
      `, [template.rows[0].id])).rows[0].version);
      const inserted = await client.query(`
        INSERT INTO prompt_versions(template_id, version, content, content_sha256)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [template.rows[0].id, version, content, sha256]);
      return {
        id: Number(inserted.rows[0].id),
        templateId: Number(template.rows[0].id),
        kind,
        name,
        version,
        content,
        sha256,
        status: 'DRAFT',
      };
    });
  }

  async publishPromptVersion(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    return transaction(this.pool, async (client) => {
      const version = await client.query(`
        SELECT * FROM prompt_versions WHERE id = $1 FOR UPDATE
      `, [versionId]);
      if (!version.rows[0]) throw new ControlPlaneNotFoundError('prompt version not found');
      await client.query(`
        UPDATE prompt_versions SET status = 'ARCHIVED'
        WHERE template_id = $1 AND status = 'PUBLISHED'
      `, [version.rows[0].template_id]);
      const published = await client.query(`
        UPDATE prompt_versions SET status = 'PUBLISHED', published_at = now()
        WHERE id = $1 RETURNING *
      `, [versionId]);
      return {
        id: Number(published.rows[0].id),
        templateId: Number(published.rows[0].template_id),
        version: Number(published.rows[0].version),
        status: published.rows[0].status,
        publishedAt: published.rows[0].published_at,
      };
    });
  }

  async listPrompts() {
    const result = await this.pool.query(`
      SELECT t.id AS template_id, t.kind, t.name,
             v.id AS version_id, v.version, v.content, v.content_sha256,
             v.status AS version_status, v.created_at AS version_created_at,
             v.published_at
      FROM prompt_templates t
      LEFT JOIN prompt_versions v ON v.template_id = t.id
      ORDER BY t.kind, v.version DESC
    `);
    const templates = new Map();
    for (const row of result.rows) {
      const template = templates.get(row.kind) ?? {
        id: Number(row.template_id), kind: row.kind, name: row.name, versions: [],
      };
      if (row.version_id !== null) template.versions.push({
        id: Number(row.version_id),
        version: Number(row.version),
        content: row.content,
        sha256: row.content_sha256,
        status: row.version_status,
        createdAt: row.version_created_at,
        publishedAt: row.published_at,
      });
      templates.set(row.kind, template);
    }
    return [...templates.values()];
  }

  async createKnowledgeVersion({
    itemId: rawItemId = null,
    kind: rawKind,
    name: rawName,
    content: rawContent = {},
    storagePath = null,
    sha256 = null,
    publish = false,
    expectedVersionId = null,
  }) {
    if (typeof publish !== 'boolean') throw new TypeError('publish must be boolean');
    const itemId = rawItemId === null ? null : normalizeTaskId(rawItemId);
    const kind = String(rawKind ?? '').trim().toUpperCase();
    if (!['COPY', 'VISUAL'].includes(kind)) throw new TypeError('knowledge kind is invalid');
    const name = String(rawName ?? '').trim();
    if (!name || [...name].length > 200) throw new TypeError('knowledge name is invalid');
    const content = normalizeJson(rawContent, 'knowledge content', 2_000_000);
    if (storagePath !== null && typeof storagePath !== 'string') {
      throw new TypeError('knowledge storagePath is invalid');
    }
    if (sha256 !== null && !/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new TypeError('knowledge sha256 is invalid');
    }
    return transaction(this.pool, async (client) => {
      let item;
      if (itemId === null && content.legacySource) {
        const { sourceKey, sourceId } = content.legacySource;
        if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 500) throw new TypeError('legacy source key is invalid');
        normalizeTaskId(sourceId);
        await client.query('SELECT pg_advisory_xact_lock(4310, hashtext($1))', [`${kind}:${sourceKey}:${sourceId}`]);
        const existing = await client.query(`
          SELECT v.*, i.name FROM knowledge_versions v JOIN knowledge_items i ON i.id = v.item_id
          WHERE i.kind = $1 AND v.content @> $2::jsonb ORDER BY v.version DESC LIMIT 1
        `, [kind, JSON.stringify({ legacySource: content.legacySource })]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          return { itemId: Number(row.item_id), versionId: Number(row.id), kind, name: row.name,
            content: row.content, status: row.status, skipped: true };
        }
      }
      if (itemId === null) {
        item = (await client.query(`
          INSERT INTO knowledge_items(kind, name) VALUES ($1, $2) RETURNING *
        `, [kind, name])).rows[0];
      } else {
        const selected = await client.query(`
          SELECT * FROM knowledge_items WHERE id = $1 FOR UPDATE
        `, [itemId]);
        if (!selected.rows[0]) throw new ControlPlaneNotFoundError('knowledge item not found');
        if (selected.rows[0].kind !== kind) throw new TypeError('knowledge kind cannot be changed');
        item = (await client.query(`
          UPDATE knowledge_items SET name = $2, updated_at = now() WHERE id = $1 RETURNING *
        `, [itemId, name])).rows[0];
      }
      const version = Number((await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM knowledge_versions WHERE item_id = $1
      `, [item.id])).rows[0].version);
      if (expectedVersionId !== null) {
        const latest = await client.query('SELECT id FROM knowledge_versions WHERE item_id = $1 ORDER BY version DESC LIMIT 1', [item.id]);
        if (Number(latest.rows[0]?.id) !== normalizeTaskId(expectedVersionId)) {
          throw new ControlPlaneConflictError('KNOWLEDGE_CHANGED', '知识已被其他页面修改，请刷新后重试');
        }
      }
      if (publish) {
        if (kind !== 'COPY') throw new TypeError('visual knowledge requires a separate publication review');
        await client.query("UPDATE knowledge_versions SET status = 'ARCHIVED' WHERE item_id = $1 AND status = 'PUBLISHED'", [item.id]);
      }
      const created = await client.query(`
        INSERT INTO knowledge_versions(
          item_id, version, content, storage_path, content_sha256
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [item.id, version, content, storagePath, sha256]);
      if (publish) await client.query("UPDATE knowledge_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [created.rows[0].id]);
      return {
        itemId: Number(item.id),
        kind,
        name,
        versionId: Number(created.rows[0].id),
        version,
        content,
        storagePath,
        sha256,
        status: publish ? 'PUBLISHED' : 'DRAFT',
      };
    });
  }

  async publishKnowledgeVersion(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    return transaction(this.pool, async (client) => {
      const version = await client.query(`
        SELECT * FROM knowledge_versions WHERE id = $1 FOR UPDATE
      `, [versionId]);
      if (!version.rows[0]) throw new ControlPlaneNotFoundError('knowledge version not found');
      const content = version.rows[0].content;
      if (content?.retentionMode === 'IMAGE_AND_PROMPT'
        && (!['SELF_OWNED', 'LICENSED'].includes(content.rightsStatus) || !version.rows[0].storage_path)) {
        throw new TypeError('retained visual knowledge requires an authorized uploaded image before publication');
      }
      await client.query(`
        UPDATE knowledge_versions SET status = 'ARCHIVED'
        WHERE item_id = $1 AND status = 'PUBLISHED'
      `, [version.rows[0].item_id]);
      const published = await client.query(`
        UPDATE knowledge_versions SET status = 'PUBLISHED', published_at = now()
        WHERE id = $1 RETURNING *
      `, [versionId]);
      return {
        versionId: Number(published.rows[0].id),
        itemId: Number(published.rows[0].item_id),
        version: Number(published.rows[0].version),
        status: published.rows[0].status,
        publishedAt: published.rows[0].published_at,
      };
    });
  }

  async listKnowledge() {
    const result = await this.pool.query(`
      SELECT i.id AS item_id, i.kind, i.name, i.status AS item_status,
             v.id AS version_id, v.version, v.content, v.storage_path,
             v.content_sha256, v.status AS version_status,
             v.created_at AS version_created_at, v.published_at
      FROM knowledge_items i
      LEFT JOIN knowledge_versions v ON v.item_id = i.id
      ORDER BY i.kind, i.id, v.version DESC
    `);
    const items = new Map();
    for (const row of result.rows) {
      const item = items.get(row.item_id) ?? {
        id: Number(row.item_id),
        kind: row.kind,
        name: row.name,
        status: row.item_status,
        versions: [],
      };
      if (row.version_id !== null) item.versions.push({
        id: Number(row.version_id),
        version: Number(row.version),
        content: row.content,
        storagePath: row.storage_path,
        sha256: row.content_sha256,
        status: row.version_status,
        createdAt: row.version_created_at,
        publishedAt: row.published_at,
      });
      items.set(row.item_id, item);
    }
    return [...items.values()];
  }

  async knowledgeUploadContext(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    const result = await this.pool.query(`
      SELECT v.id AS version_id, v.status, v.content, i.id AS item_id, i.kind
      FROM knowledge_versions v
      JOIN knowledge_items i ON i.id = v.item_id
      WHERE v.id = $1
    `, [versionId]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('knowledge version not found');
    if (result.rows[0].status !== 'DRAFT') {
      throw new ControlPlaneConflictError(
        'KNOWLEDGE_VERSION_IMMUTABLE',
        'only a draft knowledge version can receive an asset',
      );
    }
    const content = result.rows[0].content;
    if (result.rows[0].kind !== 'VISUAL' || content?.retentionMode !== 'IMAGE_AND_PROMPT'
      || !['SELF_OWNED', 'LICENSED'].includes(content.rightsStatus)) {
      throw new TypeError('only self-owned or licensed retained visual images may be uploaded');
    }
    return {
      versionId,
      itemId: Number(result.rows[0].item_id),
      kind: result.rows[0].kind,
    };
  }

  async attachKnowledgeAsset({ versionId: rawVersionId, storagePath, sha256 }) {
    const versionId = normalizeTaskId(rawVersionId);
    if (typeof storagePath !== 'string' || !storagePath) throw new TypeError('storagePath is invalid');
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('knowledge sha256 is invalid');
    const result = await this.pool.query(`
      UPDATE knowledge_versions SET storage_path = $2, content_sha256 = $3
      WHERE id = $1 AND status = 'DRAFT'
      RETURNING id, item_id, storage_path, content_sha256
    `, [versionId, storagePath, sha256]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'KNOWLEDGE_VERSION_IMMUTABLE',
        'only a draft knowledge version can receive an asset',
      );
    }
    return {
      versionId: Number(result.rows[0].id),
      itemId: Number(result.rows[0].item_id),
      sha256: result.rows[0].content_sha256,
      url: `/v1/knowledge-versions/${versionId}/asset`,
    };
  }

  async getKnowledgeAsset(rawVersionId) {
    const versionId = normalizeTaskId(rawVersionId);
    const result = await this.pool.query(`
      SELECT id, storage_path, content_sha256 FROM knowledge_versions WHERE id = $1
    `, [versionId]);
    if (!result.rows[0]?.storage_path) return null;
    return {
      versionId,
      storagePath: result.rows[0].storage_path,
      sha256: result.rows[0].content_sha256,
    };
  }

  async activeImageUploadContext(rawExecutionId, queryable = this.pool) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = await queryable.query(`
      SELECT e.id, e.task_id, r.id AS image_run_id
      FROM task_executions e
      JOIN tasks t ON t.current_execution_id = e.id
      JOIN image_runs r ON r.execution_id = e.id
      WHERE e.id = $1 AND e.kind = 'IMAGE' AND e.status = 'RUNNING'
    `, [executionId]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'STALE_EXECUTION',
        'execution is no longer current and cannot upload assets',
      );
    }
    return {
      executionId,
      taskId: Number(result.rows[0].task_id),
      imageRunId: result.rows[0].image_run_id,
    };
  }

  async recordAsset({
    executionId: rawExecutionId,
    mediaType,
    byteSize,
    sha256,
    storagePath,
    originalName = null,
  }) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    if (![...Object.values(IMAGE_FORMATS).map(format => format.mediaType), 'application/json'].includes(mediaType)) {
      throw new TypeError('asset mediaType is invalid');
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new TypeError('asset byteSize is invalid');
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('asset sha256 is invalid');
    return transaction(this.pool, async client => {
      // Serialize validation and insertion with completion/recovery. An earlier
      // HTTP upload check alone cannot fence a late write after recovery commits.
      await lockedExecution(client, executionId);
      const context = await this.activeImageUploadContext(executionId, client);
      const result = await client.query(`
        INSERT INTO assets(
          task_id, image_run_id, media_type, byte_size, sha256, storage_path, original_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        context.taskId,
        context.imageRunId,
        mediaType,
        byteSize,
        sha256,
        storagePath,
        originalName === null ? null : String(originalName).slice(0, 255),
      ]);
      const row = result.rows[0];
      return {
        id: Number(row.id),
        taskId: Number(row.task_id),
        imageRunId: row.image_run_id,
        mediaType: row.media_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        createdAt: row.created_at,
      };
    });
  }

  async imageReprocessAsset(rawExecutionId, rawAssetId) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const assetId = normalizeTaskId(rawAssetId);
    return transaction(this.pool, async client => {
      const execution = await lockedExecution(client, executionId);
      const local = execution.snapshot?.copyRevision?.content?.imageReprocess;
      const pinned = local?.sources?.find(item => item.assetId === assetId);
      if (execution.kind !== 'IMAGE' || !pinned) throw new ControlPlaneNotFoundError('source asset not found');
      const asset = await this.getAsset(assetId, client);
      if (!asset || asset.taskId !== Number(execution.task_id) || asset.imageRunId !== local.sourceRunId || asset.sha256 !== pinned.sha256) throw new ControlPlaneNotFoundError('source asset not found');
      return asset;
    });
  }

  async getAsset(rawAssetId, queryable = this.pool) {
    const assetId = normalizeTaskId(rawAssetId);
    const result = await queryable.query('SELECT * FROM assets WHERE id = $1', [assetId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id),
      taskId: Number(row.task_id),
      imageRunId: row.image_run_id,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      storagePath: row.storage_path,
      originalName: row.original_name,
      createdAt: row.created_at,
    };
  }
}

export function createPostgresControlPlaneRepository(options) {
  return new PostgresControlPlaneRepository(options);
}
