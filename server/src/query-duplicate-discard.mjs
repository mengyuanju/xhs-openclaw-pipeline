import { createHash } from 'node:crypto';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
} from './domain.mjs';
import { normalizeTaskQueryIdentity, taskQueryIdentitySql } from './task-query-identity.mjs';

const PREVIEW_VERSION = 1;
const MAX_REPRESENTATIVE_TASKS = 100;
const MAX_MATCHING_TASKS = 1_000;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;

export const DUPLICATE_QUERY_SKIP_REASONS = Object.freeze({
  DIFFERENT_BUSINESS_CONTEXT: 'DIFFERENT_BUSINESS_CONTEXT',
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  NOT_PRISTINE_COPY_QUEUED: 'NOT_PRISTINE_COPY_QUEUED',
});

function jsonReady(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonReady);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonReady(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(jsonReady(value));
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function nullableId(value) {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeRepresentativeTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REPRESENTATIVE_TASKS) {
    throw new RangeError(`representativeTaskIds must contain between 1 and ${MAX_REPRESENTATIVE_TASKS} items`);
  }
  const ids = value.map((entry) => {
    if (typeof entry !== 'number') throw new TypeError('representativeTaskIds must contain numbers');
    return normalizeTaskId(entry);
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('representativeTaskIds must be unique');
  }
  return ids.toSorted((left, right) => left - right);
}

function normalizeActor(rawActor) {
  if (!rawActor || typeof rawActor !== 'object' || Array.isArray(rawActor)) {
    throw new TypeError('authenticated actor is required');
  }
  const userId = normalizeTaskId(rawActor.userId);
  const username = String(rawActor.username ?? '').trim().toLowerCase();
  const credentialVersion = Number(rawActor.credentialVersion);
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/u.test(username)) {
    throw new TypeError('actor username is invalid');
  }
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new TypeError('actor credentialVersion must be a positive integer');
  }
  if (rawActor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('only administrators can discard duplicate Query tasks');
  }
  return { userId, username, role: 'ADMIN', credentialVersion };
}

async function lockActiveAdministrator(client, actor) {
  const active = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = 'ADMIN'
      AND status = 'ACTIVE' AND credential_version = $3
    FOR SHARE
  `, [actor.userId, actor.username, actor.credentialVersion]);
  if (!active.rows[0]) throw new ControlPlaneAuthenticationError();
}

async function withTransaction(pool, action) {
  const client = await pool.connect();
  try {
    // The lock/re-read protocol below relies on each statement receiving a
    // fresh snapshot after it has waited for earlier row locks. Pin the
    // isolation level instead of inheriting an operator-defined session
    // default that could silently invalidate that safety property.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['40001', '40P01'].includes(error?.code)) {
      throw new ControlPlaneConflictError(
        'DUPLICATE_QUERY_PREVIEW_STALE',
        '重复 Query 任务已发生变化，请重新预览后再确认',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

function taskSummary(row) {
  return {
    id: Number(row.id),
    query: row.query,
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    createdByUserId: row.created_by_user_id ?? null,
    assignedToUserId: row.assigned_to_user_id ?? null,
    sourceQueryPackageName: row.source_query_package_name ?? null,
  };
}

function businessContext(row) {
  const taskId = Number(row.id);
  const creatorAccountId = nullableId(row.creator_account_id);
  const assigneeAccountId = nullableId(row.assignee_account_id);
  return {
    // node-postgres parses jsonb through JSON.parse, which rounds integers
    // above Number.MAX_SAFE_INTEGER. Prefer PostgreSQL's canonical jsonb text
    // so distinct task inputs can never collapse through JavaScript numbers.
    inputCanonicalJson: typeof row.input_canonical_json === 'string'
      ? row.input_canonical_json
      : canonicalJson(row.input ?? {}),
    requestedImageCount: String(row.requested_image_count ?? 'auto'),
    aiDisclosureEnabled: row.ai_disclosure_enabled !== false,
    skipCopyReview: row.skip_copy_review === true,
    mandatoryCopyQc: row.mandatory_copy_qc === true,
    mandatoryCopyQcOrigin: row.mandatory_copy_qc_origin ?? null,
    createdByNodeId: row.created_by_node_id ?? null,
    copyExecutorNodeId: row.copy_executor_node_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    // A missing creator ID cannot prove that two same-name historical users
    // are the same account. Make that context task-local (fail closed).
    createdByAccountId: creatorAccountId ?? `UNRESOLVED_TASK_${taskId}`,
    assignedToUserId: row.assigned_to_user_id ?? null,
    // NULL/NULL is a real unassigned state. A username without its stable
    // account ID is ambiguous and therefore must not compare across tasks.
    assignedToAccountId: row.assigned_to_user_id == null
      ? null
      : assigneeAccountId ?? `UNRESOLVED_TASK_${taskId}`,
    assignmentSource: row.assignment_source ?? null,
    sourceQueryPackageId: nullableId(row.source_query_package_id),
    sourceQueryPackageItemId: nullableId(row.source_query_package_item_id),
    sourceQueryPackageName: row.source_query_package_name ?? null,
    sourceQueryPackageExternalId: row.source_query_package_external_id ?? null,
    productionBatchId: nullableId(row.production_batch_id),
  };
}

function pristineTaskSql(alias) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw new TypeError('task alias is invalid');
  return `(
    ${alias}.state = 'COPY_QUEUED'
    AND ${alias}.cancelled_from_state IS NULL
    AND (${alias}.current_stage IS NULL OR ${alias}.current_stage = 'COPY_QUEUED')
    AND ${alias}.progress_percent = 0
    AND ${alias}.current_execution_id IS NULL
    AND ${alias}.current_copy_revision_id IS NULL
    AND ${alias}.current_image_run_id IS NULL
    AND ${alias}.pending_snapshot IS NULL
    AND ${alias}.execution_started_at IS NULL
    AND ${alias}.finished_at IS NULL
    AND ${alias}.error IS NULL
    AND ${alias}.image_reviewed_at IS NULL
    AND ${alias}.image_reviewed_by_user_id IS NULL
    AND ${alias}.production_batch_id IS NULL
    AND ${alias}.mandatory_copy_qc = false
    AND ${alias}.mandatory_copy_qc_origin IS NULL
    AND NOT EXISTS (SELECT 1 FROM task_executions execution WHERE execution.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM copy_revisions revision WHERE revision.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM image_runs image_run WHERE image_run.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM assets asset WHERE asset.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM delivery_entries delivery WHERE delivery.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM human_quality_assessments quality WHERE quality.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM copy_approval_events approval WHERE approval.task_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM copy_sampling_items sample WHERE sample.task_id = ${alias}.id)
    AND NOT EXISTS (
      SELECT 1 FROM xhs_query_search_jobs search
      WHERE search.task_id = ${alias}.id AND search.status = 'SUCCEEDED'
    )
  )`;
}

function contextFingerprint(row) {
  return sha256(businessContext(row));
}

function isPristine(row) {
  // Cancelling the last blocker in a production batch can freeze or release
  // that batch. Because requeue cannot safely reopen the frozen sample, batch
  // members are never eligible for this recoverable cleanup action.
  if (row.production_batch_id != null || row.mandatory_copy_qc === true) return false;
  if (row.pristine !== undefined) return row.pristine === true;
  return row.state === 'COPY_QUEUED'
    && row.current_execution_id == null
    && row.current_copy_revision_id == null
    && row.current_image_run_id == null
    && row.pending_snapshot == null
    && Number(row.execution_count ?? 0) === 0
    && Number(row.copy_revision_count ?? 0) === 0
    && Number(row.image_run_count ?? 0) === 0
    && Number(row.asset_count ?? 0) === 0
    && Number(row.delivery_entry_count ?? 0) === 0;
}

function queryIdentity(row) {
  return row.query_identity ?? normalizeTaskQueryIdentity(row.query);
}

function skippedTask(row, reasonCode) {
  return { ...taskSummary(row), reasonCode };
}

// Pure planning is exported so the safety policy can be unit-tested without a
// database. Database callers still derive every field from locked rows.
export function buildDuplicateQueryDiscardPlan(rows, representativeTaskIds) {
  const representativesById = new Map(rows.map((row) => [Number(row.id), row]));
  const missing = representativeTaskIds.filter((id) => !representativesById.has(id));
  if (missing.length) {
    throw new ControlPlaneNotFoundError(`representative task not found: ${missing.join(', ')}`);
  }

  const rowsByIdentity = new Map();
  for (const row of rows.toSorted((left, right) => Number(left.id) - Number(right.id))) {
    const identity = queryIdentity(row);
    if (!rowsByIdentity.has(identity)) rowsByIdentity.set(identity, []);
    rowsByIdentity.get(identity).push(row);
  }

  // The normal UI supplies one representative per DISTINCT query. Collapse a
  // repeated identical context defensively, while allowing explicitly selected
  // different contexts to be previewed as separate, non-overlapping groups.
  const anchors = [];
  const anchorKeys = new Set();
  for (const id of representativeTaskIds) {
    const representative = representativesById.get(id);
    const identity = queryIdentity(representative);
    const fingerprint = contextFingerprint(representative);
    const key = `${identity}\u0000${fingerprint}`;
    if (!anchorKeys.has(key)) {
      anchorKeys.add(key);
      anchors.push({ representative, identity, fingerprint });
    }
  }

  const groups = anchors.filter(({ identity }) => (rowsByIdentity.get(identity)?.length ?? 0) >= 2)
    .map(({ representative, identity, fingerprint }) => {
      const matchingQuery = rowsByIdentity.get(identity) ?? [];
      const matchingContext = matchingQuery.filter((row) => contextFingerprint(row) === fingerprint);
      const progressed = matchingContext.filter((row) => row.state !== 'CANCELLED' && !isPristine(row));
      const pristine = matchingContext.filter((row) => isPristine(row));
      const keeperRow = (progressed.length ? progressed : pristine)[0] ?? null;
      const keeperId = keeperRow === null ? null : Number(keeperRow.id);
      const discardable = matchingContext
        .filter((row) => isPristine(row) && Number(row.id) !== keeperId)
        .map(taskSummary);
      const skipped = matchingQuery.flatMap((row) => {
        if (contextFingerprint(row) !== fingerprint) {
          return [skippedTask(row, DUPLICATE_QUERY_SKIP_REASONS.DIFFERENT_BUSINESS_CONTEXT)];
        }
        if (Number(row.id) === keeperId) return [];
        if (isPristine(row)) return [];
        if (row.state === 'CANCELLED') {
          return [skippedTask(row, DUPLICATE_QUERY_SKIP_REASONS.ALREADY_CANCELLED)];
        }
        return [skippedTask(row, DUPLICATE_QUERY_SKIP_REASONS.NOT_PRISTINE_COPY_QUEUED)];
      });
      return {
        query: representative.query,
        keeper: keeperRow === null ? null : taskSummary(keeperRow),
        discardable,
        skipped,
      };
    });

  const summary = {
    queryGroupCount: groups.length,
    discardableCount: groups.reduce((total, group) => total + group.discardable.length, 0),
    skippedCount: groups.reduce((total, group) => total + group.skipped.length, 0),
  };
  const preview = { version: PREVIEW_VERSION, representativeTaskIds, groups, summary };
  // A selected Query with no duplicate intentionally has no visible group. It
  // still participates in this opaque fingerprint, so a duplicate inserted
  // after preview makes confirmation stale instead of being silently ignored.
  const observed = anchors.map(({ identity, fingerprint }) => ({
    identity,
    representativeContextFingerprint: fingerprint,
    tasks: (rowsByIdentity.get(identity) ?? []).map((task) => ({
      ...taskSummary(task),
      contextFingerprint: contextFingerprint(task),
      pristine: isPristine(task),
    })),
  }));
  return { ...preview, previewFingerprint: sha256({ preview, observed }) };
}

function duplicateRowsSql() {
  const identity = taskQueryIdentitySql('task.query');
  const representativeIdentity = taskQueryIdentitySql('representative.query');
  return `
    WITH selected_identities AS MATERIALIZED (
      SELECT DISTINCT ${representativeIdentity} AS query_identity
      FROM tasks AS representative
      WHERE representative.id = ANY($1::bigint[])
    )
    SELECT task.*,
      task.input::text AS input_canonical_json,
      ${identity} AS query_identity,
      creator.id AS creator_account_id,
      assignee.id AS assignee_account_id,
      ${pristineTaskSql('task')} AS pristine
    FROM tasks AS task
    JOIN selected_identities AS selected
      ON selected.query_identity = ${identity}
    LEFT JOIN app_users AS creator ON creator.username = task.created_by_user_id
      AND creator.created_at < task.created_at
    LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
      AND assignee.created_at < task.assigned_at
    ORDER BY task.id
    LIMIT $2
  `;
}

async function readDuplicateRows(client, representativeTaskIds) {
  const result = await client.query(duplicateRowsSql(), [
    representativeTaskIds,
    MAX_MATCHING_TASKS + 1,
  ]);
  if (result.rows.length > MAX_MATCHING_TASKS) {
    throw new ControlPlaneConflictError(
      'DUPLICATE_QUERY_SCOPE_TOO_LARGE',
      `匹配任务超过 ${MAX_MATCHING_TASKS} 条，请缩小每次处理范围`,
    );
  }
  return result.rows;
}

async function lockMatchingTasks(client, representativeTaskIds) {
  const identity = taskQueryIdentitySql('task.query');
  const representativeIdentity = taskQueryIdentitySql('representative.query');
  const result = await client.query(`
    WITH selected_identities AS MATERIALIZED (
      SELECT DISTINCT ${representativeIdentity} AS query_identity
      FROM tasks AS representative
      WHERE representative.id = ANY($1::bigint[])
    )
    SELECT task.id
    FROM tasks AS task
    JOIN selected_identities AS selected
      ON selected.query_identity = ${identity}
    ORDER BY task.id
    LIMIT $2
    FOR UPDATE OF task
  `, [representativeTaskIds, MAX_MATCHING_TASKS + 1]);
  if (result.rows.length > MAX_MATCHING_TASKS) {
    throw new ControlPlaneConflictError(
      'DUPLICATE_QUERY_SCOPE_TOO_LARGE',
      `匹配任务超过 ${MAX_MATCHING_TASKS} 条，请分拆或人工处理`,
    );
  }
  return result.rows.map((row) => Number(row.id));
}

async function lockLinkedSearchJobs(client, taskIds) {
  if (!taskIds.length) return;
  await client.query(`
    SELECT search.id
    FROM xhs_query_search_jobs AS search
    WHERE search.task_id = ANY($1::bigint[])
    ORDER BY search.task_id, search.id
    FOR UPDATE OF search
  `, [taskIds]);
}

function normalizedPreviewInput(input) {
  return { representativeTaskIds: normalizeRepresentativeTaskIds(input?.representativeTaskIds) };
}

export async function previewDuplicateQueryDiscard(pool, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const { representativeTaskIds } = normalizedPreviewInput(input);
  return withTransaction(pool, async (client) => {
    await lockActiveAdministrator(client, actor);
    const rows = await readDuplicateRows(client, representativeTaskIds);
    return buildDuplicateQueryDiscardPlan(rows, representativeTaskIds);
  });
}

function normalizedCommitInput(input) {
  const representativeTaskIds = normalizeRepresentativeTaskIds(input?.representativeTaskIds);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const previewFingerprint = String(input?.previewFingerprint ?? '').trim().toLowerCase();
  if (!HEX_SHA256.test(previewFingerprint)) {
    throw new TypeError('previewFingerprint must be a SHA-256 hex digest');
  }
  if (!Number.isSafeInteger(input?.confirmedDiscardCount) || input.confirmedDiscardCount < 0) {
    throw new TypeError('confirmedDiscardCount must be a non-negative integer');
  }
  return { requestId, representativeTaskIds, previewFingerprint,
    confirmedDiscardCount: input.confirmedDiscardCount };
}

async function lockMutationRequest(client, actor, requestId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `duplicate-query-discard:${actor.userId}`,
    requestId,
  ]);
}

async function replayMutation(client, actor, request, requestFingerprint) {
  const result = await client.query(`
    SELECT request_fingerprint, response
    FROM task_duplicate_query_discard_requests
    WHERE actor_account_id = $1 AND request_id = $2
  `, [actor.userId, request.requestId]);
  const receipt = result.rows[0];
  if (!receipt) return null;
  if (receipt.request_fingerprint !== requestFingerprint) {
    throw new ControlPlaneConflictError('REQUEST_ID_CONFLICT', 'requestId 已用于其他重复 Query 废弃操作');
  }
  return receipt.response;
}

function mutationMapping(plan, rows) {
  const rowById = new Map(rows.map((row) => [Number(row.id), row]));
  return plan.groups.flatMap((group) => group.discardable.map((task) => ({
    discardedTaskId: task.id,
    keeperTaskId: group.keeper.id,
    businessContextFingerprint: contextFingerprint(rowById.get(task.id)),
  }))).toSorted((left, right) => left.discardedTaskId - right.discardedTaskId);
}

async function cancelTasks(client, mapping) {
  if (!mapping.length) return;
  const updated = await client.query(`
    WITH discard_plan AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS planned(
        discarded_task_id bigint,
        keeper_task_id bigint
      )
    )
    UPDATE tasks AS task SET
      state = 'CANCELLED',
      cancelled_from_state = 'COPY_QUEUED',
      current_execution_id = NULL,
      current_stage = 'CANCELLED',
      progress_message = '重复 Query 已废弃；保留任务 #' || discard_plan.keeper_task_id,
      last_activity_at = now(),
      finished_at = now(),
      updated_at = now()
    FROM discard_plan
    WHERE task.id = discard_plan.discarded_task_id
      AND ${pristineTaskSql('task')}
    RETURNING task.id
  `, [JSON.stringify(mapping.map((entry) => ({
    discarded_task_id: entry.discardedTaskId,
    keeper_task_id: entry.keeperTaskId,
  })))]);
  if (updated.rows.length !== mapping.length) {
    throw new ControlPlaneConflictError(
      'DUPLICATE_QUERY_PREVIEW_STALE',
      '重复 Query 任务已发生变化，请重新预览后再确认',
    );
  }
}

async function cancelLinkedSearches(client, discardedTaskIds) {
  if (!discardedTaskIds.length) return;
  await client.query(`
    UPDATE xhs_query_search_jobs SET
      status = 'CANCELLED',
      claimed_by_node_id = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      retry_after = NULL,
      blocked_reason = NULL,
      error = '关联任务因重复 Query 被废弃',
      updated_at = now()
    WHERE task_id = ANY($1::bigint[])
      AND status <> 'SUCCEEDED'
  `, [discardedTaskIds]);
}

async function saveAudit(client, actor, request, mapping) {
  if (!mapping.length) return;
  await client.query(`
    INSERT INTO task_duplicate_query_discard_audits(
      discarded_task_id, keeper_task_id, actor_account_id, actor_username,
      request_id, preview_fingerprint, business_context_fingerprint, reason
    )
    SELECT audit.discarded_task_id, audit.keeper_task_id, $2, $3, $4, $5,
      audit.business_context_fingerprint, 'DUPLICATE_QUERY'
    FROM jsonb_to_recordset($1::jsonb) AS audit(
      discarded_task_id bigint,
      keeper_task_id bigint,
      business_context_fingerprint char(64)
    )
    ORDER BY audit.discarded_task_id
  `, [JSON.stringify(mapping.map((entry) => ({
    discarded_task_id: entry.discardedTaskId,
    keeper_task_id: entry.keeperTaskId,
    business_context_fingerprint: entry.businessContextFingerprint,
  }))), actor.userId, actor.username, request.requestId, request.previewFingerprint]);
}

async function saveReceipt(client, actor, request, requestFingerprint, response) {
  await client.query(`
    INSERT INTO task_duplicate_query_discard_requests(
      actor_account_id, actor_username, request_id, request_fingerprint,
      representative_task_ids, preview_fingerprint, confirmed_discard_count, response
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [actor.userId, actor.username, request.requestId, requestFingerprint,
    request.representativeTaskIds, request.previewFingerprint,
    request.confirmedDiscardCount, response]);
}

export async function discardDuplicateQueries(pool, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const request = normalizedCommitInput(input);
  const requestFingerprint = sha256({
    version: PREVIEW_VERSION,
    representativeTaskIds: request.representativeTaskIds,
    previewFingerprint: request.previewFingerprint,
    confirmedDiscardCount: request.confirmedDiscardCount,
  });
  return withTransaction(pool, async (client) => {
    await lockActiveAdministrator(client, actor);
    await lockMutationRequest(client, actor, request.requestId);
    const replay = await replayMutation(client, actor, request, requestFingerprint);
    if (replay !== null) return replay;

    // Phase one only discovers and locks task IDs. Do not decide whether a task
    // is pristine from this statement: it may have waited for a concurrent
    // task lock while retaining an older READ COMMITTED statement snapshot.
    const lockedTaskIds = await lockMatchingTasks(client, request.representativeTaskIds);
    await lockLinkedSearchJobs(client, lockedTaskIds);
    // Phase two uses a new statement snapshot after every relevant task and
    // search job is locked, then re-reads child artifacts and business context.
    const rows = await readDuplicateRows(client, request.representativeTaskIds);
    if (lockedTaskIds.length !== rows.length
        || lockedTaskIds.some((id, index) => id !== Number(rows[index]?.id))) {
      throw new ControlPlaneConflictError(
        'DUPLICATE_QUERY_PREVIEW_STALE',
        '重复 Query 任务已发生变化，请重新预览后再确认',
      );
    }
    let plan;
    try {
      plan = buildDuplicateQueryDiscardPlan(rows, request.representativeTaskIds);
    } catch (error) {
      if (!(error instanceof ControlPlaneNotFoundError)) throw error;
      throw new ControlPlaneConflictError(
        'DUPLICATE_QUERY_PREVIEW_STALE',
        '重复 Query 任务已发生变化，请重新预览后再确认',
      );
    }
    if (plan.previewFingerprint !== request.previewFingerprint
        || plan.summary.discardableCount !== request.confirmedDiscardCount) {
      throw new ControlPlaneConflictError(
        'DUPLICATE_QUERY_PREVIEW_STALE',
        '重复 Query 任务已发生变化，请重新预览后再确认',
      );
    }

    const mapping = mutationMapping(plan, rows);
    const discardedTaskIds = mapping.map((entry) => entry.discardedTaskId);
    const keeperTaskIds = [...new Set(mapping.map((entry) => entry.keeperTaskId))]
      .toSorted((left, right) => left - right);
    await cancelTasks(client, mapping);
    await cancelLinkedSearches(client, discardedTaskIds);
    await saveAudit(client, actor, request, mapping);

    const response = {
      requestId: request.requestId,
      discardedTaskIds,
      keeperTaskIds,
      discardedCount: discardedTaskIds.length,
      skippedCount: plan.summary.skippedCount,
    };
    await saveReceipt(client, actor, request, requestFingerprint, response);
    return response;
  });
}
