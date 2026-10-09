import { hydrateExecutionSnapshots } from './execution-snapshot-storage.mjs';
import {
  COPY_REVIEW_DRAFT_HISTORY_LIMIT,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  DEFAULT_IMAGE_SETTINGS,
  UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
  USER_ROLES,
  assertActiveManualAssignee,
  assertPermanentDeletionActor,
  assertPermanentlyDeletableTask,
  assertQualityExplanation,
  attemptAutomaticCopySamplingFreeze,
  automaticReviewImagePlan,
  canAdminDiscardTask,
  claimQualityReviewSubmission,
  contentWithAutomaticReviewLayouts,
  contentWithImagePlanRetry,
  contentWithReviewEdits,
  copyDiffersFromMachineAncestor,
  copyReviewDraftFrom,
  copyReworkBaseline,
  copyReworkChanges,
  createReadyDeliveryEntry,
  imagePlanRegenerationFrom,
  insertQualityAssessment,
  isDeepStrictEqual,
  isTaskAssignmentLocked,
  lockAutoAssignmentMember,
  lockCurrentActor,
  lockTaskForActor,
  normalizeAssigneeUserId,
  normalizeAssignmentSource,
  normalizeCopyReviewDraftContent,
  normalizeCopyReviewEdits,
  normalizeCopyReviewImagePlan,
  normalizeCreatorUserId,
  normalizeHumanQualitySettings,
  normalizeImageSettings,
  normalizeNodeId,
  normalizeSavedTaskView,
  normalizeTaskBatch,
  normalizeTaskId,
  normalizeUuid,
  normalizedActorIdentity,
  normalizedAssignmentTaskIds,
  normalizedHumanQualityScore,
  normalizedPermanentDeletionTaskIds,
  normalizedQualityNote,
  normalizedQualityProblemAssetIds,
  normalizedQualityReasonCodes,
  normalizedReviewCopy,
  normalizedReworkCopyFields,
  normalizedUsername,
  qualityAssessmentFrom,
  qualityReviewFingerprint,
  randomUUID,
  restoreDiscardedTask,
  reviseTaskImages,
  routeManualCopyApproval,
  savedTaskViewFrom,
  taskFrom,
  transaction,
  withSavedVisualPlan,
  withdrawReadyDeliveryEntries
} from './repository-context.mjs';
import { TaskReadRepository } from './repository-task-reads.mjs';
import { hydrateCopyReviewDrafts } from './copy-review-draft-archive.mjs';

async function ensureManualReviewSourceNode(client, nodeId, actor) {
  const node = await client.query('SELECT id FROM executor_nodes WHERE id = $1', [nodeId]);
  if (node.rows[0]) return;
  if (actor === null) throw new ControlPlaneNotFoundError('executor node is not registered');
  // A browser can review tasks created on another node before creating any
  // tasks itself. Preserve its source reference without granting worker
  // capabilities or marking it online, as createTasks does for web sources.
  await client.query(`
    INSERT INTO executor_nodes(id, name, image_worker_enabled, last_seen_at)
    VALUES ($1, $1, false, 'epoch'::timestamptz)
    ON CONFLICT(id) DO NOTHING
  `, [nodeId]);
}

/** TaskWrite operations; inherited methods preserve the public repository API. */
export class TaskWriteRepository extends TaskReadRepository {
  async createTasks({
    nodeId: rawNodeId,
    createdByUserId: rawCreator = null,
    actor: rawActor = null,
    assignedToUserId: rawAssignee,
    assignedToAccountId: rawAssigneeAccountId = null,
    assignmentSource: rawAssignmentSource,
    tasks: rawTasks,
    skipCopyReview = false,
  }) {
    if (typeof skipCopyReview !== 'boolean') throw new TypeError('skipCopyReview must be a boolean');
    const nodeId = normalizeNodeId(rawNodeId);
    const createdByUserId = rawCreator === null ? null : normalizeCreatorUserId(rawCreator);
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    if (actor !== null && actor.username !== createdByUserId) {
      throw new TypeError('task creator must match the authenticated actor');
    }
    const assignedToUserId = normalizeAssigneeUserId(
      rawAssignee === undefined ? null : rawAssignee,
    );
    const assignedToAccountId = rawAssigneeAccountId === null || rawAssigneeAccountId === undefined
      ? (actor !== null && assignedToUserId === actor.username ? actor.userId : null)
      : normalizeTaskId(rawAssigneeAccountId);
    if (assignedToUserId === null && assignedToAccountId !== null) {
      throw new TypeError('assignedToAccountId requires assignedToUserId');
    }
    if (actor !== null && assignedToUserId !== null && assignedToAccountId === null) {
      throw new TypeError('authenticated task assignment requires a stable assignee account id');
    }
    const assignmentSource = assignedToUserId === null
      ? null
      : normalizeAssignmentSource(rawAssignmentSource
        ?? (assignedToUserId === createdByUserId ? 'SELF' : 'MANUAL'));
    if (assignedToUserId === null && rawAssignmentSource !== undefined && rawAssignmentSource !== null) {
      throw new TypeError('unassigned tasks cannot have an assignment source');
    }
    if (assignmentSource === 'SELF' && assignedToUserId !== createdByUserId) {
      throw new TypeError('self assignment must target the task creator');
    }
    if (assignmentSource === 'SELF' && actor !== null && assignedToAccountId !== actor.userId) {
      throw new TypeError('self assignment must target the authenticated account');
    }
    if (skipCopyReview && assignedToUserId === null) {
      throw new ControlPlaneConflictError(
        'SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED',
        '免文案审核任务必须明确指定负责人',
      );
    }
    const tasks = normalizeTaskBatch(rawTasks);
    return transaction(this.pool, async (client) => {
      if (actor !== null) await lockCurrentActor(client, actor);
      if (assignedToUserId !== null) {
        await assertActiveManualAssignee(
          client,
          assignedToUserId,
          assignedToAccountId,
          actor,
        );
        // Keep explicit assignment linearizable with automatic replenishment.
        await lockAutoAssignmentMember(client, assignedToUserId);
      }
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
            skip_copy_review, assigned_to_user_id, assignment_source, assigned_at,
            current_stage, progress_message
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            CASE WHEN $7::varchar IS NULL THEN NULL ELSE now() END,
            'COPY_QUEUED',
            '等待文案执行机领取')
          RETURNING *
        `, [task.query, task.input, String(task.imageCount), nodeId, createdByUserId,
          skipCopyReview, assignedToUserId, assignmentSource]);
        if (assignedToUserId !== null && createdByUserId !== null) {
          await client.query(`
            INSERT INTO task_assignment_events(
              task_id, actor_username, previous_assignee_user_id, assignee_user_id, source, reason
            ) VALUES ($1, $2, NULL, $3, $4, '任务创建时分配')
          `, [result.rows[0].id, createdByUserId, assignedToUserId, assignmentSource]);
        }
        created.push(taskFrom(result.rows[0]));
      }
      return created;
    });
  }

  async assignTask(rawTaskId, input) {
    const tasks = await this.assignTasks([rawTaskId], input);
    return tasks[0];
  }

  async assignTasks(rawTaskIds, {
    assignedToUserId: rawAssignee,
    assignedToAccountId: rawAssigneeAccountId = null,
    actor: rawActorIdentity = null,
    actorUserId: rawLegacyActor,
    reason: rawReason = null,
  }) {
    const taskIds = normalizedAssignmentTaskIds(rawTaskIds);
    const assignedToUserId = normalizeAssigneeUserId(rawAssignee);
    const assignedToAccountId = rawAssigneeAccountId === null || rawAssigneeAccountId === undefined
      ? null : normalizeTaskId(rawAssigneeAccountId);
    if (assignedToUserId === null && assignedToAccountId !== null) {
      throw new TypeError('assignedToAccountId requires assignedToUserId');
    }
    const actor = rawActorIdentity === null ? null : normalizedActorIdentity(rawActorIdentity);
    if (actor !== null && actor.role !== 'ADMIN') {
      throw new ControlPlaneAuthorizationError('仅管理员可以分配任务');
    }
    if (actor !== null && assignedToUserId !== null && assignedToAccountId === null) {
      throw new TypeError('authenticated task assignment requires a stable assignee account id');
    }
    const actorUserId = actor?.username ?? normalizeCreatorUserId(rawLegacyActor);
    if (rawReason !== null && rawReason !== undefined && typeof rawReason !== 'string') {
      throw new TypeError('reason must be a string');
    }
    const reason = rawReason === null || rawReason === undefined || rawReason === ''
      ? null : String(rawReason).replace(/\s+/gu, ' ').trim();
    if (reason !== null && [...reason].length > 200) throw new RangeError('reason cannot exceed 200 characters');
    return transaction(this.pool, async (client) => {
      if (actor !== null) await lockCurrentActor(client, actor);
      if (assignedToUserId !== null) {
        await assertActiveManualAssignee(
          client,
          assignedToUserId,
          assignedToAccountId,
          actor,
        );
        // The limit is an automatic replenishment target, not a hard cap for
        // administrators. Locking a member still makes its count linearizable
        // with a concurrent replenishment run before either side locks tasks.
        await lockAutoAssignmentMember(client, assignedToUserId);
      }
      const current = await client.query(`
        SELECT * FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
      `, [taskIds]);
      if (current.rows.length !== taskIds.length) throw new ControlPlaneNotFoundError('task not found');
      if (current.rows.some((task) => (
        isTaskAssignmentLocked(task)
          && (task.assigned_to_user_id ?? null) !== assignedToUserId
      ))) {
        throw new ControlPlaneConflictError(
          'TASK_ASSIGNMENT_LOCKED',
          '已完成或已废弃的任务已锁定负责人，不能分配、改派或退回待分配池',
        );
      }
      if (assignedToUserId === null && current.rows.some((task) => (
        task.skip_copy_review === true && task.state === 'COPY_QUEUED'
      ))) {
        throw new ControlPlaneConflictError(
          'SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED',
          '免文案审核任务在文案执行前必须保留明确负责人',
        );
      }
      if (assignedToUserId === null && current.rows.some((task) => (
        !['COPY_QUEUED', 'COPY_REVIEW_PENDING'].includes(task.state)
          || task.current_execution_id != null
      ))) {
        throw new ControlPlaneConflictError(
          'TASK_ALREADY_STARTED',
          '只有等待文案执行或等待文案审核、且当前没有执行中的任务可以退回待分配池',
        );
      }
      if (assignedToUserId !== null && current.rows.some((task) => (
        (task.assigned_to_user_id ?? null) === null
          && (
            task.current_execution_id != null
              || !['COPY_REVIEW_PENDING', 'IMAGE_QUEUED', 'IMAGE_FAILED', 'MANUAL_ARCHIVE'].includes(task.state)
              || (task.state === 'COPY_REVIEW_PENDING'
                && !['COPY_REVIEW_PENDING', 'IMAGE_RETRY_EXHAUSTED'].includes(task.current_stage))
          )
      ))) {
        throw new ControlPlaneConflictError(
          'TASK_NOT_READY_FOR_ASSIGNMENT',
          '任务到达文案审核环节后才可以首次分配负责人',
        );
      }
      const changed = current.rows.filter((task) => (task.assigned_to_user_id ?? null) !== assignedToUserId);
      if (changed.length === 0) return current.rows.map(taskFrom);
      const updated = await client.query(`
        UPDATE tasks SET
          assigned_to_user_id = $2,
          assignment_source = CASE WHEN $2::varchar IS NULL THEN NULL ELSE 'MANUAL' END,
          assigned_at = CASE WHEN $2::varchar IS NULL THEN NULL ELSE now() END,
          progress_message = CASE
            WHEN $2::varchar IS NULL AND state = 'COPY_QUEUED' THEN '等待文案执行机领取'
            WHEN $2::varchar IS NULL AND state = 'COPY_REVIEW_PENDING'
              AND current_stage = 'IMAGE_RETRY_EXHAUSTED'
              THEN '图片重试次数已用尽，等待分配负责人后处理'
            WHEN $2::varchar IS NULL AND state = 'COPY_REVIEW_PENDING'
              THEN '文案生成完成，等待分配负责人后审核'
            WHEN $2::varchar IS NOT NULL AND state = 'COPY_QUEUED' THEN '等待文案执行机领取'
            WHEN $2::varchar IS NOT NULL
              AND (progress_message IS NULL OR progress_message IN (
                '等待管理员分配标注',
                '等待管理员分配作业员',
                '等待分配负责人',
                '负责人待分配，等待文案执行机领取',
                '等待文案执行机领取',
                '文案生成完成，等待分配负责人后审核'
              ))
              THEN CASE
                WHEN state = 'IMAGE_QUEUED' THEN '等待图片执行机领取'
                WHEN state = 'COPY_REVIEW_PENDING' AND current_stage = 'IMAGE_RETRY_EXHAUSTED'
                  THEN '图片重试次数已用尽，等待人工处理'
                WHEN state = 'COPY_REVIEW_PENDING' THEN '文案生成完成，等待人工审核'
                WHEN state = 'COPY_FAILED' THEN '文案生成失败，等待人工处理'
                WHEN state = 'IMAGE_FAILED' THEN '图片生成失败，等待人工处理'
                WHEN state = 'MANUAL_ARCHIVE' THEN '图片生成完成，等待人工归档'
                ELSE progress_message
              END
            ELSE progress_message
          END,
          updated_at = now()
        WHERE id = ANY($1::bigint[])
        RETURNING *
      `, [changed.map((task) => task.id), assignedToUserId]);
      for (const task of changed) {
        await client.query(`
          INSERT INTO task_assignment_events(
            task_id, actor_username, previous_assignee_user_id, assignee_user_id, source, reason
          ) VALUES ($1, $2, $3, $4, 'MANUAL', $5)
        `, [task.id, actorUserId, task.assigned_to_user_id ?? null, assignedToUserId, reason]);
      }
      const updatedById = new Map(updated.rows.map((task) => [Number(task.id), task]));
      return current.rows.map((task) => taskFrom(updatedById.get(Number(task.id)) ?? task));
    });
  }

  async listCopyReviewDrafts(rawTaskId, { actor: rawActor } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    return transaction(this.pool, async (client) => {
      const { actor, task } = await lockTaskForActor(client, taskId, rawActor);
      const baseCopyRevisionId = task.current_copy_revision_id === null
        ? null : Number(task.current_copy_revision_id);
      if (baseCopyRevisionId === null) return { baseCopyRevisionId, drafts: [] };
      const result = await client.query(`
        SELECT * FROM copy_review_drafts
        WHERE task_id = $1 AND base_copy_revision_id = $2 AND reviewer_account_id = $3
        ORDER BY id DESC
        LIMIT ${COPY_REVIEW_DRAFT_HISTORY_LIMIT}
      `, [taskId, baseCopyRevisionId, actor.userId]);
      return {
        baseCopyRevisionId,
        drafts: (await hydrateCopyReviewDrafts(client, result.rows)).map(copyReviewDraftFrom),
      };
    });
  }

  async saveCopyReviewDraft(rawTaskId, {
    baseCopyRevisionId: rawBaseCopyRevisionId,
    expectedLatestDraftId: rawExpectedLatestDraftId = null,
    content: rawContent,
  }, { actor: rawActor } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const baseCopyRevisionId = normalizeTaskId(rawBaseCopyRevisionId);
    const expectedLatestDraftId = rawExpectedLatestDraftId === null
      ? null : normalizeTaskId(rawExpectedLatestDraftId);
    const content = normalizeCopyReviewDraftContent(rawContent);
    return transaction(this.pool, async (client) => {
      const { actor, task } = await lockTaskForActor(client, taskId, rawActor);
      if (task.assigned_to_user_id == null) {
        throw new ControlPlaneConflictError(
          'TASK_ASSIGNEE_REQUIRED',
          '未分配任务不能保存文案审核草稿，请先指定负责人',
        );
      }
      if (task.state !== 'COPY_REVIEW_PENDING') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', '当前任务已不在文案审核阶段，草稿没有保存');
      }
      if (Number(task.current_copy_revision_id) !== baseCopyRevisionId) {
        throw new ControlPlaneConflictError('STALE_COPY_REVISION', '文案版本已经变化，请刷新后再编辑');
      }
      const latestResult = await client.query(`
        SELECT * FROM copy_review_drafts
        WHERE task_id = $1 AND base_copy_revision_id = $2 AND reviewer_account_id = $3
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `, [taskId, baseCopyRevisionId, actor.userId]);
      const latest = (await hydrateCopyReviewDrafts(client, latestResult.rows))[0] ?? null;
      if (latest && isDeepStrictEqual(latest.content, content)) {
        return { created: false, draft: copyReviewDraftFrom(latest) };
      }
      if ((latest === null ? null : Number(latest.id)) !== expectedLatestDraftId) {
        throw new ControlPlaneConflictError(
          'COPY_REVIEW_DRAFT_CONFLICT',
          '另一个窗口已经保存了更新的草稿，请刷新并从草稿历史中选择版本',
        );
      }
      const draftVersion = latest === null ? 1 : Number(latest.draft_version) + 1;
      const inserted = await client.query(`
        INSERT INTO copy_review_drafts(
          task_id, base_copy_revision_id, reviewer_account_id, reviewer_username,
          draft_version, content
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [taskId, baseCopyRevisionId, actor.userId, actor.username, draftVersion, content]);
      return { created: true, draft: copyReviewDraftFrom(inserted.rows[0]) };
    });
  }

  async createImagePlanRegeneration(rawTaskId, {
    requestId: rawRequestId,
    copyRevisionId: rawCopyRevisionId,
    copy: rawCopy,
  }, { actor: rawActor } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const requestId = normalizeUuid(rawRequestId, 'requestId');
    const copyRevisionId = normalizeTaskId(rawCopyRevisionId);
    return transaction(this.pool, async (client) => {
      const { actor, task } = await lockTaskForActor(client, taskId, rawActor);
      if (task.assigned_to_user_id == null) {
        throw new ControlPlaneConflictError(
          'TASK_ASSIGNEE_REQUIRED',
          '请先分配负责人，再重新生成图片文案规划',
        );
      }
      if (task.state !== 'COPY_REVIEW_PENDING') {
        throw new ControlPlaneConflictError(
          'INVALID_TASK_STATE',
          '当前任务已不在文案审核阶段，不能重新生成图片文案规划',
        );
      }
      if (Number(task.current_copy_revision_id) !== copyRevisionId) {
        throw new ControlPlaneConflictError(
          'STALE_COPY_REVISION',
          '文案版本已经变化，请刷新后再重新生成规划',
        );
      }
      const revision = (await client.query(`
        SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2
      `, [copyRevisionId, taskId])).rows[0];
      const currentImagePlan = revision?.content?.imagePlan
        ?? revision?.content?.reviewed?.imagePlan
        ?? revision?.content?.post?.imagePlan;
      if (!revision || !Array.isArray(currentImagePlan)) {
        throw new ControlPlaneConflictError(
          'COPY_REVISION_INCOMPLETE',
          '当前文案版本缺少可用的图片文案规划',
        );
      }
      // Regeneration repairs an existing plan, so legacy long bullets must not
      // prevent validating the copy used to request a replacement.
      const { copy } = normalizeCopyReviewEdits({ copy: rawCopy, imagePlan: currentImagePlan }, {
        allowImagePlanBulletOverflow: true,
      });
      const existingRequest = (await client.query(`
        SELECT * FROM copy_image_plan_regeneration_jobs WHERE request_id = $1
      `, [requestId])).rows[0];
      if (existingRequest) {
        if (Number(existingRequest.task_id) !== taskId
            || Number(existingRequest.copy_revision_id) !== copyRevisionId
            || Number(existingRequest.requested_by_account_id) !== actor.userId
            || !isDeepStrictEqual(existingRequest.copy_payload, copy)) {
          throw new ControlPlaneConflictError(
            'IMAGE_PLAN_REGENERATION_REQUEST_CONFLICT',
            'requestId 已用于其他图文规划生成请求',
          );
        }
        return { created: false, job: imagePlanRegenerationFrom(existingRequest) };
      }
      const active = (await client.query(`
        SELECT * FROM copy_image_plan_regeneration_jobs
        WHERE task_id = $1 AND requested_by_account_id = $2
          AND status IN ('QUEUED', 'RUNNING')
        ORDER BY created_at, id LIMIT 1
      `, [taskId, actor.userId])).rows[0];
      if (active) {
        if (Number(active.copy_revision_id) === copyRevisionId
            && isDeepStrictEqual(active.copy_payload, copy)) {
          return { created: false, job: imagePlanRegenerationFrom(active) };
        }
        throw new ControlPlaneConflictError(
          'IMAGE_PLAN_REGENERATION_ACTIVE',
          '当前任务已有一次图文规划正在生成，请等待完成后再试',
        );
      }
      const inserted = await client.query(`
        INSERT INTO copy_image_plan_regeneration_jobs(
          id, request_id, task_id, copy_revision_id,
          requested_by_account_id, requested_by_username, copy_payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [randomUUID(), requestId, taskId, copyRevisionId, actor.userId, actor.username, copy]);
      return { created: true, job: imagePlanRegenerationFrom(inserted.rows[0]) };
    });
  }

  async approveCopy(rawTaskId, {
    revisionId: rawRevisionId,
    nodeId: rawNodeId,
    edits: rawEdits,
    aiDisclosureEnabled: rawAiDisclosureEnabled,
    decision: rawDecision,
    originalScore: rawOriginalScore,
    score: rawScore,
    originalReasons: rawOriginalReasons,
    originalReasonCodes: rawOriginalReasonCodes,
    originalNote: rawOriginalNote,
    reasons: rawReasons,
    reasonCodes: rawReasonCodes,
    note: rawNote,
    imagePlanBulletOverflowConfirmed: rawImagePlanBulletOverflowConfirmed,
    reviewSessionId: rawReviewSessionId,
  }, { actor: rawActor = null, actorRole: rawActorRole = 'ADMIN', reviewerUserId: rawReviewerUserId } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const revisionId = normalizeTaskId(rawRevisionId);
    const nodeId = normalizeNodeId(rawNodeId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const actorRole = actorIdentity?.role ?? rawActorRole;
    const reviewerUsername = normalizeCreatorUserId(actorIdentity?.username ?? rawReviewerUserId);
    const reviewSessionId = normalizeUuid(rawReviewSessionId, 'reviewSessionId');
    const decision = String(rawDecision ?? '').trim().toUpperCase();
    if (!['SAVE', 'SAVE_PLAN', 'APPROVE', 'DISCARD'].includes(decision)) throw new TypeError('copy review decision is invalid');
    if (rawImagePlanBulletOverflowConfirmed !== undefined
        && typeof rawImagePlanBulletOverflowConfirmed !== 'boolean') {
      throw new TypeError('imagePlanBulletOverflowConfirmed must be a boolean');
    }
    const originalScoreX10 = rawOriginalScore === undefined
      ? null : normalizedHumanQualityScore(rawOriginalScore, 'originalScore');
    let edits = rawEdits === undefined ? null : normalizeCopyReviewEdits(rawEdits);
    if (decision === 'DISCARD' && edits) throw new TypeError('discarding copy does not accept edits');
    if (decision === 'SAVE_PLAN' && !edits) throw new TypeError('saving an image plan requires edits');
    if (decision === 'SAVE_PLAN' && [rawOriginalScore, rawScore, rawOriginalReasons, rawOriginalReasonCodes,
      rawOriginalNote, rawReasons, rawReasonCodes, rawNote, rawAiDisclosureEnabled].some(value => value !== undefined)) {
      throw new TypeError('saving an image plan does not accept copy rating or disclosure fields');
    }
    const submittedScoreX10 = rawScore === undefined ? null : normalizedHumanQualityScore(rawScore);
    const currentScoreX10 = submittedScoreX10 ?? originalScoreX10;
    const originalReasonCodes = normalizedQualityReasonCodes(rawOriginalReasons ?? rawOriginalReasonCodes);
    const originalNote = normalizedQualityNote(rawOriginalNote);
    const currentReasonCodes = normalizedQualityReasonCodes(
      rawReasons ?? rawReasonCodes ?? (edits ? undefined : originalReasonCodes),
    );
    const currentNote = normalizedQualityNote(rawNote ?? (edits ? undefined : originalNote));
      if (!edits && currentScoreX10 !== null) {
        assertQualityExplanation(currentScoreX10, currentReasonCodes, currentNote);
      }
      if (decision === 'APPROVE' && currentScoreX10 !== null && currentScoreX10 !== 30) {
        throw new ControlPlaneConflictError('QUALITY_SCORE_TOO_LOW', '文案仅在最终评分为 3 分时可以提交达标审核结果');
    }
    if (rawAiDisclosureEnabled !== undefined && typeof rawAiDisclosureEnabled !== 'boolean') {
      throw new TypeError('aiDisclosureEnabled must be a boolean');
    }
    const requestFingerprint = qualityReviewFingerprint({
      stage: 'COPY', taskId, revisionId, nodeId, decision,
      originalScoreX10, currentScoreX10, edits,
      originalReasonCodes, originalNote, currentReasonCodes, currentNote,
      aiDisclosureEnabled: rawAiDisclosureEnabled ?? null,
      imagePlanBulletOverflowConfirmed: rawImagePlanBulletOverflowConfirmed === true,
      reviewerUsername,
    });
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity)).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.assigned_to_user_id == null) {
        throw new ControlPlaneConflictError(
          'TASK_ASSIGNEE_REQUIRED',
          '未分配任务不能进行文案审核，请先指定负责人',
        );
      }
      if (await claimQualityReviewSubmission(client, {
        taskId, stage: 'COPY', reviewerUsername, reviewSessionId, requestFingerprint,
      })) return taskFrom(task);
      if (task.priority_paused) throw new ControlPlaneConflictError('TASK_PRIORITY_PAUSED', '任务已暂停，请先恢复优先级');
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
      if (!edits && decision !== 'DISCARD') {
        normalizeCopyReviewImagePlan(
          revision.rows[0].content.imagePlan
            ?? revision.rows[0].content.reviewed?.imagePlan
            ?? revision.rows[0].content.post?.imagePlan,
        );
      }
      const imageRetryRework = task.current_stage === 'IMAGE_RETRY_EXHAUSTED';
      const mandatoryRework = imageRetryRework || task.copy_qa_rework_pending === true || (task.mandatory_copy_qc === true
        && !['DISCARD_RESTORE', 'SECOND_ASSIGNMENT'].includes(task.mandatory_copy_qc_origin));
      if (imageRetryRework && ['SAVE', 'SAVE_PLAN'].includes(decision)) {
        throw new ControlPlaneConflictError(
          'IMAGE_RETRY_REVIEW_SUBMIT_REQUIRED',
          '生图失败修订不能单独保存正式版本；修改会自动保存为草稿，请完成修改后直接提交强制复检',
        );
      }
      // Image exhaustion starts a new rework round at the copy that failed.
      const reworkBaseline = imageRetryRework ? revision.rows[0]
        : mandatoryRework ? await copyReworkBaseline(client, taskId, revision.rows[0]) : null;
      const originalImagePlan = edits ? normalizeCopyReviewImagePlan(
        revision.rows[0].content.imagePlan
          ?? revision.rows[0].content.reviewed?.imagePlan
          ?? revision.rows[0].content.post?.imagePlan,
        { allowBulletOverflow: true },
      ) : null;
      const originalImageSettings = edits ? normalizeImageSettings(
        revision.rows[0].content.imageSettings ?? DEFAULT_IMAGE_SETTINGS,
      ) : null;
      let imagePlanChanged = Boolean(edits && !isDeepStrictEqual(edits.imagePlan, originalImagePlan));
      const imageSettingsChanged = Boolean(edits
        && !isDeepStrictEqual(edits.imageSettings ?? originalImageSettings, originalImageSettings));
      if (edits && !mandatoryRework && actorRole !== 'ADMIN' && decision !== 'SAVE_PLAN' && !imagePlanChanged
          && revision.rows[0].content.manualReview?.imagePlanEdited !== true) {
        edits = { ...edits, imagePlan: automaticReviewImagePlan(edits.imagePlan) };
        imagePlanChanged = !isDeepStrictEqual(edits.imagePlan, originalImagePlan);
      }
      const revisionRework = reworkBaseline?.content?.finalRework;
      const copyOnlyFinalRework = reworkBaseline?.revision_origin === 'FINAL_REWORK'
        && revisionRework?.target === 'COPY';
      if (copyOnlyFinalRework) {
        if (rawAiDisclosureEnabled !== undefined
            && rawAiDisclosureEnabled !== (task.ai_disclosure_enabled ?? true)) {
          throw new ControlPlaneConflictError(
            'COPY_REWORK_SCOPE_VIOLATION',
            '仅文案返工不能改变 AI 内容标识设置',
          );
        }
        if (edits) {
          const originalSettings = normalizeImageSettings(
            revision.rows[0].content.imageSettings ?? DEFAULT_IMAGE_SETTINGS,
          );
          if (!isDeepStrictEqual(edits.imageSettings ?? originalSettings, originalSettings)) {
            throw new ControlPlaneConflictError(
              'COPY_REWORK_SCOPE_VIOLATION',
              '仅文案返工不能改变图片格式或背景设置',
            );
          }
        }
      }
      if (mandatoryRework && (task.copy_qa_rework_pending === true || task.mandatory_copy_qc_origin === 'QA_RETURN')
          && decision === 'DISCARD') {
        throw new ControlPlaneConflictError(
          'RETURNED_COPY_DISCARD_REQUIRES_DISPOSITION',
          '质检打回任务必须通过专用废弃入口填写原因并完成质检链路处置',
        );
      }
      if (!mandatoryRework && decision !== 'SAVE_PLAN' && currentScoreX10 === null) throw new TypeError('score is required');
      await ensureManualReviewSourceNode(client, nodeId, actorIdentity);
      // Saving image planning creates a manual PLAN_EDIT revision with no
      // execution id, but it does not turn the unchanged machine copy into an
      // edited draft. Copy provenance is tracked explicitly on the revision;
      // use it so the first rating after a plan-only save remains ORIGINAL.
      const sourceIsOriginal = revision.rows[0].execution_id !== null || revision.rows[0].revision_origin === 'SECOND_ASSIGNMENT_RESET'
        || (revision.rows[0].revision_origin === 'PLAN_EDIT'
          && revision.rows[0].copy_content_changed_from_machine !== true);
      let sourceRatingContext = sourceIsOriginal ? 'ORIGINAL' : 'EDITED';
      let copyChanged = false;
      let baseScoreX10 = originalScoreX10;
      let baseReasonCodes = originalReasonCodes;
      let baseNote = originalNote;
      let baseRatingAlreadyStored = false;
      const latestAssessment = await client.query(`
        SELECT * FROM human_quality_assessments
        WHERE task_id = $1 AND stage = 'COPY' AND copy_revision_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [taskId, revisionId]);
      const baseAssessment = qualityAssessmentFrom(latestAssessment.rows[0]);
      if (baseAssessment) {
        baseScoreX10 = baseAssessment.scoreX10;
        baseReasonCodes = baseAssessment.reasonCodes;
        baseNote = baseAssessment.note;
        sourceRatingContext = baseAssessment.ratingContext;
        baseRatingAlreadyStored = true;
      }
      if (edits) {
        copyChanged = !isDeepStrictEqual(
          edits.copy,
          normalizedReviewCopy(revision.rows[0].content, edits.imagePlan),
        );
        if (decision === 'SAVE_PLAN') {
          if (copyChanged || imageSettingsChanged) {
            throw new ControlPlaneConflictError(
              'IMAGE_PLAN_SAVE_SCOPE_VIOLATION',
              '单独保存图片规划不能修改标题、正文、标签、图片格式或背景设置',
            );
          }
          if (!imagePlanChanged) {
            throw new ControlPlaneConflictError('IMAGE_PLAN_UNCHANGED', '图片规划内容与当前正式版本一致，无需重复保存');
          }
        }
        if (!mandatoryRework && decision !== 'SAVE_PLAN' && !baseAssessment && baseScoreX10 === null) {
          if (sourceIsOriginal) {
            throw new TypeError('originalScore is required when editing generated copy');
          }
          throw new ControlPlaneConflictError(
            'COPY_BASE_RATING_REQUIRED',
            '当前文案版本缺少可验证的评分，不能提交修改',
          );
        } else if (!mandatoryRework && decision !== 'SAVE_PLAN' && !baseAssessment) {
          // Legacy manual revisions and a machine draft's first edit can both
          // predate a stored assessment. Accept only an explicitly submitted,
          // fully validated base rating; the edited score never stands in for it.
          assertQualityExplanation(baseScoreX10, baseReasonCodes, baseNote, 'originalScore');
        }
        if (!mandatoryRework && copyChanged && ![20, 25].includes(baseScoreX10)) {
          throw new ControlPlaneConflictError(
            'COPY_EDIT_SCORE_NOT_ALLOWED',
            '当前文案仅在评分为 2 分或 2.5 分时可以修改标题、正文或标签',
          );
        }
      }
      const wasCopyEdited = revision.rows[0].copy_content_changed_from_machine === true;
      const copyReworkSatisfied = mandatoryRework && copyReworkChanges(
        reworkBaseline.content, edits ?? revision.rows[0].content,
      ).satisfied;
      let finalCopyEdited = wasCopyEdited || copyChanged;
      if (decision === 'APPROVE' && !mandatoryRework && !sourceIsOriginal && wasCopyEdited) {
        const differsFromMachine = await copyDiffersFromMachineAncestor(client, {
          taskId,
          revisionId,
          revisionContent: revision.rows[0].content,
          edits,
        });
        if (differsFromMachine !== null) finalCopyEdited = differsFromMachine;
      }
      if (!mandatoryRework && sourceIsOriginal
          && (baseScoreX10 ?? currentScoreX10) === 10 && !['DISCARD', 'SAVE_PLAN'].includes(decision)) {
        throw new ControlPlaneConflictError('SCORE_ONE_REQUIRES_DISCARD', '1 分机器初稿必须直接作废');
      }
      if (decision === 'APPROVE' && mandatoryRework && !copyReworkSatisfied) {
        throw new ControlPlaneConflictError(
          'COPY_REWORK_NOT_SATISFIED',
          '返工稿尚未发生实际修改；请修改文案或图片规划后再提交强制复检',
        );
      }
      if (decision === 'APPROVE' && !mandatoryRework
          && baseScoreX10 !== null && baseScoreX10 < 30 && !finalCopyEdited) {
        throw new ControlPlaneConflictError(
          'COPY_EDIT_REQUIRED',
          '低于 3 分的机器初稿必须实际修改标题、正文或标签，才能提交达标审核结果',
        );
      }
      const carryBaseRating = decision !== 'APPROVE'
        && !copyChanged && (Boolean(edits) || baseRatingAlreadyStored);
      const assessmentScoreX10 = decision === 'APPROVE' ? 30
        : carryBaseRating ? baseScoreX10 : currentScoreX10;
      const assessmentReasonCodes = decision === 'APPROVE' ? []
        : carryBaseRating ? baseReasonCodes : currentReasonCodes;
      const assessmentNote = decision === 'APPROVE' ? null
        : carryBaseRating ? baseNote : currentNote;
      if (assessmentScoreX10 !== null) {
        assertQualityExplanation(assessmentScoreX10, assessmentReasonCodes, assessmentNote);
      }
      let reviewedRevisionId = revisionId;
      let reviewedRevisionRow = revision.rows[0];
      const reviewedContent = edits
        ? contentWithReviewEdits(revision.rows[0].content, edits, {
          baseRevisionId: revisionId,
          nodeId,
          copyChanged,
          imagePlanChanged,
        })
        : decision === 'APPROVE' && !mandatoryRework && actorRole !== 'ADMIN'
            && revision.rows[0].content.manualReview?.imagePlanEdited !== true
          ? contentWithAutomaticReviewLayouts(revision.rows[0].content, { baseRevisionId: revisionId, nodeId })
          : null;
      if (reviewedContent) {
        const revisionNumber = Number((await client.query(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM copy_revisions WHERE task_id = $1
        `, [taskId])).rows[0].revision);
        const reviewedRevision = await client.query(`
          INSERT INTO copy_revisions(
            task_id, execution_id, revision, content, approved_at, approved_by_node_id, approval_mode,
            parent_revision_id, revision_origin, copy_content_changed_from_machine, copy_rework_satisfied
          ) VALUES ($1, NULL, $2, $3,
            CASE WHEN $5 = 'APPROVE' THEN now() ELSE NULL END,
            CASE WHEN $5 = 'APPROVE' THEN $4 ELSE NULL END,
            CASE WHEN $5 = 'APPROVE' THEN 'MANUAL' ELSE NULL END,
            $6, $7, $8, $9)
          RETURNING *
        `, [taskId, revisionNumber, reviewedContent, nodeId, decision, revisionId,
          copyChanged ? 'COPY_EDIT' : 'PLAN_EDIT', finalCopyEdited,
          (task.mandatory_copy_qc === true || task.copy_qa_rework_pending === true) && copyReworkSatisfied]);
        reviewedRevisionId = Number(reviewedRevision.rows[0].id);
        reviewedRevisionRow = reviewedRevision.rows[0];
      } else if (decision === 'APPROVE') {
        const approvedRevision = await client.query(`
          UPDATE copy_revisions SET approved_at = now(), approved_by_node_id = $2, approval_mode = 'MANUAL',
            copy_rework_satisfied = $3
          WHERE id = $1 RETURNING *
        `, [revisionId, nodeId, copyReworkSatisfied]);
        reviewedRevisionRow = approvedRevision.rows[0];
      }
      let finalAssessment = null;
      if (assessmentScoreX10 !== null
          && (!reviewedContent || (!mandatoryRework && copyChanged && !baseRatingAlreadyStored))) {
        const storedAssessment = await insertQualityAssessment(client, {
          taskId, stage: 'COPY', copyRevisionId: revisionId,
          scoreX10: reviewedContent && copyChanged ? baseScoreX10 : assessmentScoreX10,
          ratingContext: sourceRatingContext,
          action: reviewedContent ? 'SAVE' : decision,
          reasonCodes: reviewedContent && copyChanged ? baseReasonCodes : assessmentReasonCodes,
          note: reviewedContent && copyChanged ? baseNote : assessmentNote,
          reviewerUsername, reviewSessionId, requestFingerprint,
        });
        if (!reviewedContent && decision === 'APPROVE') finalAssessment = storedAssessment;
      }
      if (reviewedContent && (decision === 'APPROVE' || assessmentScoreX10 !== null)) {
        finalAssessment = await insertQualityAssessment(client, {
          taskId, stage: 'COPY', copyRevisionId: reviewedRevisionId,
          scoreX10: assessmentScoreX10,
          ratingContext: copyChanged ? 'EDITED' : sourceRatingContext,
          action: decision === 'SAVE_PLAN' ? 'SAVE' : decision,
          reasonCodes: assessmentReasonCodes, note: assessmentNote,
          reviewerUsername, reviewSessionId, requestFingerprint,
        });
      }
      if (decision === 'APPROVE') {
        const routed = await routeManualCopyApproval(client, {
          task,
          revision: reviewedRevisionRow,
          assessment: finalAssessment,
          actor: actorIdentity ?? { userId: null, username: reviewerUsername, role: actorRole },
          reviewSessionId,
          aiDisclosureEnabled,
          retryExhaustedCopyChanged: imageRetryRework && (copyChanged || imagePlanChanged),
        });
        return taskFrom(routed.task);
      }
      if (decision === 'DISCARD') {
        const discarded = await client.query(`
          UPDATE tasks SET
            state = 'CANCELLED', cancelled_from_state = state,
            current_execution_id = NULL, current_stage = 'CANCELLED',
            progress_percent = 100, progress_message = '文案已被质检废弃',
            last_activity_at = now(), finished_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [taskId]);
        if (task.production_batch_id !== null) {
          await attemptAutomaticCopySamplingFreeze(client, task.production_batch_id,
            actorIdentity ?? { userId: null, username: reviewerUsername, role: actorRole });
        }
        return taskFrom(discarded.rows[0]);
      }
      const saved = await client.query(`
        UPDATE tasks SET
          state = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2,
          ai_disclosure_enabled = $3,
          current_image_run_id = CASE WHEN $4 THEN NULL ELSE current_image_run_id END,
          current_execution_id = NULL, current_stage = 'COPY_REVIEW_PENDING',
          progress_percent = 100, progress_message = $5,
          last_activity_at = now(), finished_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId, reviewedRevisionId, aiDisclosureEnabled, Boolean(reviewedContent),
        reviewedContent
          ? decision === 'SAVE_PLAN' ? '图片文案规划已保存，等待继续文案审核' : '人工修改已保存，等待继续审核'
          : '人工评分已保存，等待继续审核']);
      return taskFrom(saved.rows[0]);
    });
  }

  async reviewImages(rawTaskId, {
    imageRunId: rawImageRunId,
    revisionId: rawRevisionId,
    nodeId: rawNodeId,
    imagePlan: rawImagePlan,
    decision: rawDecision,
    reworkTarget: rawReworkTarget,
    score: rawScore,
    reasons: rawReasons,
    reasonCodes: rawReasonCodes,
    note: rawNote,
    problemAssetIds: rawProblemAssetIds,
    copyFields: rawCopyFields,
    imagePlanBulletOverflowConfirmed: rawImagePlanBulletOverflowConfirmed,
    reviewerUserId: rawReviewerUserId,
    reviewSessionId: rawReviewSessionId,
    actor: rawActor = null,
  }) {
    const taskId = normalizeTaskId(rawTaskId);
    const imageRunId = normalizeUuid(rawImageRunId, 'imageRunId');
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const reviewerUsername = normalizeCreatorUserId(actorIdentity?.username ?? rawReviewerUserId);
    const reviewSessionId = normalizeUuid(rawReviewSessionId, 'reviewSessionId');
    const scoreX10 = normalizedHumanQualityScore(rawScore);
    const reasonCodes = normalizedQualityReasonCodes(rawReasons ?? rawReasonCodes);
    const problemAssetIds = normalizedQualityProblemAssetIds(rawProblemAssetIds);
    const copyFields = normalizedReworkCopyFields(rawCopyFields);
    const note = normalizedQualityNote(rawNote);
    const decision = String(rawDecision ?? '').trim().toUpperCase();
    if (!['APPROVE', 'RETRY', 'REWORK', 'DISCARD'].includes(decision)) throw new TypeError('image review decision is invalid');
    if (rawImagePlanBulletOverflowConfirmed !== undefined
        && typeof rawImagePlanBulletOverflowConfirmed !== 'boolean') {
      throw new TypeError('imagePlanBulletOverflowConfirmed must be a boolean');
    }
    const reworkTarget = decision === 'RETRY' ? 'IMAGE'
      : decision === 'REWORK' ? String(rawReworkTarget ?? '').trim().toUpperCase() : null;
    if (decision === 'REWORK' && !['COPY', 'IMAGE', 'BOTH'].includes(reworkTarget)) {
      throw new TypeError('reworkTarget must be COPY, IMAGE or BOTH');
    }
    if (decision !== 'REWORK' && copyFields.length > 0) {
      throw new TypeError('copyFields are only accepted for rework');
    }
    if (decision === 'REWORK') {
      if (!note) throw new TypeError('rework requires precise change instructions');
      if (['COPY', 'BOTH'].includes(reworkTarget) && copyFields.length === 0) {
        throw new TypeError('copy rework requires at least one copyFields target');
      }
      if (['IMAGE', 'BOTH'].includes(reworkTarget) && problemAssetIds.length === 0) {
        throw new TypeError('image rework requires at least one problemAssetIds target');
      }
    }
    const editedImagePlan = rawImagePlan === undefined ? null : normalizeCopyReviewImagePlan(rawImagePlan);
    if (editedImagePlan && reworkTarget !== 'IMAGE') {
      throw new TypeError('imagePlan edits are only accepted for image-only rework');
    }
    if (editedImagePlan && actorIdentity?.role !== 'ADMIN') {
      throw new ControlPlaneAuthorizationError('only administrators can edit an approved image plan');
    }
    const revisionId = editedImagePlan ? normalizeTaskId(rawRevisionId) : null;
    const nodeId = editedImagePlan ? normalizeNodeId(rawNodeId) : null;
    if (decision === 'APPROVE' && scoreX10 <= 20) {
      throw new ControlPlaneConflictError('QUALITY_SCORE_TOO_LOW', 'image score must be 2.5 or 3 to approve');
    }
    const requestFingerprint = qualityReviewFingerprint({
      stage: 'IMAGE', taskId, imageRunId, decision, scoreX10,
      reworkTarget, reasonCodes, problemAssetIds, copyFields, note, reviewerUsername,
      imagePlanBulletOverflowConfirmed: rawImagePlanBulletOverflowConfirmed === true,
      ...(editedImagePlan ? { revisionId, nodeId, imagePlan: editedImagePlan } : {}),
    });
    const retry = reworkTarget !== null;
    const copyRework = ['COPY', 'BOTH'].includes(reworkTarget);
    const approved = decision === 'APPROVE';
    const state = approved ? 'REVIEWED' : copyRework ? 'COPY_REVIEW_PENDING'
      : retry ? 'IMAGE_QUEUED' : 'CANCELLED';
    const message = approved ? '图片审核通过，任务已完成'
      : copyRework ? '图文终审已退回文案；实际修改后须提交强制复检，复检通过后才进入待生图队列'
        : retry ? '质检要求重新生成图片，等待图片执行机领取' : '任务已被质检废弃';
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          allowedRoles: USER_ROLES,
          reviewAssignmentOnly: true,
        })).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (await claimQualityReviewSubmission(client, {
        taskId, stage: 'IMAGE', reviewerUsername, reviewSessionId, requestFingerprint,
      })) return taskFrom(task);
      if (task.priority_paused) throw new ControlPlaneConflictError('TASK_PRIORITY_PAUSED', '任务已暂停，请先恢复优先级');
      if (task.state !== 'MANUAL_ARCHIVE') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', '任务已不在人工归档阶段，请刷新后重试');
      }
      if (task.current_image_run_id !== imageRunId) {
        throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '图片版本已变化，请刷新后重新审核');
      }
      if (decision === 'REWORK') {
        const settings = await client.query("SELECT value FROM global_settings WHERE key = 'production'");
        const humanQualitySettings = normalizeHumanQualitySettings(
          settings.rows[0]?.value?.humanQualityReasons,
        );
        if (humanQualitySettings.imageReviewDisplay.showDeductionReasons
          && humanQualitySettings.imageReasons.length > 0 && reasonCodes.length === 0) {
          throw new TypeError('rework requires at least one reason code while image reasons are enabled');
        }
      }
      const run = await client.query(`
        SELECT id FROM image_runs WHERE id = $1 AND task_id = $2
          AND copy_revision_id = $3 AND status = 'COMPLETED'
      `, [imageRunId, taskId, task.current_copy_revision_id]);
      if (!run.rows[0]) throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '当前文案对应的图片尚未生成完成');
      if (problemAssetIds.length) {
        const assets = await client.query(`
          SELECT id FROM image_run_asset_view
          WHERE task_id = $1 AND image_run_id = $2 AND id = ANY($3::bigint[])
        `, [taskId, imageRunId, problemAssetIds]);
        if (assets.rows.length !== problemAssetIds.length) {
          throw new ControlPlaneConflictError(
            'INVALID_PROBLEM_ASSETS',
            'problemAssetIds must belong to the current image run',
          );
        }
      }
      let nextCopyRevisionId = Number(task.current_copy_revision_id);
      if (editedImagePlan) {
        if (nextCopyRevisionId !== revisionId) {
          throw new ControlPlaneConflictError('STALE_COPY_REVISION', '文案规划版本已变化，请刷新后重新审核');
        }
        const revision = await client.query(`
          SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE
        `, [revisionId, taskId]);
        if (!revision.rows[0]?.approved_at) {
          throw new ControlPlaneConflictError('COPY_NOT_APPROVED', '当前文案尚未审核通过');
        }
        const original = revision.rows[0].content;
        const originalPlan = original.imagePlan ?? original.reviewed?.imagePlan ?? original.post?.imagePlan;
        if (!Array.isArray(originalPlan) || originalPlan.length !== editedImagePlan.length
          || originalPlan.some((page, index) => page?.kind !== editedImagePlan[index].kind)) {
          throw new TypeError('图片审核只能修改现有页面的文字与画面指令，不能改变页数或页面类型');
        }
        const revisionNumber = Number((await client.query(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM copy_revisions WHERE task_id = $1
        `, [taskId])).rows[0].revision);
        const content = contentWithImagePlanRetry(original, editedImagePlan, {
          baseRevisionId: revisionId,
          baseImageRunId: imageRunId,
          actorUsername: reviewerUsername,
        });
        await ensureManualReviewSourceNode(client, nodeId, actorIdentity);
        const saved = await client.query(`
          INSERT INTO copy_revisions(
            task_id, execution_id, revision, content, approved_at, approved_by_node_id, approval_mode,
            parent_revision_id, revision_origin, copy_content_changed_from_machine, copy_rework_satisfied
          ) VALUES ($1, NULL, $2, $3, now(), $4, 'MANUAL', $5, 'PLAN_EDIT', $6, $7)
          RETURNING *
        `, [taskId, revisionNumber, content, nodeId, revisionId,
          revision.rows[0].copy_content_changed_from_machine === true,
          revision.rows[0].copy_rework_satisfied === true]);
        nextCopyRevisionId = Number(saved.rows[0].id);
        await client.query(`
          INSERT INTO copy_qc_revision_inheritances(
            target_revision_id, task_id, source_revision_id,
            inherited_by_account_id, inherited_by_username, reason
          ) VALUES ($1, $2, $3, $4, $5, 'IMAGE_PLAN_RETRY')
        `, [nextCopyRevisionId, taskId, revisionId,
          actorIdentity?.userId ?? null, reviewerUsername]);
      }
      if (copyRework) {
        const source = await client.query(`
          SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE
        `, [task.current_copy_revision_id, taskId]);
        if (!source.rows[0]) throw new ControlPlaneConflictError('COPY_NOT_APPROVED', '当前文案版本不存在');
        const revisionNumber = Number((await client.query(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM copy_revisions WHERE task_id = $1
        `, [taskId])).rows[0].revision);
        const content = {
          ...source.rows[0].content,
          finalRework: {
            target: reworkTarget,
            reasonCodes,
            copyFields,
            problemAssetIds,
            instructions: note,
            note,
            returnedByUsername: reviewerUsername,
            returnedAt: new Date().toISOString(),
          },
        };
        const placeholder = await client.query(`
          INSERT INTO copy_revisions(
            task_id, execution_id, revision, content, parent_revision_id, revision_origin,
            copy_content_changed_from_machine, copy_rework_satisfied
          ) VALUES ($1, NULL, $2, $3, $4, 'FINAL_REWORK', $5, false)
          RETURNING *
        `, [taskId, revisionNumber, content, task.current_copy_revision_id,
          source.rows[0].copy_content_changed_from_machine === true]);
        nextCopyRevisionId = Number(placeholder.rows[0].id);
      }
      await insertQualityAssessment(client, {
        taskId, stage: 'IMAGE', imageRunId, scoreX10,
        ratingContext: 'IMAGE', action: decision === 'REWORK' ? 'RETRY' : decision,
        reasonCodes, problemAssetIds, note,
        reworkTarget,
        reworkDetails: decision === 'REWORK' ? {
          copyFields,
          problemAssetIds,
          instructions: note,
        } : null,
        reviewerUsername, reviewSessionId, requestFingerprint,
      });
      if (!approved) await withdrawReadyDeliveryEntries(client, taskId);
      const updated = await client.query(`
        UPDATE tasks SET
          state = $2, current_stage = $2, progress_message = $3,
          current_copy_revision_id = $5,
          current_execution_id = NULL, pending_snapshot = NULL, error = NULL,
          current_image_run_id = ${retry ? 'NULL' : 'current_image_run_id'},
          ${retry ? `image_production_chain_id = NULL, image_production_started_at = NULL,
          image_production_duration_ms = 0,` : ''}
          mandatory_copy_qc = ${copyRework ? 'true' : 'mandatory_copy_qc'},
          mandatory_copy_qc_origin = ${copyRework ? "'FINAL_REWORK'" : 'mandatory_copy_qc_origin'},
          progress_percent = ${retry ? 0 : 100},
          execution_started_at = ${retry ? 'NULL' : 'execution_started_at'},
          finished_at = ${retry ? 'NULL' : 'COALESCE(finished_at, now())'},
          image_reviewed_at = ${approved ? 'now()' : 'NULL'},
          image_reviewed_by_user_id = $4,
          last_activity_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [taskId, state, editedImagePlan
        ? '管理员已修正图片文案规划，等待图片执行机重新生成'
        : message, approved ? reviewerUsername : null, nextCopyRevisionId]);
      if (approved) {
        await createReadyDeliveryEntry(client, {
          taskId,
          copyRevisionId: nextCopyRevisionId,
          imageRunId,
          actor: actorIdentity ?? { userId: null, username: reviewerUsername },
        });
      }
      return taskFrom(updated.rows[0]);
    });
  }

  async retryTask(rawTaskId, { useLatestConfig = false, actor: rawActor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    if (typeof useLatestConfig !== 'boolean') throw new TypeError('useLatestConfig must be a boolean');
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          ownerOnly: actorIdentity.role !== 'ADMIN',
          allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
        })).task;
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
        const executionRows = useLatestConfig ? execution.rows : await hydrateExecutionSnapshots(client, execution.rows);
        if (executionRows[0]?.status === 'RUNNING') {
          sourceExecution = executionRows[0];
          snapshot = executionRows[0].snapshot;
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
          SELECT * FROM task_executions
          WHERE task_id = $1 AND kind = $2
          ORDER BY started_at DESC LIMIT 1
        `, [taskId, isCopy ? 'COPY' : 'IMAGE']);
        sourceExecution = (await hydrateExecutionSnapshots(client, previous.rows))[0];
        snapshot = sourceExecution?.snapshot ?? null;
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
          state = $2, requeue_reason = 'MANUAL_RETRY', current_execution_id = NULL, current_stage = $2,
          ${isCopy ? 'copy_executor_node_id = NULL,' : ''}
          progress_percent = 0, progress_message = ${isCopy ? "'等待文案执行机领取'" : "'等待重新执行'"},
          ${isImage && useLatestConfig ? `image_production_chain_id = NULL,
          image_production_started_at = NULL, image_production_duration_ms = 0,` : ''}
          pending_snapshot = $3, execution_started_at = NULL,
          last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, values);
      return taskFrom(updated.rows[0]);
    });
  }

  async saveTaskView(rawOwnerUsername, input, { actor: rawActor = null } = {}) {
    const ownerUsername = normalizedUsername(rawOwnerUsername);
    const view = normalizeSavedTaskView(input);
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const save = async (queryable) => {
      const result = await queryable.query(`
        INSERT INTO saved_task_views(owner_username, name, view_key, filters)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(owner_username, name) DO UPDATE SET
          view_key = EXCLUDED.view_key, filters = EXCLUDED.filters, updated_at = now()
        RETURNING *
      `, [ownerUsername, view.name, view.viewKey, view.filters]);
      return savedTaskViewFrom(result.rows[0]);
    };
    if (actor === null) return save(this.pool);
    return transaction(this.pool, async (client) => {
      const locked = await lockCurrentActor(client, actor);
      if (locked.actor.role !== 'ADMIN' || locked.actor.username !== ownerUsername) {
        throw new ControlPlaneAuthorizationError('saved task views belong to the current administrator');
      }
      return save(client);
    });
  }

  async deleteSavedTaskView(rawOwnerUsername, rawViewId, { actor: rawActor = null } = {}) {
    const ownerUsername = normalizedUsername(rawOwnerUsername);
    const viewId = normalizeTaskId(rawViewId);
    const actor = rawActor === null ? null : normalizedActorIdentity(rawActor);
    const remove = async (queryable) => {
      const result = await queryable.query(`
        DELETE FROM saved_task_views WHERE id = $1 AND owner_username = $2 RETURNING id
      `, [viewId, ownerUsername]);
      if (!result.rows[0]) throw new ControlPlaneNotFoundError('saved task view not found');
      return { id: Number(result.rows[0].id), deleted: true };
    };
    if (actor === null) return remove(this.pool);
    return transaction(this.pool, async (client) => {
      const locked = await lockCurrentActor(client, actor);
      if (locked.actor.role !== 'ADMIN' || locked.actor.username !== ownerUsername) {
        throw new ControlPlaneAuthorizationError('saved task views belong to the current administrator');
      }
      return remove(client);
    });
  }

  async restoreCancelledTask(rawTaskId, input, { actor: rawActor } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actor = normalizedActorIdentity(rawActor);
    return transaction(this.pool, async (client) => {
      const { task } = await lockTaskForActor(client, taskId, actor, { allowedRoles: ['ADMIN'] });
      return taskFrom(await restoreDiscardedTask(client, task, actor, input));
    });
  }

  async requeueCancelledTask(rawTaskId, { actor: rawActor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          allowedRoles: ['ADMIN'],
        })).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (task.state !== 'CANCELLED' || !['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.cancelled_from_state)) {
        throw new ControlPlaneConflictError('REQUEUE_UNAVAILABLE', 'only a cancelled queued task can be queued again');
      }
      await withdrawReadyDeliveryEntries(client, taskId, 'CANCELLED_TASK_REQUEUED');
      const updated = await client.query(`
        UPDATE tasks SET state = $2, requeue_reason = 'MANUAL_RETRY', cancelled_from_state = NULL, current_stage = $2,
          progress_percent = 0, progress_message = $3, finished_at = NULL, error = NULL,
          last_activity_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [taskId, task.cancelled_from_state, task.cancelled_from_state === 'IMAGE_QUEUED' ? '等待图片执行机领取' : '等待文案执行机领取']);
      // Duplicate cleanup also pauses an unfinished Xiaohongshu acquisition.
      // Requeue that paired job only when an immutable duplicate-discard audit
      // proves why it was cancelled; successful searches remain untouched.
      await client.query(`
        UPDATE xhs_query_search_jobs AS search SET
          status = 'PENDING', attempt_count = 0,
          claimed_by_node_id = NULL, lease_token = NULL, lease_expires_at = NULL,
          retry_after = NULL, blocked_reason = NULL, error = NULL,
          result_count = 0, searched_at = NULL, updated_at = now()
        WHERE search.task_id = $1 AND search.status = 'CANCELLED'
          AND EXISTS (
            SELECT 1 FROM task_duplicate_query_discard_audits AS audit
            WHERE audit.discarded_task_id = $1
          )
      `, [taskId]);
      return taskFrom(updated.rows[0]);
    });
  }

  async reviseImages(taskId, input, actorUsername, actorRole = 'ADMIN', rawActor = null) {
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    return transaction(this.pool, async (client) => {
      if (actorIdentity !== null) {
        await lockTaskForActor(client, taskId, actorIdentity, {
          ownerOnly: actorIdentity.role !== 'ADMIN',
        });
      }
      return taskFrom(await reviseTaskImages(client, taskId, input,
        actorIdentity?.username ?? actorUsername, actorIdentity?.role ?? actorRole));
    });
  }

  async requeueImageTask(rawTaskId, { retryOnly = false, actor: rawActor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    if (typeof retryOnly !== 'boolean') throw new TypeError('retryOnly must be a boolean');
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          ownerOnly: actorIdentity.role !== 'ADMIN',
        })).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      const retryExhausted = task.state === 'COPY_REVIEW_PENDING'
        && task.current_stage === 'IMAGE_RETRY_EXHAUSTED';
      if (retryExhausted && retryOnly) {
        throw new ControlPlaneConflictError(
          'IMAGE_RETRY_REVIEW_REQUIRED',
          '生图重试已用尽，请从任务详情单条确认后重试生图',
        );
      }
      if (retryExhausted && (task.mandatory_copy_qc !== true
          || task.mandatory_copy_qc_origin !== 'IMAGE_RETRY_REVIEW'
          || task.copy_qa_rework_pending === true)) {
        throw new ControlPlaneConflictError(
          'IMAGE_RETRY_REVIEW_REQUIRED',
          '当前任务还有文案返工或复检要求，不能直接重试生图',
        );
      }
      if (retryOnly && !['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only running or failed image work can be retried in bulk');
      }
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
      if (retryExhausted) {
        const previouslyReleased = task.copy_qc_released_revision_id != null
          && String(task.copy_qc_released_revision_id) === String(task.current_copy_revision_id);
        const quality = previouslyReleased ? await client.query(`
          SELECT copy_quality_image_eligible($1, $2, false) AS eligible
        `, [taskId, task.current_copy_revision_id]) : { rows: [] };
        if (!quality.rows[0]?.eligible) {
          throw new ControlPlaneConflictError(
            'IMAGE_RETRY_UNAVAILABLE',
            '当前文案版本尚未完成质检放行，不能直接重试生图',
          );
        }
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
      await withdrawReadyDeliveryEntries(client, taskId, 'IMAGE_REQUEUE');
      const updated = await client.query(`
        UPDATE tasks SET
          state = 'IMAGE_QUEUED', requeue_reason = 'MANUAL_RETRY', current_execution_id = NULL,
          current_image_run_id = NULL, current_stage = 'IMAGE_QUEUED',
          progress_percent = 0, progress_message = '已人工重试，等待图片执行机领取',
          pending_snapshot = NULL, execution_started_at = NULL,
          image_production_chain_id = NULL, image_production_started_at = NULL,
          image_production_duration_ms = 0,
          mandatory_copy_qc = CASE WHEN $2 THEN false ELSE mandatory_copy_qc END,
          mandatory_copy_qc_origin = CASE WHEN $2 THEN NULL ELSE mandatory_copy_qc_origin END,
          last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId, retryExhausted]);
      return taskFrom(updated.rows[0]);
    });
  }

  async cancelTask(rawTaskId, { queuedOnly = false, adminDiscardOnly = false, actor: rawActor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    if (typeof queuedOnly !== 'boolean') throw new TypeError('queuedOnly must be a boolean');
    if (typeof adminDiscardOnly !== 'boolean') throw new TypeError('adminDiscardOnly must be a boolean');
    if (adminDiscardOnly && actorIdentity?.role !== 'ADMIN') {
      throw new ControlPlaneAuthorizationError('仅管理员可批量废弃待文案审核任务');
    }
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          ownerOnly: actorIdentity.role !== 'ADMIN',
          allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
        })).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (queuedOnly && !['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state)) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', 'only queued work can be cancelled in bulk');
      }
      if (actorIdentity && actorIdentity.role !== 'ADMIN'
          && ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'IMAGE_QC_PENDING'].includes(task.state)) {
        throw new ControlPlaneConflictError('IMAGE_DISCARD_REQUIRES_REASON', '请通过图片环节的废弃入口填写原因');
      }
      if (task.state === 'COPY_QC_PENDING') {
        throw new ControlPlaneConflictError(
          'COPY_QC_CANCEL_FORBIDDEN',
          '文案抽检冻结中的任务不能从通用入口取消，请通过质检处置',
        );
      }
      if (task.state === 'COPY_REVIEW_PENDING' && task.mandatory_copy_qc === true
          && task.mandatory_copy_qc_origin === 'QA_RETURN') {
        throw new ControlPlaneConflictError(
          'RETURNED_COPY_DISCARD_REQUIRES_DISPOSITION',
          '质检打回任务必须通过专用废弃入口填写原因并完成质检链路处置',
        );
      }
      if (adminDiscardOnly && !canAdminDiscardTask({
        state: task.state,
        mandatoryCopyQc: task.mandatory_copy_qc,
        mandatoryCopyQcOrigin: task.mandatory_copy_qc_origin,
        copyQaReworkPending: task.copy_qa_rework_pending,
      })) {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', '仅排队或普通待文案审核任务可批量废弃');
      }
      if (adminDiscardOnly) {
        const regeneration = await client.query(`
          SELECT id FROM copy_image_plan_regeneration_jobs
          WHERE task_id = $1 AND status = 'RUNNING'
          ORDER BY created_at, id
          FOR UPDATE LIMIT 1
        `, [taskId]);
        if (regeneration.rows[0]) {
          throw new ControlPlaneConflictError('TASK_EXECUTION_ACTIVE', '图片规划正在生成，请等待完成后再废弃');
        }
      }
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
      await withdrawReadyDeliveryEntries(client, taskId, 'TASK_CANCELLED');
      const updated = await client.query(`
        UPDATE tasks SET
          state = 'CANCELLED', current_execution_id = NULL, current_stage = 'CANCELLED',
          cancelled_from_state = state,
          progress_message = CASE WHEN state IN ('COPY_QUEUED', 'IMAGE_QUEUED')
            THEN '排队任务已废弃，可由管理员重新加入队列' ELSE '任务已被人工废弃' END,
          last_activity_at = now(),
          finished_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [taskId]);
      if (task.production_batch_id !== null) {
        await attemptAutomaticCopySamplingFreeze(client, task.production_batch_id, actorIdentity);
      }
      return taskFrom(updated.rows[0]);
    });
  }

  async permanentlyDeleteTask(rawTaskId, {
    actor: rawActor = null,
    actorUsername: rawActorUsername,
    deletionPassword,
    beforeDelete = null,
  }) {
    const taskId = normalizeTaskId(rawTaskId);
    const actor = rawActor === null ? normalizedUsername(rawActorUsername) : normalizedActorIdentity(rawActor);
    if (beforeDelete !== null && typeof beforeDelete !== 'function') throw new TypeError('beforeDelete must be a function');
    return transaction(this.pool, async (client) => {
      await assertPermanentDeletionActor(client, actor, deletionPassword);
      const task = await assertPermanentlyDeletableTask(client, taskId);
      if (beforeDelete) await beforeDelete(taskId);
      await withdrawReadyDeliveryEntries(client, taskId, 'TASK_PERMANENTLY_DELETED');
      await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      if (task.production_batch_id !== null && task.production_batch_id !== undefined) {
        await attemptAutomaticCopySamplingFreeze(client, task.production_batch_id,
          typeof actor === 'object' ? actor : null);
      }
      return { id: taskId };
    });
  }

  async permanentlyDeleteTasks(rawTaskIds, {
    actor: rawActor = null,
    actorUsername: rawActorUsername,
    deletionPassword,
    beforeDelete = null,
  }) {
    const taskIds = normalizedPermanentDeletionTaskIds(rawTaskIds);
    const actor = rawActor === null ? normalizedUsername(rawActorUsername) : normalizedActorIdentity(rawActor);
    if (beforeDelete !== null && typeof beforeDelete !== 'function') throw new TypeError('beforeDelete must be a function');
    return transaction(this.pool, async (client) => {
      await assertPermanentDeletionActor(client, actor, deletionPassword);
      const eligible = [];
      const failed = [];
      const productionBatchIds = new Set();
      for (const taskId of taskIds) {
        try {
          const task = await assertPermanentlyDeletableTask(client, taskId);
          eligible.push(taskId);
          if (task.production_batch_id !== null && task.production_batch_id !== undefined) {
            productionBatchIds.add(Number(task.production_batch_id));
          }
        } catch (error) {
          if (!(error instanceof ControlPlaneNotFoundError) && !(error instanceof ControlPlaneConflictError)) throw error;
          failed.push({ id: taskId, code: error.code, message: error.message });
        }
      }
      for (const taskId of eligible) {
        if (beforeDelete) await beforeDelete(taskId);
        await withdrawReadyDeliveryEntries(client, taskId, 'TASK_PERMANENTLY_DELETED');
        await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      }
      for (const productionBatchId of [...productionBatchIds].sort((left, right) => left - right)) {
        await attemptAutomaticCopySamplingFreeze(client, productionBatchId,
          typeof actor === 'object' ? actor : null);
      }
      return { succeeded: eligible, failed };
    });
  }
}
