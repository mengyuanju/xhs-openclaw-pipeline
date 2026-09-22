import { priorityOrderSql, priorityFrom } from './task-priority.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_COPY_QA_REASON_CODES } from '../../src/copy-qa-reasons.mjs';
import { resolveCopyQaReasonSnapshots } from './copy-qa-reason-tags.mjs';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
} from './domain.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { selectStratifiedCopySample } from './stratified-copy-sampling.mjs';
import { planCopyQualityChunk } from './copy-quality-flow.mjs';
import { resolveEffectiveCopySamplingPolicy } from '../../src/copy-sampling-policy.mjs';
import {
  assertReviewerBatchReturnAllowed,
  lockWorkflowQualitySettings,
  readWorkflowQualitySettings,
} from './workflow-quality-settings.mjs';

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clientBatchCodeForTask(task) {
  const existing=String(task?.source_client_batch_code??'').trim().toLowerCase();
  return /^[0-9a-f]{32}$/u.test(existing)?existing:randomUUID().replaceAll('-','');
}

function normalizeActor(actor, roles = ['ADMIN', 'REVIEWER', 'USER']) {
  if (!actor || !roles.includes(actor.role) || !Number.isSafeInteger(Number(actor.userId))) {
    throw new ControlPlaneAuthorizationError('current role cannot perform this quality operation');
  }
  return { ...actor, userId: Number(actor.userId), username: String(actor.username).toLowerCase() };
}

async function lockActiveQualityActor(client, actor) {
  const credentialVersion = Number(actor.credentialVersion);
  const result = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3 AND status = 'ACTIVE'
      AND ($4::integer IS NULL OR credential_version = $4)
      AND (role = 'ADMIN' OR copy_qc_enabled = true)
    FOR SHARE
  `, [actor.userId, actor.username, actor.role,
    Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : null]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
}

async function lockActiveCopyWorkerActor(client, actor) {
  const credentialVersion = Number(actor.credentialVersion);
  const result = await client.query(`
    SELECT id FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3 AND status = 'ACTIVE'
      AND ($4::integer IS NULL OR credential_version = $4)
      AND (role = 'ADMIN' OR copy_review_enabled = true)
    FOR SHARE
  `, [actor.userId, actor.username, actor.role,
    Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : null]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
}

async function lockQualityMutationRequest(client, actor, requestId) {
  // A receipt row does not exist on the first attempt. Serialize the immutable
  // account/request pair before any task, freeze or item lock so concurrent
  // requests with different targets cannot both mutate and race on the receipt.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))
  `, [`copy-qa:${actor.userId}`, requestId]);
}

function positiveVersion(value, name = 'expectedVersion') {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new TypeError(`${name} must be a positive integer`);
  return normalized;
}

function normalizedReasons(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_COPY_QA_REASON_CODES) {
    throw new RangeError(`reasonCodes must contain at most ${MAX_COPY_QA_REASON_CODES} items`);
  }
  const reasons = value.map((entry, index) => {
    const reason = String(entry ?? '').trim();
    if (!reason || [...reason].length > 50) throw new RangeError(`reasonCodes[${index}] is invalid`);
    return reason;
  });
  if (new Set(reasons).size !== reasons.length) throw new TypeError('reasonCodes must be unique');
  return reasons.toSorted();
}

function normalizedNote(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError('note is required');
    return null;
  }
  const note = String(value).replace(/\r\n?/gu, '\n').trim();
  if ([...note].length > 1_000) throw new RangeError('note cannot exceed 1000 characters');
  if (required && !note) throw new TypeError('note is required');
  return note || null;
}

function normalizedReturnRecommendation(value) {
  const recommendation = String(value ?? 'REWORK').trim().toUpperCase();
  if (!['REWORK', 'DISCARD'].includes(recommendation)) {
    throw new TypeError('recommendedDisposition must be REWORK or DISCARD');
  }
  return recommendation;
}

const COPY_RETURN_DISCARD_REASONS = Object.freeze([
  'QA_RECOMMENDATION',
  'UNRECOVERABLE_QUALITY',
  'REWORK_COST_TOO_HIGH',
  'MISSING_SOURCE_MATERIAL',
  'OTHER',
]);

function normalizedCopyReturnDiscardReason(value) {
  const reason = String(value ?? '').trim().toUpperCase();
  if (!COPY_RETURN_DISCARD_REASONS.includes(reason)) {
    throw new TypeError('reasonCode is invalid');
  }
  return reason;
}

function normalizedQueryPackageNameFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('queryPackageName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 200) {
    throw new RangeError('queryPackageName must contain between 1 and 200 characters');
  }
  return name;
}

function normalizedPersonNameFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('personName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 80) {
    throw new RangeError('personName must contain between 1 and 80 characters');
  }
  return name;
}

function normalizedRequest(input, operation) {
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const reasonCodes = normalizedReasons(input?.reasonCodes);
  const note = normalizedNote(input?.note, { required: operation === 'RETURN_BATCH' });
  return { requestId, reasonCodes, note };
}

function contentSha256(content) {
  return hashJson(content);
}

function opaqueCode(prefix, publicId) {
  return `${prefix}-${createHash('sha256').update(String(publicId)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function blindApprovedContent(content) {
  const value = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  const rawCopy = value.copy ?? value.reviewed?.copy ?? value.post ?? {};
  const copy = {
    title: typeof rawCopy?.title === 'string' ? rawCopy.title : '',
    body: typeof rawCopy?.body === 'string' ? rawCopy.body : '',
    tags: Array.isArray(rawCopy?.tags)
      ? rawCopy.tags.filter((tag) => typeof tag === 'string').slice(0, 8)
      : [],
  };
  const rawPlan = value.imagePlan ?? value.reviewed?.imagePlan ?? value.post?.imagePlan;
  const imagePlan = Array.isArray(rawPlan) ? rawPlan.slice(0, 5).map((page) => ({
    kind: typeof page?.kind === 'string' ? page.kind : '',
    headline: typeof page?.headline === 'string' ? page.headline : '',
    subtitle: typeof page?.subtitle === 'string' ? page.subtitle : '',
    bullets: Array.isArray(page?.bullets)
      ? page.bullets.filter((bullet) => typeof bullet === 'string').slice(0, 5)
      : [],
    prompt: typeof page?.prompt === 'string' ? page.prompt : '',
  })) : [];
  return { copy, imagePlan };
}

function qaItemIdentifier(value) {
  const identifier = String(value ?? '').trim();
  if (/^[1-9]\d*$/u.test(identifier)) return { id: normalizeTaskId(identifier), publicId: null };
  return { id: null, publicId: normalizeUuid(identifier, 'samplingItemId') };
}

function qaItemFrom(row, actor) {
  if (!row) return null;
  const blindPolicyEnabled = row.blind_review_enabled === true;
  const blind = blindPolicyEnabled && actor.role !== 'ADMIN';
  const approvedContent = blind
    ? blindApprovedContent(row.copy_content)
    : row.copy_content;
  const canReviewOwnItem = actor.role === 'ADMIN'
    || Number(row.final_approver_account_id) !== actor.userId;
  const common = {
    ...(row.system_priority === undefined ? {} : { prioritySummary: `${row.priority_paused ? '已暂停' : `生效 ${row.effective_priority}`} · 系统 ${row.system_priority} / 人工 ${row.manual_priority ?? '—'}` }),
    id: row.public_id,
    freezePublicId: row.freeze_public_id,
    anonymousCode: opaqueCode('QC', row.public_id),
    blindReview: blind,
    status: row.status,
    sampleKind: row.sample_kind ?? 'RANDOM',
    approvedRevision: {
      content: approvedContent,
      contentSha256: row.content_sha256,
      revisionToken: row.content_sha256,
    },
    productionBatch: {
      anonymousCode: opaqueCode('QCB', row.freeze_public_id),
    },
    capabilities: {
      canPass: canReviewOwnItem && row.status === 'PENDING' && row.priority_paused !== true,
      canReturnSingle: canReviewOwnItem && row.status === 'PENDING' && row.priority_paused !== true,
      canReturnBatch: row.priority_paused !== true,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // Blind responses are an allowlist. Do not add task/package/user fields here.
  if (blind) return common;
  return {
    ...common,
    ...priorityFrom(row),
    ...(actor.role === 'ADMIN' ? {
      samplingPolicy: {
        rateBps: Number(row.freeze_rate_bps),
        rateSource: row.freeze_rate_source,
        globalPolicyVersion: Number(row.freeze_policy_version),
        accountPolicyVersion: row.freeze_account_policy_version == null ? null : Number(row.freeze_account_policy_version),
        frozenAt: row.freeze_frozen_at,
      },
      reviewMethod: (row.admin_direct_approval_id !== null && row.admin_direct_approval_id !== undefined)
        || (['PASSED', 'SUPERSEDED'].includes(row.status) && Boolean(row.note) && row.reviewed_by_role === 'ADMIN')
        ? 'ADMIN_DIRECT'
        : 'STANDARD',
    } : {}),
    query: row.query,
    taskId: Number(row.task_id),
    approvedRevision: {
      ...common.approvedRevision,
      id: Number(row.copy_revision_id),
      revision: Number(row.copy_revision_number),
    },
    productionBatch: {
      ...common.productionBatch,
      id: Number(row.production_batch_id),
      publicId: row.production_batch_public_id,
      queryPackageName: row.query_package_name ?? null,
    },
    source: {
      finalApproverAccountId: Number(row.final_approver_account_id),
      finalApproverUsername: row.final_approver_username,
      assignedToUserId: row.assigned_to_user_id ?? null,
      createdByUserId: row.created_by_user_id ?? null,
    },
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
    if (['40P01', '55P03'].includes(error?.code)) {
      throw new ControlPlaneConflictError('QA_OPERATION_BUSY', '质检数据正在被其他操作更新，请刷新后重试');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function mutationReplay(client, actor, requestId, operation, fingerprint) {
  const result = await client.query(`
    SELECT * FROM copy_sampling_mutation_requests
    WHERE actor_account_id = $1 AND request_id = $2
  `, [actor.userId, requestId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.operation !== operation || row.request_fingerprint !== fingerprint) {
    throw new ControlPlaneConflictError('REQUEST_ID_CONFLICT', 'requestId 已用于其他质检操作');
  }
  return row.response;
}

async function storeMutation(client, actor, requestId, operation, fingerprint, response) {
  await client.query(`
    INSERT INTO copy_sampling_mutation_requests(
      actor_account_id, actor_username, request_id, operation, request_fingerprint, response
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [actor.userId, actor.username, requestId, operation, fingerprint, response]);
}

export async function insertCopyApprovalEvent(client, {
  taskId,
  copyRevisionId,
  assessmentId,
  approvalMode = 'MANUAL',
  actor,
  reviewSessionId = null,
  content,
}) {
  const digest = contentSha256(content);
  const inserted = await client.query(`
    INSERT INTO copy_approval_events(
      task_id, copy_revision_id, assessment_id, approval_mode,
      approved_by_account_id, approved_by_username, review_session_id, content_sha256
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (task_id, copy_revision_id) DO NOTHING
    RETURNING *
  `, [taskId, copyRevisionId, assessmentId, approvalMode,
    actor?.userId ?? null, actor?.username ?? 'system', reviewSessionId, digest]);
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await client.query(`
    SELECT * FROM copy_approval_events WHERE task_id = $1 AND copy_revision_id = $2
  `, [taskId, copyRevisionId]);
  const row = existing.rows[0];
  if (!row || row.content_sha256 !== digest) {
    throw new ControlPlaneConflictError('COPY_APPROVAL_CONFLICT', '文案通过事件与当前版本不一致');
  }
  return row;
}

async function productionBatchReadiness(client, productionBatchId) {
  const result = await client.query(`
    SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (
        WHERE task.state = 'COPY_QC_PENDING'
          OR (direct_approval.id IS NOT NULL AND task.state <> 'CANCELLED')
      ) AS approved_count,
      COUNT(*) FILTER (WHERE task.state = 'CANCELLED') AS cancelled_count,
      ARRAY_AGG(task.id ORDER BY task.id) FILTER (
        WHERE task.id IS NOT NULL
          AND task.state NOT IN ('COPY_QC_PENDING', 'CANCELLED')
          AND direct_approval.id IS NULL
          AND NOT EXISTS (SELECT 1 FROM copy_approval_events a WHERE a.task_id = task.id)
      ) AS blocker_task_ids
    FROM production_batch_items AS item
    LEFT JOIN tasks AS task ON task.id = item.task_id
    LEFT JOIN copy_qa_admin_direct_approvals AS direct_approval
      ON direct_approval.task_id = task.id
      AND direct_approval.copy_revision_id = task.current_copy_revision_id
    WHERE item.production_batch_id = $1
  `, [productionBatchId]);
  const row = result.rows[0] ?? {};
  const blockers = (row.blocker_task_ids ?? []).map(Number);
  return {
    totalCount: Number(row.total_count ?? 0),
    approvedCount: Number(row.approved_count ?? 0),
    cancelledCount: Number(row.cancelled_count ?? 0),
    blockerCount: blockers.length,
    blockerTaskIds: blockers.slice(0, 200),
    ready: Number(row.total_count ?? 0) > 0 && blockers.length === 0,
  };
}

async function releaseFrozenMembers(client, freezeId, actor, requestId, { withExceptions = false } = {}) {
  const eligible = await client.query(`
    SELECT item.id, task.id AS task_id
    FROM copy_sampling_items AS item
    JOIN tasks AS task ON task.id = item.task_id
    WHERE item.freeze_id = $1
      AND (item.status IN ('NOT_SELECTED', 'PASSED') OR ($2::boolean AND item.status = 'PENDING'))
      AND task.state = 'COPY_QC_PENDING'
      AND task.current_copy_revision_id = item.copy_revision_id
      AND (NOT $2::boolean OR NOT EXISTS (
        SELECT 1 FROM copy_sampling_items AS returned
        WHERE returned.freeze_id = item.freeze_id AND returned.task_id = item.task_id
          AND returned.status IN ('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED')
          AND NOT EXISTS (
            WITH RECURSIVE rechecks AS (
              SELECT returned.id, returned.status, returned.sample_kind
              UNION ALL
              SELECT child.id, child.status, child.sample_kind
              FROM copy_sampling_items AS child
              JOIN rechecks AS parent ON child.parent_item_id = parent.id
              WHERE child.sample_kind = 'MANDATORY_RECHECK'
            )
          SELECT 1 FROM rechecks AS recheck
            WHERE (recheck.sample_kind = 'MANDATORY_RECHECK'
              AND recheck.status IN ('PASSED', 'RELEASED'))
              OR EXISTS (
                SELECT 1 FROM copy_return_dispositions AS disposition
                WHERE disposition.source_sampling_item_id = recheck.id
              )
          )
      ))
    ORDER BY task.id
    FOR UPDATE OF task, item NOWAIT
  `, [freezeId, withExceptions]);
  const ids = eligible.rows.map((row) => Number(row.task_id));
  const itemIds = eligible.rows.map((row) => Number(row.id));
  if (ids.length) {
    // Keep PASSED as the immutable QA verdict for statistics. Only a held,
    // unselected member needs its lifecycle status changed on release.
    await client.query(`
      UPDATE copy_sampling_items SET status = 'RELEASED', updated_at = now()
      WHERE id = ANY($1::bigint[])
        AND (status = 'NOT_SELECTED' OR ($2::boolean AND status = 'PENDING'))
    `, [itemIds, withExceptions]);
  }
  const freeze = await client.query(`
    UPDATE copy_sampling_freezes SET status = $2, version = version + 1,
      resolved_at = now() WHERE id = $1 RETURNING production_batch_id
  `, [freezeId, withExceptions ? 'RELEASED_WITH_EXCEPTIONS' : 'RELEASED']);
  await client.query(`
    UPDATE production_batches SET status = $2, sampling_status = 'COMPLETED',
      version = version + 1, updated_at = now() WHERE id = $1
      AND NOT EXISTS (SELECT 1 FROM copy_sampling_freezes active WHERE active.production_batch_id = $1
        AND active.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED'))
  `, [freeze.rows[0].production_batch_id,
    withExceptions ? 'RELEASED_WITH_EXCEPTIONS' : 'RELEASED']);
  await client.query(`
    INSERT INTO copy_sampling_events(
      freeze_id, action, actor_account_id, actor_username, request_id, details
    ) VALUES ($1, 'RELEASE', $2, $3, $4, $5)
  `, [freezeId, actor?.userId ?? null, actor?.username ?? 'system', requestId, { taskIds: ids }]);
  const released = await client.query(`
    UPDATE tasks task SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
      progress_percent = 0, progress_message = '文案质检已放行，等待生图',
      copy_qc_released_revision_id = task.current_copy_revision_id,
      mandatory_copy_qc = false, mandatory_copy_qc_origin = NULL,
      current_execution_id = NULL, current_image_run_id = NULL, pending_snapshot = NULL,
      image_production_chain_id = NULL, image_production_started_at = NULL, image_production_duration_ms = 0,
      execution_started_at = NULL, finished_at = NULL, error = NULL,
      last_activity_at = now(), updated_at = now()
    WHERE task.state = 'COPY_QC_PENDING'
      AND task.id IN (SELECT task_id FROM copy_sampling_items WHERE freeze_id = $1)
      AND copy_quality_image_eligible(task.id, task.current_copy_revision_id, false)
    RETURNING task.id
  `, [freezeId]);
  return released.rows.map(row => Number(row.id));
}

async function assertExceptionalReleaseScope(client, freezeId) {
  const scope = await client.query(`
    SELECT COUNT(*) FILTER (
      WHERE sample_kind = 'RANDOM' AND status = 'RETURNED'
    ) AS returned_random_count
    FROM copy_sampling_items WHERE freeze_id = $1
  `, [freezeId]);
  if (Number(scope.rows[0]?.returned_random_count ?? 0) < 1) {
    throw new ControlPlaneConflictError(
      'BATCH_NOT_RELEASABLE',
      '仅单条随机抽检退回后可以显式放行其余任务，强制复检不能跳过',
    );
  }
}

async function createFreeze(client, productionBatch, settings, actor, requestId, group, policy) {
  const populationResult = await client.query(`
    SELECT task.id AS task_id, revision.id AS copy_revision_id,
      approval.id AS approval_event_id, approval.approved_by_account_id AS final_approver_account_id,
      approval.approved_by_username AS final_approver_username,
      approval.content_sha256
    FROM production_batch_items AS batch_item
    JOIN tasks AS task ON task.id = batch_item.task_id AND task.state = 'COPY_QC_PENDING'
    JOIN copy_revisions AS revision ON revision.id = task.current_copy_revision_id
    JOIN copy_approval_events AS approval
      ON approval.task_id = task.id AND approval.copy_revision_id = revision.id
      AND approval.approval_mode = 'MANUAL'
    WHERE batch_item.production_batch_id = $1
      AND ($2::bigint[] IS NULL OR task.id = ANY($2::bigint[]))
      AND NOT EXISTS (SELECT 1 FROM copy_sampling_items existing
        WHERE existing.task_id = task.id AND existing.copy_revision_id = revision.id)
    ORDER BY task.id
  `, [productionBatch.id, group.taskIds ?? null]);
  const population = populationResult.rows.map((row) => ({
    taskId: Number(row.task_id),
    copyRevisionId: Number(row.copy_revision_id),
    approvalEventId: Number(row.approval_event_id),
    finalApproverAccountId: Number(row.final_approver_account_id),
    contentSha256: row.content_sha256,
  }));
  if (!population.length) {
    await client.query(`
      UPDATE production_batches SET status = 'RELEASED', sampling_status = 'COMPLETED',
        version = version + 1, updated_at = now() WHERE id = $1
    `, [productionBatch.id]);
    return { frozen: false, released: true, populationCount: 0, sampleCount: 0 };
  }
  if (population.some((item) => !Number.isSafeInteger(item.finalApproverAccountId))) {
    throw new ControlPlaneConflictError('APPROVER_IDENTITY_MISSING', '最终人工通过人缺少稳定账号 ID，无法分层抽检');
  }
  const plan = selectStratifiedCopySample({
    population,
    rateBps: policy.rateBps,
    seed: randomUUID(),
    sampleCount: group.sampleCount ?? null,
  });
  const freeze = await client.query(`
    INSERT INTO copy_sampling_freezes(
      public_id, production_batch_id, policy_version, rate_bps, seed,
      algorithm_version, blind_review_enabled, population_count, sample_count,
      snapshot_sha256, frozen_by_account_id, frozen_by_username,
      request_id, request_fingerprint, freeze_version,
      final_approver_account_id, remainder_before, remainder_after, close_reason,
      rate_source, account_policy_version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      (SELECT COALESCE(MAX(freeze_version), 0) + 1 FROM copy_sampling_freezes WHERE production_batch_id = $2),
      $15, $16, $17, $18, $19, $20)
    RETURNING *
  `, [randomUUID(), productionBatch.id, policy.globalPolicyVersion, plan.rateBps, plan.seed,
    plan.algorithmVersion, settings.copySampling.blindReviewEnabled,
    plan.populationCount, plan.sampleCount, plan.snapshotSha256,
    actor?.userId ?? null, actor?.username ?? 'system', requestId,
    hashJson({ productionBatchId: Number(productionBatch.id), version: Number(productionBatch.version) }),
    group.accountId ?? null, group.remainderBefore ?? 0, group.remainderAfter ?? 0, group.closeReason ?? null,
    policy.rateSource, policy.accountPolicyVersion]);
  for (const stratum of plan.strata) {
    await client.query(`
      INSERT INTO copy_sampling_strata(
        freeze_id, final_approver_account_id, population_count, quota
      ) VALUES ($1, $2, $3, $4)
    `, [freeze.rows[0].id, stratum.finalApproverAccountId, stratum.populationCount, stratum.quota]);
  }
  const sourceByTask = new Map(populationResult.rows.map((row) => [Number(row.task_id), row]));
  for (const member of plan.members) {
    const source = sourceByTask.get(member.taskId);
    await client.query(`
      INSERT INTO copy_sampling_items(
        public_id, freeze_id, task_id, approval_event_id, copy_revision_id,
        content_sha256, final_approver_account_id, final_approver_username,
        rank_hash, selected, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [randomUUID(), freeze.rows[0].id, member.taskId, member.approvalEventId,
      member.copyRevisionId, member.contentSha256, member.finalApproverAccountId,
      source.final_approver_username, member.rankHash, member.selected,
      member.selected ? 'PENDING' : 'NOT_SELECTED']);
    await client.query(`
      UPDATE tasks SET current_stage = $2, progress_message = $3,
        last_activity_at = now(), updated_at = now() WHERE id = $1
    `, [member.taskId, member.selected ? 'QC_SAMPLE_PENDING' : 'QC_NON_SAMPLE_HELD',
      member.selected ? '当前最终达标版本已进入文案抽检' : '等待本批文案抽检完成后进入待生图队列']);
  }
  await client.query(`
    UPDATE production_batches SET status = 'FROZEN', sampling_status = 'FROZEN',
      version = version + 1, updated_at = now() WHERE id = $1
  `, [productionBatch.id]);
  await client.query(`
    INSERT INTO copy_sampling_events(
      freeze_id, action, actor_account_id, actor_username, request_id, details
    ) VALUES ($1, 'FREEZE', $2, $3, $4, $5)
  `, [freeze.rows[0].id, actor?.userId ?? null, actor?.username ?? 'system', requestId,
    { populationCount: plan.populationCount, sampleCount: plan.sampleCount, snapshotSha256: plan.snapshotSha256,
      effectiveRateBps: policy.rateBps, rateSource: policy.rateSource,
      globalPolicyVersion: policy.globalPolicyVersion, accountPolicyVersion: policy.accountPolicyVersion }]);
  if (plan.sampleCount === 0) {
    await releaseFrozenMembers(client, freeze.rows[0].id, actor, requestId);
  }
  return { frozen: true, freezeId: freeze.rows[0].public_id, ...plan };
}

export async function attemptAutomaticCopySamplingFreeze(client, productionBatchId, actor = null, { close = false } = {}) {
  if (productionBatchId == null) return { frozen: false, reason: 'NO_BATCH' };
  const batch = (await client.query('SELECT * FROM production_batches WHERE id = $1 FOR UPDATE', [productionBatchId])).rows[0];
  if (!batch) return { frozen: false, reason: 'NO_BATCH' };
  const settings = await readWorkflowQualitySettings(client);
  const pending = await client.query(`
    SELECT task.id, approval.approved_by_account_id AS account_id, approval.approved_at,
      approver.copy_sampling_rate_bps_override, approver.version AS account_policy_version
    FROM production_batch_items member JOIN tasks task ON task.id = member.task_id
    JOIN copy_approval_events approval ON approval.task_id = task.id AND approval.copy_revision_id = task.current_copy_revision_id
    LEFT JOIN app_users approver ON approver.id = approval.approved_by_account_id
    WHERE member.production_batch_id = $1 AND task.state = 'COPY_QC_PENDING' AND NOT task.mandatory_copy_qc
      AND NOT EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task.id AND i.copy_revision_id = task.current_copy_revision_id)
    ORDER BY approval.approved_by_account_id, approval.approved_at, task.id
    FOR UPDATE OF task NOWAIT
  `, [productionBatchId]);
  const readiness = await productionBatchReadiness(client, productionBatchId);
  if (readiness.ready && !pending.rows.length) {
    await client.query(`UPDATE production_batches SET status = 'RELEASED', sampling_status = 'COMPLETED',
      version = version + 1, updated_at = now() WHERE id = $1 AND sampling_status <> 'COMPLETED'
      AND NOT EXISTS (SELECT 1 FROM copy_sampling_freezes f WHERE f.production_batch_id = $1
        AND f.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED'))`, [productionBatchId]);
  }
  const groups = Map.groupBy(pending.rows, row => Number(row.account_id));
  const freezes = [];
  for (const [accountId, rows] of groups) {
    if (!Number.isSafeInteger(accountId) || accountId < 1) throw new ControlPlaneConflictError('APPROVER_IDENTITY_MISSING', '缺少最终审核账号');
    const policy = resolveEffectiveCopySamplingPolicy({
      globalEnabled: settings.copySampling.enabled, globalRateBps: settings.copySampling.rateBps,
      globalPolicyVersion: settings.version,
      accountRateBpsOverride: rows[0].copy_sampling_rate_bps_override ?? null,
      accountVersion: rows[0].account_policy_version == null ? null : Number(rows[0].account_policy_version),
    });
    await client.query('INSERT INTO copy_sampling_remainders(final_approver_account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
    let remainder = Number((await client.query('SELECT remainder_bps FROM copy_sampling_remainders WHERE final_approver_account_id = $1 FOR UPDATE', [accountId])).rows[0].remainder_bps);
    const expired = Date.now() - new Date(rows[0].approved_at).getTime() >= 30 * 60 * 1000;
    const closeReason = close ? 'MANUAL_CLOSE' : readiness.ready ? 'BATCH_CLOSED' : expired ? 'TIMEOUT' : null;
    if (!policy.enabled) {
      await client.query(`UPDATE tasks SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
        copy_qc_released_revision_id = current_copy_revision_id,
        progress_percent = 0, last_activity_at = now(), updated_at = now() WHERE id = ANY($1::bigint[]) AND NOT mandatory_copy_qc`, [rows.map(row => Number(row.id))]);
      continue;
    }
    while (rows.length) {
      const plan = planCopyQualityChunk({ count: rows.length, rateBps: policy.rateBps, remainder, close: Boolean(closeReason) });
      if (!plan.memberCount) break;
      const taskIds = rows.splice(0, plan.memberCount).map(row => Number(row.id));
      freezes.push(await createFreeze(client, batch, settings, actor, randomUUID(), {
        taskIds, accountId, sampleCount: plan.sampleCount, remainderBefore: remainder,
        remainderAfter: plan.remainder, closeReason: closeReason ?? 'RATIO_REACHED',
      }, policy));
      remainder = plan.remainder;
      await client.query('UPDATE copy_sampling_remainders SET remainder_bps = $2, updated_at = now() WHERE final_approver_account_id = $1', [accountId, remainder]);
    }
  }
  // Seeds and member ranks are admin-only; approval responses never disclose them.
  return { frozen: freezes.length > 0, freezes: freezes.map(f => ({ freezeId: f.freezeId, populationCount: f.populationCount, sampleCount: f.sampleCount })) };
}

export async function flushExpiredCopyQualityBatches(pool) {
  const batches = await pool.query(`SELECT DISTINCT task.production_batch_id AS id FROM tasks task
    JOIN copy_approval_events a ON a.task_id = task.id AND a.copy_revision_id = task.current_copy_revision_id
    WHERE task.state = 'COPY_QC_PENDING' AND NOT task.mandatory_copy_qc
      AND task.production_batch_id IS NOT NULL AND a.approved_at <= now() - interval '30 minutes'
      AND NOT EXISTS (SELECT 1 FROM copy_sampling_items i WHERE i.task_id = task.id AND i.copy_revision_id = task.current_copy_revision_id)
    LIMIT 100`);
  for (const batch of batches.rows) {
    try { await withTransaction(pool, client => attemptAutomaticCopySamplingFreeze(client, batch.id)); }
    catch (error) { if (error.code !== 'QA_OPERATION_BUSY') throw error; }
  }
}

export async function routeManualCopyApproval(client, {
  task,
  revision,
  assessment,
  actor,
  reviewSessionId,
  aiDisclosureEnabled,
  retryExhaustedCopyChanged = false,
}) {
  const approval = await insertCopyApprovalEvent(client, {
    taskId: Number(task.id),
    copyRevisionId: Number(revision.id),
    assessmentId: assessment?.id ?? null,
    actor,
    reviewSessionId,
    content: revision.content,
  });
  if (task.production_batch_id === null && !task.mandatory_copy_qc
      && (await readWorkflowQualitySettings(client)).copySampling.enabled) {
    const batch = await client.query(`INSERT INTO production_batches(public_id, client_batch_code, query_package_name, created_by_account_id, created_by_username, request_id, request_fingerprint)
      VALUES ($1, $2, '独立文案', $3, $4, $5, $6) RETURNING id`, [randomUUID(), clientBatchCodeForTask(task), actor.userId, actor.username, randomUUID(), hashJson({ taskId: task.id, revisionId: revision.id })]);
    task.production_batch_id = Number(batch.rows[0].id);
    await client.query('UPDATE tasks SET production_batch_id = $2 WHERE id = $1', [task.id, task.production_batch_id]);
    await client.query('INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot) VALUES ($1, $2, $3)', [task.production_batch_id, task.id, task.query]);
  }
  const imageRetryReview = task.current_stage === 'IMAGE_RETRY_EXHAUSTED'
    && retryExhaustedCopyChanged;
  if (task.mandatory_copy_qc === true || imageRetryReview) {
    const mandatoryOrigin = imageRetryReview
      ? 'IMAGE_RETRY_REVIEW'
      : task.mandatory_copy_qc_origin;
    let parent = null;
    let policyVersion;
    let blindReviewEnabled;
    if (mandatoryOrigin === 'QA_RETURN') {
      const priorReturn = await client.query(`
        SELECT item.*, sampling_freeze.production_batch_id,
          sampling_freeze.status AS freeze_status,
          sampling_freeze.policy_version AS parent_policy_version,
          sampling_freeze.blind_review_enabled AS parent_blind_review_enabled
        FROM copy_sampling_items AS item
        JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
        WHERE item.task_id = $1 AND item.status IN ('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'SUPERSEDED')
          AND sampling_freeze.status <> 'CANCELLED'
        ORDER BY item.updated_at DESC, item.id DESC LIMIT 1
        FOR UPDATE OF item, sampling_freeze
      `, [task.id]);
      parent = priorReturn.rows[0] ?? null;
      policyVersion = Number(parent?.parent_policy_version);
      blindReviewEnabled = parent?.parent_blind_review_enabled === true;
    } else if (['FINAL_REWORK', 'IMAGE_RETRY_REVIEW', 'DISCARD_RESTORE'].includes(mandatoryOrigin)) {
      // These review rounds have no random-sampling parent. Freeze one task
      // against the live policy without attaching unrelated historical returns.
      const settings = await lockWorkflowQualitySettings(client);
      policyVersion = settings.version;
      blindReviewEnabled = settings.copySampling.blindReviewEnabled;
    }
    if (!Number.isSafeInteger(policyVersion) || policyVersion < 1
        || (mandatoryOrigin === 'QA_RETURN' && !parent)) {
      throw new ControlPlaneConflictError(
        'MANDATORY_QA_PARENT_MISSING',
        mandatoryOrigin === 'QA_RETURN'
          ? '返工任务缺少原始质检记录，不能创建强制复检'
          : '返工任务缺少有效来源，不能创建强制复检',
      );
    }
    // A mandatory recheck is an isolated one-task round. Reusing the original
    // random-sampling freeze would let "release the rest" accidentally release
    // the returned task, or let the recheck resolve unrelated held members.
    // The task keeps its original business production_batch_id below; this
    // synthetic batch exists only as the immutable QA-round container.
    const syntheticBatch = await client.query(`
      INSERT INTO production_batches(
        public_id, query_package_id, query_package_name, client_batch_code, status, sampling_status,
        created_by_account_id, created_by_username, request_id, request_fingerprint
      ) VALUES ($1, NULL, '强制文案复检', $2, 'FROZEN', 'FROZEN', $3, $4, $5, $6)
      RETURNING *
    `, [randomUUID(), clientBatchCodeForTask(task), actor?.userId ?? null, actor?.username ?? 'system', randomUUID(),
      hashJson({ taskId: Number(task.id), revisionId: Number(revision.id), origin: task.mandatory_copy_qc_origin })]);
    const productionBatchId = Number(syntheticBatch.rows[0].id);
    const freeze = await client.query(`
      INSERT INTO copy_sampling_freezes(
        public_id, production_batch_id, policy_version, rate_bps, seed,
        algorithm_version, blind_review_enabled, population_count, sample_count,
        snapshot_sha256, frozen_by_account_id, frozen_by_username,
        request_id, request_fingerprint, status, rate_source
      ) VALUES ($1, $2, $3, 10000, $4, 'mandatory-recheck-v1',
        $5, 1, 1, $6, $7, $8, $9, $10, 'REVIEW_REQUIRED', 'MANDATORY_RECHECK')
      RETURNING *
    `, [randomUUID(), productionBatchId, policyVersion,
      `mandatory:${task.id}:${revision.id}`,
      blindReviewEnabled,
      hashJson({ taskId: Number(task.id), revisionId: Number(revision.id) }),
      actor?.userId ?? null, actor?.username ?? 'system', randomUUID(),
      hashJson({ taskId: Number(task.id), revisionId: Number(revision.id), mandatory: true })]);
    const freezeId = Number(freeze.rows[0].id);
    const rankHash = hashJson({ freezeId, taskId: Number(task.id), revisionId: Number(revision.id) });
    const recheck = await client.query(`
      INSERT INTO copy_sampling_items(
        public_id, freeze_id, task_id, approval_event_id, copy_revision_id,
        content_sha256, final_approver_account_id, final_approver_username,
        rank_hash, selected, sample_kind, parent_item_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true,
        'MANDATORY_RECHECK', $10, 'PENDING') RETURNING *
    `, [randomUUID(), freezeId, task.id, approval.id, revision.id, approval.content_sha256,
      parent?.final_approver_account_id ?? approval.approved_by_account_id, parent?.final_approver_username ?? approval.approved_by_username, rankHash, parent?.id ?? null]);
    await client.query(`
      UPDATE production_batches SET status = 'REVIEW_REQUIRED', sampling_status = 'FROZEN',
        version = version + 1, updated_at = now() WHERE id = $1
    `, [productionBatchId]);
    const updated = await client.query(`
      UPDATE tasks SET state = 'COPY_QC_PENDING', production_batch_id = COALESCE(production_batch_id, $2),
        current_copy_revision_id = $3, ai_disclosure_enabled = $4,
        mandatory_copy_qc = true, mandatory_copy_qc_origin = $5,
        current_execution_id = NULL, current_image_run_id = NULL,
        current_stage = 'QC_MANDATORY_RECHECK', progress_percent = 100,
        progress_message = '返工稿已记录为最终 3 分并提交强制复检；复检通过后才进入待生图队列',
        execution_started_at = NULL, finished_at = NULL, error = NULL,
        pending_snapshot = NULL, last_activity_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *
    `, [task.id, productionBatchId, revision.id, aiDisclosureEnabled, mandatoryOrigin]);
    return { task: updated.rows[0], approval, samplingItem: recheck.rows[0] };
  }
  // Every production-batch member is held until the batch's initial review is
  // closed. The sampling policy is read exactly once at that boundary, so a
  // mid-batch settings change cannot let early approvals escape the snapshot.
  const unchangedRetryExhaustion = task.current_stage === 'IMAGE_RETRY_EXHAUSTED'
    && !retryExhaustedCopyChanged;
  const shouldHold = task.production_batch_id !== null && !unchangedRetryExhaustion;
  const updated = await client.query(`
    UPDATE tasks SET
      state = $2, current_copy_revision_id = $3, ai_disclosure_enabled = $4,
      copy_qc_released_revision_id = CASE WHEN $2::varchar = 'IMAGE_QUEUED' THEN $3::bigint ELSE NULL END,
      current_execution_id = NULL, current_image_run_id = NULL,
      current_stage = $2, progress_percent = $5, progress_message = $6,
      execution_started_at = NULL, last_activity_at = now(), finished_at = NULL,
      error = NULL, pending_snapshot = NULL, updated_at = now()
    WHERE id = $1 RETURNING *
  `, [task.id, shouldHold ? 'COPY_QC_PENDING' : 'IMAGE_QUEUED', revision.id,
    aiDisclosureEnabled, shouldHold ? 100 : 0,
    shouldHold ? '最终达标版本等待生产批次完成初审并进入文案抽检' : '文案审核已完成，任务已进入待生图队列，等待图片执行机领取']);
  if (shouldHold) await attemptAutomaticCopySamplingFreeze(client, task.production_batch_id, actor);
  return { task: updated.rows[0], approval };
}

export async function freezeCopySamplingBatch(pool, rawProductionBatchId, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN']);
  const productionBatchId = normalizeTaskId(rawProductionBatchId);
  const expectedVersion = positiveVersion(input?.expectedVersion);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const fingerprint = hashJson({ productionBatchId, expectedVersion });
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const replay = await mutationReplay(client, actor, requestId, 'FREEZE', fingerprint);
    if (replay) return replay;
    const batch = await client.query('SELECT * FROM production_batches WHERE id = $1 FOR UPDATE', [productionBatchId]);
    if (!batch.rows[0]) throw new ControlPlaneNotFoundError('生产批次不存在');
    if (Number(batch.rows[0].version) !== expectedVersion) throw new ControlPlaneConflictError('VERSION_CONFLICT', '生产批次已变化');
    const response = await attemptAutomaticCopySamplingFreeze(client, productionBatchId, actor, { close: true });
    await storeMutation(client, actor, requestId, 'FREEZE', fingerprint, response);
    return response;
  });
}

const QA_ITEM_SQL = `
  SELECT item.*, sampling_freeze.public_id AS freeze_public_id, sampling_freeze.production_batch_id,
    sampling_freeze.rate_bps AS freeze_rate_bps, sampling_freeze.rate_source AS freeze_rate_source,
    sampling_freeze.policy_version AS freeze_policy_version,
    sampling_freeze.account_policy_version AS freeze_account_policy_version,
    sampling_freeze.frozen_at AS freeze_frozen_at,
    sampling_freeze.blind_review_enabled, revision.revision AS copy_revision_number,
    revision.content AS copy_content, task.query, task.assigned_to_user_id,
    task.created_by_user_id, task.system_priority, task.manual_priority, task.effective_priority,
    task.priority_mode, task.priority_paused, task.queue_entered_at, task.priority_sort_at,
    task.rework_count, task.requeue_reason, task.priority_version, batch.public_id AS production_batch_public_id,
    batch.query_package_name, direct_approval.id AS admin_direct_approval_id,
    reviewed_actor.role AS reviewed_by_role,
    ROW_NUMBER() OVER (
      PARTITION BY item.final_approver_account_id
      ORDER BY ${priorityOrderSql('task.')}, item.id ASC
    ) AS approver_queue_round,
    settings.reviewer_batch_return_enabled
  FROM copy_sampling_items AS item
  JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
  JOIN production_batches AS batch ON batch.id = sampling_freeze.production_batch_id
  JOIN copy_revisions AS revision ON revision.id = item.copy_revision_id
  JOIN tasks AS task ON task.id = item.task_id
  LEFT JOIN copy_qa_admin_direct_approvals AS direct_approval
    ON direct_approval.task_id = item.task_id
    AND direct_approval.copy_revision_id = item.copy_revision_id
  LEFT JOIN app_users AS reviewed_actor ON reviewed_actor.id = item.reviewed_by_account_id
  CROSS JOIN workflow_quality_settings AS settings
`;

export async function listCopyQaItems(pool, {
  itemPublicId = null,
  status = 'PENDING',
  queryPackageName: rawQueryPackageName = null,
  personName: rawPersonName = null,
  limit: rawLimit = 50,
  offset: rawOffset = 0,
  actionableOnly = false,
} = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const allowedStatuses = ['ALL', 'PENDING', 'PASSED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'RELEASED', 'SUPERSEDED', 'ADMIN_DIRECT_PASSED'];
  if (!allowedStatuses.includes(status)) throw new TypeError('copy QA status is invalid');
  const adminDirectOnly = status === 'ADMIN_DIRECT_PASSED';
  if (adminDirectOnly && actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('只有管理员可以筛选单独通过的文案质检项');
  }
  const queryPackageName = normalizedQueryPackageNameFilter(rawQueryPackageName);
  if (queryPackageName !== null && actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('只有管理员可以按词包名称筛选文案抽检项');
  }
  const personName = normalizedPersonNameFilter(rawPersonName);
  if (personName !== null && actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('只有管理员可以按人员姓名筛选文案抽检项');
  }
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  await lockActiveQualityActor(pool, actor);
  await flushExpiredCopyQualityBatches(pool);
  const values = [status === 'ALL' || adminDirectOnly ? null : status, actor.role === 'ADMIN' ? null : actor.userId];
  const itemFilter = itemPublicId === null ? '' : (() => {
    values.push(normalizeUuid(itemPublicId, 'itemPublicId'));
    return `AND item.public_id = $${values.length}::uuid`;
  })();
  const packageFilter = queryPackageName === null ? '' : (() => {
    values.push(queryPackageName);
    return `AND strpos(lower(batch.query_package_name), lower($${values.length})) > 0`;
  })();
  const personFilter = personName === null ? '' : (() => {
    values.push(personName);
    return `AND (
      strpos(lower(item.final_approver_username), lower($${values.length})) > 0
      OR EXISTS (
        SELECT 1 FROM app_users AS person_filter
        WHERE person_filter.id = item.final_approver_account_id
          AND strpos(lower(person_filter.display_name), lower($${values.length})) > 0
      )
    )`;
  })();
  values.push(limit, offset);
  const limitParameter = values.length - 1;
  const offsetParameter = values.length;
  // Before this filter existed, the all-jobs shortcut used the ordinary PASS
  // receipt. Its required note plus the administrator account is the only
  // durable discriminator for those already-written rows.
  const adminDirectSql = `(direct_approval.id IS NOT NULL OR (
    item.status IN ('PASSED', 'SUPERSEDED') AND item.note IS NOT NULL
    AND reviewed_actor.role = 'ADMIN'
  ))`;
  const itemScope = actor.role === 'ADMIN' && (status === 'ALL' || adminDirectOnly)
    ? `(item.selected = true OR ${adminDirectSql})`
    : 'item.selected = true';
  const directApprovalFilter = adminDirectOnly ? `AND ${adminDirectSql}` : '';
  // Keep each approver's own queue in priority order, then interleave the first
  // item from every approver before exposing anyone's second item. This avoids
  // a prolific or earlier approver monopolizing a reviewer's visible queue.
  const result = await pool.query(`${QA_ITEM_SQL}
    WHERE ${itemScope} AND ($1::varchar IS NULL OR item.status = $1)
      ${actionableOnly ? "AND item.status = 'PENDING' AND task.priority_paused = false" : ''}
      AND ($2::bigint IS NULL OR (item.final_approver_account_id <> $2
        AND (item.status <> 'PENDING' OR (item.assigned_review_account_id = $2 AND task.priority_paused = false))))
      ${directApprovalFilter}
      ${itemFilter}
      ${packageFilter}
      ${personFilter}
    ORDER BY task.priority_paused ASC, approver_queue_round ASC,
      task.priority_sort_at ASC, task.id ASC, item.id ASC
    LIMIT $${limitParameter} OFFSET $${offsetParameter}
  `, values);
  return result.rows.map((row) => qaItemFrom(row, actor));
}

export async function getCopyQaItem(pool, rawItemId, rawActor) {
  const actor = normalizeActor(rawActor);
  await lockActiveQualityActor(pool, actor);
  const identifier = qaItemIdentifier(rawItemId);
  const result = await pool.query(`${QA_ITEM_SQL}
    WHERE ($1::bigint IS NOT NULL AND item.id = $1)
       OR ($2::uuid IS NOT NULL AND item.public_id = $2)
  `, [identifier.id, identifier.publicId]);
  const row = result.rows[0];
  if (!row) throw new ControlPlaneNotFoundError('抽检项不存在');
  if (actor.role !== 'ADMIN' && row.selected !== true) {
    // Keep held population membership opaque. Reviewers receive unselected
    // identifiers only as an atomic batch-return confirmation scope.
    throw new ControlPlaneNotFoundError('抽检项不存在');
  }
  if (actor.role !== 'ADMIN' && Number(row.final_approver_account_id) === actor.userId) {
    throw new ControlPlaneAuthorizationError('不能质检自己最终通过的文案');
  }
  return qaItemFrom(row, actor);
}

async function lockQaItem(client, rawItemId) {
  const identifier = qaItemIdentifier(rawItemId);
  const location = await client.query(`
    SELECT id, task_id, freeze_id FROM copy_sampling_items
    WHERE ($1::bigint IS NOT NULL AND id = $1)
       OR ($2::uuid IS NOT NULL AND public_id = $2)
  `, [identifier.id, identifier.publicId]);
  if (!location.rows[0]) throw new ControlPlaneNotFoundError('抽检项不存在');
  const located = location.rows[0];
  const task = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [located.task_id]);
  if (!task.rows[0]) throw new ControlPlaneNotFoundError('抽检项不存在');
  if (task.rows[0].priority_paused) throw new ControlPlaneConflictError('TASK_PRIORITY_PAUSED', '任务已暂停，请先恢复优先级');
  const freeze = await client.query(
    'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE',
    [located.freeze_id],
  );
  if (!freeze.rows[0]) throw new ControlPlaneNotFoundError('抽检项不存在');
  const result = await client.query(`
    SELECT item.*, sampling_freeze.status AS freeze_status, sampling_freeze.production_batch_id,
      sampling_freeze.blind_review_enabled, task.state AS task_state,
      task.current_copy_revision_id, task.assigned_to_user_id,
      task.created_by_user_id
    FROM copy_sampling_items AS item
    JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
    JOIN tasks AS task ON task.id = item.task_id
    WHERE item.id = $1 AND item.task_id = $2 AND item.freeze_id = $3
    FOR UPDATE OF item
  `, [located.id, located.task_id, located.freeze_id]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('抽检项不存在');
  return result.rows[0];
}

function assertExpectedQaRevision(item, input) {
  if (input?.expectedRevisionToken !== undefined) {
    const token = String(input.expectedRevisionToken ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(token) || token !== item.content_sha256) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检版本已变化');
    }
    return { expectedRevisionToken: token };
  }
  const expectedCopyRevisionId = normalizeTaskId(input?.expectedCopyRevisionId);
  if (Number(item.copy_revision_id) !== expectedCopyRevisionId) {
    throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检版本已变化');
  }
  return { expectedCopyRevisionId };
}

function qaActionResponse(item, actor, status, releasedTaskIds = []) {
  if (item.blind_review_enabled === true && actor.role !== 'ADMIN') {
    return { id: item.public_id, status, releasedCount: releasedTaskIds.length };
  }
  return {
    id: item.public_id,
    status,
    taskId: Number(item.task_id),
    copyRevisionId: Number(item.copy_revision_id),
    releasedTaskIds,
  };
}

async function maybeReleasePassedFreeze(client, item, actor, requestId, { withExceptions = false } = {}) {
  const unresolved = Number((await client.query(`
    SELECT COUNT(*) AS count
    FROM copy_sampling_items AS item
    WHERE item.freeze_id = $1 AND (
      item.status = 'PENDING'
      OR (
        item.status IN ('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'SUPERSEDED')
        AND NOT EXISTS (
          WITH RECURSIVE rechecks AS (
            SELECT item.id, item.status, item.sample_kind
            UNION ALL
            SELECT child.id, child.status, child.sample_kind
            FROM copy_sampling_items AS child
            JOIN rechecks AS parent ON child.parent_item_id = parent.id
            WHERE child.sample_kind = 'MANDATORY_RECHECK'
          )
          SELECT 1 FROM rechecks AS recheck
          WHERE (recheck.sample_kind = 'MANDATORY_RECHECK'
            AND recheck.status IN ('PASSED', 'RELEASED'))
            OR EXISTS (
              SELECT 1 FROM copy_return_dispositions AS disposition
              WHERE disposition.source_sampling_item_id = recheck.id
            )
        )
      )
    )
  `, [item.freeze_id])).rows[0].count);
  if (unresolved === 0) {
    return releaseFrozenMembers(client, item.freeze_id, actor, requestId, { withExceptions });
  }
  return null;
}

async function maybeReleaseAncestorFreezes(
  client,
  item,
  actor,
  requestId,
  { withExceptions = false } = {},
) {
  if (item.sample_kind !== 'MANDATORY_RECHECK') return [];
  const releasedTaskIds = [];
  const visited = new Set();
  let parentItemId = item.parent_item_id;
  while (parentItemId !== null && parentItemId !== undefined) {
    const normalizedParentId = Number(parentItemId);
    if (!Number.isSafeInteger(normalizedParentId) || visited.has(normalizedParentId)) {
      throw new ControlPlaneConflictError('INVALID_RECHECK_LINEAGE', '强制复检版本链无效');
    }
    visited.add(normalizedParentId);
    const parent = await client.query(`
      SELECT parent.*, sampling_freeze.status AS freeze_status
      FROM copy_sampling_items AS parent
      JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = parent.freeze_id
      WHERE parent.id = $1
      FOR UPDATE OF parent, sampling_freeze
    `, [normalizedParentId]);
    const row = parent.rows[0];
    if (!row) throw new ControlPlaneConflictError('INVALID_RECHECK_LINEAGE', '强制复检上游记录不存在');
    if (['INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED'].includes(row.freeze_status)) {
      releasedTaskIds.push(...(await maybeReleasePassedFreeze(
        client,
        row,
        actor,
        requestId,
        { withExceptions },
      ) ?? []));
    }
    parentItemId = row.parent_item_id;
  }
  return releasedTaskIds;
}

export async function adminDirectApproveCopyQa(pool, rawTaskId, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN']);
  const note = normalizedNote(input?.note, { required: true });
  const taskId = normalizeTaskId(rawTaskId);
  const item = (await pool.query(`SELECT public_id FROM copy_sampling_items WHERE task_id = $1
    AND copy_revision_id = $2 AND selected = true ORDER BY id DESC LIMIT 1`,
    [taskId, normalizeTaskId(input?.expectedCopyRevisionId)])).rows[0];
  if (!item) throw new ControlPlaneConflictError('QA_ITEM_REQUIRED', '请先结批并通过质检入口操作');
  return passCopyQaItemWithMethod(pool, item.public_id, { ...input, note }, actor, 'ADMIN_DIRECT');
}

async function passCopyQaItemWithMethod(pool, rawItemId, input, rawActor, reviewMethod) {
  const actor = normalizeActor(rawActor);
  const { requestId, reasonCodes, note } = normalizedRequest(input, 'PASS');
  const adminDirect = reviewMethod === 'ADMIN_DIRECT';
  const operation = adminDirect ? 'ADMIN_DIRECT_PASS' : 'PASS';
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const item = await lockQaItem(client, rawItemId);
    const expectedRevision = assertExpectedQaRevision(item, input);
    const fingerprint = hashJson({
      itemId: String(rawItemId), ...expectedRevision, reasonCodes, note,
      ...(adminDirect ? { reviewMethod } : {}),
    });
    const replay = await mutationReplay(client, actor, requestId, operation, fingerprint);
    if (replay) return replay;
    if (actor.role !== 'ADMIN' && Number(item.final_approver_account_id) === actor.userId) {
      throw new ControlPlaneAuthorizationError('不能质检自己最终通过的文案');
    }
    if (item.status !== 'PENDING' || item.task_state !== 'COPY_QC_PENDING'
        || Number(item.current_copy_revision_id) !== Number(item.copy_revision_id)) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检版本或任务状态已变化');
    }
    await client.query(`
      UPDATE copy_sampling_items SET status = 'PASSED', reviewed_by_account_id = $2,
        reviewed_by_username = $3, reason_codes = $4, note = $5,
        reviewed_at = now(), updated_at = now() WHERE id = $1
    `, [item.id, actor.userId, actor.username, reasonCodes, note]);
    if (adminDirect) {
      await client.query(`
        INSERT INTO copy_qa_admin_direct_approvals(
          task_id, copy_revision_id, approval_event_id,
          actor_account_id, actor_username, request_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [item.task_id, item.copy_revision_id, item.approval_event_id,
        actor.userId, actor.username, requestId]);
    }
    await client.query(`
      INSERT INTO copy_sampling_events(
        freeze_id, sampling_item_id, action, actor_account_id, actor_username,
        reason_codes, note, request_id, details
      ) VALUES ($1, $2, 'PASS', $3, $4, $5, $6, $7, $8)
    `, [item.freeze_id, item.id, actor.userId, actor.username, reasonCodes, note, requestId,
      adminDirect ? { directAdminApproval: true } : {}]);
    const currentRoundReleased = await maybeReleasePassedFreeze(client, item, actor, requestId);
    const parentRoundReleased = await maybeReleaseAncestorFreezes(client, item, actor, requestId);
    const releasedTaskIds = [...new Set([
      ...(currentRoundReleased ?? []),
      ...(parentRoundReleased ?? []),
    ])];
    const actionResponse = qaActionResponse(item, actor, 'PASSED', releasedTaskIds);
    const response = adminDirect
      ? {
          ...actionResponse,
          task: (await client.query('SELECT * FROM tasks WHERE id = $1', [item.task_id])).rows[0] ?? null,
        }
      : actionResponse;
    await storeMutation(client, actor, requestId, operation, fingerprint, response);
    return response;
  });
}

export async function passCopyQaItem(pool, rawItemId, input, rawActor) {
  return passCopyQaItemWithMethod(pool, rawItemId, input, rawActor, 'STANDARD');
}

async function appendReturnedRevision(client, item, actor, requestId, origin, {
  reasonCodes,
  reasonSnapshots,
  note,
  recommendedDisposition = 'REWORK',
}) {
  const current = await client.query(`
    SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE
  `, [item.copy_revision_id, item.task_id]);
  if (!current.rows[0]) throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检文案版本不存在');
  const revisionNumber = Number((await client.query(`
    SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM copy_revisions WHERE task_id = $1
  `, [item.task_id])).rows[0].revision);
  const content = {
    ...current.rows[0].content,
    qualityReturn: {
      origin,
      baseRevisionId: Number(item.copy_revision_id),
      samplingItemId: item.public_id,
      returnedByUsername: actor.username,
      reasonCodes,
      reasonSnapshots,
      note,
      recommendedDisposition,
      requestId,
      returnedAt: new Date().toISOString(),
    },
  };
  const created = await client.query(`
    INSERT INTO copy_revisions(
      task_id, execution_id, revision, content, parent_revision_id, revision_origin,
      copy_content_changed_from_machine, copy_rework_satisfied
    ) VALUES ($1, NULL, $2, $3, $4, 'QA_RETURN', $5, false) RETURNING *
  `, [item.task_id, revisionNumber, content, item.copy_revision_id,
    current.rows[0].copy_content_changed_from_machine === true]);
  await client.query(`
      UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2,
      current_image_run_id = NULL, current_execution_id = NULL,
      current_stage = 'COPY_REVIEW_PENDING', progress_percent = 100,
      progress_message = $3,
      pending_snapshot = NULL, mandatory_copy_qc = true,
      mandatory_copy_qc_origin = 'QA_RETURN', error = NULL, finished_at = now(),
      last_activity_at = now(), updated_at = now()
    WHERE id = $1
  `, [item.task_id, created.rows[0].id, item.sample_kind === 'MANDATORY_RECHECK'
    ? '强制复检未通过，已退回继续修改；实际修改后须再次提交强制复检'
    : '文案抽检发现问题，已仅退回当前任务修改；实际修改后须提交强制复检']);
  return created.rows[0];
}

export async function returnCopyQaItem(pool, rawItemId, input, rawActor, expectedTaskId = null) {
  const actor = normalizeActor(rawActor);
  const { requestId, reasonCodes, note } = normalizedRequest(input, 'RETURN_SINGLE');
  const recommendedDisposition = normalizedReturnRecommendation(input?.recommendedDisposition);
  if (!reasonCodes.length && !note) throw new TypeError('single return requires a reason or note');
  if (recommendedDisposition === 'DISCARD' && !note) {
    throw new TypeError('suggesting discard requires a note');
  }
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const item = await lockQaItem(client, rawItemId);
    const expectedRevision = assertExpectedQaRevision(item, input);
    const fingerprint = hashJson({
      itemId: String(rawItemId), expectedTaskId, ...expectedRevision,
      reasonCodes, note, recommendedDisposition,
    });
    const replay = await mutationReplay(client, actor, requestId, 'RETURN_SINGLE', fingerprint);
    if (replay) return replay;
    const reasonSnapshots = await resolveCopyQaReasonSnapshots(client, reasonCodes, actor);
    if (expectedTaskId !== null && Number(item.task_id) !== normalizeTaskId(expectedTaskId)) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检项不属于指定任务');
    }
    if (actor.role !== 'ADMIN' && Number(item.final_approver_account_id) === actor.userId) {
      throw new ControlPlaneAuthorizationError('不能质检自己最终通过的文案');
    }
    if (item.status !== 'PENDING' || item.task_state !== 'COPY_QC_PENDING'
        || Number(item.current_copy_revision_id) !== Number(item.copy_revision_id)) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检版本或任务状态已变化');
    }
    const revision = await appendReturnedRevision(client, item, actor, requestId, 'SINGLE', {
      reasonCodes,
      reasonSnapshots,
      note,
      recommendedDisposition,
    });
    await client.query(`
      UPDATE copy_sampling_items SET status = 'RETURNED', reviewed_by_account_id = $2,
        reviewed_by_username = $3, reason_codes = $4, note = $5,
        reviewed_at = now(), updated_at = now() WHERE id = $1
    `, [item.id, actor.userId, actor.username, reasonCodes, note]);
    await client.query(`
      UPDATE copy_sampling_freezes SET status = 'REVIEW_REQUIRED', version = version + 1
      WHERE id = $1
    `, [item.freeze_id]);
    await client.query(`
      UPDATE production_batches SET status = 'REVIEW_REQUIRED', version = version + 1,
        updated_at = now() WHERE id = $1
    `, [item.production_batch_id]);
    await client.query(`
      INSERT INTO copy_sampling_events(
        freeze_id, sampling_item_id, action, actor_account_id, actor_username,
        reason_codes, note, request_id, details
      ) VALUES ($1, $2, 'RETURN_SINGLE', $3, $4, $5, $6, $7, $8)
    `, [item.freeze_id, item.id, actor.userId, actor.username, reasonCodes, note,
      requestId, { reasonSnapshots, recommendedDisposition }]);
    const response = item.blind_review_enabled === true && actor.role !== 'ADMIN'
      ? { id: item.public_id, status: 'RETURNED' }
      : { ...qaActionResponse(item, actor, 'RETURNED'), returnedRevisionId: Number(revision.id) };
    await storeMutation(client, actor, requestId, 'RETURN_SINGLE', fingerprint, response);
    return response;
  });
}

export async function discardReturnedCopy(pool, rawTaskId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const taskId = normalizeTaskId(rawTaskId);
  const expectedCopyRevisionId = normalizeTaskId(input?.expectedCopyRevisionId);
  const sourceSamplingItemId = normalizeUuid(input?.sourceSamplingItemId, 'sourceSamplingItemId');
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const reasonCode = normalizedCopyReturnDiscardReason(input?.reasonCode);
  const note = normalizedNote(input?.note, { required: true });
  const fingerprint = hashJson({
    taskId,
    expectedCopyRevisionId,
    sourceSamplingItemId,
    reasonCode,
    note,
  });
  return withTransaction(pool, async (client) => {
    await lockActiveCopyWorkerActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const replay = await mutationReplay(client, actor, requestId, 'DISCARD_REWORK', fingerprint);
    if (replay) return replay;

    const located = (await client.query(`
      SELECT id, task_id, freeze_id FROM copy_sampling_items
      WHERE public_id = $1
    `, [sourceSamplingItemId])).rows[0];
    if (!located || Number(located.task_id) !== taskId) {
      throw new ControlPlaneConflictError('QA_RETURN_SOURCE_MISMATCH', '质检打回来源已经变化，请刷新后重试');
    }
    const task = (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
    if (!task) throw new ControlPlaneNotFoundError('task not found');
    if (actor.role !== 'ADMIN' && task.assigned_to_user_id !== actor.username) {
      throw new ControlPlaneAuthorizationError('只有当前任务负责人可以确认废弃质检返工任务');
    }
    if (task.assigned_to_user_id === null && actor.role !== 'ADMIN') {
      throw new ControlPlaneAuthorizationError('未分配任务仅管理员可操作');
    }
    if (task.state !== 'COPY_REVIEW_PENDING' || task.mandatory_copy_qc !== true
        || task.mandatory_copy_qc_origin !== 'QA_RETURN') {
      throw new ControlPlaneConflictError(
        'RETURNED_COPY_DISCARD_FORBIDDEN',
        '只有质检打回且仍待返工的文案可以从此入口废弃',
      );
    }
    if (Number(task.current_copy_revision_id) !== expectedCopyRevisionId) {
      throw new ControlPlaneConflictError('STALE_COPY_REVISION', '文案版本已经变化，请刷新后重试');
    }
    if (task.current_execution_id !== null) {
      throw new ControlPlaneConflictError('TASK_EXECUTION_ACTIVE', '当前任务仍有执行在进行，不能废弃');
    }

    const freeze = (await client.query(
      'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE',
      [located.freeze_id],
    )).rows[0];
    if (!freeze) throw new ControlPlaneConflictError('QA_RETURN_SOURCE_MISMATCH', '质检批次不存在');
    const item = (await client.query(`
      SELECT item.*, sampling_freeze.status AS freeze_status,
        sampling_freeze.production_batch_id
      FROM copy_sampling_items AS item
      JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
      WHERE item.id = $1 AND item.task_id = $2 AND item.freeze_id = $3
      FOR UPDATE OF item
    `, [located.id, taskId, located.freeze_id])).rows[0];
    if (!item || !['RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED'].includes(item.status)) {
      throw new ControlPlaneConflictError('QA_RETURN_SOURCE_MISMATCH', '质检打回记录已经变化，请刷新后重试');
    }
    const revision = (await client.query(`
      SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2
    `, [expectedCopyRevisionId, taskId])).rows[0];
    const qualityReturn = revision?.content?.qualityReturn;
    if (!revision || revision.revision_origin !== 'QA_RETURN'
        || qualityReturn?.samplingItemId !== sourceSamplingItemId) {
      throw new ControlPlaneConflictError('QA_RETURN_SOURCE_MISMATCH', '当前文案不是该质检项的返工版本');
    }
    const qaRecommendedDiscard = qualityReturn.recommendedDisposition === 'DISCARD';
    if (actor.role !== 'ADMIN'
        && (!qaRecommendedDiscard || reasonCode !== 'QA_RECOMMENDATION')) {
      throw new ControlPlaneConflictError(
        'QA_DISCARD_NOT_RECOMMENDED',
        '质检未建议废弃，任务负责人应继续返工；如需例外处置请联系管理员',
      );
    }
    if (reasonCode === 'QA_RECOMMENDATION' && !qaRecommendedDiscard) {
      throw new ControlPlaneConflictError('QA_DISCARD_NOT_RECOMMENDED', '当前质检记录没有建议废弃');
    }

    const disposition = (await client.query(`
      INSERT INTO copy_return_dispositions(
        task_id, returned_revision_id, source_sampling_item_id, action,
        reason_code, note, actor_account_id, actor_username, actor_role, request_id
      ) VALUES ($1, $2, $3, 'DISCARD_AFTER_QA_RETURN', $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at
    `, [taskId, expectedCopyRevisionId, item.id, reasonCode, note,
      actor.userId, actor.username, actor.role, requestId])).rows[0];
    const updated = (await client.query(`
      UPDATE tasks SET
        state = 'CANCELLED', cancelled_from_state = state,
        current_execution_id = NULL, current_stage = 'CANCELLED',
        progress_percent = 100,
        progress_message = '质检打回后由任务负责人确认废弃',
        last_activity_at = now(), finished_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [taskId])).rows[0];

    const releasedTaskIds = [];
    if (['INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED'].includes(item.freeze_status)) {
      releasedTaskIds.push(...(await maybeReleasePassedFreeze(
        client,
        item,
        actor,
        requestId,
        { withExceptions: true },
      ) ?? []));
    }
    releasedTaskIds.push(...await maybeReleaseAncestorFreezes(
      client,
      item,
      actor,
      requestId,
      { withExceptions: true },
    ));
    const response = {
      status: 'DISCARDED',
      task: updated,
      dispositionId: Number(disposition.id),
      releasedTaskIds: [...new Set(releasedTaskIds)],
    };
    await storeMutation(client, actor, requestId, 'DISCARD_REWORK', fingerprint, response);
    return response;
  });
}

function batchMemberHash(row) {
  return createHash('sha256')
    .update(`${row.public_id}\0${row.content_sha256}`)
    .digest('hex');
}

async function locateQaFreeze(client, freezePublicId, productionBatchId = null) {
  const result = await client.query(`
    SELECT id FROM copy_sampling_freezes
    WHERE public_id = $1 AND ($2::bigint IS NULL OR production_batch_id = $2)
  `, [freezePublicId, productionBatchId]);
  return result.rows[0] ?? null;
}

async function lockQaFreezeMemberTasks(client, freezeId) {
  await client.query(`
    SELECT task.id FROM copy_sampling_items AS item
    JOIN tasks AS task ON task.id = item.task_id
    WHERE item.freeze_id = $1
    ORDER BY task.id
    FOR UPDATE OF task NOWAIT
  `, [freezeId]);
}

async function lockQaFreezeAfterMemberTasks(client, freezePublicId, productionBatchId = null) {
  const location = await locateQaFreeze(client, freezePublicId, productionBatchId);
  if (!location) return null;
  await lockQaFreezeMemberTasks(client, location.id);
  const result = await client.query(`
    SELECT * FROM copy_sampling_freezes
    WHERE id = $1 AND public_id = $2
      AND ($3::bigint IS NULL OR production_batch_id = $3)
    FOR UPDATE
  `, [location.id, freezePublicId, productionBatchId]);
  return result.rows[0] ?? null;
}

export async function getCopyQaBatchReturnPreview(pool, rawFreezePublicId, rawActor) {
  const actor = normalizeActor(rawActor);
  await lockActiveQualityActor(pool, actor);
  const freezePublicId = normalizeUuid(rawFreezePublicId, 'freezePublicId');
  assertReviewerBatchReturnAllowed(actor, await readWorkflowQualitySettings(pool));
  const freeze = await pool.query(`
    SELECT sampling_freeze.*, batch.public_id AS batch_public_id
    FROM copy_sampling_freezes AS sampling_freeze
    JOIN production_batches AS batch ON batch.id = sampling_freeze.production_batch_id
    WHERE sampling_freeze.public_id = $1
  `, [freezePublicId]);
  if (!freeze.rows[0] || !['INSPECTING', 'REVIEW_REQUIRED'].includes(freeze.rows[0].status)) {
    throw new ControlPlaneConflictError('BATCH_NOT_RETURNABLE', '抽检批次已放行、已打回或不存在');
  }
  const result = await pool.query(`
    SELECT item.*, task.state AS task_state, task.current_copy_revision_id
    FROM copy_sampling_items AS item
    JOIN tasks AS task ON task.id = item.task_id
    WHERE item.freeze_id = $1 AND item.status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RETURNED')
    ORDER BY item.public_id
  `, [freeze.rows[0].id]);
  const blind = freeze.rows[0].blind_review_enabled === true && actor.role !== 'ADMIN';
  return {
    freezePublicId,
    anonymousCode: opaqueCode('QCB', freezePublicId),
    version: Number(freeze.rows[0].version),
    confirmedCount: result.rows.length,
    triggerCandidates: result.rows
      .filter((row) => row.selected === true && ['PENDING', 'RETURNED'].includes(row.status)
        && row.sample_kind === 'RANDOM')
      .map((row) => row.public_id),
    items: result.rows.map((row) => ({
      id: row.public_id,
      memberHash: batchMemberHash(row),
      revisionToken: row.content_sha256,
      status: row.status,
      selected: row.selected === true,
      sampleKind: row.sample_kind,
      ...(blind ? {} : {
        taskId: Number(row.task_id),
        copyRevisionId: Number(row.copy_revision_id),
      }),
    })),
  };
}

export async function batchReturnCopyQa(pool, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const freezePublicId = normalizeUuid(input?.freezePublicId ?? input?.freezeId, 'freezePublicId');
  const triggerSamplingItemId = normalizeUuid(input?.triggerSamplingItemId, 'triggerSamplingItemId');
  const rawItems = input?.itemIds ?? input?.items?.map((entry) => entry.samplingItemId);
  const { requestId, reasonCodes, note } = normalizedRequest(input, 'RETURN_BATCH');
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 5_000) {
    throw new RangeError('itemIds must contain between 1 and 5000 entries');
  }
  const itemIds = [...new Set(rawItems.map((entry) => normalizeUuid(entry, 'samplingItemId')))]
    .toSorted((left, right) => left.localeCompare(right));
  if (itemIds.length !== rawItems.length) throw new TypeError('itemIds must be unique');
  if (Number(input?.confirmedCount) !== itemIds.length) throw new TypeError('confirmedCount must match itemIds length');
  const fingerprint = hashJson({ freezePublicId, triggerSamplingItemId, itemIds, reasonCodes, note });
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const replay = await mutationReplay(client, actor, requestId, 'RETURN_BATCH', fingerprint);
    if (replay) return replay;
    const reasonSnapshots = await resolveCopyQaReasonSnapshots(client, reasonCodes, actor);
    assertReviewerBatchReturnAllowed(actor, await lockWorkflowQualitySettings(client));
    const freeze = await lockQaFreezeAfterMemberTasks(client, freezePublicId);
    if (!freeze || !['INSPECTING', 'REVIEW_REQUIRED'].includes(freeze.status)) {
      throw new ControlPlaneConflictError('BATCH_NOT_RETURNABLE', '抽检批次已放行、已打回或不存在');
    }
    const eligible = await client.query(`
      SELECT item.*, task.state AS task_state, task.current_copy_revision_id
      FROM copy_sampling_items AS item
      JOIN tasks AS task ON task.id = item.task_id
      WHERE item.freeze_id = $1 AND item.status IN ('PENDING', 'PASSED', 'NOT_SELECTED', 'RETURNED')
      ORDER BY task.id FOR UPDATE OF item
    `, [freeze.id]);
    const submitted = new Set(itemIds);
    const trigger = eligible.rows.find((row) => row.public_id === triggerSamplingItemId);
    if (!trigger || trigger.selected !== true || !['PENDING', 'RETURNED'].includes(trigger.status)
        || trigger.sample_kind !== 'RANDOM') {
      throw new ControlPlaneConflictError('INVALID_BATCH_TRIGGER', '整批打回必须指定本次确认错误的随机抽检项');
    }
    if (actor.role !== 'ADMIN'
        && eligible.rows.some(row => Number(row.final_approver_account_id) === actor.userId)) {
      throw new ControlPlaneAuthorizationError('不能以自己最终通过的文案作为整批打回触发项');
    }
    if (eligible.rows.length !== itemIds.length
        || eligible.rows.some((item) => !submitted.has(item.public_id)
          || (item.status !== 'RETURNED' && (
            item.task_state !== 'COPY_QC_PENDING'
            || Number(item.current_copy_revision_id) !== Number(item.copy_revision_id)
          )))) {
      throw new ControlPlaneConflictError('BATCH_SCOPE_CHANGED', '整批范围或文案版本已变化，请重新预览确认');
    }
    const taskIds = [];
    const affectedItemIds = [];
    for (const item of eligible.rows) {
      taskIds.push(Number(item.task_id));
      if (item.status === 'RETURNED') continue;
      const isTrigger = item.public_id === triggerSamplingItemId;
      await appendReturnedRevision(client, item, actor, requestId, 'BATCH', {
        reasonCodes,
        reasonSnapshots,
        note,
      });
      if (!isTrigger) affectedItemIds.push(item.public_id);
      await client.query(`
        UPDATE copy_sampling_items SET status = $2, reviewed_by_account_id = $3,
          reviewed_by_username = $4, reason_codes = $5, note = $6,
          reviewed_at = CASE WHEN $7 THEN now() ELSE reviewed_at END, updated_at = now()
        WHERE id = $1
      `, [item.id, isTrigger ? 'RETURNED' : 'BATCH_AFFECTED', actor.userId,
        actor.username, isTrigger ? reasonCodes : [], isTrigger ? note : null, isTrigger]);
    }
    await client.query(`
      UPDATE copy_sampling_freezes SET status = 'BATCH_RETURNED', version = version + 1,
        resolved_at = now() WHERE id = $1
    `, [freeze.id]);
    await client.query(`
      UPDATE production_batches SET status = 'BATCH_RETURNED', sampling_status = 'RETURNED',
        version = version + 1, updated_at = now() WHERE id = $1
    `, [freeze.production_batch_id]);
    await client.query(`
      INSERT INTO copy_sampling_events(
        freeze_id, sampling_item_id, action, actor_account_id, actor_username,
        reason_codes, note, request_id, details
      ) VALUES ($1, $2, 'RETURN_BATCH', $3, $4, $5, $6, $7, $8)
    `, [freeze.id, trigger.id, actor.userId, actor.username, reasonCodes, note,
      requestId, {
        reasonSnapshots,
        triggerSamplingItemId,
        affectedItemIds,
        alreadyReturnedItemIds: eligible.rows
          .filter((row) => row.status === 'RETURNED')
          .map((row) => row.public_id),
        memberHashes: eligible.rows.map((row) => ({ id: row.public_id, memberHash: batchMemberHash(row) })),
        snapshotSha256: freeze.snapshot_sha256,
        affectedCount: affectedItemIds.length,
        affectedTaskIds: eligible.rows.filter(row=>affectedItemIds.includes(row.public_id)).map(row=>Number(row.task_id)),
      }]);
    const blind = freeze.blind_review_enabled === true && actor.role !== 'ADMIN';
    const response = {
      freezePublicId,
      status: 'BATCH_RETURNED',
      triggerSamplingItemId,
      affectedCount: affectedItemIds.length,
      ...(blind ? {} : { taskIds }),
    };
    await storeMutation(client, actor, requestId, 'RETURN_BATCH', fingerprint, response);
    return response;
  });
}

export async function releaseCopyQaFreeze(pool, rawFreezePublicId, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN']);
  const freezePublicId = normalizeUuid(rawFreezePublicId, 'freezePublicId');
  const { requestId } = normalizedRequest(input, 'RELEASE');
  const note = normalizedNote(input?.note, { required: true });
  const fingerprint = hashJson({ freezePublicId, note });
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const replay = await mutationReplay(client, actor, requestId, 'RELEASE', fingerprint);
    if (replay) return replay;
    const freeze = await lockQaFreezeAfterMemberTasks(client, freezePublicId);
    if (!freeze || freeze.status !== 'REVIEW_REQUIRED') {
      throw new ControlPlaneConflictError('BATCH_NOT_RELEASABLE', '当前抽检批次不需要异常放行');
    }
    await client.query(`INSERT INTO copy_sampling_events(freeze_id, action, actor_account_id, actor_username, request_id, note) VALUES ($1, 'RELEASE', $2, $3, $4, $5)`, [freeze.id, actor.userId, actor.username, requestId, note]);
    await assertExceptionalReleaseScope(client, freeze.id);
    const ids = await releaseFrozenMembers(client, freeze.id, actor, requestId,
      { withExceptions: true });
    const blind = freeze.blind_review_enabled === true && actor.role !== 'ADMIN';
    const response = {
      freezePublicId,
      status: 'RELEASED_WITH_EXCEPTIONS',
      releasedCount: ids.length,
      ...(blind ? {} : { taskIds: ids }),
    };
    await storeMutation(client, actor, requestId, 'RELEASE', fingerprint, response);
    return response;
  });
}

export async function releaseCopySamplingBatch(pool, rawProductionBatchId, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN']);
  normalizedNote(input?.note, { required: true });
  const productionBatchId = normalizeTaskId(rawProductionBatchId);
  const { requestId, note } = normalizedRequest(input, 'RELEASE');
  const freezePublicId = normalizeUuid(input?.freezeId, 'freezeId');
  const fingerprint = hashJson({ productionBatchId, freezePublicId, note });
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const replay = await mutationReplay(client, actor, requestId, 'RELEASE', fingerprint);
    if (replay) return replay;
    const freeze = await lockQaFreezeAfterMemberTasks(client, freezePublicId, productionBatchId);
    if (!freeze || freeze.status !== 'REVIEW_REQUIRED') {
      throw new ControlPlaneConflictError('BATCH_NOT_RELEASABLE', '当前抽检批次不需要异常放行');
    }
    await assertExceptionalReleaseScope(client, freeze.id);
    await client.query(`INSERT INTO copy_sampling_events(freeze_id, action, actor_account_id, actor_username, request_id, note) VALUES ($1, 'RELEASE', $2, $3, $4, $5)`, [freeze.id, actor.userId, actor.username, requestId, note]);
    const ids = await releaseFrozenMembers(client, freeze.id, actor, requestId, { withExceptions: true });
    const response = freeze.blind_review_enabled === true && actor.role !== 'ADMIN'
      ? { freezePublicId, status: 'RELEASED_WITH_EXCEPTIONS', releasedCount: ids.length }
      : { freezePublicId, status: 'RELEASED_WITH_EXCEPTIONS', taskIds: ids };
    await storeMutation(client, actor, requestId, 'RELEASE', fingerprint, response);
    return response;
  });
}

export async function getProductionBatchSamplingReadiness(pool, rawProductionBatchId, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  const productionBatchId = normalizeTaskId(rawProductionBatchId);
  const batch = await pool.query('SELECT * FROM production_batches WHERE id = $1', [productionBatchId]);
  if (!batch.rows[0]) throw new ControlPlaneNotFoundError('生产批次不存在');
  const readiness = await productionBatchReadiness(pool, productionBatchId);
  if (actor.role === 'ADMIN') return readiness;
  const { blockerTaskIds: _hidden, ...safeReadiness } = readiness;
  return safeReadiness;
}

export async function getCopyQaStatistics(pool, rawActor) {
  normalizeActor(rawActor, ['ADMIN']);
  const [random, mandatory, affected] = await Promise.all([
    pool.query(`
      WITH RECURSIVE roots AS (
        SELECT item.* FROM copy_sampling_items AS item
        WHERE item.sample_kind = 'RANDOM' AND item.selected = true
      ), lineage AS (
        SELECT root.id AS root_item_id, root.id AS item_id FROM roots AS root
        UNION ALL
        SELECT lineage.root_item_id, child.id
        FROM lineage JOIN copy_sampling_items AS child ON child.parent_item_id = lineage.item_id
        WHERE child.sample_kind = 'MANDATORY_RECHECK'
      ), passed_roots AS (
        SELECT DISTINCT lineage.root_item_id
        FROM lineage JOIN copy_sampling_events AS event ON event.sampling_item_id = lineage.item_id
        WHERE event.action = 'PASS'
      )
      SELECT item.final_approver_account_id,
        MAX(item.final_approver_username) AS final_approver_username,
        MAX(approver.display_name) AS final_approver_display_name,
        COUNT(*) FILTER (WHERE item.status = 'RETURNED') AS returned_count,
        COUNT(*) FILTER (
          WHERE item.status <> 'RETURNED' AND EXISTS (
            SELECT 1 FROM copy_sampling_events AS event
            WHERE event.sampling_item_id = item.id AND event.action = 'PASS'
          )
        ) AS passed_count,
        COUNT(*) FILTER (
          WHERE passed_root.root_item_id IS NOT NULL AND (
            item.status = 'RETURNED' OR EXISTS (
              SELECT 1 FROM copy_sampling_events AS event
              WHERE event.sampling_item_id = item.id AND event.action = 'PASS'
            )
          )
        ) AS overall_passed_count,
        COUNT(*) FILTER (WHERE item.status = 'PENDING') AS pending_count
      FROM roots AS item
      LEFT JOIN app_users AS approver ON approver.id = item.final_approver_account_id
      LEFT JOIN passed_roots AS passed_root ON passed_root.root_item_id = item.id
      GROUP BY item.final_approver_account_id
      ORDER BY item.final_approver_account_id
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PASSED') AS passed_count,
        COUNT(*) FILTER (WHERE status = 'RETURNED') AS returned_count,
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_count
      FROM copy_sampling_items WHERE sample_kind = 'MANDATORY_RECHECK'
    `),
    pool.query("SELECT COUNT(*) AS count FROM copy_sampling_items WHERE status = 'BATCH_AFFECTED'"),
  ]);
  return {
    random: random.rows.map((row) => {
      const passed = Number(row.passed_count ?? 0);
      const returned = Number(row.returned_count ?? 0);
      const decided = passed + returned;
      const overallPassed = Number(row.overall_passed_count ?? 0);
      return {
        finalApproverAccountId: Number(row.final_approver_account_id),
        finalApproverUsername: row.final_approver_username,
        finalApproverDisplayName: row.final_approver_display_name ?? null,
        passed,
        returned,
        pending: Number(row.pending_count ?? 0),
        decided,
        accuracyRate: decided === 0 ? null : passed / decided,
        overallPassed,
        overallPassRate: decided === 0 ? null : overallPassed / decided,
      };
    }),
    mandatory: {
      passed: Number(mandatory.rows[0]?.passed_count ?? 0),
      returned: Number(mandatory.rows[0]?.returned_count ?? 0),
      pending: Number(mandatory.rows[0]?.pending_count ?? 0),
    },
    batchAffectedCount: Number(affected.rows[0]?.count ?? 0),
  };
}

export async function getCopyQualityQueues(pool, rawActor) {
  const actor = normalizeActor(rawActor);
  const user = (await pool.query(`SELECT * FROM app_users WHERE id = $1 AND username = $2
    AND role = $3 AND status = 'ACTIVE' AND credential_version = $4`,
  [actor.userId, actor.username, actor.role, actor.credentialVersion])).rows[0];
  if (!user) throw new ControlPlaneAuthenticationError();
  await flushExpiredCopyQualityBatches(pool);
  const result = await pool.query(`SELECT b.id, b.public_id, b.version, b.query_package_name,
    count(*) FILTER (WHERE t.state = 'COPY_REVIEW_PENDING')::integer AS review,
    count(*) FILTER (WHERE t.state = 'COPY_QC_PENDING')::integer AS qc,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM copy_sampling_items i JOIN copy_sampling_freezes f ON f.id = i.freeze_id
      WHERE i.task_id = t.id AND f.status IN ('INSPECTING', 'REVIEW_REQUIRED', 'BATCH_RETURNED')))::integer AS frozen,
    count(*) FILTER (WHERE t.mandatory_copy_qc)::integer AS rework,
    count(*) FILTER (WHERE t.state = 'IMAGE_QUEUED' AND t.copy_qc_released_revision_id = t.current_copy_revision_id
      AND copy_quality_image_eligible(t.id, t.current_copy_revision_id, t.mandatory_copy_qc))::integer AS image
    FROM tasks t LEFT JOIN production_batches b ON b.id = t.production_batch_id
    WHERE $1::boolean OR t.assigned_to_user_id = $2
    GROUP BY b.id ORDER BY b.id DESC NULLS LAST`, [actor.role === 'ADMIN', actor.username]);
  return { capabilities: { review: actor.role === 'ADMIN' || user.copy_review_enabled,
    qc: actor.role === 'ADMIN' || user.copy_qc_enabled, admin: actor.role === 'ADMIN' }, queues: result.rows };
}
