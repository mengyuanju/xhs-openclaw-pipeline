import { createHash, randomUUID } from 'node:crypto';

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
import {
  assertReviewerBatchReturnAllowed,
  lockWorkflowQualitySettings,
  readWorkflowQualitySettings,
} from './workflow-quality-settings.mjs';

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeActor(actor, roles = ['ADMIN', 'REVIEWER']) {
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
  if (!Array.isArray(value) || value.length > 10) throw new RangeError('reasonCodes must contain at most 10 items');
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

function normalizedQueryPackageNameFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('queryPackageName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 200) {
    throw new RangeError('queryPackageName must contain between 1 and 200 characters');
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
  const common = {
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
      canPass: ['ADMIN', 'REVIEWER'].includes(actor.role) && row.status === 'PENDING',
      canReturnSingle: ['ADMIN', 'REVIEWER'].includes(actor.role) && row.status === 'PENDING',
      canReturnBatch: actor.role === 'ADMIN'
        || (actor.role === 'REVIEWER' && row.reviewer_batch_return_enabled === true),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // Blind responses are an allowlist. Do not add task/package/user fields here.
  if (blind) return common;
  return {
    ...common,
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
      COUNT(*) FILTER (WHERE task.state = 'COPY_QC_PENDING') AS approved_count,
      COUNT(*) FILTER (WHERE task.state = 'CANCELLED') AS cancelled_count,
      ARRAY_AGG(task.id ORDER BY task.id) FILTER (
        WHERE task.id IS NOT NULL AND task.state NOT IN ('COPY_QC_PENDING', 'CANCELLED')
      ) AS blocker_task_ids
    FROM production_batch_items AS item
    LEFT JOIN tasks AS task ON task.id = item.task_id
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
              SELECT child.id, child.status, child.sample_kind
              FROM copy_sampling_items AS child
              WHERE child.parent_item_id = returned.id
                AND child.sample_kind = 'MANDATORY_RECHECK'
              UNION ALL
              SELECT child.id, child.status, child.sample_kind
              FROM copy_sampling_items AS child
              JOIN rechecks AS parent ON child.parent_item_id = parent.id
              WHERE child.sample_kind = 'MANDATORY_RECHECK'
            )
            SELECT 1 FROM rechecks AS recheck
            WHERE recheck.sample_kind = 'MANDATORY_RECHECK'
              AND recheck.status IN ('PASSED', 'RELEASED')
          )
      ))
    ORDER BY task.id
    FOR UPDATE OF task, item NOWAIT
  `, [freezeId, withExceptions]);
  const ids = eligible.rows.map((row) => Number(row.task_id));
  const itemIds = eligible.rows.map((row) => Number(row.id));
  if (ids.length) {
    await client.query(`
      UPDATE tasks SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
        progress_percent = 0, progress_message = '文案质检已通过，任务已进入待生图队列，等待图片执行机领取',
        current_execution_id = NULL, current_image_run_id = NULL,
        execution_started_at = NULL, finished_at = NULL, error = NULL,
        pending_snapshot = NULL, mandatory_copy_qc = false,
        mandatory_copy_qc_origin = NULL, last_activity_at = now(), updated_at = now()
      WHERE id = ANY($1::bigint[])
    `, [ids]);
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
  `, [freeze.rows[0].production_batch_id,
    withExceptions ? 'RELEASED_WITH_EXCEPTIONS' : 'RELEASED']);
  await client.query(`
    INSERT INTO copy_sampling_events(
      freeze_id, action, actor_account_id, actor_username, request_id, details
    ) VALUES ($1, 'RELEASE', $2, $3, $4, $5)
  `, [freezeId, actor?.userId ?? null, actor?.username ?? 'system', requestId, { taskIds: ids }]);
  return ids;
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

async function createFreeze(client, productionBatch, settings, actor, requestId) {
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
    ORDER BY task.id
  `, [productionBatch.id]);
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
    rateBps: settings.copySampling.rateBps,
    seed: `${productionBatch.public_id}:${settings.version}:${productionBatch.version}:${settings.copySampling.samplingSeed}`,
  });
  const freeze = await client.query(`
    INSERT INTO copy_sampling_freezes(
      public_id, production_batch_id, policy_version, rate_bps, seed,
      algorithm_version, blind_review_enabled, population_count, sample_count,
      snapshot_sha256, frozen_by_account_id, frozen_by_username,
      request_id, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `, [randomUUID(), productionBatch.id, settings.version, plan.rateBps, plan.seed,
    plan.algorithmVersion, settings.copySampling.blindReviewEnabled,
    plan.populationCount, plan.sampleCount, plan.snapshotSha256,
    actor?.userId ?? null, actor?.username ?? 'system', requestId,
    hashJson({ productionBatchId: Number(productionBatch.id), version: Number(productionBatch.version) })]);
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
    { populationCount: plan.populationCount, sampleCount: plan.sampleCount, snapshotSha256: plan.snapshotSha256 }]);
  if (plan.sampleCount === 0) {
    await releaseFrozenMembers(client, freeze.rows[0].id, actor, requestId);
  }
  return { frozen: true, freezeId: freeze.rows[0].public_id, ...plan };
}

export async function attemptAutomaticCopySamplingFreeze(client, productionBatchId, actor = null) {
  if (productionBatchId === null || productionBatchId === undefined) return { ready: false, reason: 'NO_BATCH' };
  const batch = await client.query('SELECT * FROM production_batches WHERE id = $1 FOR UPDATE', [productionBatchId]);
  if (!batch.rows[0] || batch.rows[0].sampling_status !== 'OPEN') {
    return { ready: false, reason: 'ALREADY_FROZEN' };
  }
  const readiness = await productionBatchReadiness(client, productionBatchId);
  if (!readiness.ready) return { ...readiness, frozen: false, reason: 'INITIAL_REVIEW_INCOMPLETE' };
  const settings = await readWorkflowQualitySettings(client);
  if (!settings.copySampling.enabled) {
    const ids = (await client.query(`
      SELECT task.id FROM production_batch_items AS item
      JOIN tasks AS task ON task.id = item.task_id
      WHERE item.production_batch_id = $1 AND task.state = 'COPY_QC_PENDING'
      ORDER BY task.id FOR UPDATE OF task
    `, [productionBatchId])).rows.map((row) => Number(row.id));
    if (ids.length) await client.query(`
      UPDATE tasks SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
        progress_percent = 0, progress_message = '文案审核已完成，任务已进入待生图队列，等待图片执行机领取',
        execution_started_at = NULL, finished_at = NULL, updated_at = now()
      WHERE id = ANY($1::bigint[])
    `, [ids]);
    await client.query(`
      UPDATE production_batches SET status = 'RELEASED', sampling_status = 'COMPLETED',
        version = version + 1, updated_at = now() WHERE id = $1
    `, [productionBatchId]);
    return { ...readiness, frozen: false, released: true };
  }
  return { ...readiness, ...await createFreeze(client, batch.rows[0], settings, actor, randomUUID()) };
}

export async function routeManualCopyApproval(client, {
  task,
  revision,
  assessment,
  actor,
  reviewSessionId,
  aiDisclosureEnabled,
}) {
  const approval = await insertCopyApprovalEvent(client, {
    taskId: Number(task.id),
    copyRevisionId: Number(revision.id),
    assessmentId: assessment?.id ?? null,
    actor,
    reviewSessionId,
    content: revision.content,
  });
  if (task.mandatory_copy_qc === true) {
    const mandatoryOrigin = task.mandatory_copy_qc_origin;
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
        WHERE item.task_id = $1 AND item.status IN ('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED')
          AND sampling_freeze.status <> 'CANCELLED'
        ORDER BY item.updated_at DESC, item.id DESC LIMIT 1
        FOR UPDATE OF item, sampling_freeze
      `, [task.id]);
      parent = priorReturn.rows[0] ?? null;
      policyVersion = Number(parent?.parent_policy_version);
      blindReviewEnabled = parent?.parent_blind_review_enabled === true;
    } else if (mandatoryOrigin === 'FINAL_REWORK') {
      // A final image-review return has no random-sampling parent. Freeze a new
      // one-task QA round against the live policy instead of attaching it to an
      // unrelated historical return for the same task.
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
        public_id, query_package_id, query_package_name, status, sampling_status,
        created_by_account_id, created_by_username, request_id, request_fingerprint
      ) VALUES ($1, NULL, '强制文案复检', 'FROZEN', 'FROZEN', $2, $3, $4, $5)
      RETURNING *
    `, [randomUUID(), actor?.userId ?? null, actor?.username ?? 'system', randomUUID(),
      hashJson({ taskId: Number(task.id), revisionId: Number(revision.id), origin: task.mandatory_copy_qc_origin })]);
    const productionBatchId = Number(syntheticBatch.rows[0].id);
    const freeze = await client.query(`
      INSERT INTO copy_sampling_freezes(
        public_id, production_batch_id, policy_version, rate_bps, seed,
        algorithm_version, blind_review_enabled, population_count, sample_count,
        snapshot_sha256, frozen_by_account_id, frozen_by_username,
        request_id, request_fingerprint, status
      ) VALUES ($1, $2, $3, 10000, $4, 'mandatory-recheck-v1',
        $5, 1, 1, $6, $7, $8, $9, $10, 'REVIEW_REQUIRED')
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
      approval.approved_by_account_id, approval.approved_by_username, rankHash, parent?.id ?? null]);
    await client.query(`
      UPDATE production_batches SET status = 'REVIEW_REQUIRED', sampling_status = 'FROZEN',
        version = version + 1, updated_at = now() WHERE id = $1
    `, [productionBatchId]);
    const updated = await client.query(`
      UPDATE tasks SET state = 'COPY_QC_PENDING', production_batch_id = COALESCE(production_batch_id, $2),
        current_copy_revision_id = $3, ai_disclosure_enabled = $4,
        current_execution_id = NULL, current_image_run_id = NULL,
        current_stage = 'QC_MANDATORY_RECHECK', progress_percent = 100,
        progress_message = '返工稿已记录为最终 3 分并提交强制复检；复检通过后才进入待生图队列',
        execution_started_at = NULL, finished_at = NULL, error = NULL,
        pending_snapshot = NULL, last_activity_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *
    `, [task.id, productionBatchId, revision.id, aiDisclosureEnabled]);
    return { task: updated.rows[0], approval, samplingItem: recheck.rows[0] };
  }
  // Every production-batch member is held until the batch's initial review is
  // closed. The sampling policy is read exactly once at that boundary, so a
  // mid-batch settings change cannot let early approvals escape the snapshot.
  const shouldHold = task.production_batch_id !== null;
  const updated = await client.query(`
    UPDATE tasks SET
      state = $2, current_copy_revision_id = $3, ai_disclosure_enabled = $4,
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
    if (batch.rows[0].sampling_status !== 'OPEN') {
      throw new ControlPlaneConflictError('BATCH_ALREADY_FROZEN', '生产批次已冻结或已结束');
    }
    const readiness = await productionBatchReadiness(client, productionBatchId);
    if (!readiness.ready) {
      const error = new ControlPlaneConflictError('INITIAL_REVIEW_INCOMPLETE', '生产批次仍有文案尚未完成初审');
      error.details = readiness;
      throw error;
    }
    const settings = await readWorkflowQualitySettings(client);
    const response = await createFreeze(client, batch.rows[0], settings, actor, requestId);
    await storeMutation(client, actor, requestId, 'FREEZE', fingerprint, response);
    return response;
  });
}

const QA_ITEM_SQL = `
  SELECT item.*, sampling_freeze.public_id AS freeze_public_id, sampling_freeze.production_batch_id,
    sampling_freeze.blind_review_enabled, revision.revision AS copy_revision_number,
    revision.content AS copy_content, task.query, task.assigned_to_user_id,
    task.created_by_user_id, batch.public_id AS production_batch_public_id,
    batch.query_package_name,
    settings.reviewer_batch_return_enabled
  FROM copy_sampling_items AS item
  JOIN copy_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
  JOIN production_batches AS batch ON batch.id = sampling_freeze.production_batch_id
  JOIN copy_revisions AS revision ON revision.id = item.copy_revision_id
  JOIN tasks AS task ON task.id = item.task_id
  CROSS JOIN workflow_quality_settings AS settings
`;

export async function listCopyQaItems(pool, {
  status = 'PENDING',
  queryPackageName: rawQueryPackageName = null,
  limit: rawLimit = 50,
  offset: rawOffset = 0,
} = {}, rawActor) {
  const actor = normalizeActor(rawActor);
  const allowedStatuses = ['ALL', 'PENDING', 'PASSED', 'RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED', 'RELEASED'];
  if (!allowedStatuses.includes(status)) throw new TypeError('copy QA status is invalid');
  const queryPackageName = normalizedQueryPackageNameFilter(rawQueryPackageName);
  if (queryPackageName !== null && actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('只有管理员可以按词包名称筛选文案抽检项');
  }
  const { limit, offset } = normalizeListPagination(rawLimit, rawOffset);
  const values = [status === 'ALL' ? null : status, actor.role === 'REVIEWER' ? actor.userId : null];
  const packageFilter = queryPackageName === null ? '' : (() => {
    values.push(queryPackageName);
    return `AND strpos(lower(batch.query_package_name), lower($${values.length})) > 0`;
  })();
  values.push(limit, offset);
  const limitParameter = values.length - 1;
  const offsetParameter = values.length;
  const result = await pool.query(`${QA_ITEM_SQL}
    WHERE item.selected = true AND ($1::varchar IS NULL OR item.status = $1)
      AND ($2::bigint IS NULL OR item.final_approver_account_id <> $2)
      ${packageFilter}
    ORDER BY lower(batch.query_package_name) NULLS LAST, batch.query_package_name NULLS LAST,
      item.created_at, item.id
    LIMIT $${limitParameter} OFFSET $${offsetParameter}
  `, values);
  return result.rows.map((row) => qaItemFrom(row, actor));
}

export async function getCopyQaItem(pool, rawItemId, rawActor) {
  const actor = normalizeActor(rawActor);
  const identifier = qaItemIdentifier(rawItemId);
  const result = await pool.query(`${QA_ITEM_SQL}
    WHERE ($1::bigint IS NOT NULL AND item.id = $1)
       OR ($2::uuid IS NOT NULL AND item.public_id = $2)
  `, [identifier.id, identifier.publicId]);
  const row = result.rows[0];
  if (!row) throw new ControlPlaneNotFoundError('抽检项不存在');
  if (actor.role === 'REVIEWER' && row.selected !== true) {
    // Keep held population membership opaque. Reviewers receive unselected
    // identifiers only as an atomic batch-return confirmation scope.
    throw new ControlPlaneNotFoundError('抽检项不存在');
  }
  if (actor.role === 'REVIEWER' && Number(row.final_approver_account_id) === actor.userId) {
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

async function maybeReleasePassedFreeze(client, item, actor, requestId) {
  const unresolved = Number((await client.query(`
    SELECT COUNT(*) AS count
    FROM copy_sampling_items AS item
    WHERE item.freeze_id = $1 AND (
      item.status = 'PENDING'
      OR (
        item.status IN ('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED')
        AND NOT EXISTS (
          WITH RECURSIVE rechecks AS (
            SELECT child.id, child.status, child.sample_kind
            FROM copy_sampling_items AS child
            WHERE child.parent_item_id = item.id
              AND child.sample_kind = 'MANDATORY_RECHECK'
            UNION ALL
            SELECT child.id, child.status, child.sample_kind
            FROM copy_sampling_items AS child
            JOIN rechecks AS parent ON child.parent_item_id = parent.id
            WHERE child.sample_kind = 'MANDATORY_RECHECK'
          )
          SELECT 1 FROM rechecks AS recheck
          WHERE recheck.sample_kind = 'MANDATORY_RECHECK'
            AND recheck.status IN ('PASSED', 'RELEASED')
        )
      )
    )
  `, [item.freeze_id])).rows[0].count);
  if (unresolved === 0) return releaseFrozenMembers(client, item.freeze_id, actor, requestId);
  return null;
}

async function maybeReleaseAncestorFreezes(client, item, actor, requestId) {
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
    if (['INSPECTING', 'REVIEW_REQUIRED'].includes(row.freeze_status)) {
      releasedTaskIds.push(...(await maybeReleasePassedFreeze(client, row, actor, requestId) ?? []));
    }
    parentItemId = row.parent_item_id;
  }
  return releasedTaskIds;
}

export async function passCopyQaItem(pool, rawItemId, input, rawActor) {
  const actor = normalizeActor(rawActor);
  const { requestId, reasonCodes, note } = normalizedRequest(input, 'PASS');
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const item = await lockQaItem(client, rawItemId);
    const expectedRevision = assertExpectedQaRevision(item, input);
    const fingerprint = hashJson({ itemId: String(rawItemId), ...expectedRevision, reasonCodes, note });
    const replay = await mutationReplay(client, actor, requestId, 'PASS', fingerprint);
    if (replay) return replay;
    if (actor.role === 'REVIEWER' && Number(item.final_approver_account_id) === actor.userId) {
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
    await client.query(`
      INSERT INTO copy_sampling_events(
        freeze_id, sampling_item_id, action, actor_account_id, actor_username,
        reason_codes, note, request_id
      ) VALUES ($1, $2, 'PASS', $3, $4, $5, $6, $7)
    `, [item.freeze_id, item.id, actor.userId, actor.username, reasonCodes, note, requestId]);
    const currentRoundReleased = await maybeReleasePassedFreeze(client, item, actor, requestId);
    const parentRoundReleased = await maybeReleaseAncestorFreezes(client, item, actor, requestId);
    const releasedTaskIds = [...new Set([
      ...(currentRoundReleased ?? []),
      ...(parentRoundReleased ?? []),
    ])];
    const response = qaActionResponse(item, actor, 'PASSED', releasedTaskIds);
    await storeMutation(client, actor, requestId, 'PASS', fingerprint, response);
    return response;
  });
}

async function appendReturnedRevision(client, item, actor, requestId, origin, { reasonCodes, note }) {
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
      note,
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
  if (!reasonCodes.length && !note) throw new TypeError('single return requires a reason or note');
  return withTransaction(pool, async (client) => {
    await lockActiveQualityActor(client, actor);
    await lockQualityMutationRequest(client, actor, requestId);
    const item = await lockQaItem(client, rawItemId);
    const expectedRevision = assertExpectedQaRevision(item, input);
    const fingerprint = hashJson({ itemId: String(rawItemId), expectedTaskId, ...expectedRevision, reasonCodes, note });
    const replay = await mutationReplay(client, actor, requestId, 'RETURN_SINGLE', fingerprint);
    if (replay) return replay;
    if (expectedTaskId !== null && Number(item.task_id) !== normalizeTaskId(expectedTaskId)) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检项不属于指定任务');
    }
    if (actor.role === 'REVIEWER' && Number(item.final_approver_account_id) === actor.userId) {
      throw new ControlPlaneAuthorizationError('不能质检自己最终通过的文案');
    }
    if (item.status !== 'PENDING' || item.task_state !== 'COPY_QC_PENDING'
        || Number(item.current_copy_revision_id) !== Number(item.copy_revision_id)) {
      throw new ControlPlaneConflictError('STALE_QA_ITEM', '抽检版本或任务状态已变化');
    }
    const revision = await appendReturnedRevision(client, item, actor, requestId, 'SINGLE', { reasonCodes, note });
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
        reason_codes, note, request_id
      ) VALUES ($1, $2, 'RETURN_SINGLE', $3, $4, $5, $6, $7)
    `, [item.freeze_id, item.id, actor.userId, actor.username, reasonCodes, note, requestId]);
    const response = item.blind_review_enabled === true && actor.role !== 'ADMIN'
      ? { id: item.public_id, status: 'RETURNED' }
      : { ...qaActionResponse(item, actor, 'RETURNED'), returnedRevisionId: Number(revision.id) };
    await storeMutation(client, actor, requestId, 'RETURN_SINGLE', fingerprint, response);
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
    if (actor.role === 'REVIEWER' && Number(trigger.final_approver_account_id) === actor.userId) {
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
      await appendReturnedRevision(client, item, actor, requestId, 'BATCH', { reasonCodes, note });
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
        triggerSamplingItemId,
        affectedItemIds,
        alreadyReturnedItemIds: eligible.rows
          .filter((row) => row.status === 'RETURNED')
          .map((row) => row.public_id),
        memberHashes: eligible.rows.map((row) => ({ id: row.public_id, memberHash: batchMemberHash(row) })),
        snapshotSha256: freeze.snapshot_sha256,
        affectedCount: affectedItemIds.length,
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
  const actor = normalizeActor(rawActor);
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
  const actor = normalizeActor(rawActor);
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
    const ids = await releaseFrozenMembers(client, freeze.id, actor, requestId, { withExceptions: true });
    const response = freeze.blind_review_enabled === true && actor.role !== 'ADMIN'
      ? { freezePublicId, status: 'RELEASED_WITH_EXCEPTIONS', releasedCount: ids.length }
      : { freezePublicId, status: 'RELEASED_WITH_EXCEPTIONS', taskIds: ids };
    await storeMutation(client, actor, requestId, 'RELEASE', fingerprint, response);
    return response;
  });
}

export async function getProductionBatchSamplingReadiness(pool, rawProductionBatchId, rawActor) {
  const actor = normalizeActor(rawActor);
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
      SELECT item.final_approver_account_id,
        MAX(item.final_approver_username) AS final_approver_username,
        COUNT(*) FILTER (WHERE item.status = 'RETURNED') AS returned_count,
        COUNT(*) FILTER (
          WHERE item.status <> 'RETURNED' AND EXISTS (
            SELECT 1 FROM copy_sampling_events AS event
            WHERE event.sampling_item_id = item.id AND event.action = 'PASS'
          )
        ) AS passed_count,
        COUNT(*) FILTER (WHERE item.status = 'PENDING') AS pending_count
      FROM copy_sampling_items AS item
      WHERE item.sample_kind = 'RANDOM' AND item.selected = true
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
      return {
        finalApproverAccountId: Number(row.final_approver_account_id),
        finalApproverUsername: row.final_approver_username,
        passed,
        returned,
        pending: Number(row.pending_count ?? 0),
        decided,
        accuracyRate: decided === 0 ? null : passed / decided,
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
