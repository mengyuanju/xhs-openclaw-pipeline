import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  lockCurrentActor,
  nodeFrom,
  normalizeConcurrency,
  normalizeNodeId,
  normalizeNodeName,
  transaction
} from './repository-context.mjs';
import { ConfigurationRepository } from './repository-configuration.mjs';

export class NodeRepository extends ConfigurationRepository {
  async registerNode({ nodeId: rawNodeId, name: rawName, imageWorkerEnabled = false,
    copyConcurrency, imageConcurrency, codexPoolId: rawCodexPoolId,
    codexTotalConcurrency, codexImageConcurrency, imageEditExecutorVersion = 0,
    copyImagePlanRegenerationVersion = 0 }) {
    const nodeId = normalizeNodeId(rawNodeId);
    const name = normalizeNodeName(rawName, nodeId);
    if (copyConcurrency !== undefined) normalizeConcurrency(copyConcurrency, 'copyConcurrency');
    if (imageConcurrency !== undefined) normalizeConcurrency(imageConcurrency, 'imageConcurrency');
    if (typeof imageWorkerEnabled !== 'boolean') {
      throw new TypeError('imageWorkerEnabled must be a boolean');
    }
    if (!Number.isInteger(imageEditExecutorVersion) || imageEditExecutorVersion < 0) {
      throw new TypeError('imageEditExecutorVersion must be a non-negative integer');
    }
    if (!Number.isInteger(copyImagePlanRegenerationVersion)
        || copyImagePlanRegenerationVersion < 0) {
      throw new TypeError('copyImagePlanRegenerationVersion must be a non-negative integer');
    }
    const codexPoolId = rawCodexPoolId === undefined ? nodeId : String(rawCodexPoolId).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(codexPoolId)) {
      throw new TypeError('codexPoolId is invalid');
    }
    const totalConcurrency = codexTotalConcurrency === undefined
      ? Math.max(copyConcurrency ?? 1, imageConcurrency ?? 1)
      : normalizeConcurrency(codexTotalConcurrency, 'codexTotalConcurrency');
    const poolImageConcurrency = codexImageConcurrency === undefined
      ? imageConcurrency ?? 1
      : normalizeConcurrency(codexImageConcurrency, 'codexImageConcurrency');
    if (poolImageConcurrency > totalConcurrency) {
      throw new RangeError('codexImageConcurrency cannot exceed codexTotalConcurrency');
    }
    const result = await this.pool.query(`
      WITH pool AS (
        INSERT INTO codex_concurrency_pools(id, total_concurrency, image_concurrency)
        VALUES ($6, $7, $8)
        ON CONFLICT(id) DO UPDATE SET
          total_concurrency = excluded.total_concurrency,
          image_concurrency = excluded.image_concurrency,
          updated_at = now()
        WHERE (codex_concurrency_pools.total_concurrency, codex_concurrency_pools.image_concurrency)
            = (excluded.total_concurrency, excluded.image_concurrency)
          OR NOT EXISTS (
            SELECT 1 FROM task_executions AS running
            JOIN executor_nodes AS owner ON owner.id = running.node_id
            WHERE owner.codex_pool_id = excluded.id AND running.status = 'RUNNING'
          )
        RETURNING *
      )
      INSERT INTO executor_nodes(id, name, image_worker_enabled, copy_concurrency, image_concurrency,
        codex_pool_id, image_edit_executor_version, copy_image_plan_regeneration_version)
      SELECT $1, $2, $3, COALESCE($4, 1), COALESCE($5, 1), pool.id, $9, $10 FROM pool
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        image_worker_enabled = excluded.image_worker_enabled,
        copy_concurrency = COALESCE($4, executor_nodes.copy_concurrency),
        image_concurrency = COALESCE($5, executor_nodes.image_concurrency),
        codex_pool_id = excluded.codex_pool_id,
        image_edit_executor_version = excluded.image_edit_executor_version,
        copy_image_plan_regeneration_version = excluded.copy_image_plan_regeneration_version,
        retired_at = NULL,
        last_seen_at = now(),
        updated_at = now()
      RETURNING *,
        (SELECT total_concurrency FROM pool) AS codex_total_concurrency,
        (SELECT image_concurrency FROM pool) AS codex_image_concurrency
    `, [nodeId, name, imageWorkerEnabled, copyConcurrency ?? null, imageConcurrency ?? null,
      codexPoolId, totalConcurrency, poolImageConcurrency, imageEditExecutorVersion,
      copyImagePlanRegenerationVersion]);
    if (!result.rows[0]) {
      throw new ControlPlaneConflictError(
        'CODEX_POOL_CONCURRENCY_MISMATCH',
        '共享 Codex 并发池仍有运行任务，所有共用该池的执行机必须使用一致的并发配置',
      );
    }
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      imageWorkerEnabled: row.image_worker_enabled,
      imageEditExecutorVersion: Number(row.image_edit_executor_version ?? 0),
      copyImagePlanRegenerationVersion: Number(row.copy_image_plan_regeneration_version ?? 0),
      copyConcurrency: row.copy_concurrency ?? 1,
      imageConcurrency: row.image_concurrency ?? 1,
      lastSeenAt: row.last_seen_at,
    };
  }

  async listNodes({ includeRunningImageEdits = false } = {}) {
    const result = await this.pool.query(`
      WITH task_counts AS MATERIALIZED (
        SELECT copy_executor_node_id AS node_id,
          COUNT(*) FILTER (WHERE state = 'COPY_QUEUED') AS copy_queued_count
        FROM tasks WHERE copy_executor_node_id IS NOT NULL
        GROUP BY copy_executor_node_id
      ), execution_counts AS MATERIALIZED (
        SELECT e.node_id,
          COUNT(*) FILTER (WHERE e.kind = 'COPY' AND e.status = 'RUNNING') AS copy_running_count,
          COUNT(*) FILTER (WHERE e.kind = 'IMAGE' AND e.status = 'RUNNING') AS image_running_count,
          COUNT(*) FILTER (WHERE e.kind = 'IMAGE' AND e.status = 'RUNNING'
            AND e.snapshot ? 'imageEditRequestId') AS image_edit_running_count,
          COALESCE(jsonb_agg(jsonb_build_object(
            'executionId', e.id, 'taskId', e.task_id,
            'progressMessage', e.progress_message, 'startedAt', e.started_at
          ) ORDER BY e.started_at, e.id) FILTER (WHERE e.kind = 'IMAGE'
            AND e.snapshot ? 'imageEditRequestId'), '[]'::jsonb) AS running_image_edits
        FROM task_executions e
        WHERE e.status = 'RUNNING'
        GROUP BY e.node_id
      ), pool_counts AS MATERIALIZED (
        SELECT owner.codex_pool_id, COUNT(*) AS codex_running_count
        FROM task_executions e
        JOIN executor_nodes owner ON owner.id = e.node_id
        WHERE e.status = 'RUNNING' AND owner.codex_pool_id IS NOT NULL
        GROUP BY owner.codex_pool_id
      )
      SELECT
        n.*,
        pool.total_concurrency AS codex_total_concurrency,
        pool.image_concurrency AS codex_image_concurrency,
        COALESCE(pool_count.codex_running_count, 0) AS codex_running_count,
        n.last_seen_at >= now() - interval '90 seconds' AS online,
        COALESCE(task_count.copy_queued_count, 0) AS copy_queued_count,
        COALESCE(execution_count.copy_running_count, 0) AS copy_running_count,
        COALESCE(execution_count.image_running_count, 0) AS image_running_count,
        COALESCE(execution_count.image_edit_running_count, 0) AS image_edit_running_count,
        COALESCE(execution_count.running_image_edits, '[]'::jsonb) AS running_image_edits
      FROM executor_nodes n
      LEFT JOIN codex_concurrency_pools pool ON pool.id = n.codex_pool_id
      LEFT JOIN task_counts task_count ON task_count.node_id = n.id
      LEFT JOIN execution_counts execution_count ON execution_count.node_id = n.id
      LEFT JOIN pool_counts pool_count ON pool_count.codex_pool_id = n.codex_pool_id
      WHERE n.retired_at IS NULL
      ORDER BY online DESC, n.name, n.id
    `);
    return result.rows.map(row => nodeFrom(row, { includeRunningImageEdits }));
  }

  async retireNode(rawNodeId, rawActor) {
    const nodeId = normalizeNodeId(rawNodeId);
    return transaction(this.pool, async (client) => {
      const { actor } = await lockCurrentActor(client, rawActor);
      if (actor.role !== 'ADMIN') {
        throw new ControlPlaneAuthorizationError('current role cannot perform this operation');
      }
      const currentResult = await client.query(`
        SELECT *, last_seen_at >= now() - interval '90 seconds' AS online
        FROM executor_nodes
        WHERE id = $1 AND retired_at IS NULL
        FOR UPDATE
      `, [nodeId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('executor node not found');
      if (current.online) {
        throw new ControlPlaneConflictError(
          'EXECUTOR_STILL_ONLINE',
          '执行机仍在线，请先停止执行机并等待状态变为离线后再删除',
        );
      }
      // The node-row lock serializes new claims. Keep this as a plain read because
      // progress updates lock executions before touching the node heartbeat.
      const running = await client.query(`
        SELECT id
        FROM task_executions
        WHERE node_id = $1 AND status = 'RUNNING'
        ORDER BY started_at
        LIMIT 1
      `, [nodeId]);
      if (running.rows[0]) {
        throw new ControlPlaneConflictError(
          'EXECUTOR_HAS_RUNNING_TASKS',
          '执行机仍有关联的运行中任务，请先处理任务后再删除',
        );
      }
      const result = await client.query(`
        UPDATE executor_nodes
        SET retired_at = now(), updated_at = now()
        WHERE id = $1 AND retired_at IS NULL
        RETURNING id, name, retired_at
      `, [nodeId]);
      if (!result.rows[0]) throw new ControlPlaneNotFoundError('executor node not found');
      return {
        id: result.rows[0].id,
        name: result.rows[0].name,
        retiredAt: result.rows[0].retired_at,
      };
    });
  }

  async retireXhsQuerySearchNode(rawNodeId, rawActor) {
    const nodeId = normalizeNodeId(rawNodeId);
    return transaction(this.pool, async (client) => {
      const { actor } = await lockCurrentActor(client, rawActor);
      if (actor.role !== 'ADMIN') {
        throw new ControlPlaneAuthorizationError('current role cannot perform this operation');
      }
      const currentResult = await client.query(`
        SELECT *, last_seen_at >= now() - interval '90 seconds' AS online
        FROM xhs_query_search_nodes
        WHERE id = $1 AND retired_at IS NULL
        FOR UPDATE
      `, [nodeId]);
      const current = currentResult.rows[0];
      if (!current) throw new ControlPlaneNotFoundError('Xiaohongshu search node not found');
      if (current.online) {
        throw new ControlPlaneConflictError(
          'XHS_SEARCH_NODE_STILL_ONLINE',
          '小红书搜索节点仍在线，请先停止搜索进程并等待状态变为离线后再移除',
        );
      }
      const running = await client.query(`
        SELECT id
        FROM xhs_query_search_jobs
        WHERE claimed_by_node_id = $1 AND status = 'RUNNING'
        ORDER BY id
        LIMIT 1
      `, [nodeId]);
      if (running.rows[0]) {
        throw new ControlPlaneConflictError(
          'XHS_SEARCH_NODE_HAS_RUNNING_TASK',
          '小红书搜索节点仍有关联的运行中任务，请先处理任务后再移除',
        );
      }
      const result = await client.query(`
        UPDATE xhs_query_search_nodes
        SET retired_at = now(), updated_at = now()
        WHERE id = $1 AND retired_at IS NULL
        RETURNING id, name, retired_at
      `, [nodeId]);
      if (!result.rows[0]) throw new ControlPlaneNotFoundError('Xiaohongshu search node not found');
      return {
        id: result.rows[0].id,
        name: result.rows[0].name,
        retiredAt: result.rows[0].retired_at,
      };
    });
  }
}
