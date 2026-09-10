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
import {
  runAutoAssignmentReplenishment,
} from './task-auto-assignment-runner.mjs';
import { normalizeSavedTaskView, normalizeTaskAttention } from './task-view-filters.mjs';
import {
  normalizeAssigneeUserId,
  normalizeAssignmentSource,
  UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
} from './task-assignment-domain.mjs';
import {
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../../src/human-quality-settings.mjs';
import {
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
  normalizeXiaohongshuSearchSettings,
} from '../../src/xhs-query-search.mjs';
import {
  normalizeAutoAssignmentEnabled,
  normalizeAutoAssignmentExpectedVersion,
  normalizeAutoAssignmentLimit,
  normalizeAutoAssignmentWorkerStatus,
} from './task-auto-assignment-domain.mjs';
import {
  abandonQueryPackage,
  createQueryPackage,
  createQueryPackageProductionBatch,
  getQueryPackage,
  listQueryPackages,
  permanentlyDeleteQueryPackage,
  previewPermanentQueryPackageDeletion,
  updateQueryPackageScreening,
} from './query-packages.mjs';
import {
  blockXhsQuerySearch,
  claimXhsQuerySearch,
  completeXhsQuerySearch,
  failXhsQuerySearch,
  resumeXhsQuerySearch,
  retryFailedXhsQuerySearch,
} from './xhs-query-search.mjs';
import {
  discardDuplicateQueries,
  previewDuplicateQueryDiscard,
} from './query-duplicate-discard.mjs';
import { taskQueryIdentitySql } from './task-query-identity.mjs';
import {
  batchReturnCopyQa,
  freezeCopySamplingBatch,
  getCopyQaItem,
  getCopyQaBatchReturnPreview,
  getCopyQaStatistics,
  getProductionBatchSamplingReadiness,
  listCopyQaItems,
  passCopyQaItem,
  releaseCopySamplingBatch,
  releaseCopyQaFreeze,
  returnCopyQaItem,
  routeManualCopyApproval,
  attemptAutomaticCopySamplingFreeze,
} from './copy-quality-control.mjs';
import {
  readWorkflowQualitySettings,
  updateWorkflowQualitySettings,
} from './workflow-quality-settings.mjs';
import {
  assertTaskReadyForDelivery,
  assertTasksReadyForDelivery,
  createReadyDeliveryEntry,
  listAllDeliveryPoolTaskIds,
  listDeliveryPool,
  withdrawReadyDeliveryEntries,
} from './final-delivery.mjs';

import pg from 'pg';

import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  TASK_STATES,
  normalizeConcurrency,
  normalizeCopyReviewEdits,
  normalizeCopyReviewImagePlan,
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
const PERMANENT_DELETE_STATES = Object.freeze(['COPY_FAILED', 'IMAGE_FAILED', 'REVIEWED', 'CANCELLED']);

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
    WHEN ${column} = 'COPY_QC_PENDING' THEN 2
    WHEN ${column} = 'MANUAL_ARCHIVE' THEN 3
    WHEN ${column} = 'COPY_RUNNING' THEN 4
    WHEN ${column} = 'IMAGE_RUNNING' THEN 5
    WHEN ${column} IN ('COPY_FAILED', 'IMAGE_FAILED') THEN 6
    WHEN ${column} IN ('COPY_QUEUED', 'IMAGE_QUEUED') THEN 7
    WHEN ${column} = 'REVIEWED' THEN 8
    WHEN ${column} = 'CANCELLED' THEN 9
    ELSE 10
  END`;
}

function taskFrom(row) {
  if (!row) return null;
  const hasCreatorAccountId = Object.hasOwn(row, 'creator_account_id');
  const hasAssigneeAccountId = Object.hasOwn(row, 'assignee_account_id');
  const creatorAccountId = hasCreatorAccountId && row.creator_account_id !== null
    ? Number(row.creator_account_id)
    : null;
  return {
    id: Number(row.id),
    query: row.query,
    input: row.input,
    requestedImageCount: row.requested_image_count === 'auto'
      ? 'auto'
      : Number(row.requested_image_count),
    aiDisclosureEnabled: row.ai_disclosure_enabled ?? true,
    skipCopyReview: row.skip_copy_review === true,
    sourceQueryPackageId: row.source_query_package_id === undefined || row.source_query_package_id === null
      ? null : Number(row.source_query_package_id),
    sourceQueryPackageName: row.source_query_package_name ?? null,
    sourceQueryPackageExternalId: row.source_query_package_external_id ?? null,
    productionBatchId: row.production_batch_id === undefined || row.production_batch_id === null
      ? null : Number(row.production_batch_id),
    deliveryStatus: row.delivery_ready === true ? 'READY' : null,
    mandatoryCopyQc: row.mandatory_copy_qc === true,
    mandatoryCopyQcOrigin: row.mandatory_copy_qc_origin ?? null,
    state: row.state,
    cancelledFromState: row.cancelled_from_state ?? null,
    imageReviewedAt: row.image_reviewed_at ?? null,
    imageReviewedByUserId: row.image_reviewed_by_user_id ?? null,
    createdByNodeId: row.created_by_node_id,
    createdByUserId: row.created_by_user_id ?? null,
    ...(hasCreatorAccountId ? { createdByAccountId: creatorAccountId } : {}),
    createdByRole: creatorAccountId === null ? null : row.creator_role ?? null,
    createdByDisplayName: creatorAccountId === null ? null : row.creator_display_name ?? null,
    assignedToUserId: row.assigned_to_user_id ?? null,
    ...(hasAssigneeAccountId ? { assignedToAccountId: row.assignee_account_id === null
      ? null : Number(row.assignee_account_id) } : {}),
    assignedToDisplayName: row.assigned_to_display_name ?? null,
    assigneeStatus: row.assignee_status ?? null,
    assignmentSource: row.assignment_source ?? null,
    assignedAt: row.assigned_at ?? null,
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

function normalizedPermanentDeletionTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new RangeError('taskIds must contain between 1 and 20 items');
  }
  return [...new Set(value.map((taskId) => normalizeTaskId(taskId)))].sort((left, right) => left - right);
}

async function assertPermanentDeletionActor(client, rawActor, deletionPassword) {
  let user;
  if (rawActor && typeof rawActor === 'object' && !Array.isArray(rawActor)) {
    const locked = await lockCurrentActor(client, rawActor);
    if (locked.actor.role !== 'ADMIN') {
      throw new ControlPlaneAuthorizationError('only administrators can permanently delete tasks');
    }
    user = locked.row;
  } else {
    const actorUsername = normalizedUsername(rawActor);
    const actor = await client.query(
      "SELECT * FROM app_users WHERE username = $1 AND status = 'ACTIVE' FOR UPDATE",
      [actorUsername],
    );
    user = actor.rows[0];
  }
  if (!user || user.role !== 'ADMIN' || !user.deletion_password_hash
    || !await verifyUserPassword(deletionPassword, user.deletion_password_hash)) {
    throw new ControlPlaneConflictError('DELETION_PASSWORD_INVALID', 'deletion password is incorrect or has not been set');
  }
}

async function assertPermanentlyDeletableTask(client, taskId) {
  const task = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  if (!task.rows[0]) throw new ControlPlaneNotFoundError('task not found');
  if (!PERMANENT_DELETE_STATES.includes(task.rows[0].state)) {
    throw new ControlPlaneConflictError('TASK_MUST_BE_INACTIVE', '请先废弃排队任务或等待任务结束，再永久删除');
  }
  if (task.rows[0].state === 'CANCELLED'
    && ['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.rows[0].cancelled_from_state)) {
    const settled = await client.query(`
      SELECT updated_at <= now() - interval '3 minutes' AS ready
      FROM tasks WHERE id = $1
    `, [taskId]);
    if (!settled.rows[0]?.ready) {
      throw new ControlPlaneConflictError('TASK_CANCELLATION_SETTLING', '执行机仍在确认取消，请在取消后等待3分钟再永久删除');
    }
  }
  return task.rows[0];
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
    hasDeletionPassword: Boolean(row.deletion_password_hash),
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

function contentWithImagePlanRetry(content, imagePlan, {
  baseRevisionId,
  baseImageRunId,
  actorUsername,
}) {
  const original = normalizeJson(content, 'copy revision content', 5_000_000);
  // A plan edit requests a brand-new image generation. Do not inherit a prior
  // format/background-only reprocess marker, otherwise the executor would
  // convert the old assets and silently skip the corrected plan.
  delete original.imageReprocess;
  const reviewed = original.reviewed && typeof original.reviewed === 'object' && !Array.isArray(original.reviewed)
    ? { ...original.reviewed, imagePlan }
    : original.reviewed;
  return {
    ...original,
    imagePlan,
    ...(reviewed ? { reviewed } : {}),
    imageRevision: {
      version: 1,
      operation: 'REGENERATE',
      planEdited: true,
      baseRevisionId,
      baseImageRunId,
      actorUsername,
      createdAt: new Date().toISOString(),
    },
  };
}

function normalizedReviewCopy(content, imagePlan) {
  const original = normalizeJson(content, 'copy revision content', 5_000_000);
  return normalizeCopyReviewEdits({
    copy: original.copy ?? original.reviewed?.copy ?? original.post,
    // The caller only needs the normalized copy fields. Reusing the already
    // normalized submitted plan avoids assigning edit semantics to the plan.
    imagePlan: imagePlan ?? original.imagePlan ?? original.reviewed?.imagePlan ?? original.post?.imagePlan,
  }).copy;
}

async function copyDiffersFromMachineAncestor(client, {
  taskId,
  revisionId,
  revisionContent,
  edits,
}) {
  const machine = await client.query(`
    WITH RECURSIVE copy_lineage AS (
      SELECT id, task_id, execution_id, parent_revision_id, content, 0 AS depth
      FROM copy_revisions
      WHERE id = $1 AND task_id = $2
      UNION ALL
      SELECT parent.id, parent.task_id, parent.execution_id, parent.parent_revision_id,
        parent.content, child.depth + 1
      FROM copy_revisions AS parent
      JOIN copy_lineage AS child ON parent.id = child.parent_revision_id
      WHERE parent.task_id = $2 AND child.depth < 1000
    )
    SELECT content FROM copy_lineage
    WHERE execution_id IS NOT NULL
    ORDER BY depth
    LIMIT 1
  `, [revisionId, taskId]);
  if (!machine.rows[0]) return null;
  const finalCopy = edits?.copy ?? normalizedReviewCopy(revisionContent);
  return !isDeepStrictEqual(finalCopy, normalizedReviewCopy(machine.rows[0].content));
}

function revisionFrom(row) {
  if (!row) return null;
  const rework = row.content?.qualityReturn ?? row.content?.finalRework ?? null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    executionId: row.execution_id,
    revision: Number(row.revision),
    content: row.content,
    approvedAt: row.approved_at,
    approvalMode: row.approval_mode ?? (row.approved_at ? 'MANUAL' : null),
    approvedByNodeId: row.approved_by_node_id,
    parentRevisionId: row.parent_revision_id === undefined || row.parent_revision_id === null
      ? null : Number(row.parent_revision_id),
    revisionOrigin: row.revision_origin ?? null,
    copyContentChangedFromMachine: row.copy_content_changed_from_machine === true,
    copyReworkSatisfied: row.copy_rework_satisfied === true,
    reworkOrigin: rework?.origin ?? row.revision_origin ?? null,
    reworkReasonCodes: Array.isArray(rework?.reasonCodes) ? rework.reasonCodes : [],
    reworkNote: rework?.note ?? null,
    createdAt: row.created_at,
  };
}

function normalizedActorIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('actor identity is required');
  }
  const credentialVersion = Number(value.credentialVersion);
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new TypeError('actor credentialVersion must be a positive integer');
  }
  return {
    userId: normalizeTaskId(value.userId),
    username: normalizedUsername(value.username),
    role: normalizedUserRole(value.role),
    credentialVersion,
  };
}

async function lockCurrentActor(client, rawActor) {
  const actor = normalizedActorIdentity(rawActor);
  const result = await client.query(`
    SELECT * FROM app_users
    WHERE id = $1 AND username = $2 AND role = $3
      AND status = 'ACTIVE' AND credential_version = $4
    FOR UPDATE
  `, [actor.userId, actor.username, actor.role, actor.credentialVersion]);
  if (!result.rows[0]) throw new ControlPlaneAuthenticationError();
  return { actor, row: result.rows[0] };
}

function isStableUnassignedTaskCreator(task, actor, actorRow, allowedStates) {
  if ((task.assigned_to_user_id ?? null) !== null
      || task.created_by_user_id !== actor.username) return false;
  const stateAllowed = allowedStates.includes(task.state)
    || (task.state === 'CANCELLED' && allowedStates.includes(task.cancelled_from_state));
  if (!stateAllowed) return false;
  const actorCreatedAt = new Date(actorRow?.created_at).getTime();
  const taskCreatedAt = new Date(task.created_at).getTime();
  return Number.isFinite(actorCreatedAt)
    && Number.isFinite(taskCreatedAt)
    && actorCreatedAt < taskCreatedAt;
}

function assertTaskActorAccess(task, actor, {
  ownerOnly = false,
  allowedRoles = USER_ROLES,
  allowUnassignedCreatorStates = [],
  actorRow = null,
} = {}) {
  if (!allowedRoles.includes(actor.role)) {
    throw new ControlPlaneAuthorizationError('current role cannot perform this operation');
  }
  const assignedToUserId = task.assigned_to_user_id ?? null;
  const creatorAccess = isStableUnassignedTaskCreator(
    task,
    actor,
    actorRow,
    allowUnassignedCreatorStates,
  );
  if (actor.role !== 'ADMIN' && assignedToUserId === null && !creatorAccess) {
    throw new ControlPlaneAuthorizationError('未分配任务仅管理员可操作');
  }
  if ((ownerOnly || actor.role === 'USER')
      && assignedToUserId !== actor.username
      && !creatorAccess) {
    throw new ControlPlaneAuthorizationError('任务负责人已变化，请刷新后重试');
  }
}

async function lockTaskForActor(client, rawTaskId, rawActor, options = {}) {
  const { actor, row: actorRow } = await lockCurrentActor(client, rawActor);
  const taskId = normalizeTaskId(rawTaskId);
  const result = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  const task = result.rows[0];
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  assertTaskActorAccess(task, actor, { ...options, actorRow });
  return { actor, task };
}

function autoAssignmentSettingsFrom(row) {
  if (!row) return null;
  return {
    enabled: row.enabled === true,
    version: Number(row.version),
    updatedByUsername: row.updated_by_username ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function autoAssignmentWorkerFrom(row) {
  if (!row) return null;
  const assignmentLimit = Number(row.assignment_limit);
  const currentTaskCount = Number(row.current_task_count ?? 0);
  const userRole = row.user_role ?? null;
  const userStatus = row.user_status ?? null;
  const status = row.status;
  return {
    accountId: row.account_id === null || row.account_id === undefined
      ? null : Number(row.account_id),
    username: row.username,
    displayName: row.display_name ?? null,
    userRole,
    userStatus,
    status,
    assignmentLimit,
    currentTaskCount,
    availableSlots: Math.max(0, assignmentLimit - currentTaskCount),
    canReceive: status === 'ACTIVE' && userRole === 'USER' && userStatus === 'ACTIVE',
    version: Number(row.version),
    createdByUsername: row.created_by_username,
    updatedByUsername: row.updated_by_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function autoAssignmentAdminEventFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    actorUsername: row.actor_username,
    action: row.action,
    workerUsername: row.worker_username ?? null,
    details: row.details ?? {},
    createdAt: row.created_at,
  };
}

const AUTO_ASSIGNMENT_WORKER_RECORD_SQL = `
  SELECT
    pool.*,
    app_user.id AS account_id,
    app_user.display_name,
    app_user.role AS user_role,
    app_user.status AS user_status,
    (
      SELECT COUNT(*)
      FROM tasks AS assigned_task
      WHERE assigned_task.assigned_to_user_id = pool.username
        AND assigned_task.state = 'COPY_REVIEW_PENDING'
        AND assigned_task.current_stage = 'COPY_REVIEW_PENDING'
        AND assigned_task.current_execution_id IS NULL
    ) AS current_task_count
  FROM task_auto_assignment_workers AS pool
  JOIN app_users AS app_user ON app_user.username = pool.username
`;

async function readAutoAssignmentWorker(client, username) {
  const result = await client.query(
    `${AUTO_ASSIGNMENT_WORKER_RECORD_SQL} WHERE pool.username = $1`,
    [username],
  );
  return autoAssignmentWorkerFrom(result.rows[0]);
}

async function recordAutoAssignmentAdminEvent(client, {
  actorUsername,
  action,
  workerUsername = null,
  details,
}) {
  await client.query(`
    INSERT INTO task_auto_assignment_admin_events(
      actor_username, action, worker_username, details
    ) VALUES ($1, $2, $3, $4::jsonb)
  `, [actorUsername, action, workerUsername, JSON.stringify(details)]);
}

function assertAutoAssignmentVersion(currentVersion, expectedVersion, subject) {
  if (Number(currentVersion) !== expectedVersion) {
    throw new ControlPlaneConflictError('VERSION_CONFLICT', `${subject} was updated by another request`);
  }
}

function normalizedAssignmentTaskIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new RangeError('taskIds must contain between 1 and 100 items');
  }
  const taskIds = [...new Set(value.map((taskId) => normalizeTaskId(taskId)))].sort((left, right) => left - right);
  if (taskIds.length !== value.length) throw new TypeError('taskIds must not contain duplicates');
  return taskIds;
}

async function assertActiveAssignableUser(client, username, accountId = null) {
  const result = accountId === null
    ? await client.query(`
      SELECT id, username FROM app_users
      WHERE username = $1 AND status = 'ACTIVE' AND role = 'USER'
      FOR UPDATE
    `, [username])
    : await client.query(`
      SELECT id, username FROM app_users
      WHERE id = $1 AND username = $2 AND status = 'ACTIVE' AND role = 'USER'
      FOR UPDATE
    `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '指定的作业员不存在、已停用或不是普通作业员');
  }
}

async function assertActiveManualAssignee(client, username, accountId, actor = null) {
  if (actor?.role === 'ADMIN'
      && username === actor.username
      && accountId === actor.userId) {
    await lockAssignmentUser(client, username, accountId);
    return;
  }
  await assertActiveAssignableUser(client, username, accountId);
}

async function lockAccountIdentity(client, username, accountId) {
  const result = await client.query(`
    SELECT id, username FROM app_users
    WHERE id = $1 AND username = $2
    FOR UPDATE
  `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '指定的作业员账号已变化，请刷新后重试');
  }
}

async function lockAssignmentUser(client, username, accountId = null) {
  const result = accountId === null
    ? await client.query(`
      SELECT id, username FROM app_users
      WHERE username = $1 AND status = 'ACTIVE'
      FOR UPDATE
    `, [username])
    : await client.query(`
      SELECT id, username FROM app_users
      WHERE id = $1 AND username = $2 AND status = 'ACTIVE'
      FOR UPDATE
    `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '任务负责人不存在或已停用');
  }
}

async function lockAutoAssignmentMember(client, username) {
  await client.query(`
    SELECT username FROM task_auto_assignment_workers
    WHERE username = $1
    FOR UPDATE
  `, [username]);
}

const HUMAN_QUALITY_SCORES = Object.freeze([1, 2, 2.5, 3]);

function normalizedHumanQualityScore(value, name = 'score') {
  if (typeof value !== 'number' || !HUMAN_QUALITY_SCORES.includes(value)) {
    throw new TypeError(`${name} must be one of 1, 2, 2.5 or 3`);
  }
  return Math.round(value * 10);
}

function normalizedQualityReasonCodes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new RangeError('reasons must contain at most 10 items');
  }
  const reasons = value.map((entry, index) => {
    if (typeof entry !== 'string') throw new TypeError(`reasons[${index}] must be a string`);
    const reason = entry.trim();
    if (!reason || [...reason].length > 50) {
      throw new RangeError(`reasons[${index}] must contain between 1 and 50 characters`);
    }
    return reason;
  });
  if (new Set(reasons).size !== reasons.length) throw new TypeError('reasons must not contain duplicates');
  return reasons.sort((left, right) => left.localeCompare(right));
}

function normalizedQualityProblemAssetIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new RangeError('problemAssetIds must contain at most 20 items');
  }
  const ids = value.map((entry) => normalizeTaskId(entry));
  if (new Set(ids).size !== ids.length) throw new TypeError('problemAssetIds must not contain duplicates');
  return ids.sort((left, right) => left - right);
}

function normalizedQualityNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('note must be a string');
  const note = value.replace(/\r\n?/gu, '\n').trim();
  if ([...note].length > 1_000) throw new RangeError('note cannot exceed 1000 characters');
  return note || null;
}

function assertQualityExplanation(scoreX10, reasonCodes, note, name = 'score') {
  if (scoreX10 < 30 && reasonCodes.length === 0 && !note) {
    throw new TypeError(`${name} below 3 requires at least one reason or a note`);
  }
}

function qualityReviewFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function qualityAssessmentFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    stage: row.stage,
    copyRevisionId: row.copy_revision_id === null ? null : Number(row.copy_revision_id),
    imageRunId: row.image_run_id,
    score: Number(row.score_x10) / 10,
    scoreX10: Number(row.score_x10),
    ratingContext: row.rating_context,
    action: row.action,
    reasonCodes: row.reason_codes ?? [],
    problemAssetIds: (row.problem_asset_ids ?? []).map(Number),
    note: row.note ?? null,
    ...(row.rework_target ? { reworkTarget: row.rework_target } : {}),
    reviewerUsername: row.reviewer_username,
    reviewSessionId: row.review_session_id,
    createdAt: row.created_at,
  };
}

async function claimQualityReviewSubmission(client, {
  taskId, stage, reviewerUsername, reviewSessionId, requestFingerprint,
}) {
  const claimed = await client.query(`
    INSERT INTO human_quality_review_submissions(
      review_session_id, task_id, stage, reviewer_username, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(review_session_id) DO NOTHING
    RETURNING review_session_id
  `, [reviewSessionId, taskId, stage, reviewerUsername, requestFingerprint]);
  if (claimed.rows[0]) return false;
  const existing = await client.query(`
    SELECT task_id, stage, reviewer_username, request_fingerprint
    FROM human_quality_review_submissions
    WHERE review_session_id = $1
  `, [reviewSessionId]);
  const row = existing.rows[0];
  if (!row) throw new ControlPlaneConflictError('REVIEW_SESSION_CONFLICT', 'review session could not be reconciled');
  if (Number(row.task_id) !== taskId || row.stage !== stage
    || row.reviewer_username !== reviewerUsername || row.request_fingerprint !== requestFingerprint) {
    throw new ControlPlaneConflictError(
      'REVIEW_SESSION_CONFLICT',
      'reviewSessionId was already used for a different review submission',
    );
  }
  return true;
}

async function insertQualityAssessment(client, {
  taskId, stage, copyRevisionId = null, imageRunId = null, scoreX10,
  ratingContext, action, reasonCodes = [], problemAssetIds = [], note = null,
  reworkTarget = null, reviewerUsername, reviewSessionId, requestFingerprint,
}) {
  const result = await client.query(`
    INSERT INTO human_quality_assessments(
      task_id, stage, copy_revision_id, image_run_id, score_x10,
      rating_context, action, reason_codes, problem_asset_ids, note,
      rework_target, reviewer_username, review_session_id, request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `, [
    taskId, stage, copyRevisionId, imageRunId, scoreX10,
    ratingContext, action, reasonCodes, problemAssetIds, note,
    reworkTarget, reviewerUsername, reviewSessionId, requestFingerprint,
  ]);
  return qualityAssessmentFrom(result.rows[0]);
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

function normalizedQueryPackageNameFilter(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('queryPackageName must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 200) {
    throw new RangeError('queryPackageName must contain between 1 and 200 characters');
  }
  return name;
}

function savedTaskViewFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ownerUsername: row.owner_username,
    name: row.name,
    viewKey: row.view_key,
    filters: row.filters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedTaskSort(sortBy = 'priority', sortOrder = 'desc') {
  const field = String(sortBy || 'priority');
  const direction = String(sortOrder || 'desc').toLowerCase();
  if (!['priority', 'createdAt', 'id'].includes(field)) throw new TypeError('task sort field is invalid');
  if (!['asc', 'desc'].includes(direction)) throw new TypeError('task sort order is invalid');
  return { field, direction: direction.toUpperCase() };
}

function taskSortOrder({ field, direction }, prefix = '') {
  if (!['', 'page.'].includes(prefix)) throw new TypeError('task sort prefix is invalid');
  if (field === 'id') return `${prefix}id ${direction}`;
  if (field === 'createdAt') return `${prefix}created_at ${direction}, ${prefix}id ${direction}`;
  return `${taskStateOrder(`${prefix}state`)}, ${prefix}created_at DESC, ${prefix}id DESC`;
}

function automaticReviewImagePlan(plan) {
  if (!Array.isArray(plan) || plan.length < 3 || plan.length > 5) throw new TypeError('approved copy image plan is unavailable');
  return plan.map((page) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new TypeError('approved copy image plan is invalid');
    return { ...page, layout: { mode: 'AUTO' } };
  });
}

function contentWithAutomaticReviewLayouts(content, { baseRevisionId, nodeId }) {
  const original = normalizeJson(content, 'copy revision content', 5_000_000);
  const imagePlan = automaticReviewImagePlan(original.imagePlan ?? original.reviewed?.imagePlan ?? original.post?.imagePlan);
  const reviewed = original.reviewed && typeof original.reviewed === 'object' && !Array.isArray(original.reviewed)
    ? { ...original.reviewed, imagePlan }
    : original.reviewed;
  return {
    ...original,
    imagePlan,
    ...(reviewed ? { reviewed } : {}),
    manualReview: {
      edited: false,
      layoutsForcedAutomatic: true,
      baseRevisionId,
      reviewedByNodeId: nodeId,
      submittedAt: new Date().toISOString(),
    },
  };
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

async function lockAdministratorRoster(client) {
  // User updates and deletions are rare. One transaction lock makes the
  // last-active-administrator invariant safe across different account rows.
  await client.query('SELECT pg_advisory_xact_lock(4310, 8301)');
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
  const knowledgeEnabled = settings.rows.find((row) => row.key === 'production')?.value?.knowledgeEnabled !== false;
  const knowledge = knowledgeEnabled ? await client.query(`
      SELECT i.id, i.kind, i.name, v.id AS version_id, v.version, v.content,
             v.storage_path, v.content_sha256
      FROM knowledge_items i
      JOIN knowledge_versions v ON v.item_id = i.id AND v.status = 'PUBLISHED'
      WHERE i.status = 'ACTIVE'
      ORDER BY i.kind, i.id
    `) : { rows: [] };
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
  const taskLock = await client.query(`
    SELECT t.id
    FROM tasks t
    WHERE t.id = (
      SELECT e.task_id FROM task_executions e WHERE e.id = $1
    )
    FOR UPDATE OF t
  `, [executionId]);
  if (!taskLock.rows[0]) throw new ControlPlaneNotFoundError('execution not found');
  const result = await client.query(`
    SELECT e.*, t.current_execution_id, t.state AS task_state,
      t.skip_copy_review, t.created_by_node_id, t.ai_disclosure_enabled,
      t.assigned_to_user_id
    FROM task_executions e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.id = $1
    FOR UPDATE OF e
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
  replenishAutoAssignments(options) { return runAutoAssignmentReplenishment(this.pool, options); }
  recordModelCall(executionId, callId, input) { return saveModelCall(this.pool, executionId, callId, input); }
  listModelCalls(taskId, options) { return listModelCalls(this.pool, taskId, options); }
  getModelCall(taskId, callId) { return getModelCall(this.pool, taskId, callId); }
  listQueryPackages(options, { actor } = {}) { return listQueryPackages(this.pool, options, actor); }
  createQueryPackage(input, { actor } = {}) { return createQueryPackage(this.pool, input, actor); }
  getQueryPackage(id, { actor } = {}) { return getQueryPackage(this.pool, id, actor); }
  updateQueryPackageScreening(id, input, { actor } = {}) {
    return updateQueryPackageScreening(this.pool, id, input, actor);
  }
  createQueryPackageProductionBatch(id, input, { actor } = {}) {
    return createQueryPackageProductionBatch(this.pool, id, input, actor);
  }
  permanentlyDeleteQueryPackage(id, input, { actor } = {}) {
    return permanentlyDeleteQueryPackage(this.pool, id, input, actor);
  }
  previewPermanentQueryPackageDeletion(id, { actor } = {}) {
    return previewPermanentQueryPackageDeletion(this.pool, id, actor);
  }
  abandonQueryPackage(id, input, { actor } = {}) {
    return abandonQueryPackage(this.pool, id, input, actor);
  }
  claimXhsQuerySearch(input) { return claimXhsQuerySearch(this.pool, input); }
  completeXhsQuerySearch(id, input) { return completeXhsQuerySearch(this.pool, id, input); }
  blockXhsQuerySearch(id, input) { return blockXhsQuerySearch(this.pool, id, input); }
  failXhsQuerySearch(id, input) { return failXhsQuerySearch(this.pool, id, input); }
  resumeXhsQuerySearch(input) { return resumeXhsQuerySearch(this.pool, input); }
  retryFailedXhsQuerySearch(input) { return retryFailedXhsQuerySearch(this.pool, input); }
  previewDuplicateQueryDiscard(input, { actor } = {}) {
    return previewDuplicateQueryDiscard(this.pool, input, actor);
  }
  discardDuplicateQueries(input, { actor } = {}) {
    return discardDuplicateQueries(this.pool, input, actor);
  }
  getWorkflowQualitySettings() { return readWorkflowQualitySettings(this.pool); }
  updateWorkflowQualitySettings(input, { actor } = {}) {
    return updateWorkflowQualitySettings(this.pool, input, actor);
  }
  freezeCopySamplingBatch(id, input, { actor } = {}) {
    return freezeCopySamplingBatch(this.pool, id, input, actor);
  }
  getProductionBatchSamplingReadiness(id, { actor } = {}) {
    return getProductionBatchSamplingReadiness(this.pool, id, actor);
  }
  listCopyQaItems(options, { actor } = {}) { return listCopyQaItems(this.pool, options, actor); }
  getCopyQaItem(id, { actor } = {}) { return getCopyQaItem(this.pool, id, actor); }
  passCopyQaItem(id, input, { actor } = {}) { return passCopyQaItem(this.pool, id, input, actor); }
  returnCopyQaItem(id, input, { actor, expectedTaskId = null } = {}) {
    return returnCopyQaItem(this.pool, id, input, actor, expectedTaskId);
  }
  batchReturnCopyQa(input, { actor } = {}) { return batchReturnCopyQa(this.pool, input, actor); }
  getCopyQaBatchReturnPreview(id, { actor } = {}) {
    return getCopyQaBatchReturnPreview(this.pool, id, actor);
  }
  getCopyQaStatistics({ actor } = {}) { return getCopyQaStatistics(this.pool, actor); }
  releaseCopyQaFreeze(id, input, { actor } = {}) {
    return releaseCopyQaFreeze(this.pool, id, input, actor);
  }
  assertTaskReadyForDelivery(id) { return assertTaskReadyForDelivery(this.pool, id); }
  assertTasksReadyForDelivery(bindings) {
    return assertTasksReadyForDelivery(this.pool, bindings);
  }
  listDeliveryPool(options, { actor } = {}) { return listDeliveryPool(this.pool, options, actor); }
  listAllDeliveryPoolTaskIds({ actor, queryPackageName = null } = {}) {
    return listAllDeliveryPoolTaskIds(this.pool, actor, { queryPackageName });
  }
  releaseCopySamplingBatch(id, input, { actor } = {}) {
    return releaseCopySamplingBatch(this.pool, id, input, actor);
  }

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
      capabilities: { executionHeartbeats: true, executionRetryControl: true, imageResume: true, executorConcurrency: true, executorManagementVersion: 1, adminTaskFilters: true, creatorAccountFilters: true, adminTaskOperations: true, savedTaskViews: true, imageControlsVersion: 1, taskAssignmentVersion: 3, autoAssignmentPoolVersion: 3, queryPackageVersion: 2, xiaohongshuQuerySearchVersion: 3, duplicateQueryDiscardVersion: 1, copySamplingVersion: 1, blindCopyReviewVersion: 1, finalDeliveryVersion: 2, deliverySpreadsheetVersion: 1 } };
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
    expectedVersion: rawExpectedVersion,
    actor: rawActor = null,
    actorUsername: rawActorUsername,
  }) {
    const enabled = normalizeAutoAssignmentEnabled(rawEnabled);
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
      if (current.enabled === enabled) return autoAssignmentSettingsFrom(current);
      const updatedResult = await client.query(`
        UPDATE task_auto_assignment_settings
        SET enabled = $1, version = version + 1,
            updated_by_username = $2, updated_at = now()
        WHERE singleton = 1 AND version = $3
        RETURNING *
      `, [enabled, actorUsername, expectedVersion]);
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
          previous: { enabled: current.enabled === true, version: Number(current.version) },
          next: { enabled: updated.enabled === true, version: Number(updated.version) },
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
      await lockAdministratorRoster(client);
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
      if (role !== 'USER' || status !== 'ACTIVE') {
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
            '该账号仍有未完成任务，请先将任务转交其他作业员后再停用或更换角色',
          );
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
        SELECT id, state FROM tasks
        WHERE assigned_to_user_id = $1
        ORDER BY id
        FOR UPDATE
      `, [current.username]);
      const unfinished = assignedTasks.rows.find((task) => !['REVIEWED', 'CANCELLED'].includes(task.state));
      if (unfinished) {
        throw new ControlPlaneConflictError(
          'USER_HAS_ACTIVE_TASKS',
          '该账号仍有未完成任务，请先将任务转交其他作业员后再删除',
        );
      }
      if (assignedTasks.rows.length > 0) {
        await client.query(`
          INSERT INTO task_assignment_events(
            task_id, actor_username, previous_assignee_user_id,
            assignee_user_id, source, reason
          )
          SELECT assigned_task.id, $2::varchar(50), $1::varchar(50), NULL,
            'MANUAL', '删除账号时解除已结束任务负责人'
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
        retired_at = NULL,
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
      WHERE n.retired_at IS NULL
      ORDER BY online DESC, n.name, n.id
    `);
    return result.rows.map(nodeFrom);
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

  async listTasks({
    state = null,
    states = null,
    nodeId = null,
    createdByUserId = null,
    createdByAccountId = null,
    assignedToUserId = null,
    visibleToUserId = null,
    visibleToAccountId = null,
    unassignedOnly = false,
    excludeUnassigned = false,
    createdByRole = null,
    taskId = null,
    query = null,
    queryPackageName = null,
    deduplicateQuery = false,
    attention = null,
    sortBy = 'priority',
    sortOrder = 'desc',
    limit = 50,
    offset = 0,
    includeTotal = false,
    excludeActiveBlindQa = false,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (typeof includeTotal !== 'boolean') throw new TypeError('includeTotal must be a boolean');
    if (typeof deduplicateQuery !== 'boolean') throw new TypeError('deduplicateQuery must be a boolean');
    if (typeof unassignedOnly !== 'boolean') throw new TypeError('unassignedOnly must be a boolean');
    if (typeof excludeUnassigned !== 'boolean') throw new TypeError('excludeUnassigned must be a boolean');
    if (typeof excludeActiveBlindQa !== 'boolean') throw new TypeError('excludeActiveBlindQa must be a boolean');
    if (unassignedOnly && assignedToUserId !== null) throw new TypeError('assignee and unassigned filters conflict');
    if (visibleToAccountId !== null && visibleToUserId === null) {
      throw new TypeError('visibleToAccountId requires visibleToUserId');
    }
    if (visibleToUserId !== null && visibleToAccountId === null) {
      throw new TypeError('visibleToUserId requires visibleToAccountId');
    }
    if (visibleToUserId !== null
        && (assignedToUserId !== null || unassignedOnly || excludeUnassigned)) {
      throw new TypeError('visibility and assignee filters conflict');
    }
    const values = [];
    const filters = [];
    if (excludeActiveBlindQa) {
      filters.push(`NOT EXISTS (
        SELECT 1 FROM copy_sampling_items blind_item
        JOIN copy_sampling_freezes blind_freeze ON blind_freeze.id = blind_item.freeze_id
        WHERE blind_item.task_id = tasks.id
          AND blind_freeze.blind_review_enabled = true
          AND (
            blind_freeze.status IN ('INSPECTING', 'REVIEW_REQUIRED')
            OR (blind_freeze.status = 'BATCH_RETURNED'
              AND tasks.state IN ('COPY_REVIEW_PENDING', 'COPY_QC_PENDING'))
          )
      )`);
    }
    const stateFilters = normalizedTaskStates(state, states);
    if (stateFilters.length > 0) {
      values.push(stateFilters);
      filters.push(`state = ANY($${values.length}::varchar[])`);
    }
    if (nodeId !== null) {
      values.push(normalizeNodeId(nodeId));
      filters.push(`copy_executor_node_id = $${values.length}`);
    }
    if (createdByAccountId !== null && createdByUserId === null) {
      throw new TypeError('createdByAccountId requires createdByUserId');
    }
    if (createdByUserId !== null) {
      values.push(normalizeCreatorUserId(createdByUserId));
      const creatorParameter = values.length;
      let accountPredicate = '';
      if (createdByAccountId !== null) {
        values.push(normalizeTaskId(createdByAccountId));
        accountPredicate = `AND exact_creator.id = $${values.length}`;
      }
      filters.push(`created_by_user_id = $${creatorParameter}
        AND EXISTS (
          SELECT 1 FROM app_users exact_creator
          WHERE exact_creator.username = tasks.created_by_user_id
            AND exact_creator.username = $${creatorParameter}
            ${accountPredicate}
            AND exact_creator.created_at < tasks.created_at
        )`);
    }
    if (assignedToUserId !== null) {
      values.push(normalizeAssigneeUserId(assignedToUserId, { allowNull: false }));
      filters.push(`assigned_to_user_id = $${values.length}`);
    } else if (unassignedOnly) {
      filters.push('assigned_to_user_id IS NULL');
    } else if (excludeUnassigned) {
      filters.push('assigned_to_user_id IS NOT NULL');
    }
    if (visibleToUserId !== null) {
      values.push(normalizeCreatorUserId(visibleToUserId));
      const visibleUsernameParameter = values.length;
      values.push(normalizeTaskId(visibleToAccountId));
      const visibleAccountParameter = values.length;
      filters.push(`(
        (
          assigned_to_user_id = $${visibleUsernameParameter}
          AND EXISTS (
            SELECT 1 FROM app_users visible_assignee
            WHERE visible_assignee.id = $${visibleAccountParameter}
              AND visible_assignee.username = tasks.assigned_to_user_id
              AND visible_assignee.created_at < tasks.assigned_at
          )
        )
        OR (
          created_by_user_id = $${visibleUsernameParameter}
          AND EXISTS (
            SELECT 1 FROM app_users visible_creator
            WHERE visible_creator.id = $${visibleAccountParameter}
              AND visible_creator.username = tasks.created_by_user_id
              AND visible_creator.created_at < tasks.created_at
          )
        )
      )`);
    }
    const creatorRole = normalizeTaskCreatorRole(createdByRole);
    if (creatorRole === 'UNKNOWN') {
      filters.push(`NOT EXISTS (SELECT 1 FROM app_users role_creator
        WHERE role_creator.username = tasks.created_by_user_id
          AND role_creator.created_at < tasks.created_at)`);
    } else if (creatorRole !== null) {
      values.push(creatorRole);
      filters.push(`EXISTS (SELECT 1 FROM app_users role_creator
        WHERE role_creator.username = tasks.created_by_user_id
          AND role_creator.created_at < tasks.created_at
          AND role_creator.role = $${values.length})`);
    }
    if (taskId !== null && taskId !== undefined && taskId !== '') {
      values.push(normalizeTaskId(taskId));
      filters.push(`id = $${values.length}`);
    }
    const taskAttention = normalizeTaskAttention(attention);
    if (taskAttention) {
      const stale = `(state IN ('COPY_RUNNING', 'IMAGE_RUNNING')
        AND COALESCE(last_activity_at, execution_started_at, updated_at, created_at) <= now() - interval '30 minutes')`;
      const failed = `(state IN ('COPY_FAILED', 'IMAGE_FAILED') OR current_stage = 'IMAGE_RETRY_EXHAUSTED')`;
      filters.push(taskAttention === 'STALE' ? stale : taskAttention === 'FAILED' ? failed : `(${stale} OR ${failed})`);
    }
    const searchQuery = normalizedTaskQuery(query);
    if (searchQuery !== null) {
      values.push(searchQuery);
      filters.push(`strpos(lower(query), lower($${values.length})) > 0`);
    }
    const searchQueryPackageName = normalizedQueryPackageNameFilter(queryPackageName);
    if (searchQueryPackageName !== null) {
      values.push(searchQueryPackageName);
      filters.push(`strpos(lower(COALESCE(source_query_package_name, '')), lower($${values.length})) > 0`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const queryIdentity = taskQueryIdentitySql('query');
    const taskSort = normalizedTaskSort(sortBy, sortOrder);
    const pageOrder = taskSortOrder(taskSort);
    const resultOrder = taskSortOrder(taskSort, 'page.');
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
        n.name AS image_executor_node_name, creator.id AS creator_account_id,
        creator.display_name AS creator_display_name,
        creator.role AS creator_role, assignee.id AS assignee_account_id,
        assignee.display_name AS assigned_to_display_name,
        assignee.status AS assignee_status,
        EXISTS (
          SELECT 1 FROM delivery_entries AS current_delivery
          WHERE current_delivery.task_id = page.id AND current_delivery.status = 'READY'
            AND current_delivery.copy_revision_id = page.current_copy_revision_id
            AND current_delivery.image_run_id = page.current_image_run_id
        ) AS delivery_ready
      FROM (
        ${taskPage}
        ORDER BY ${pageOrder}
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
        AND creator.created_at < page.created_at
      LEFT JOIN app_users assignee ON assignee.username = page.assigned_to_user_id
        AND assignee.created_at < page.assigned_at
      ORDER BY ${resultOrder}
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
    const result = await this.pool.query(`
      SELECT task.id, task.state, task.cancelled_from_state, task.assigned_at,
        task.created_by_user_id, task.assigned_to_user_id,
        creator.id AS creator_account_id, assignee.id AS assignee_account_id,
        EXISTS (
          SELECT 1 FROM copy_sampling_items AS blind_item
          JOIN copy_sampling_freezes AS blind_freeze ON blind_freeze.id = blind_item.freeze_id
          WHERE blind_item.task_id = task.id
            AND blind_freeze.blind_review_enabled = true
            AND (
              blind_freeze.status IN ('INSPECTING', 'REVIEW_REQUIRED')
              OR (blind_freeze.status = 'BATCH_RETURNED'
                AND task.state IN ('COPY_REVIEW_PENDING', 'COPY_QC_PENDING'))
            )
        ) AS active_blind_qa
      FROM tasks AS task
      LEFT JOIN app_users AS creator ON creator.username = task.created_by_user_id
        AND creator.created_at < task.created_at
      LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
        AND assignee.created_at < task.assigned_at
      WHERE task.id = $1
    `, [normalizeTaskId(rawTaskId)]);
    const row = result.rows[0];
    return row ? {
      id: Number(row.id),
      state: row.state,
      cancelledFromState: row.cancelled_from_state ?? null,
      createdByUserId: row.created_by_user_id,
      createdByAccountId: row.creator_account_id === null || row.creator_account_id === undefined
        ? null : Number(row.creator_account_id),
      assignedToUserId: row.assigned_to_user_id ?? null,
      assignedToAccountId: row.assignee_account_id === null || row.assignee_account_id === undefined
        ? null : Number(row.assignee_account_id),
      assignedAt: row.assigned_at ?? null,
      activeBlindQa: row.active_blind_qa === true,
    } : null;
  }

  async getTask(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const [task, executions, revisions, imageRuns, assets, humanQualityAssessments] = await Promise.all([
      this.pool.query(`
        WITH task AS (
          SELECT * FROM tasks WHERE id = $1
        )
        SELECT task.*, creator.id AS creator_account_id,
          creator.display_name AS creator_display_name,
          creator.role AS creator_role, assignee.id AS assignee_account_id,
          assignee.display_name AS assigned_to_display_name,
          assignee.status AS assignee_status,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'noteId', link.note_id,
              'url', link.url,
              'title', link.title,
              'rank', link.rank
            ) ORDER BY link.rank, link.id)
            FROM xhs_query_search_jobs AS search
            JOIN xhs_query_links AS link ON link.search_job_id = search.id
            WHERE search.task_id = task.id AND search.status = 'SUCCEEDED'
          ), '[]'::jsonb) AS xiaohongshu_links,
          (
            SELECT search.status
            FROM xhs_query_search_jobs AS search
            WHERE search.task_id = task.id
          ) AS xiaohongshu_search_status,
          (
            SELECT search.blocked_reason
            FROM xhs_query_search_jobs AS search
            WHERE search.task_id = task.id
          ) AS xiaohongshu_search_blocked_reason,
          EXISTS (
            SELECT 1 FROM delivery_entries AS current_delivery
            WHERE current_delivery.task_id = task.id AND current_delivery.status = 'READY'
              AND current_delivery.copy_revision_id = task.current_copy_revision_id
              AND current_delivery.image_run_id = task.current_image_run_id
          ) AS delivery_ready
        FROM task
        LEFT JOIN app_users AS creator ON creator.username = task.created_by_user_id
          AND creator.created_at < task.created_at
        LEFT JOIN app_users AS assignee ON assignee.username = task.assigned_to_user_id
          AND assignee.created_at < task.assigned_at
      `, [taskId]),
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
      this.pool.query(`
        SELECT * FROM human_quality_assessments
        WHERE task_id = $1 ORDER BY created_at, id
      `, [taskId]),
    ]);
    if (!task.rows[0]) return null;
    return {
      ...taskFrom(task.rows[0]),
      xiaohongshuLinks: Array.isArray(task.rows[0].xiaohongshu_links)
        ? task.rows[0].xiaohongshu_links.map((link) => ({
          noteId: String(link.noteId),
          url: String(link.url),
          title: link.title === null || link.title === undefined ? null : String(link.title),
          rank: Number(link.rank),
        }))
        : [],
      xiaohongshuSearchStatus: task.rows[0].xiaohongshu_search_status ?? null,
      xiaohongshuSearchBlockedReason: task.rows[0].xiaohongshu_search_blocked_reason ?? null,
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
      humanQualityAssessments: humanQualityAssessments.rows.map(qualityAssessmentFrom),
    };
  }

  async getTaskForDelivery(rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const result = await this.pool.query(`
      SELECT
        task.id,
        task.query,
        task.source_query_package_name,
        task.state,
        task.current_copy_revision_id,
        task.current_image_run_id,
        revision.content AS copy_content,
        image_run.result AS image_result,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'noteId', link.note_id,
            'url', link.url,
            'title', link.title,
            'rank', link.rank
          ) ORDER BY link.rank, link.id)
          FROM xhs_query_search_jobs AS search
          JOIN xhs_query_links AS link ON link.search_job_id = search.id
          WHERE search.task_id = task.id AND search.status = 'SUCCEEDED'
        ), '[]'::jsonb) AS xiaohongshu_links,
        (
          SELECT search.status
          FROM xhs_query_search_jobs AS search
          WHERE search.task_id = task.id
        ) AS xiaohongshu_search_status,
        (
          SELECT search.blocked_reason
          FROM xhs_query_search_jobs AS search
          WHERE search.task_id = task.id
        ) AS xiaohongshu_search_blocked_reason,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', asset.id,
              'taskId', asset.task_id,
              'imageRunId', asset.image_run_id,
              'mediaType', asset.media_type,
              'originalName', asset.original_name
            ) ORDER BY asset.id
          ) FILTER (WHERE asset.id IS NOT NULL),
          '[]'::jsonb
        ) AS assets
      FROM tasks AS task
      JOIN copy_revisions AS revision
        ON revision.id = task.current_copy_revision_id
      JOIN image_runs AS image_run
        ON image_run.id = task.current_image_run_id
      JOIN delivery_entries AS delivery
        ON delivery.task_id = task.id AND delivery.status = 'READY'
        AND delivery.copy_revision_id = task.current_copy_revision_id
        AND delivery.image_run_id = task.current_image_run_id
      LEFT JOIN assets AS asset
        ON asset.task_id = task.id AND asset.image_run_id = task.current_image_run_id
        AND asset.media_type LIKE 'image/%'
      WHERE task.id = $1 AND task.state = 'REVIEWED'
      GROUP BY task.id, task.state, task.current_copy_revision_id,
        task.current_image_run_id, revision.content, image_run.result
    `, [taskId]);
    const row = result.rows[0];
    if (!row) return null;
    const copyRevisionId = Number(row.current_copy_revision_id);
    const imageRunId = row.current_image_run_id;
    return {
      task: {
        id: Number(row.id),
        query: row.query,
        sourceQueryPackageName: row.source_query_package_name ?? null,
        state: row.state,
        currentCopyRevisionId: copyRevisionId,
        currentImageRunId: imageRunId,
        copyRevisions: [{ id: copyRevisionId, content: row.copy_content }],
        imageRuns: [{ id: imageRunId, result: row.image_result }],
        xiaohongshuLinks: Array.isArray(row.xiaohongshu_links)
          ? row.xiaohongshu_links.map((link) => ({
            noteId: String(link.noteId),
            url: String(link.url),
            title: link.title === null || link.title === undefined ? null : String(link.title),
            rank: Number(link.rank),
          }))
          : [],
        xiaohongshuSearchStatus: row.xiaohongshu_search_status ?? null,
        xiaohongshuSearchBlockedReason: row.xiaohongshu_search_blocked_reason ?? null,
        assets: Array.isArray(row.assets) ? row.assets.map((asset) => ({
          ...asset,
          id: Number(asset.id),
          taskId: Number(asset.taskId),
        })) : [],
      },
      binding: { taskId: Number(row.id), copyRevisionId, imageRunId },
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
        SELECT * FROM executor_nodes WHERE id = $1 AND retired_at IS NULL FOR UPDATE
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
      let cursor = null;
      if (available && kind === 'IMAGE') {
        const cursorResult = await client.query(`
          SELECT last_assignee_user_id FROM execution_claim_cursors
          WHERE kind = $1
          FOR UPDATE
        `, [kind]);
        if (!cursorResult.rows[0]) {
          throw new Error(`execution claim cursor is missing for ${kind}`);
        }
        cursor = cursorResult.rows[0];
      }
      let candidate = { rows: [] };
      if (available && kind === 'COPY') {
        candidate = await client.query(`
          SELECT task.*
          FROM tasks AS task
          WHERE task.state = $1
          ORDER BY task.id
          FOR UPDATE OF task SKIP LOCKED
          LIMIT $2
        `, [queuedState, available]);
      } else if (available) {
        candidate = await client.query(`
          WITH ranked_candidates AS MATERIALIZED (
            SELECT
              queued.id AS task_id,
              queued.assigned_to_user_id,
              queued.last_activity_at,
              queued.assigned_to_user_id AS claim_owner,
              row_number() OVER (
                PARTITION BY queued.assigned_to_user_id
                ORDER BY queued.last_activity_at NULLS FIRST, queued.id
              ) AS owner_row_number
            FROM tasks AS queued
            WHERE queued.state = $1
              AND queued.assigned_to_user_id IS NOT NULL
              AND (queued.pending_snapshot->'imageRetry'->>'nodeId' IS NULL
                OR queued.pending_snapshot->'imageRetry'->>'nodeId' = $2)
              AND (queued.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL
                OR queued.pending_snapshot->'imageRecovery'->>'nodeId' = $2)
              AND (queued.error IS NULL OR queued.last_activity_at <= now() - interval '5 seconds')
          )
          SELECT task.*
          FROM ranked_candidates AS ranked
          JOIN tasks AS task ON task.id = ranked.task_id
          WHERE task.state = $1
            AND task.assigned_to_user_id IS NOT NULL
            AND task.assigned_to_user_id IS NOT DISTINCT FROM ranked.assigned_to_user_id
            AND (task.pending_snapshot->'imageRetry'->>'nodeId' IS NULL
              OR task.pending_snapshot->'imageRetry'->>'nodeId' = $2)
            AND (task.pending_snapshot->'imageRecovery'->>'nodeId' IS NULL
              OR task.pending_snapshot->'imageRecovery'->>'nodeId' = $2)
            AND (task.error IS NULL OR task.last_activity_at <= now() - interval '5 seconds')
          ORDER BY
            ranked.owner_row_number,
            CASE WHEN $3::varchar IS NULL
                OR ranked.claim_owner > $3::varchar THEN 0 ELSE 1 END,
            ranked.claim_owner,
            ranked.last_activity_at NULLS FIRST, ranked.task_id
          FOR UPDATE OF task SKIP LOCKED
          LIMIT $4
        `, [queuedState, nodeId, cursor?.last_assignee_user_id ?? null, available]);
      }
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
      if (kind === 'IMAGE' && claims.length) {
        const lastClaimedAssignee = claims.at(-1).task?.assignedToUserId;
        if (!lastClaimedAssignee) {
          throw new Error(`claimed ${kind.toLowerCase()} task is missing its assignee`);
        }
        const cursorUpdate = await client.query(`
          UPDATE execution_claim_cursors
          SET last_assignee_user_id = $2, updated_at = now()
          WHERE kind = $1
          RETURNING kind
        `, [kind, lastClaimedAssignee]);
        if (cursorUpdate.rows.length !== 1 || cursorUpdate.rows[0].kind !== kind
            || (cursorUpdate.rowCount !== undefined && cursorUpdate.rowCount !== 1)) {
          throw new Error(`execution claim cursor could not be advanced for ${kind}`);
        }
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
      let bypass = execution.skip_copy_review === true && execution.assigned_to_user_id != null;
      let message = execution.assigned_to_user_id == null
        ? '文案生成完成，等待分配负责人后审核'
        : '文案生成完成，等待人工审核';
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
        INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at, approved_by_node_id,
          approval_mode, revision_origin, copy_content_changed_from_machine, copy_rework_satisfied)
        VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END,
          CASE WHEN $5 THEN $6 ELSE NULL END, CASE WHEN $5 THEN 'ADMIN_BYPASS' ELSE NULL END,
          'GENERATION', false, false)
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
    decision: rawDecision,
    originalScore: rawOriginalScore,
    score: rawScore,
    originalReasons: rawOriginalReasons,
    originalReasonCodes: rawOriginalReasonCodes,
    originalNote: rawOriginalNote,
    reasons: rawReasons,
    reasonCodes: rawReasonCodes,
    note: rawNote,
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
    if (!['SAVE', 'APPROVE', 'DISCARD'].includes(decision)) throw new TypeError('copy review decision is invalid');
    const originalScoreX10 = rawOriginalScore === undefined
      ? null : normalizedHumanQualityScore(rawOriginalScore, 'originalScore');
    let edits = rawEdits === undefined ? null : normalizeCopyReviewEdits(rawEdits);
    if (decision === 'DISCARD' && edits) throw new TypeError('discarding copy does not accept edits');
    if (edits && actorRole !== 'ADMIN') edits = { ...edits, imagePlan: automaticReviewImagePlan(edits.imagePlan) };
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
      const mandatoryRework = task.mandatory_copy_qc === true;
      if (!mandatoryRework && currentScoreX10 === null) throw new TypeError('score is required');
      const node = await client.query('SELECT id FROM executor_nodes WHERE id = $1', [nodeId]);
      if (!node.rows[0]) throw new ControlPlaneNotFoundError('executor node is not registered');
      const sourceIsOriginal = revision.rows[0].execution_id !== null;
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
        if (!mandatoryRework && !baseAssessment && baseScoreX10 === null) {
          if (sourceIsOriginal) {
            throw new TypeError('originalScore is required when editing generated copy');
          }
          throw new ControlPlaneConflictError(
            'COPY_BASE_RATING_REQUIRED',
            '当前文案版本缺少可验证的评分，不能提交修改',
          );
        } else if (!mandatoryRework && !baseAssessment) {
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
      const copyReworkSatisfied = revision.rows[0].copy_rework_satisfied === true || copyChanged;
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
          && (baseScoreX10 ?? currentScoreX10) === 10 && decision !== 'DISCARD') {
        throw new ControlPlaneConflictError('SCORE_ONE_REQUIRES_DISCARD', '1 分机器初稿必须直接作废');
      }
      if (decision === 'APPROVE' && mandatoryRework && !copyReworkSatisfied) {
        throw new ControlPlaneConflictError(
          'COPY_REWORK_NOT_SATISFIED',
          '返工稿尚未发生实际修改；请修改标题、正文或标签后再提交强制复检',
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
        ? contentWithReviewEdits(revision.rows[0].content, edits, { baseRevisionId: revisionId, nodeId })
        : decision === 'APPROVE' && actorRole !== 'ADMIN'
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
          task.mandatory_copy_qc === true && copyReworkSatisfied]);
        reviewedRevisionId = Number(reviewedRevision.rows[0].id);
        reviewedRevisionRow = reviewedRevision.rows[0];
      } else if (decision === 'APPROVE') {
        const approvedRevision = await client.query(`
          UPDATE copy_revisions SET approved_at = now(), approved_by_node_id = $2, approval_mode = 'MANUAL'
          WHERE id = $1 RETURNING *
        `, [revisionId, nodeId]);
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
          action: decision,
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
        });
        return taskFrom(routed.task);
      }
      if (decision === 'DISCARD') {
        const discarded = await client.query(`
          UPDATE tasks SET
            state = 'CANCELLED', cancelled_from_state = state,
            current_execution_id = NULL, current_stage = 'CANCELLED',
            progress_percent = 100, progress_message = '文案已被审核员废弃',
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
        reviewedContent ? '人工修改已保存，等待继续审核' : '人工评分已保存，等待继续审核']);
      return taskFrom(saved.rows[0]);
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
    const note = normalizedQualityNote(rawNote);
    const decision = String(rawDecision ?? '').trim().toUpperCase();
    if (!['APPROVE', 'RETRY', 'REWORK', 'DISCARD'].includes(decision)) throw new TypeError('image review decision is invalid');
    const reworkTarget = decision === 'RETRY' ? 'IMAGE'
      : decision === 'REWORK' ? String(rawReworkTarget ?? '').trim().toUpperCase() : null;
    if (decision === 'REWORK' && !['COPY', 'IMAGE', 'BOTH'].includes(reworkTarget)) {
      throw new TypeError('reworkTarget must be COPY, IMAGE or BOTH');
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
      reworkTarget, reasonCodes, problemAssetIds, note, reviewerUsername,
      ...(editedImagePlan ? { revisionId, nodeId, imagePlan: editedImagePlan } : {}),
    });
    const retry = reworkTarget !== null;
    const copyRework = ['COPY', 'BOTH'].includes(reworkTarget);
    const approved = decision === 'APPROVE';
    const state = approved ? 'REVIEWED' : copyRework ? 'COPY_REVIEW_PENDING'
      : retry ? 'IMAGE_QUEUED' : 'CANCELLED';
    const message = approved ? '图片审核通过，任务已完成'
      : copyRework ? '图文终审已退回文案；实际修改后须提交强制复检，复检通过后才进入待生图队列'
        : retry ? '审核员要求重新生成图片，等待图片执行机领取' : '任务已被审核员废弃';
    return transaction(this.pool, async (client) => {
      const task = actorIdentity === null
        ? (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]
        : (await lockTaskForActor(client, taskId, actorIdentity, {
          allowedRoles: ['ADMIN', 'REVIEWER'],
        })).task;
      if (!task) throw new ControlPlaneNotFoundError('task not found');
      if (await claimQualityReviewSubmission(client, {
        taskId, stage: 'IMAGE', reviewerUsername, reviewSessionId, requestFingerprint,
      })) return taskFrom(task);
      if (task.state !== 'MANUAL_ARCHIVE') {
        throw new ControlPlaneConflictError('INVALID_TASK_STATE', '任务已不在人工归档阶段，请刷新后重试');
      }
      if (task.current_image_run_id !== imageRunId) {
        throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '图片版本已变化，请刷新后重新审核');
      }
      const run = await client.query(`
        SELECT id FROM image_runs WHERE id = $1 AND task_id = $2
          AND copy_revision_id = $3 AND status = 'COMPLETED'
      `, [imageRunId, taskId, task.current_copy_revision_id]);
      if (!run.rows[0]) throw new ControlPlaneConflictError('STALE_IMAGE_RUN', '当前文案对应的图片尚未生成完成');
      if (problemAssetIds.length) {
        const assets = await client.query(`
          SELECT id FROM assets
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
        reviewerUsername, reviewSessionId, requestFingerprint,
      });
      if (!approved) await withdrawReadyDeliveryEntries(client, taskId);
      const updated = await client.query(`
        UPDATE tasks SET
          state = $2, current_stage = $2, progress_message = $3,
          current_copy_revision_id = $5,
          current_execution_id = NULL, pending_snapshot = NULL, error = NULL,
          current_image_run_id = ${retry ? 'NULL' : 'current_image_run_id'},
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

  async getTaskActionSummary(rawTaskId) {
    const result = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [normalizeTaskId(rawTaskId)]);
    return taskFrom(result.rows[0]);
  }

  async listSavedTaskViews(rawOwnerUsername) {
    const ownerUsername = normalizedUsername(rawOwnerUsername);
    const result = await this.pool.query(`
      SELECT * FROM saved_task_views
      WHERE owner_username = $1
      ORDER BY updated_at DESC, id DESC
    `, [ownerUsername]);
    return result.rows.map(savedTaskViewFrom);
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
      const updated = await client.query(`
        UPDATE tasks SET state = $2, cancelled_from_state = NULL, current_stage = $2,
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
      if (retryOnly && !['IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)
        && !(task.state === 'COPY_REVIEW_PENDING' && task.current_stage === 'IMAGE_RETRY_EXHAUSTED')) {
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

  async cancelTask(rawTaskId, { queuedOnly = false, actor: rawActor = null } = {}) {
    const taskId = normalizeTaskId(rawTaskId);
    const actorIdentity = rawActor === null ? null : normalizedActorIdentity(rawActor);
    if (typeof queuedOnly !== 'boolean') throw new TypeError('queuedOnly must be a boolean');
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
      if (task.state === 'CANCELLED') return taskFrom(task);
      if (task.state === 'COPY_QC_PENDING') {
        throw new ControlPlaneConflictError(
          'COPY_QC_CANCEL_FORBIDDEN',
          '文案抽检冻结中的任务不能从通用入口取消，请通过质检处置',
        );
      }
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
        await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      }
      for (const productionBatchId of [...productionBatchIds].sort((left, right) => left - right)) {
        await attemptAutomaticCopySamplingFreeze(client, productionBatchId,
          typeof actor === 'object' ? actor : null);
      }
      return { succeeded: eligible, failed };
    });
  }

  async upsertSetting(rawKey, rawValue) {
    const key = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9._-]{0,99}$/u.test(key)) throw new TypeError('setting key is invalid');
    const jsonValue = normalizeJson(rawValue, 'setting value', 1_000_000);
    const value = key === XIAOHONGSHU_SEARCH_SETTINGS_KEY
      ? normalizeXiaohongshuSearchSettings(jsonValue)
      : jsonValue;
    if (key === 'production' && value?.layoutPresets !== undefined) value.layoutPresets = normalizeLayoutPresets(value.layoutPresets);
    if (key === 'production' && value?.humanQualityReasons !== undefined) {
      value.humanQualityReasons = normalizeHumanQualitySettingsUpdate(value.humanQualityReasons);
    }
    if (key === 'production' && value?.layoutCatalog !== undefined) {
      value.layoutCatalog = normalizeLayoutCatalog(value.layoutCatalog);
      const current = await this.getLayoutCatalog();
      if (current.revision !== layoutCatalogRecord(value).revision) throw new TypeError('请在布局模板库中更新目录，避免覆盖其他编辑');
    }
    const result = await this.pool.query(`
      INSERT INTO global_settings(key, value) VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET
        value = CASE WHEN excluded.key = 'production' THEN
          excluded.value
          || CASE WHEN global_settings.value ? 'layoutCatalog'
            THEN jsonb_build_object('layoutCatalog', global_settings.value->'layoutCatalog') ELSE '{}'::jsonb END
          || CASE WHEN global_settings.value ? 'humanQualityReasons'
            THEN jsonb_build_object('humanQualityReasons', global_settings.value->'humanQualityReasons') ELSE '{}'::jsonb END
          ELSE excluded.value END,
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

  async getHumanQualitySettings() {
    const result = await this.pool.query("SELECT value FROM global_settings WHERE key = 'production'");
    return normalizeHumanQualitySettings(result.rows[0]?.value?.humanQualityReasons);
  }

  async updateHumanQualitySettings(input) {
    return transaction(this.pool, async client => {
      await client.query("INSERT INTO global_settings(key, value) VALUES ('production', '{}'::jsonb) ON CONFLICT(key) DO NOTHING");
      const current = await client.query("SELECT value FROM global_settings WHERE key = 'production' FOR UPDATE");
      const settings = normalizeHumanQualitySettingsUpdate(
        input,
        current.rows[0]?.value?.humanQualityReasons,
      );
      const result = await client.query(`
        UPDATE global_settings SET
          value = jsonb_set(value, '{humanQualityReasons}', $1::jsonb, true),
          version = version + 1,
          updated_at = now()
        WHERE key = 'production'
        RETURNING value
      `, [JSON.stringify(settings)]);
      return normalizeHumanQualitySettings(result.rows[0].value.humanQualityReasons);
    });
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
