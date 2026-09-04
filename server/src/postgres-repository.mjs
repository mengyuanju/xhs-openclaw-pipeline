import { createHash, randomUUID } from 'node:crypto';
import { migrateDatabase } from './database-migrations.mjs';

import pg from 'pg';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  TASK_STATES,
  normalizeCopyReviewEdits,
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

function taskFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    query: row.query,
    input: row.input,
    requestedImageCount: row.requested_image_count === 'auto'
      ? 'auto'
      : Number(row.requested_image_count),
    state: row.state,
    createdByNodeId: row.created_by_node_id,
    copyExecutorNodeId: row.copy_executor_node_id,
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
    online: Boolean(row.online),
    copyQueuedCount: Number(row.copy_queued_count ?? 0),
    copyRunningCount: Number(row.copy_running_count ?? 0),
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

async function configurationSnapshot(client, task, kind) {
  const [settings, prompts, knowledge, revision] = await Promise.all([
    client.query(`SELECT key, value, version FROM global_settings ORDER BY key`),
    client.query(`
      SELECT t.kind, t.name, v.id AS version_id, v.version, v.content, v.content_sha256
      FROM prompt_templates t
      LEFT JOIN prompt_versions v ON v.template_id = t.id AND v.status = 'PUBLISHED'
      ORDER BY t.kind
    `),
    client.query(`
      SELECT i.id, i.kind, i.name, v.id AS version_id, v.version, v.content,
             v.storage_path, v.content_sha256
      FROM knowledge_items i
      JOIN knowledge_versions v ON v.item_id = i.id AND v.status = 'PUBLISHED'
      WHERE i.status = 'ACTIVE'
      ORDER BY i.kind, i.id
    `),
    kind === 'IMAGE'
      ? client.query('SELECT * FROM copy_revisions WHERE id = $1', [task.current_copy_revision_id])
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    task: {
      id: Number(task.id),
      query: task.query,
      input: task.input,
      requestedImageCount: task.requested_image_count === 'auto'
        ? 'auto'
        : Number(task.requested_image_count),
    },
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
    copyRevision: revisionFrom(revision.rows[0]),
  };
}

async function lockedExecution(client, executionId) {
  const result = await client.query(`
    SELECT e.*, t.current_execution_id, t.state AS task_state
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

export class PostgresControlPlaneRepository {
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
  }

  async health() {
    const result = await this.pool.query('SELECT now() AS now');
    return { ok: true, databaseTime: result.rows[0].now };
  }

  async registerNode({ nodeId: rawNodeId, name: rawName, imageWorkerEnabled = false }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const name = normalizeNodeName(rawName, nodeId);
    if (typeof imageWorkerEnabled !== 'boolean') {
      throw new TypeError('imageWorkerEnabled must be a boolean');
    }
    const result = await this.pool.query(`
      INSERT INTO executor_nodes(id, name, image_worker_enabled)
      VALUES ($1, $2, $3)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        image_worker_enabled = excluded.image_worker_enabled,
        last_seen_at = now(),
        updated_at = now()
      RETURNING *
    `, [nodeId, name, imageWorkerEnabled]);
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      imageWorkerEnabled: row.image_worker_enabled,
      lastSeenAt: row.last_seen_at,
    };
  }

  async listNodes() {
    const result = await this.pool.query(`
      SELECT
        n.*,
        n.last_seen_at >= now() - interval '90 seconds' AS online,
        COUNT(t.id) FILTER (WHERE t.state = 'COPY_QUEUED') AS copy_queued_count,
        COUNT(t.id) FILTER (WHERE t.state = 'COPY_RUNNING') AS copy_running_count
      FROM executor_nodes n
      LEFT JOIN tasks t ON t.copy_executor_node_id = n.id
      GROUP BY n.id
      ORDER BY online DESC, n.name, n.id
    `);
    return result.rows.map(nodeFrom);
  }

  async createTasks({ nodeId: rawNodeId, copyExecutorNodeId: rawCopyExecutorNodeId, tasks: rawTasks }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const copyExecutorNodeId = normalizeNodeId(rawCopyExecutorNodeId ?? rawNodeId);
    const tasks = normalizeTaskBatch(rawTasks);
    return transaction(this.pool, async (client) => {
      await client.query(`
        INSERT INTO executor_nodes(id, name, image_worker_enabled, last_seen_at)
        VALUES ($1, $1, false, 'epoch'::timestamptz)
        ON CONFLICT(id) DO NOTHING
      `, [nodeId]);
      const executor = await client.query(`
        SELECT id, last_seen_at >= now() - interval '90 seconds' AS online
        FROM executor_nodes
        WHERE id = $1
        FOR UPDATE
      `, [copyExecutorNodeId]);
      if (!executor.rows[0]) {
        throw new ControlPlaneNotFoundError('copy executor node is not registered');
      }
      if (!executor.rows[0].online) {
        throw new ControlPlaneConflictError(
          'EXECUTOR_OFFLINE',
          'copy executor node is offline; choose an online executor',
        );
      }
      const created = [];
      for (const task of tasks) {
        const result = await client.query(`
          INSERT INTO tasks(
            query, input, requested_image_count, created_by_node_id, copy_executor_node_id
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [task.query, task.input, String(task.imageCount), nodeId, copyExecutorNodeId]);
        created.push(taskFrom(result.rows[0]));
      }
      return created;
    });
  }

  async listTasks({
    state = null,
    states = null,
    nodeId = null,
    query = null,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (typeof includeTotal !== 'boolean') throw new TypeError('includeTotal must be a boolean');
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
    const searchQuery = normalizedTaskQuery(query);
    if (searchQuery !== null) {
      values.push(searchQuery);
      filters.push(`strpos(lower(query), lower($${values.length})) > 0`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const pageValues = [...values, safeLimit, safeOffset];
    const [result, countResult] = await Promise.all([
      this.pool.query(`
      SELECT * FROM tasks
      ${where}
      ORDER BY id DESC
      LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}
    `, pageValues),
      includeTotal
        ? this.pool.query(`SELECT COUNT(*) AS total FROM tasks ${where}`, values)
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
        COUNT(*) FILTER (WHERE state = 'DELIVERY_REVIEW_PENDING') AS delivery_review,
        COUNT(*) FILTER (WHERE state = 'COMPLETED') AS completed
      FROM tasks
      WHERE state <> 'CANCELLED'
    `, [nodeId]);
    const row = result.rows[0];
    return {
      localCopy: Number(row.local_copy),
      allCopy: Number(row.all_copy),
      copyReview: Number(row.copy_review),
      imageWork: Number(row.image_work),
      deliveryReview: Number(row.delivery_review),
      completed: Number(row.completed),
    };
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
    return this.#claim({ kind: 'COPY', nodeId: rawNodeId });
  }

  async claimImage(rawNodeId) {
    return this.#claim({ kind: 'IMAGE', nodeId: rawNodeId });
  }

  async #claim({ kind, nodeId: rawNodeId }) {
    const nodeId = normalizeNodeId(rawNodeId);
    return transaction(this.pool, async (client) => {
      const node = await client.query(`
        SELECT * FROM executor_nodes WHERE id = $1 FOR UPDATE
      `, [nodeId]);
      if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
      await client.query(`UPDATE executor_nodes SET last_seen_at = now() WHERE id = $1`, [nodeId]);
      if (kind === 'IMAGE' && !node.rows[0].image_worker_enabled) {
        throw new ControlPlaneConflictError(
          'IMAGE_WORKER_DISABLED',
          'this executor node is not enabled for image work',
        );
      }
      const active = await client.query(`
        SELECT 1 FROM task_executions
        WHERE node_id = $1 AND kind = $2 AND status = 'RUNNING'
        LIMIT 1
      `, [nodeId, kind]);
      if (active.rows[0]) return null;
      const queuedState = kind === 'COPY' ? 'COPY_QUEUED' : 'IMAGE_QUEUED';
      const runningState = kind === 'COPY' ? 'COPY_RUNNING' : 'IMAGE_RUNNING';
      const ownership = kind === 'COPY' ? 'AND copy_executor_node_id = $2' : '';
      // Cool down failed image tasks centrally, including claims from other nodes.
      const retryDelay = kind === 'IMAGE'
        ? "AND (error IS NULL OR last_activity_at <= now() - interval '5 seconds')" : '';
      const order = kind === 'IMAGE' ? 'last_activity_at NULLS FIRST, id' : 'id';
      const parameters = kind === 'COPY' ? [queuedState, nodeId] : [queuedState];
      const candidate = await client.query(`
        SELECT * FROM tasks
        WHERE state = $1 ${ownership} ${retryDelay}
        ORDER BY ${order}
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `, parameters);
      const task = candidate.rows[0];
      if (!task) return null;
      const executionId = randomUUID();
      const snapshot = task.pending_snapshot
        ?? await configurationSnapshot(client, task, kind);
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
      `, [runningState, executionId, kind, stage, task.id, queuedState]);
      return {
        task: taskFrom(updated.rows[0]),
        execution: executionFrom((await client.query(
          'SELECT * FROM task_executions WHERE id = $1',
          [executionId],
        )).rows[0]),
      };
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
      const revisionNumber = Number((await client.query(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM copy_revisions WHERE task_id = $1
      `, [execution.task_id])).rows[0].revision);
      const revision = await client.query(`
        INSERT INTO copy_revisions(task_id, execution_id, revision, content)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [execution.task_id, executionId, revisionNumber, result]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = '文案生成完成，等待人工审核', last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId]);
      const task = await client.query(`
        UPDATE tasks SET
          state = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2,
          current_execution_id = NULL, current_stage = 'COPY_REVIEW_PENDING',
          progress_percent = 100, progress_message = '文案生成完成，等待人工审核',
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $3
        RETURNING *
      `, [execution.task_id, revision.rows[0].id, executionId]);
      return { task: taskFrom(task.rows[0]), revision: revisionFrom(revision.rows[0]) };
    });
  }

  async approveCopy(rawTaskId, { revisionId: rawRevisionId, nodeId: rawNodeId, edits: rawEdits }) {
    const taskId = normalizeTaskId(rawTaskId);
    const revisionId = normalizeTaskId(rawRevisionId);
    const nodeId = normalizeNodeId(rawNodeId);
    const edits = rawEdits === undefined ? null : normalizeCopyReviewEdits(rawEdits);
    return transaction(this.pool, async (client) => {
      const taskResult = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.state !== 'COPY_REVIEW_PENDING') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'task is not waiting for copy review');
      }
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
            task_id, execution_id, revision, content, approved_at, approved_by_node_id
          ) VALUES ($1, NULL, $2, $3, now(), $4)
          RETURNING *
        `, [taskId, revisionNumber, reviewedContent, nodeId]);
        approvedRevisionId = Number(reviewedRevision.rows[0].id);
      } else {
        await client.query(`
          UPDATE copy_revisions SET approved_at = now(), approved_by_node_id = $2 WHERE id = $1
        `, [revisionId, nodeId]);
      }
      const updated = await client.query(`
        UPDATE tasks SET
          state = 'IMAGE_QUEUED', current_copy_revision_id = $2,
          current_image_run_id = NULL,
          current_stage = 'IMAGE_QUEUED', progress_percent = 0,
          progress_message = '文案审核通过，等待图片执行机领取',
          execution_started_at = NULL, last_activity_at = now(), finished_at = NULL,
          error = NULL, pending_snapshot = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId, approvedRevisionId]);
      return taskFrom(updated.rows[0]);
    });
  }

  async completeImage(rawExecutionId, rawResult) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = normalizeJson(rawResult, 'image result', 10_000_000);
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      if (execution.kind !== 'IMAGE') throw new TypeError('execution is not an image execution');
      await client.query(`
        UPDATE image_runs SET status = 'COMPLETED', result = $2, finished_at = now()
        WHERE id = $1
      `, [executionId, result]);
      await client.query(`
        UPDATE task_executions SET
          status = 'SUCCEEDED', stage = 'COMPLETED', progress_percent = 100,
          progress_message = '图片生成完成，等待图文审核', last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId]);
      const task = await client.query(`
        UPDATE tasks SET
          state = 'DELIVERY_REVIEW_PENDING', current_execution_id = NULL,
          current_stage = 'DELIVERY_REVIEW_PENDING', progress_percent = 100,
          progress_message = '图片生成完成，等待图文审核',
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1 AND current_execution_id = $2
        RETURNING *
      `, [execution.task_id, executionId]);
      return taskFrom(task.rows[0]);
    });
  }

  async failExecution(rawExecutionId, rawError) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const message = redactExecutionError(rawError);
    // Both progress columns are varchar(500); keep longer diagnostics in error (text).
    const progressMessage = [...message].slice(0, 500).join('');
    return transaction(this.pool, async (client) => {
      const execution = await lockedExecution(client, executionId);
      const isImage = execution.kind === 'IMAGE';
      const nextState = isImage ? 'IMAGE_QUEUED' : 'COPY_FAILED';
      await client.query(`
        UPDATE task_executions SET
          status = 'FAILED', stage = 'FAILED', progress_message = $2,
          error = $3, last_activity_at = now(), finished_at = now()
        WHERE id = $1
      `, [executionId, progressMessage, message]);
      if (isImage) {
        await client.query(`
          UPDATE image_runs SET status = 'FAILED', finished_at = now() WHERE id = $1
        `, [executionId]);
      }
      const lifecycle = isImage
        ? `current_stage = 'IMAGE_QUEUED', progress_percent = 0,
           current_image_run_id = NULL, pending_snapshot = $6,
           execution_started_at = NULL, finished_at = NULL,`
        : "current_stage = 'FAILED', finished_at = now(),";
      const values = [execution.task_id, nextState,
        isImage ? '生图失败，已重新排队，等待执行机领取' : progressMessage,
        message, executionId];
      if (isImage) values.push(execution.snapshot);
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
      if (task.current_execution_id) {
        const execution = await client.query(`
          SELECT * FROM task_executions WHERE id = $1 FOR UPDATE
        `, [task.current_execution_id]);
        if (execution.rows[0]?.status === 'RUNNING') {
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
          SELECT snapshot FROM task_executions
          WHERE task_id = $1 AND kind = $2
          ORDER BY started_at DESC LIMIT 1
        `, [taskId, isCopy ? 'COPY' : 'IMAGE']);
        snapshot = previous.rows[0]?.snapshot ?? null;
      }
      const nextState = isCopy ? 'COPY_QUEUED' : 'IMAGE_QUEUED';
      const updated = await client.query(`
        UPDATE tasks SET
          state = $2, current_execution_id = NULL, current_stage = $2,
          progress_percent = 0, progress_message = '等待重新执行',
          pending_snapshot = $3, execution_started_at = NULL,
          last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId, nextState, useLatestConfig ? null : snapshot]);
      return taskFrom(updated.rows[0]);
    });
  }

  async completeDeliveryReview(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const result = await this.pool.query(`
      UPDATE tasks SET
        state = 'COMPLETED', current_stage = 'COMPLETED',
        progress_message = '图文审核通过，任务完成', finished_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'DELIVERY_REVIEW_PENDING'
      RETURNING *
    `, [taskId]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'INVALID_TASK_STATE',
        'task is not waiting for delivery review',
      );
    }
    return taskFrom(result.rows[0]);
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
    const result = await this.pool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, version = global_settings.version + 1, updated_at = now()
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
  }) {
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
      const created = await client.query(`
        INSERT INTO knowledge_versions(
          item_id, version, content, storage_path, content_sha256
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [item.id, version, content, storagePath, sha256]);
      return {
        itemId: Number(item.id),
        kind,
        name,
        versionId: Number(created.rows[0].id),
        version,
        content,
        storagePath,
        sha256,
        status: 'DRAFT',
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
      SELECT v.id AS version_id, v.status, i.id AS item_id, i.kind
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

  async activeImageUploadContext(rawExecutionId) {
    const executionId = normalizeUuid(rawExecutionId, 'executionId');
    const result = await this.pool.query(`
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
    const context = await this.activeImageUploadContext(rawExecutionId);
    if (!['image/png', 'image/jpeg', 'application/json'].includes(mediaType)) {
      throw new TypeError('asset mediaType is invalid');
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new TypeError('asset byteSize is invalid');
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError('asset sha256 is invalid');
    const result = await this.pool.query(`
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
  }

  async getAsset(rawAssetId) {
    const assetId = normalizeTaskId(rawAssetId);
    const result = await this.pool.query('SELECT * FROM assets WHERE id = $1', [assetId]);
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
