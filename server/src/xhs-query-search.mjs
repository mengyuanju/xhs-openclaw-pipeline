import { randomUUID } from 'node:crypto';

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeNodeId,
  normalizeNodeName,
  normalizeTaskId,
  normalizeUuid,
  redactExecutionError,
} from './domain.mjs';
import {
  XIAOHONGSHU_BLOCK_REASONS,
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
  normalizeXiaohongshuLinks,
  normalizeXiaohongshuSearchSettings,
} from '../../src/xhs-query-search.mjs';

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;

function normalizeBoolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function jobFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    queryPackageItemId: row.query_package_item_id === null || row.query_package_item_id === undefined
      ? null : Number(row.query_package_item_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : Number(row.task_id),
    query: row.query_snapshot,
    status: row.status,
    attempt: Number(row.attempt_count),
    nodeId: row.claimed_by_node_id ?? null,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    blockedReason: row.blocked_reason ?? null,
    resultLimit: Number(row.result_limit),
    resultCount: Number(row.result_count ?? 0),
    searchedAt: row.searched_at ?? null,
    updatedAt: row.updated_at,
  };
}

async function withTransaction(pool, action) {
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

async function lockActiveJob(client, rawJobId, rawLeaseToken) {
  const jobId = normalizeTaskId(rawJobId);
  const leaseToken = normalizeUuid(rawLeaseToken, 'leaseToken');
  const result = await client.query(`
    SELECT job.*, job.lease_expires_at > now() AS lease_active,
      (
        task.id IS NOT NULL
        OR (
          item.screening_decision = 'SELECTED'
          AND item.status IN ('READY', 'TASK_CREATED')
          AND package.status <> 'ABANDONED'
        )
      ) AS source_active
    FROM xhs_query_search_jobs AS job
    LEFT JOIN query_package_items AS item ON item.id = job.query_package_item_id
    LEFT JOIN query_packages AS package ON package.id = item.query_package_id
    LEFT JOIN tasks AS task ON task.id = job.task_id
    WHERE job.id = $1
    FOR UPDATE OF job
  `, [jobId]);
  const job = result.rows[0];
  if (!job) throw new ControlPlaneNotFoundError('小红书 Query 搜索任务不存在');
  if (job.status !== 'RUNNING' || job.lease_token !== leaseToken
      || job.source_active !== true
      || job.lease_active !== true) {
    throw new ControlPlaneConflictError('STALE_XHS_SEARCH_LEASE', '小红书 Query 搜索任务已取消、过期或被其他执行机接管');
  }
  return job;
}

export async function claimXhsQuerySearch(pool, input) {
  if (input?.protocolVersion !== XIAOHONGSHU_SEARCH_PROTOCOL_VERSION) {
    throw new TypeError(`protocolVersion must be ${XIAOHONGSHU_SEARCH_PROTOCOL_VERSION}`);
  }
  const nodeId = normalizeNodeId(input?.nodeId);
  const nodeName = normalizeNodeName(input?.nodeName, nodeId);
  return withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO xhs_query_search_nodes(id, name, last_seen_at)
      VALUES ($1, $2, now())
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, last_seen_at = now(), updated_at = now()
    `, [nodeId, nodeName]);
    const node = await client.query(`
      SELECT id FROM xhs_query_search_nodes WHERE id = $1 FOR UPDATE
    `, [nodeId]);
    if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
    await client.query('SELECT pg_advisory_xact_lock(8821, 4107)');
    await client.query(`
      UPDATE xhs_query_search_jobs
      SET status = CASE WHEN attempt_count >= $1 THEN 'FAILED' ELSE 'PENDING' END,
        claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        retry_after = CASE WHEN attempt_count >= $1 THEN NULL ELSE now() END,
        error = COALESCE(error, '搜索租约超时，结果未确认'), updated_at = now()
      WHERE status = 'RUNNING' AND lease_expires_at <= now()
    `, [MAX_ATTEMPTS]);
    const blockedOrRunning = await client.query(`
      SELECT id FROM xhs_query_search_jobs
      WHERE status = 'RUNNING' OR status = 'BLOCKED'
      ORDER BY id LIMIT 1
    `);
    if (blockedOrRunning.rows[0]) return null;
    const candidate = await client.query(`
      SELECT job.id
      FROM xhs_query_search_jobs AS job
      LEFT JOIN query_package_items AS item ON item.id = job.query_package_item_id
      LEFT JOIN query_packages AS package ON package.id = item.query_package_id
      LEFT JOIN tasks AS task ON task.id = job.task_id
      WHERE job.status = 'PENDING'
        AND (job.retry_after IS NULL OR job.retry_after <= now())
        AND (
          task.id IS NOT NULL
          OR (
            item.status IN ('READY', 'TASK_CREATED')
            AND item.screening_decision = 'SELECTED'
            AND package.status <> 'ABANDONED'
          )
        )
      ORDER BY job.id
      FOR UPDATE OF job SKIP LOCKED
      LIMIT 1
    `);
    if (!candidate.rows[0]) return null;
    const setting = await client.query(`
      SELECT value FROM global_settings WHERE key = $1 FOR SHARE
    `, [XIAOHONGSHU_SEARCH_SETTINGS_KEY]);
    const { resultLimit } = normalizeXiaohongshuSearchSettings(setting.rows[0]?.value ?? {});
    const leaseToken = randomUUID();
    const claimed = await client.query(`
      UPDATE xhs_query_search_jobs
      SET status = 'RUNNING', attempt_count = attempt_count + 1,
        claimed_by_node_id = $2, lease_token = $3,
        lease_expires_at = now() + ($4 * interval '1 second'),
        retry_after = NULL, blocked_reason = NULL, error = NULL,
        result_limit = $5, updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [candidate.rows[0].id, nodeId, leaseToken, LEASE_SECONDS, resultLimit]);
    return jobFrom(claimed.rows[0]);
  });
}

export async function completeXhsQuerySearch(pool, rawJobId, input) {
  const rawLinks = input?.links;
  return withTransaction(pool, async (client) => {
    const job = await lockActiveJob(client, rawJobId, input?.leaseToken);
    const { resultLimit } = normalizeXiaohongshuSearchSettings({
      resultLimit: Number(job.result_limit),
    });
    if (Array.isArray(rawLinks) && rawLinks.length > resultLimit) {
      throw new RangeError(`Xiaohongshu search may submit at most ${resultLimit} ranked links`);
    }
    const links = normalizeXiaohongshuLinks(rawLinks, {
      limit: resultLimit,
      requireAccessParameters: true,
    });
    if (links.length !== rawLinks.length) {
      throw new TypeError('Xiaohongshu search links must be unique, signed note URLs with ranked like counts');
    }
    await client.query('DELETE FROM xhs_query_links WHERE search_job_id = $1', [job.id]);
    if (links.length) {
      await client.query(`
        INSERT INTO xhs_query_links(search_job_id, note_id, url, title, rank)
        SELECT $1,
          source.link ->> 'noteId', source.link ->> 'url',
          source.link ->> 'title', (source.link ->> 'rank')::smallint
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS source(link, ordinal)
        ORDER BY source.ordinal
      `, [job.id, JSON.stringify(links)]);
    }
    const updated = await client.query(`
      UPDATE xhs_query_search_jobs
      SET status = 'SUCCEEDED', result_count = $2, searched_at = now(),
        claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        retry_after = NULL, blocked_reason = NULL, error = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [job.id, links.length]);
    return { ...jobFrom(updated.rows[0]), links };
  });
}

export async function blockXhsQuerySearch(pool, rawJobId, input) {
  const reason = String(input?.reason ?? '').toUpperCase();
  if (!XIAOHONGSHU_BLOCK_REASONS.includes(reason)) {
    throw new TypeError('reason must be LOGIN_REQUIRED or CAPTCHA_REQUIRED');
  }
  return withTransaction(pool, async (client) => {
    const job = await lockActiveJob(client, rawJobId, input?.leaseToken);
    const updated = await client.query(`
      UPDATE xhs_query_search_jobs
      SET status = 'BLOCKED', blocked_reason = $2,
        claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        retry_after = NULL, error = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [job.id, reason]);
    return jobFrom(updated.rows[0]);
  });
}

export async function failXhsQuerySearch(pool, rawJobId, input) {
  const retryable = normalizeBoolean(input?.retryable, 'retryable', true);
  const error = redactExecutionError(input?.error);
  return withTransaction(pool, async (client) => {
    const job = await lockActiveJob(client, rawJobId, input?.leaseToken);
    const retry = retryable && Number(job.attempt_count) < MAX_ATTEMPTS;
    const updated = await client.query(`
      UPDATE xhs_query_search_jobs
      SET status = $2::varchar(20), error = $3,
        claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        retry_after = CASE WHEN $2::varchar(20) = 'PENDING'
          THEN now() + interval '15 seconds' ELSE NULL END,
        blocked_reason = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [job.id, retry ? 'PENDING' : 'FAILED', error]);
    return jobFrom(updated.rows[0]);
  });
}

export async function resumeXhsQuerySearch(pool, input) {
  const nodeId = normalizeNodeId(input?.nodeId);
  const nodeName = normalizeNodeName(input?.nodeName, nodeId);
  await pool.query(`
    INSERT INTO xhs_query_search_nodes(id, name, last_seen_at)
    VALUES ($1, $2, now())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, last_seen_at = now(), updated_at = now()
  `, [nodeId, nodeName]);
  const node = await pool.query('SELECT id FROM xhs_query_search_nodes WHERE id = $1', [nodeId]);
  if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
  const result = await pool.query(`
    UPDATE xhs_query_search_jobs AS job
    SET status = 'PENDING', attempt_count = 0, claimed_by_node_id = NULL,
      lease_token = NULL, lease_expires_at = NULL, retry_after = NULL,
      blocked_reason = NULL, error = NULL, updated_at = now()
    WHERE job.status = 'BLOCKED'
      AND (
        EXISTS (
          SELECT 1
          FROM query_package_items AS item
          JOIN query_packages AS package ON package.id = item.query_package_id
          WHERE item.id = job.query_package_item_id
            AND item.screening_decision = 'SELECTED'
            AND item.status IN ('READY', 'TASK_CREATED')
            AND package.status <> 'ABANDONED'
        )
        OR EXISTS (SELECT 1 FROM tasks AS task WHERE task.id = job.task_id)
      )
    RETURNING job.id
  `);
  return { resumedCount: result.rows.length };
}

export async function retryFailedXhsQuerySearch(pool, input = {}) {
  const jobId = input.jobId === undefined || input.jobId === null
    ? null : normalizeTaskId(input.jobId);
  const taskId = input.taskId === undefined || input.taskId === null
    ? null : normalizeTaskId(input.taskId);
  if ((jobId === null) === (taskId === null)) {
    throw new TypeError('exactly one of jobId or taskId is required');
  }
  const result = await pool.query(`
    UPDATE xhs_query_search_jobs AS job
    SET status = 'PENDING', attempt_count = 0, claimed_by_node_id = NULL,
      lease_token = NULL, lease_expires_at = NULL, retry_after = NULL,
      blocked_reason = NULL, error = NULL, result_count = 0, searched_at = NULL,
      updated_at = now()
    WHERE job.status = 'FAILED'
      AND ($1::bigint IS NULL OR job.id = $1)
      AND ($2::bigint IS NULL OR job.task_id = $2)
      AND (
        EXISTS (
          SELECT 1
          FROM query_package_items AS item
          JOIN query_packages AS package ON package.id = item.query_package_id
          WHERE item.id = job.query_package_item_id
            AND item.screening_decision = 'SELECTED'
            AND item.status IN ('READY', 'TASK_CREATED')
            AND package.status <> 'ABANDONED'
        )
        OR EXISTS (SELECT 1 FROM tasks AS task WHERE task.id = job.task_id)
      )
    RETURNING job.id
  `, [jobId, taskId]);
  return { retriedCount: result.rows.length };
}
