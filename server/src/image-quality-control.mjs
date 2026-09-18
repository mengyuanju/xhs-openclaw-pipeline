import { createHash, randomUUID } from 'node:crypto';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  normalizeTaskId,
  normalizeUuid,
} from './domain.mjs';
import {
  PENDING_IMAGE_EDIT_STATUSES,
  assertNoPendingImageEdits,
  createReadyDeliveryEntry,
  withdrawReadyDeliveryEntries,
} from './final-delivery.mjs';
import { normalizeListPagination } from './list-pagination.mjs';
import { lockWorkflowQualitySettings, readWorkflowQualitySettings } from './workflow-quality-settings.mjs';
import { normalizeHumanQualitySettings } from '../../src/human-quality-settings.mjs';

export const IMAGE_SAMPLING_ALGORITHM_VERSION = 'account-bps-remainder-v1';
const IMAGE_BATCH_TAIL_MS = 30 * 60 * 1000;

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function clientBatchCodeForTask(task) {
  const existing=String(task?.source_client_batch_code??'').trim().toLowerCase();
  return /^[0-9a-f]{32}$/u.test(existing)?existing:randomUUID().replaceAll('-','');
}

function normalizeActor(actor, roles) {
  if (!actor || !roles.includes(actor.role) || !Number.isSafeInteger(Number(actor.userId))) {
    throw new ControlPlaneAuthorizationError('当前账号不能执行图片质检操作');
  }
  return { ...actor, userId: Number(actor.userId), username: String(actor.username ?? '').trim().toLowerCase() };
}

async function lockActiveActor(client, actor, { quality = false } = {}) {
  const credentialVersion = Number(actor.credentialVersion);
  const result = await client.query(`
    SELECT id, username, role FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3 AND status = 'ACTIVE'
      AND ($4::integer IS NULL OR credential_version = $4)
      ${quality ? "AND (role = 'ADMIN' OR (role = 'REVIEWER' AND image_qc_enabled))" : "AND role IN ('ADMIN','USER')"}
    FOR SHARE
  `, [actor.userId, actor.username, actor.role,
    Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : null]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
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
    if (['40P01', '55P03'].includes(error?.code)) {
      throw new ControlPlaneConflictError('IMAGE_QA_BUSY', '图片质检数据正在更新，请刷新后重试');
    }
    throw error;
  } finally {
    client.release();
  }
}

function normalizeNote(value, { required = false } = {}) {
  const note = String(value ?? '').replace(/\r\n?/gu, '\n').trim();
  if ([...note].length > 1_000) throw new RangeError('note cannot exceed 1000 characters');
  if (required && !note) throw new TypeError('返工时必须填写具体修改说明');
  return note || null;
}

function normalizeReasons(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new RangeError('reasonCodes must contain at most 10 items');
  const result = value.map((entry, index) => {
    const reason = String(entry ?? '').trim();
    if (!reason || [...reason].length > 50) throw new RangeError(`reasonCodes[${index}] is invalid`);
    return reason;
  });
  if (new Set(result).size !== result.length) throw new TypeError('reasonCodes must be unique');
  return result.toSorted();
}

function normalizeIdList(value, name, { max = 20 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new RangeError(`${name} must contain at most ${max} items`);
  const result = value.map((entry) => normalizeTaskId(entry));
  if (new Set(result).size !== result.length) throw new TypeError(`${name} must be unique`);
  return result.toSorted((left, right) => left - right);
}

function normalizeCopyFields(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('copyFields must be an array');
  const allowed = new Set(['TITLE', 'BODY', 'TAGS', 'IMAGE_PLAN']);
  const fields = value.map((entry) => String(entry ?? '').trim().toUpperCase());
  if (fields.some((field) => !allowed.has(field)) || new Set(fields).size !== fields.length) {
    throw new TypeError('copyFields contains an invalid or duplicate field');
  }
  return fields.toSorted();
}

function normalizeScore(value, decision) {
  const score = Number(value);
  const scoreX10 = Math.round(score * 10);
  if (!Number.isFinite(score) || ![10, 20, 25, 30].includes(scoreX10) || scoreX10 !== score * 10) {
    throw new RangeError('score must be 1, 2, 2.5 or 3');
  }
  if (decision === 'PASS' && scoreX10 <= 20) {
    throw new ControlPlaneConflictError('QUALITY_SCORE_TOO_LOW', '图片得分高于 2 分才能通过');
  }
  if (decision === 'RETURN' && scoreX10 > 20) {
    throw new ControlPlaneConflictError('QUALITY_SCORE_TOO_HIGH', '图片得分高于 2 分时不能发起返工');
  }
  return scoreX10;
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

async function imageSnapshot(client, taskId, imageRunId) {
  const result = await client.query(`
    SELECT asset.id, asset.media_type, asset.byte_size, asset.sha256, asset.original_name,
      page.page_index, jsonb_array_length(image_run.result->'images') AS expected_page_count
    FROM image_runs AS image_run
    CROSS JOIN LATERAL jsonb_array_elements(image_run.result->'images')
      WITH ORDINALITY AS page(image, page_index)
    JOIN image_run_asset_view AS asset
      ON asset.task_id = image_run.task_id AND asset.image_run_id = image_run.id
      AND asset.id::text = COALESCE(page.image->>'deliveryAssetId', page.image->>'assetId')
    WHERE image_run.task_id = $1 AND image_run.id = $2
    ORDER BY page.page_index
  `, [taskId, imageRunId]);
  const expectedPageCount = Number(result.rows[0]?.expected_page_count ?? 0);
  if (result.rows.length < 1 || result.rows.length !== expectedPageCount) {
    throw new ControlPlaneConflictError('IMAGE_ASSETS_MISSING', '当前图片版本的最终交付图片不完整');
  }
  const assets = result.rows.map((row) => ({
    id: Number(row.id), mediaType: row.media_type, byteSize: Number(row.byte_size),
    sha256: row.sha256, originalName: row.original_name, pageIndex: Number(row.page_index),
  }));
  return { assets, sha256: hash(assets) };
}

async function legacyImageSnapshotSha256(client, taskId, imageRunId) {
  const result = await client.query(`
    SELECT id, media_type, byte_size, sha256, original_name
    FROM image_run_asset_view
    WHERE task_id = $1 AND image_run_id = $2
    ORDER BY id
  `, [taskId, imageRunId]);
  if (result.rows.length < 1) return null;
  return hash(result.rows.map((row) => ({
    id: Number(row.id), mediaType: row.media_type, byteSize: Number(row.byte_size),
    sha256: row.sha256, originalName: row.original_name,
  })));
}

async function ensureProductionBatch(client, task, actor) {
  if (task.production_batch_id) return Number(task.production_batch_id);
  const publicId = randomUUID();
  const requestId = randomUUID();
  const name = task.source_query_package_name || `单任务图片抽检-${task.id}`;
  const batch = (await client.query(`
    INSERT INTO production_batches(
      public_id, query_package_id, query_package_name, client_batch_code, status, sampling_status,
      created_by_account_id, created_by_username, request_id, request_fingerprint
    ) VALUES ($1, NULL, $2, $3, 'OPEN', 'OPEN', $4, $5, $6, $7)
    RETURNING id
  `, [publicId, name, clientBatchCodeForTask(task), actor.userId, actor.username, requestId,
    hash({ taskId: Number(task.id), kind: 'IMAGE_SELF_REVIEW' })])).rows[0];
  await client.query(`
    INSERT INTO production_batch_items(production_batch_id, query_snapshot, task_id)
    VALUES ($1, $2, $3)
  `, [batch.id, task.query, task.id]);
  await client.query('UPDATE tasks SET production_batch_id = $2 WHERE id = $1', [task.id, batch.id]);
  return Number(batch.id);
}

async function releaseApproval(client, approval, actor, message) {
  const locked = (await client.query(`
    SELECT * FROM tasks WHERE id = $1 FOR UPDATE
  `, [approval.task_id])).rows[0];
  if (!locked || Number(locked.current_copy_revision_id) !== Number(approval.copy_revision_id)
      || locked.current_image_run_id !== approval.image_run_id) return false;
  const snapshot = await imageSnapshot(client, Number(locked.id), locked.current_image_run_id);
  if (snapshot.sha256 !== approval.image_set_sha256) {
    // Approvals created before the final-delivery-only snapshot rollout hashed every
    // asset in the run and did not include page indexes. Keep those frozen approvals
    // verifiable during the rolling upgrade without weakening checks for new records.
    const legacySha256 = await legacyImageSnapshotSha256(
      client, Number(locked.id), locked.current_image_run_id,
    );
    if (legacySha256 !== approval.image_set_sha256) {
      throw new ControlPlaneConflictError('IMAGE_VERSION_CHANGED', '图片文件已经变化，必须重新提交初审');
    }
  }
  const updated = (await client.query(`
    UPDATE tasks SET state = 'REVIEWED', current_stage = 'REVIEWED', progress_percent = 100,
      progress_message = $3, image_qc_released_approval_event_id = $2,
      image_qc_legacy_accepted = false, mandatory_image_qc = false,
      mandatory_image_qc_origin = NULL, image_rework_source_run_id = NULL,
      image_reviewed_at = now(), image_reviewed_by_user_id = $4,
      finished_at = COALESCE(finished_at, now()), last_activity_at = now(), updated_at = now()
    WHERE id = $1 RETURNING *
  `, [locked.id, approval.id, message, actor.username])).rows[0];
  await createReadyDeliveryEntry(client, {
    taskId: Number(updated.id), copyRevisionId: Number(updated.current_copy_revision_id),
    imageRunId: updated.current_image_run_id, actor,
  });
  return true;
}

async function latestReturnedParent(client, taskId) {
  const result = await client.query(`
    SELECT id FROM image_sampling_items
    WHERE task_id = $1 AND status IN ('RETURNED', 'BATCH_RETURNED')
    ORDER BY reviewed_at DESC NULLS LAST, id DESC LIMIT 1
  `, [taskId]);
  return result.rows[0]?.id ?? null;
}

async function createMandatoryFreeze(client, { task, approval, actor, settings }) {
  const batchId = await ensureProductionBatch(client, task, actor);
  const publicId = randomUUID();
  const requestId = randomUUID();
  const snapshotSha256 = hash({ kind: 'MANDATORY_RECHECK', approvalId: Number(approval.id), imageSet: approval.image_set_sha256 });
  const version = Number((await client.query(`
    SELECT COALESCE(max(freeze_version), 0) + 1 AS version
    FROM image_sampling_freezes WHERE production_batch_id = $1 AND submitter_account_id = $2
  `, [batchId, actor.userId])).rows[0].version);
  const freeze = (await client.query(`
    INSERT INTO image_sampling_freezes(
      public_id, production_batch_id, freeze_version, policy_version, rate_bps, seed,
      algorithm_version, blind_review_enabled, submitter_account_id,
      population_count, sample_count, snapshot_sha256, frozen_by_account_id,
      frozen_by_username, request_id, close_reason
    ) VALUES ($1,$2,$3,$4,10000,$5,$6,$7,$8,1,1,$9,$10,$11,$12,'MANDATORY_RECHECK')
    RETURNING *
  `, [publicId, batchId, version, settings.version, settings.imageSampling.samplingSeed,
    IMAGE_SAMPLING_ALGORITHM_VERSION, settings.imageSampling.blindReviewEnabled,
    actor.userId, snapshotSha256, actor.userId, actor.username, requestId])).rows[0];
  const parentId = await latestReturnedParent(client, Number(task.id));
  const item = (await client.query(`
    INSERT INTO image_sampling_items(
      public_id, freeze_id, task_id, approval_event_id, copy_revision_id,
      image_run_id, image_set_sha256, submitter_account_id, submitter_username,
      rank_hash, selected, sample_kind, parent_item_id, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'MANDATORY_RECHECK',$11,'PENDING')
    RETURNING *
  `, [randomUUID(), freeze.id, task.id, approval.id, approval.copy_revision_id,
    approval.image_run_id, approval.image_set_sha256, actor.userId, actor.username,
    hash(`${settings.imageSampling.samplingSeed}\0${approval.id}\0${approval.image_set_sha256}`), parentId])).rows[0];
  await client.query(`
    INSERT INTO image_sampling_events(freeze_id, sampling_item_id, action, actor_account_id, actor_username, request_id, details)
    VALUES ($1,$2,'FREEZE',$3,$4,$5,$6)
  `, [freeze.id, item.id, actor.userId, actor.username, requestId,
    { kind: 'MANDATORY_RECHECK', parentItemId: parentId }]);
  return freeze;
}

function chunkSize(rateBps) {
  if (rateBps <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(10_000 / rateBps));
}

async function pendingApprovalRows(client, productionBatchId, submitterAccountId, limit = null) {
  const values = [productionBatchId, submitterAccountId];
  const limitSql = limit === null ? '' : (() => { values.push(limit); return `LIMIT $${values.length}`; })();
  return (await client.query(`
    SELECT approval.*, task.query, task.production_batch_id
    FROM image_approval_events AS approval
    JOIN tasks AS task ON task.id = approval.task_id
      AND task.current_copy_revision_id = approval.copy_revision_id
      AND task.current_image_run_id = approval.image_run_id
      AND task.state = 'IMAGE_QC_PENDING'
    WHERE task.production_batch_id = $1 AND approval.submitted_by_account_id = $2
      AND NOT EXISTS (SELECT 1 FROM image_sampling_items item WHERE item.approval_event_id = approval.id)
    ORDER BY approval.submitted_at, approval.id
    ${limitSql}
    FOR UPDATE OF approval
  `, values)).rows;
}

async function releaseFreeze(client, freeze, actor) {
  const approvals = (await client.query(`
    SELECT approval.*, item.id AS item_id, item.status AS item_status,
      item.sample_kind, item.parent_item_id
    FROM image_sampling_items AS item
    JOIN image_approval_events AS approval ON approval.id = item.approval_event_id
    WHERE item.freeze_id = $1 ORDER BY item.id FOR UPDATE OF item
  `, [freeze.id])).rows;
  for (const approval of approvals) {
    await releaseApproval(client, approval, actor, '图片抽检批次已通过，进入交付池');
  }
  await client.query(`
    UPDATE image_sampling_items SET status = CASE WHEN status = 'PASSED' THEN 'PASSED' ELSE 'RELEASED' END,
      updated_at = now() WHERE freeze_id = $1 AND status IN ('NOT_SELECTED', 'PASSED')
  `, [freeze.id]);
  await client.query(`
    UPDATE image_sampling_freezes SET status = 'RELEASED', resolved_at = now(), version = version + 1
    WHERE id = $1
  `, [freeze.id]);
  await client.query(`
    INSERT INTO image_sampling_events(freeze_id, action, actor_account_id, actor_username, request_id, details)
    VALUES ($1,'RELEASE',$2,$3,$4,$5)
  `, [freeze.id, actor.userId ?? null, actor.username, randomUUID(), { memberCount: approvals.length }]);
  const parentIds = [...new Set(approvals
    .filter((approval) => approval.sample_kind === 'MANDATORY_RECHECK' && approval.parent_item_id)
    .map((approval) => Number(approval.parent_item_id)))];
  for (const parentId of parentIds) {
    const parent = (await client.query(`
      UPDATE image_sampling_items SET status = 'SUPERSEDED', updated_at = now()
      WHERE id = $1 AND status IN ('RETURNED', 'BATCH_RETURNED')
      RETURNING freeze_id
    `, [parentId])).rows[0];
    if (!parent) continue;
    const blockers = Number((await client.query(`
      SELECT count(*)::integer AS count FROM image_sampling_items
      WHERE freeze_id = $1 AND (
        (selected AND status NOT IN ('PASSED', 'RELEASED', 'SUPERSEDED'))
        OR status IN ('RETURNED', 'BATCH_RETURNED')
      )
    `, [parent.freeze_id])).rows[0].count);
    if (blockers === 0) await releaseFreeze(client, { id: parent.freeze_id }, actor);
  }
}

export async function attemptAutomaticImageSamplingFreeze(client, {
  productionBatchId: rawBatchId,
  submitterAccountId: rawAccountId,
  actor = { userId: null, username: 'system' },
  force = false,
  now = new Date(),
} = {}) {
  const productionBatchId = normalizeTaskId(rawBatchId);
  const submitterAccountId = normalizeTaskId(rawAccountId);
  const settings = await lockWorkflowQualitySettings(client);
  if (!settings.imageSampling.enabled || settings.imageSampling.rateBps === 0) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `image-batch:${productionBatchId}`,
    `image-submitter:${submitterAccountId}`,
  ]);
  const allPending = await pendingApprovalRows(client, productionBatchId, submitterAccountId);
  if (allPending.length < 1) return null;
  const fullChunkSize = chunkSize(settings.imageSampling.rateBps);
  const oldestMs = new Date(allPending[0].submitted_at).valueOf();
  const tailExpired = Number.isFinite(oldestMs) && now.valueOf() - oldestMs >= IMAGE_BATCH_TAIL_MS;
  if (!force && allPending.length < fullChunkSize && !tailExpired) return null;
  const population = allPending.slice(0, allPending.length >= fullChunkSize ? fullChunkSize : allPending.length);
  const remainderResult = await client.query(`
    INSERT INTO image_sampling_remainders(production_batch_id, submitter_account_id, remainder_bps)
    VALUES ($1,$2,0)
    ON CONFLICT(production_batch_id, submitter_account_id) DO UPDATE SET updated_at = now()
    RETURNING remainder_bps
  `, [productionBatchId, submitterAccountId]);
  const remainderBefore = Number(remainderResult.rows[0].remainder_bps);
  const numerator = population.length * settings.imageSampling.rateBps + remainderBefore;
  const sampleCount = Math.min(population.length, Math.max(
    force || tailExpired ? 1 : 0,
    Math.floor(numerator / 10_000),
  ));
  const remainderAfter = numerator % 10_000;
  const ranked = population.map((row) => ({
    ...row,
    rankHash: hash([IMAGE_SAMPLING_ALGORITHM_VERSION, settings.imageSampling.samplingSeed,
      row.task_id, row.copy_revision_id, row.image_run_id, row.id, row.image_set_sha256].join('\0')),
  })).toSorted((left, right) => left.rankHash.localeCompare(right.rankHash) || Number(left.id) - Number(right.id));
  const selectedIds = new Set(ranked.slice(0, sampleCount).map((row) => Number(row.id)));
  const ordered = population.toSorted((left, right) => Number(left.id) - Number(right.id));
  const snapshotSha256 = hash({
    algorithmVersion: IMAGE_SAMPLING_ALGORITHM_VERSION,
    rateBps: settings.imageSampling.rateBps,
    seed: settings.imageSampling.samplingSeed,
    remainderBefore, remainderAfter,
    members: ordered.map((row) => ({ approvalId: Number(row.id), taskId: Number(row.task_id),
      imageRunId: row.image_run_id, imageSetSha256: row.image_set_sha256,
      selected: selectedIds.has(Number(row.id)) })),
  });
  const version = Number((await client.query(`
    SELECT COALESCE(max(freeze_version), 0) + 1 AS version FROM image_sampling_freezes
    WHERE production_batch_id = $1 AND submitter_account_id = $2
  `, [productionBatchId, submitterAccountId])).rows[0].version);
  const requestId = randomUUID();
  const freeze = (await client.query(`
    INSERT INTO image_sampling_freezes(
      public_id, production_batch_id, freeze_version, policy_version, rate_bps, seed,
      algorithm_version, blind_review_enabled, submitter_account_id, population_count,
      sample_count, remainder_before, remainder_after, snapshot_sha256,
      frozen_by_account_id, frozen_by_username, request_id, close_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING *
  `, [randomUUID(), productionBatchId, version, settings.version, settings.imageSampling.rateBps,
    settings.imageSampling.samplingSeed, IMAGE_SAMPLING_ALGORITHM_VERSION,
    settings.imageSampling.blindReviewEnabled, submitterAccountId, population.length,
    sampleCount, remainderBefore, remainderAfter, snapshotSha256, actor.userId ?? null,
    actor.username, requestId, force ? 'MANUAL_CLOSE' : tailExpired ? 'TAIL_TIMEOUT' : 'FULL_CHUNK'])).rows[0];
  for (const approval of ordered) {
    const selected = selectedIds.has(Number(approval.id));
    const rankHash = ranked.find((row) => Number(row.id) === Number(approval.id)).rankHash;
    await client.query(`
      INSERT INTO image_sampling_items(
        public_id, freeze_id, task_id, approval_event_id, copy_revision_id,
        image_run_id, image_set_sha256, submitter_account_id, submitter_username,
        rank_hash, selected, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [randomUUID(), freeze.id, approval.task_id, approval.id, approval.copy_revision_id,
      approval.image_run_id, approval.image_set_sha256, approval.submitted_by_account_id,
      approval.submitted_by_username, rankHash, selected, selected ? 'PENDING' : 'NOT_SELECTED']);
  }
  await client.query(`
    UPDATE image_sampling_remainders SET remainder_bps = $3, updated_at = now()
    WHERE production_batch_id = $1 AND submitter_account_id = $2
  `, [productionBatchId, submitterAccountId, remainderAfter]);
  await client.query(`
    INSERT INTO image_sampling_events(freeze_id, action, actor_account_id, actor_username, request_id, details)
    VALUES ($1,'FREEZE',$2,$3,$4,$5)
  `, [freeze.id, actor.userId ?? null, actor.username, requestId,
    { populationCount: population.length, sampleCount, remainderBefore, remainderAfter }]);
  if (sampleCount === 0) await releaseFreeze(client, freeze, actor);
  return freeze;
}

export async function submitImageSelfReview(pool, rawTaskId, input, rawActor) {
  const taskId = normalizeTaskId(rawTaskId);
  const actor = normalizeActor(rawActor, ['ADMIN', 'USER']);
  const imageRunId = normalizeUuid(input?.imageRunId, 'imageRunId');
  const reviewSessionId = normalizeUuid(input?.reviewSessionId, 'reviewSessionId');
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor);
    const task = (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
    if (!task) throw new ControlPlaneNotFoundError('task not found');
    if (task.assigned_to_user_id !== actor.username) {
      throw new ControlPlaneAuthorizationError('只能初审自己负责的图片任务');
    }
    if (task.priority_paused) throw new ControlPlaneConflictError('TASK_PRIORITY_PAUSED', '任务已暂停，请先恢复优先级');
    if (task.state !== 'MANUAL_ARCHIVE') {
      throw new ControlPlaneConflictError('INVALID_TASK_STATE', '任务已不在图片初审阶段，请刷新后重试');
    }
    if (task.current_image_run_id !== imageRunId) {
      throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '图片版本已变化，请刷新后重新初审');
    }
    const run = (await client.query(`
      SELECT id FROM image_runs WHERE id = $1 AND task_id = $2
        AND copy_revision_id = $3 AND status = 'COMPLETED' FOR SHARE
    `, [imageRunId, taskId, task.current_copy_revision_id])).rows[0];
    if (!run) throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '当前文案对应的图片尚未生成完成');
    await assertNoPendingImageEdits(client, { taskId, imageRunId });
    const snapshot = await imageSnapshot(client, taskId, imageRunId);
    const existing = (await client.query(`
      SELECT * FROM image_approval_events WHERE task_id = $1 AND image_run_id = $2
    `, [taskId, imageRunId])).rows[0];
    if (existing) {
      if (existing.review_session_id !== reviewSessionId || Number(existing.submitted_by_account_id) !== actor.userId) {
        throw new ControlPlaneConflictError('IMAGE_ALREADY_SUBMITTED', '当前图片版本已经提交初审');
      }
      return { taskId, state: task.state, approvalEventId: Number(existing.id), idempotent: true };
    }
    const approval = (await client.query(`
      INSERT INTO image_approval_events(
        task_id, copy_revision_id, image_run_id, submitted_by_account_id,
        submitted_by_username, review_session_id, image_set_sha256, submission_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [taskId, task.current_copy_revision_id, imageRunId, actor.userId, actor.username,
      reviewSessionId, snapshot.sha256, task.mandatory_image_qc ? 'MANDATORY_RECHECK' : 'SELF_REVIEW'])).rows[0];
    const settings = await lockWorkflowQualitySettings(client);
    if (!task.mandatory_image_qc
        && (!settings.imageSampling.enabled || settings.imageSampling.rateBps === 0)) {
      await client.query(`
        UPDATE tasks SET image_qc_released_approval_event_id = $2,
          image_qc_legacy_accepted = false WHERE id = $1
      `, [taskId, approval.id]);
      await releaseApproval(client, approval, actor, '图片初审完成；当前未开启图片抽检，进入交付池');
      return { taskId, state: 'REVIEWED', approvalEventId: Number(approval.id), sampled: false };
    }
    const productionBatchId = await ensureProductionBatch(client, task, actor);
    await client.query(`
      UPDATE tasks SET state = 'IMAGE_QC_PENDING', current_stage = 'IMAGE_QC_PENDING',
        progress_percent = 95, progress_message = $2, image_qc_released_approval_event_id = NULL,
        image_qc_legacy_accepted = false, last_activity_at = now(), updated_at = now()
      WHERE id = $1
    `, [taskId, task.mandatory_image_qc ? '图片返修初审已完成，等待强制图片复检' : '图片初审已完成，等待图片抽检批次冻结']);
    if (task.mandatory_image_qc) {
      await createMandatoryFreeze(client, { task: { ...task, production_batch_id: productionBatchId }, approval, actor, settings });
    } else {
      await attemptAutomaticImageSamplingFreeze(client, {
        productionBatchId, submitterAccountId: actor.userId, actor,
      });
    }
    return { taskId, state: 'IMAGE_QC_PENDING', approvalEventId: Number(approval.id), sampled: true };
  });
}

export function imageQaItemFrom(row, actor) {
  const blind = row.blind_review_enabled === true && actor.role !== 'ADMIN';
  const pendingImageEdits = Number(row.pending_image_edit_count ?? 0);
  const canAct = row.status === 'PENDING' && row.priority_paused !== true
    && (actor.role === 'ADMIN' || (Number(row.assigned_review_account_id) === actor.userId
      && Number(row.submitter_account_id) !== actor.userId));
  const canBatch = row.sample_kind === 'RANDOM' && ['PENDING', 'RETURNED'].includes(row.status)
    && row.priority_paused !== true
    && (actor.role === 'ADMIN' || (Number(row.assigned_review_account_id) === actor.userId
      && Number(row.submitter_account_id) !== actor.userId
      && row.image_reviewer_batch_return_enabled === true));
  const item = {
    id: row.public_id,
    freezePublicId: row.freeze_public_id,
    anonymousCode: `IQ-${hash(row.public_id).slice(0, 12).toUpperCase()}`,
    status: row.status,
    sampleKind: row.sample_kind,
    blindReview: blind,
    assets: Array.isArray(row.assets) ? row.assets.map((asset) => ({
      id: Number(asset.id), mediaType: asset.media_type, sha256: asset.sha256,
      originalName: asset.original_name, pageIndex: Number(asset.page_index),
      url: `/v1/image-qa/items/${row.public_id}/assets/${asset.id}`,
    })) : [],
    capabilities: { canPass: canAct && pendingImageEdits === 0, canReturnSingle: canAct,
      canReturnBatch: canBatch },
    blockers: { pendingImageEdits },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (blind) return item;
  return {
    ...item,
    taskId: Number(row.task_id),
    query: row.query,
    productionBatch: { id: Number(row.production_batch_id), queryPackageName: row.query_package_name },
    submitter: { accountId: Number(row.submitter_account_id), username: row.submitter_username },
    imageRunId: row.image_run_id,
    copyRevisionId: Number(row.copy_revision_id),
  };
}

export async function getImageQaAsset(pool, rawItemId, rawAssetId, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  const itemId = normalizeUuid(rawItemId, 'samplingItemId');
  const assetId = normalizeTaskId(rawAssetId);
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor, { quality: true });
    const result = await client.query(`
      SELECT asset.*
      FROM image_sampling_items AS item
      JOIN image_runs AS image_run
        ON image_run.id = item.image_run_id AND image_run.task_id = item.task_id
      CROSS JOIN LATERAL jsonb_array_elements(image_run.result->'images')
        WITH ORDINALITY AS page(image, page_index)
      JOIN image_run_asset_view AS asset
        ON asset.task_id = item.task_id AND asset.image_run_id = item.image_run_id
        AND asset.id::text = COALESCE(page.image->>'deliveryAssetId', page.image->>'assetId')
      WHERE item.public_id = $1 AND item.selected AND asset.id = $2
        AND ($3 = 'ADMIN' OR (
          item.assigned_review_account_id = $4
          AND item.submitter_account_id <> $4
        ))
    `, [itemId, assetId, actor.role, actor.userId]);
    const row = result.rows[0];
    if (!row) throw new ControlPlaneNotFoundError('image QA asset not found');
    return {
      id: Number(row.id), taskId: Number(row.task_id), imageRunId: row.image_run_id,
      mediaType: row.media_type, byteSize: Number(row.byte_size), sha256: row.sha256,
      storagePath: row.storage_path, originalName: row.original_name, createdAt: row.created_at,
    };
  });
}

async function qaActor(pool, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  await transaction(pool, async (client) => lockActiveActor(client, actor, { quality: true }));
  return actor;
}

export async function listImageQaItems(pool, options = {}, rawActor) {
  const actor = await qaActor(pool, rawActor);
  const { limit, offset } = normalizeListPagination(options.limit ?? 50, options.offset ?? 0);
  const status = String(options.status ?? 'PENDING').trim().toUpperCase();
  if (!['PENDING', 'PASSED', 'RETURNED', 'BATCH_RETURNED', 'ALL'].includes(status)) {
    throw new TypeError('image QA status filter is invalid');
  }
  const personName = normalizedPersonNameFilter(options.personName);
  if (personName !== null && actor.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('只有管理员可以按人员姓名筛选图片质检项');
  }
  await flushExpiredImageQualityBatches(pool);
  const values = [actor.userId, status, limit, offset, personName];
  const itemPublicId = options.itemPublicId == null ? null : normalizeUuid(options.itemPublicId, 'itemPublicId');
  const itemParameter = options.actionableOnly ? 8 : 7;
  const result = await pool.query(`
    SELECT item.*, sampling_freeze.public_id AS freeze_public_id, sampling_freeze.blind_review_enabled,
      task.query, task.priority_paused, task.source_query_package_name AS query_package_name,
      sampling_freeze.production_batch_id, settings.image_reviewer_batch_return_enabled,
      (SELECT count(*)::integer FROM image_edit_requests AS edit
        WHERE edit.task_id = item.task_id AND edit.source_image_run_id = item.image_run_id
          AND edit.status = ANY($6::text[])) AS pending_image_edit_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', asset.id, 'media_type', asset.media_type, 'sha256', asset.sha256,
        'original_name', asset.original_name, 'page_index', page.page_index
      ) ORDER BY page.page_index) FILTER (WHERE asset.id IS NOT NULL), '[]'::jsonb) AS assets
    FROM image_sampling_items AS item
    JOIN image_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
    JOIN tasks AS task ON task.id = item.task_id
    JOIN image_runs AS image_run
      ON image_run.id = item.image_run_id AND image_run.task_id = item.task_id
    CROSS JOIN workflow_quality_settings AS settings
    LEFT JOIN LATERAL jsonb_array_elements(image_run.result->'images')
      WITH ORDINALITY AS page(image, page_index) ON true
    LEFT JOIN image_run_asset_view AS asset
      ON asset.task_id = item.task_id AND asset.image_run_id = item.image_run_id
      AND asset.id::text = COALESCE(page.image->>'deliveryAssetId', page.image->>'assetId')
    WHERE item.selected
      ${itemPublicId === null ? '' : `AND item.public_id = $${itemParameter}::uuid`}
      ${options.actionableOnly ? "AND item.status = 'PENDING' AND task.priority_paused = false AND ($7 = 'ADMIN' OR item.submitter_account_id <> $1)" : ''}
      AND ($2 = 'ALL' OR item.status = $2)
      AND ($5::varchar IS NULL OR (
        strpos(lower(item.submitter_username), lower($5)) > 0
        OR EXISTS (
          SELECT 1 FROM app_users AS person_filter
          WHERE person_filter.id = item.submitter_account_id
            AND strpos(lower(person_filter.display_name), lower($5)) > 0
        )
      ))
      AND ($1 = item.assigned_review_account_id OR EXISTS (
        SELECT 1 FROM app_users actor WHERE actor.id = $1 AND actor.role = 'ADMIN' AND actor.status = 'ACTIVE'
      ))
    GROUP BY item.id, sampling_freeze.id, task.id, settings.singleton
    ORDER BY task.priority_sort_at, item.id
    LIMIT $3 OFFSET $4
  `, [...values, PENDING_IMAGE_EDIT_STATUSES, ...(options.actionableOnly ? [actor.role] : []), ...(itemPublicId === null ? [] : [itemPublicId])]);
  return { items: result.rows.map((row) => imageQaItemFrom(row, actor)), limit, offset };
}

async function lockQaItem(client, identifier) {
  const parsed = /^[1-9]\d*$/u.test(String(identifier ?? ''))
    ? { id: normalizeTaskId(identifier), publicId: null }
    : { id: null, publicId: normalizeUuid(identifier, 'samplingItemId') };
  const result = await client.query(`
    SELECT item.*, sampling_freeze.public_id AS freeze_public_id, sampling_freeze.status AS freeze_status,
      sampling_freeze.version AS freeze_version, sampling_freeze.blind_review_enabled,
      sampling_freeze.production_batch_id, task.priority_paused, task.current_image_run_id,
      task.current_copy_revision_id, task.assigned_to_user_id
    FROM image_sampling_items AS item
    JOIN image_sampling_freezes AS sampling_freeze ON sampling_freeze.id = item.freeze_id
    JOIN tasks AS task ON task.id = item.task_id
    WHERE ($1::bigint IS NOT NULL AND item.id = $1)
       OR ($2::uuid IS NOT NULL AND item.public_id = $2)
    FOR UPDATE OF item, sampling_freeze, task
  `, [parsed.id, parsed.publicId]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('image QA item not found');
  return result.rows[0];
}

function assertCanReview(item, actor) {
  if (item.status !== 'PENDING' || item.priority_paused) {
    throw new ControlPlaneConflictError('IMAGE_QA_NOT_PENDING', '该图片质检项已处理或任务已暂停');
  }
  if (actor.role !== 'ADMIN') {
    if (Number(item.submitter_account_id) === actor.userId) {
      throw new ControlPlaneAuthorizationError('质检员不能质检自己提交的图片');
    }
    if (Number(item.assigned_review_account_id) !== actor.userId) {
      throw new ControlPlaneAuthorizationError('该图片质检项未分配给当前账号');
    }
  }
  if (item.current_image_run_id !== item.image_run_id
      || Number(item.current_copy_revision_id) !== Number(item.copy_revision_id)) {
    throw new ControlPlaneConflictError('IMAGE_VERSION_CHANGED', '图片或文案版本已经变化');
  }
}

async function mutationReplay(client, actor, requestId, operation, fingerprint) {
  const result = await client.query(`
    SELECT * FROM image_sampling_mutation_requests
    WHERE actor_username = $1 AND request_id = $2
  `, [actor.username, requestId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.operation !== operation || row.request_fingerprint !== fingerprint) {
    throw new ControlPlaneConflictError('REQUEST_ID_CONFLICT', 'requestId 已用于其他图片质检操作');
  }
  return row.response;
}

async function saveMutation(client, actor, requestId, operation, fingerprint, response) {
  await client.query(`
    INSERT INTO image_sampling_mutation_requests(
      actor_username, request_id, operation, request_fingerprint, response
    ) VALUES ($1,$2,$3,$4,$5)
  `, [actor.username, requestId, operation, fingerprint, response]);
}

export async function passImageQaItem(pool, identifier, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const scoreX10 = normalizeScore(input?.score, 'PASS');
  const note = normalizeNote(input?.note);
  const fingerprint = hash({ identifier, scoreX10, note });
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor, { quality: true });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`image-qa:${actor.userId}`, requestId]);
    const replay = await mutationReplay(client, actor, requestId, 'PASS', fingerprint);
    if (replay) return replay;
    const item = await lockQaItem(client, identifier);
    assertCanReview(item, actor);
    await assertNoPendingImageEdits(client, {
      taskId: Number(item.task_id),
      imageRunId: item.image_run_id,
    });
    await client.query(`
      UPDATE image_sampling_items SET status = 'PASSED', reviewed_by_account_id = $2,
        reviewed_by_username = $3, score_x10 = $4, note = $5,
        reviewed_at = now(), updated_at = now() WHERE id = $1
    `, [item.id, actor.userId, actor.username, scoreX10, note]);
    await client.query(`
      INSERT INTO image_sampling_events(freeze_id, sampling_item_id, action,
        actor_account_id, actor_username, request_id, note, details)
      VALUES ($1,$2,'PASS',$3,$4,$5,$6,$7)
    `, [item.freeze_id, item.id, actor.userId, actor.username, requestId, note, { scoreX10 }]);
    const pending = Number((await client.query(`
      SELECT count(*)::integer AS count FROM image_sampling_items
      WHERE freeze_id = $1 AND selected AND status = 'PENDING'
    `, [item.freeze_id])).rows[0].count);
    if (pending === 0) await releaseFreeze(client, { id: item.freeze_id }, actor);
    const response = { id: item.public_id, status: 'PASSED', freezeReleased: pending === 0 };
    await saveMutation(client, actor, requestId, 'PASS', fingerprint, response);
    return response;
  });
}

async function validateReturnReasons(client, reasonCodes) {
  const result = await client.query("SELECT value FROM global_settings WHERE key = 'production'");
  const settings = normalizeHumanQualitySettings(result.rows[0]?.value?.humanQualityReasons);
  if (settings.imageReviewDisplay.showDeductionReasons
      && settings.imageReasons.length > 0 && reasonCodes.length === 0) {
    throw new TypeError('发起图片返工时至少选择一项返工原因');
  }
}

async function createCopyReworkRevision(client, item, { actor, reworkTarget, reasonCodes, copyFields, problemAssetIds, note }) {
  const source = (await client.query(`
    SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE
  `, [item.copy_revision_id, item.task_id])).rows[0];
  if (!source) throw new ControlPlaneConflictError('COPY_NOT_APPROVED', '当前文案版本不存在');
  const revisionNumber = Number((await client.query(`
    SELECT COALESCE(max(revision), 0) + 1 AS revision FROM copy_revisions WHERE task_id = $1
  `, [item.task_id])).rows[0].revision);
  const content = {
    ...source.content,
    finalRework: {
      target: reworkTarget, reasonCodes, copyFields, problemAssetIds,
      instructions: note, note, returnedByUsername: actor.username,
      returnedAt: new Date().toISOString(),
    },
  };
  return (await client.query(`
    INSERT INTO copy_revisions(
      task_id, execution_id, revision, content, parent_revision_id, revision_origin,
      copy_content_changed_from_machine, copy_rework_satisfied
    ) VALUES ($1,NULL,$2,$3,$4,'FINAL_REWORK',$5,false) RETURNING id
  `, [item.task_id, revisionNumber, content, item.copy_revision_id,
    source.copy_content_changed_from_machine === true])).rows[0];
}

export async function returnImageQaItem(pool, identifier, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const scoreX10 = normalizeScore(input?.score, 'RETURN');
  const reasonCodes = normalizeReasons(input?.reasonCodes ?? input?.reasons);
  const note = normalizeNote(input?.note, { required: true });
  const reworkTarget = String(input?.reworkTarget ?? 'IMAGE').trim().toUpperCase();
  if (!['COPY', 'IMAGE', 'BOTH'].includes(reworkTarget)) throw new TypeError('reworkTarget must be COPY, IMAGE or BOTH');
  const problemAssetIds = normalizeIdList(input?.problemAssetIds, 'problemAssetIds');
  const copyFields = normalizeCopyFields(input?.copyFields);
  if (['IMAGE', 'BOTH'].includes(reworkTarget) && problemAssetIds.length < 1) {
    throw new TypeError('图片返工必须至少选择一张问题图片');
  }
  if (['COPY', 'BOTH'].includes(reworkTarget) && copyFields.length < 1) {
    throw new TypeError('文案返工必须至少选择一个文案字段');
  }
  const fingerprint = hash({ identifier, scoreX10, reasonCodes, note, reworkTarget, problemAssetIds, copyFields });
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor, { quality: true });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`image-qa:${actor.userId}`, requestId]);
    const replay = await mutationReplay(client, actor, requestId, 'RETURN_SINGLE', fingerprint);
    if (replay) return replay;
    const item = await lockQaItem(client, identifier);
    assertCanReview(item, actor);
    await validateReturnReasons(client, reasonCodes);
    if (problemAssetIds.length) {
      const matched = await client.query(`
        SELECT id FROM image_run_asset_view
        WHERE task_id = $1 AND image_run_id = $2 AND id = ANY($3::bigint[])
      `, [item.task_id, item.image_run_id, problemAssetIds]);
      if (matched.rows.length !== problemAssetIds.length) {
        throw new ControlPlaneConflictError('INVALID_PROBLEM_ASSETS', '所选问题图片不属于当前图片版本');
      }
    }
    let nextCopyRevisionId = Number(item.copy_revision_id);
    if (['COPY', 'BOTH'].includes(reworkTarget)) {
      nextCopyRevisionId = Number((await createCopyReworkRevision(client, item, {
        actor, reworkTarget, reasonCodes, copyFields, problemAssetIds, note,
      })).id);
    }
    await withdrawReadyDeliveryEntries(client, item.task_id, 'IMAGE_QA_RETURN');
    await client.query(`
      UPDATE image_sampling_items SET status = 'RETURNED', reviewed_by_account_id = $2,
        reviewed_by_username = $3, score_x10 = $4, reason_codes = $5, note = $6,
        problem_asset_ids = $7, copy_fields = $8, rework_target = $9,
        reviewed_at = now(), updated_at = now() WHERE id = $1
    `, [item.id, actor.userId, actor.username, scoreX10, reasonCodes, note,
      problemAssetIds, copyFields, reworkTarget]);
    await client.query(`
      UPDATE image_sampling_freezes SET status = 'REVIEW_REQUIRED', version = version + 1
      WHERE id = $1
    `, [item.freeze_id]);
    const copyRework = ['COPY', 'BOTH'].includes(reworkTarget);
    await client.query(`
      UPDATE tasks SET state = $2, current_stage = $2, current_copy_revision_id = $3,
        progress_percent = 0, progress_message = $4, mandatory_image_qc = true,
        mandatory_image_qc_origin = 'QA_RETURN', image_qc_released_approval_event_id = NULL,
        image_qc_legacy_accepted = false, image_rework_source_run_id = $5,
        mandatory_copy_qc = CASE WHEN $6 THEN true ELSE mandatory_copy_qc END,
        mandatory_copy_qc_origin = CASE WHEN $6 THEN 'FINAL_REWORK' ELSE mandatory_copy_qc_origin END,
        current_execution_id = NULL, pending_snapshot = NULL, error = NULL,
        finished_at = NULL, last_activity_at = now(), updated_at = now()
      WHERE id = $1
    `, [item.task_id, copyRework ? 'COPY_REVIEW_PENDING' : 'IMAGE_REWORK_PENDING',
      nextCopyRevisionId, copyRework
        ? '图片质检已打回文案；完成修改和文案复检后重新生图'
        : '图片质检已打回；请修改图片后重新完成图片初审',
      item.image_run_id, copyRework]);
    await client.query(`
      INSERT INTO image_sampling_events(freeze_id, sampling_item_id, action,
        actor_account_id, actor_username, request_id, reason_codes, note, details)
      VALUES ($1,$2,'RETURN_SINGLE',$3,$4,$5,$6,$7,$8)
    `, [item.freeze_id, item.id, actor.userId, actor.username, requestId, reasonCodes,
      note, { scoreX10, reworkTarget, problemAssetIds, copyFields }]);
    const response = { id: item.public_id, status: 'RETURNED', taskState: copyRework ? 'COPY_REVIEW_PENDING' : 'IMAGE_REWORK_PENDING' };
    await saveMutation(client, actor, requestId, 'RETURN_SINGLE', fingerprint, response);
    return response;
  });
}

export async function getImageQaBatchReturnPreview(pool, rawFreezePublicId, rawActor) {
  const actor = await qaActor(pool, rawActor);
  const freezePublicId = normalizeUuid(rawFreezePublicId, 'freezePublicId');
  const settings = await readWorkflowQualitySettings(pool);
  if (actor.role !== 'ADMIN' && !settings.imageSampling.reviewerBatchReturnEnabled) {
    throw new ControlPlaneAuthorizationError('管理员尚未允许审核员整批打回图片');
  }
  const result = await pool.query(`
    SELECT sampling_freeze.id, sampling_freeze.public_id, sampling_freeze.blind_review_enabled, sampling_freeze.status,
      item.public_id AS item_public_id, item.submitter_account_id,
      item.assigned_review_account_id, item.status AS item_status, item.selected
    FROM image_sampling_freezes AS sampling_freeze
    JOIN image_sampling_items AS item ON item.freeze_id = sampling_freeze.id
    WHERE sampling_freeze.public_id = $1 AND item.sample_kind = 'RANDOM'
    ORDER BY item.id
  `, [freezePublicId]);
  if (result.rows.length < 1) throw new ControlPlaneNotFoundError('image QA freeze not found');
  if (actor.role !== 'ADMIN' && !result.rows.some((row) => row.selected
      && Number(row.assigned_review_account_id) === actor.userId
      && Number(row.submitter_account_id) !== actor.userId)) {
    throw new ControlPlaneAuthorizationError('当前账号不能整批处理该图片抽检批次');
  }
  return {
    freezePublicId,
    confirmedCount: result.rows.length,
    itemIds: result.rows.map((row) => row.item_public_id),
    blindReview: result.rows[0].blind_review_enabled === true && actor.role !== 'ADMIN',
    status: result.rows[0].status,
  };
}

export async function batchReturnImageQa(pool, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN', 'REVIEWER']);
  const requestId = normalizeUuid(input?.requestId, 'requestId');
  const freezePublicId = normalizeUuid(input?.freezePublicId, 'freezePublicId');
  const itemIds = Array.isArray(input?.itemIds)
    ? input.itemIds.map((id) => normalizeUuid(id, 'itemId')).toSorted() : [];
  const confirmedCount = Number(input?.confirmedCount);
  const reasonCodes = normalizeReasons(input?.reasonCodes ?? input?.reasons);
  const note = normalizeNote(input?.note, { required: true });
  if (!Number.isSafeInteger(confirmedCount) || confirmedCount < 1 || confirmedCount !== itemIds.length) {
    throw new TypeError('整批打回数量与预览不一致');
  }
  const fingerprint = hash({ freezePublicId, itemIds, confirmedCount, reasonCodes, note });
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor, { quality: true });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`image-qa:${actor.userId}`, requestId]);
    const replay = await mutationReplay(client, actor, requestId, 'RETURN_BATCH', fingerprint);
    if (replay) return replay;
    const settings = await lockWorkflowQualitySettings(client);
    if (actor.role !== 'ADMIN' && !settings.imageSampling.reviewerBatchReturnEnabled) {
      throw new ControlPlaneAuthorizationError('管理员尚未允许审核员整批打回图片');
    }
    await validateReturnReasons(client, reasonCodes);
    const rows = (await client.query(`
      SELECT item.*, sampling_freeze.status AS freeze_status, task.priority_paused,
        task.current_image_run_id, task.current_copy_revision_id
      FROM image_sampling_freezes AS sampling_freeze
      JOIN image_sampling_items AS item ON item.freeze_id = sampling_freeze.id
      JOIN tasks AS task ON task.id = item.task_id
      WHERE sampling_freeze.public_id = $1 AND item.sample_kind = 'RANDOM'
      ORDER BY item.id FOR UPDATE OF sampling_freeze, item, task
    `, [freezePublicId])).rows;
    if (rows.length < 1) throw new ControlPlaneNotFoundError('image QA freeze not found');
    const actualIds = rows.map((row) => row.public_id).toSorted();
    if (rows.length !== confirmedCount || JSON.stringify(actualIds) !== JSON.stringify(itemIds)) {
      throw new ControlPlaneConflictError('IMAGE_QA_SCOPE_CHANGED', '整批范围已变化，请重新预览后确认');
    }
    if (rows.some((row) => row.priority_paused)) {
      throw new ControlPlaneConflictError('TASK_PRIORITY_PAUSED', '批次中存在已暂停任务，不能整批打回');
    }
    if (actor.role !== 'ADMIN' && (!rows.some((row) => row.selected
      && Number(row.assigned_review_account_id) === actor.userId)
      || rows.some((row) => Number(row.submitter_account_id) === actor.userId))) {
      throw new ControlPlaneAuthorizationError('质检员不能整批处理自己提交的图片');
    }
    for (const row of rows) {
      if (row.current_image_run_id !== row.image_run_id
          || Number(row.current_copy_revision_id) !== Number(row.copy_revision_id)) {
        throw new ControlPlaneConflictError('IMAGE_VERSION_CHANGED', '批次中图片或文案版本已经变化');
      }
    }
    const freezeId = rows[0].freeze_id;
    for (const row of rows) {
      await withdrawReadyDeliveryEntries(client, row.task_id, 'IMAGE_QA_BATCH_RETURN');
      await client.query(`
        UPDATE tasks SET state = 'IMAGE_REWORK_PENDING', current_stage = 'IMAGE_REWORK_PENDING',
          progress_percent = 0, progress_message = $2, mandatory_image_qc = true,
          mandatory_image_qc_origin = 'BATCH_RETURN', image_qc_released_approval_event_id = NULL,
          image_qc_legacy_accepted = false, image_rework_source_run_id = current_image_run_id,
          finished_at = NULL, last_activity_at = now(), updated_at = now()
        WHERE id = $1
      `, [row.task_id, `图片抽检批次已整批打回：${note}`]);
    }
    await client.query(`
      UPDATE image_sampling_items SET status = 'BATCH_RETURNED', reviewed_by_account_id = $2,
        reviewed_by_username = $3, reason_codes = $4, note = $5, rework_target = 'IMAGE',
        reviewed_at = now(), updated_at = now() WHERE freeze_id = $1
    `, [freezeId, actor.userId, actor.username, reasonCodes, note]);
    await client.query(`
      UPDATE image_sampling_freezes SET status = 'BATCH_RETURNED', resolved_at = now(), version = version + 1
      WHERE id = $1
    `, [freezeId]);
    await client.query(`
      INSERT INTO image_sampling_events(freeze_id, action, actor_account_id, actor_username,
        request_id, reason_codes, note, details)
      VALUES ($1,'RETURN_BATCH',$2,$3,$4,$5,$6,$7)
    `, [freezeId, actor.userId, actor.username, requestId, reasonCodes, note, { affectedCount: rows.length }]);
    const response = { freezePublicId, status: 'BATCH_RETURNED', affectedCount: rows.length };
    await saveMutation(client, actor, requestId, 'RETURN_BATCH', fingerprint, response);
    return response;
  });
}

export async function closeImageSamplingTail(pool, input, rawActor) {
  const actor = normalizeActor(rawActor, ['ADMIN']);
  return transaction(pool, async (client) => {
    await lockActiveActor(client, actor, { quality: true });
    return attemptAutomaticImageSamplingFreeze(client, {
      productionBatchId: input?.productionBatchId,
      submitterAccountId: input?.submitterAccountId,
      actor, force: true,
    });
  });
}

export async function flushExpiredImageQualityBatches(pool, { now = new Date() } = {}) {
  const settings = await readWorkflowQualitySettings(pool);
  if (!settings.imageSampling.enabled || settings.imageSampling.rateBps === 0) return [];
  const candidates = await pool.query(`
    SELECT task.production_batch_id, approval.submitted_by_account_id
    FROM image_approval_events AS approval
    JOIN tasks AS task ON task.id = approval.task_id AND task.state = 'IMAGE_QC_PENDING'
    WHERE approval.submitted_at <= $1
      AND NOT EXISTS (SELECT 1 FROM image_sampling_items item WHERE item.approval_event_id = approval.id)
    GROUP BY task.production_batch_id, approval.submitted_by_account_id
  `, [new Date(now.valueOf() - IMAGE_BATCH_TAIL_MS)]);
  const frozen = [];
  for (const row of candidates.rows) {
    const result = await transaction(pool, (client) => attemptAutomaticImageSamplingFreeze(client, {
      productionBatchId: row.production_batch_id,
      submitterAccountId: row.submitted_by_account_id,
      actor: { userId: null, username: 'system' }, force: true, now,
    }));
    if (result) frozen.push(result);
  }
  return frozen;
}
