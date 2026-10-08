import { priorityFrom, priorityOrderSql, normalizePriorityMode } from './task-priority.mjs';
import { adjustTaskPriority, readPriorityScope } from './task-priority-store.mjs';
import { flushExpiredCopyQualityBatches } from './copy-quality-control.mjs';
import { restoreReassignmentCase, finishReassignmentBaseline, regenerateReassignmentBaseline, escalateQualityToAdmin, listReassignmentCases, getReassignmentCase, retryReassignmentReset, disposeReassignmentCase, batchReassignmentCases } from './secondary-assignment.mjs';
import { readSecondaryAssignmentFeedback } from './secondary-assignment-feedback.mjs';
import { snapshotProductionSearchMode } from '../../src/web-search-config.mjs';
import { hydrateExecutionSnapshots } from './execution-snapshot-storage.mjs';
import { normalizeCopySamplingRateOverride } from '../../src/copy-sampling-policy.mjs';
import {
  createCopyQaReasonTag,
  listCopyQaReasonTags,
  updateCopyQaReasonTag,
} from './copy-qa-reason-tags.mjs';
import { readPersonalWorkspace, readPersonalQualityActivity } from './personal-workspace.mjs';
import { confirmDeliveryBatchMembers } from './delivery-ledger.mjs';
import { readOperatorPerformance } from './operator-performance.mjs';
import { invalidateTaskTotals, readTaskTotal, taskListFactClient, taskListFactQueryable, taskListFactVersion } from './task-list-facts.mjs';
import {
  closeImageSamplingTail,
  batchReturnImageQa,
  flushExpiredImageQualityBatches,
  getImageQaAsset,
  listImageQaItems,
  getImageQaBatchReturnPreview,
  passImageQaItem,
  returnImageQaItem,
  discardTaskImages,
  discardImageQaItem,
  submitImageSelfReview,
} from './image-quality-control.mjs';
import { copyQualityImageGate } from './copy-quality-flow.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { copyReworkChanges, findCopyReworkBaseline } from '../../src/copy-rework.mjs';
import { assertImageResultSettings, reviseTaskImages } from './image-revisions.mjs';
import {
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_FORMATS,
  hasImageControls,
  normalizeImageSettings,
  normalizePageLayout,
} from './image-options.mjs';
import { normalizeLayoutPresets } from './layout-library.mjs';
import { BUILTIN_LAYOUT_CATALOG, normalizeLayoutCatalog } from './layout-catalog.mjs';
import { changeLayoutCatalog, layoutCatalogRecord } from './layout-catalog-settings.mjs';
import { parseVisualPlanOutput } from '../../src/visual-plan.mjs';
import { assertLockedImageText, imageTextHash } from '../../src/locked-image-plan.mjs';
import { migrateDatabase, loadMigrations, pendingMigrations } from './database-migrations.mjs';
import { autoCreateCopyQaBatchesV2, listCopyQaWorkItemsV2 } from './copy-qa-v2.mjs';
import { claimRequestExpiry } from './claim-request.mjs';
import { saveModelCall, listModelCalls, getModelCall } from './model-call-traces.mjs';
import { hashUserPassword, verifyUserPassword } from './user-auth.mjs';
import { createPromptRuntime } from '../../src/prompt-runtime.mjs';
import { heartbeatExecutions, recoverStaleExecutions } from './execution-recovery.mjs';
import {
  AUTO_ASSIGNABLE_TASK_STATES,
  AUTO_ASSIGNMENT_ACTOR,
  runAutoAssignmentReplenishment,
} from './task-auto-assignment-runner.mjs';
import { normalizeSavedTaskView, normalizeTaskAttention } from './task-view-filters.mjs';
import { normalizeTaskDateRange } from '../../src/control-plane/task-date-filter.mjs';
import {
  normalizeAssigneeUserId,
  normalizeAssignmentSource,
  UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
} from './task-assignment-domain.mjs';
import { isTaskAssignmentLocked } from '../../src/control-plane/task-assignment.mjs';
import { latestImageRetryFailures } from '../../src/control-plane/image-retry-status.mjs';
import { canAdminDiscardTask } from '../../src/control-plane/task-discard.mjs';
import {
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../../src/human-quality-settings.mjs';
import { normalizeImageEditRepairMaxAttempts } from '../../src/production-settings.mjs';
import {
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
  normalizeXiaohongshuSearchSettings,
} from '../../src/xhs-query-search.mjs';
import {
  normalizeAutoAssignmentEnabled,
  normalizeAutoAssignmentExpectedVersion,
  normalizeAutoAssignmentLimit,
  normalizeAutoAssignmentMode,
  normalizeAutoAssignmentWorkerStatus,
} from './task-auto-assignment-domain.mjs';
import {
  abandonQueryPackage,
  assignQueryPackage,
  assignQueryPackageItems,
  createQueryPackage,
  createQueryPackageProductionBatch,
  getQueryPackage,
  getQueryPackageItemAssignmentSummary,
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
  listXhsQuerySearchNodes,
  resumeXhsQuerySearch,
  retryFailedXhsQuerySearch,
} from './xhs-query-search.mjs';
import {
  discardDuplicateQueries,
  previewDuplicateQueryDiscard,
} from './query-duplicate-discard.mjs';
import { taskQueryIdentitySql } from './task-query-identity.mjs';
import { restoreDiscardedTask } from './task-restoration.mjs';
import {
  adminDirectApproveCopyQa,
  batchReturnCopyQa,
  discardReturnedCopy,
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
  claimDeliveryPreviewRevocationJobs,
  createReadyDeliveryEntry,
  failDeliveryPreviewRevocationJob,
  listAllDeliveryPoolTaskIds,
  listDeliveryPoolTaskIdsForPreview,
  listDeliveryPool,
  markDeliveryPreviewRevoked,
  recordDeliveryPreviewLinks,
  withdrawReadyDeliveryEntries,
} from './final-delivery.mjs';
import {
  confirmDeliveryBatch,
  createDeliveryBatch,
  getDeliveryBatch,
  getDeliveryBatchSpreadsheet,
  getDeliveryBatchArtifact,
  listDeliveryBatches,
  recordDeliveryBatchDownload,
} from './delivery-batches.mjs';

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
  if (!['state', 'page.state', 'cursor_page.state'].includes(column)) throw new TypeError('task state order column is invalid');
  return `CASE
    WHEN ${column} = 'COPY_REVIEW_PENDING' THEN 1
    WHEN ${column} = 'COPY_QC_PENDING' THEN 2
    WHEN ${column} IN ('MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING') THEN 3
    WHEN ${column} = 'COPY_RUNNING' THEN 4
    WHEN ${column} = 'IMAGE_RUNNING' THEN 5
    WHEN ${column} IN ('COPY_FAILED', 'IMAGE_FAILED') THEN 6
    WHEN ${column} IN ('COPY_QUEUED', 'IMAGE_QUEUED') THEN 7
    WHEN ${column} = 'REVIEWED' THEN 8
    WHEN ${column} = 'CANCELLED' THEN 9
    ELSE 10
  END`;
}

const TASK_LATEST_ACTIVITY_SQL = 'GREATEST(created_at, updated_at, COALESCE(last_activity_at, updated_at))';

// List pages do not need model/configuration snapshots or whole execution history.
const TASK_LIST_COLUMNS_SQL = [
  'id', 'query', 'input', 'requested_image_count', 'ai_disclosure_enabled', 'skip_copy_review',
  'source_query_package_id', 'source_query_package_snapshot_id', 'source_query_package_name',
  'source_query_package_external_id', 'source_client_batch_code', 'production_batch_id',
  'mandatory_copy_qc', 'copy_qa_rework_pending', 'mandatory_copy_qc_origin',
  'mandatory_image_qc', 'mandatory_image_qc_origin', 'state', 'cancelled_from_state',
  'image_reviewed_at', 'image_reviewed_by_user_id', 'created_by_node_id', 'created_by_user_id',
  'assigned_to_user_id', 'assigned_at', 'assignment_source', 'copy_executor_node_id',
  'current_copy_revision_id', 'copy_qc_released_revision_id',
  'current_image_run_id', 'image_production_chain_id',
  'image_production_started_at', 'image_production_duration_ms', 'current_execution_id',
  'current_stage', 'progress_percent', 'progress_message', 'execution_started_at',
  'last_activity_at', 'finished_at', 'error', 'created_at', 'updated_at',
  'system_priority', 'manual_priority', 'effective_priority', 'priority_mode', 'priority_paused',
  'priority_sort_at', 'queue_entered_at', 'rework_count', 'requeue_reason', 'priority_version',
  'priority_updated_by', 'priority_updated_at', 'priority_reason', 'review_assigned_to_account_id',
].join(', ');
const TASK_PAGE_KEYS_SQL = 'id, created_at, priority_paused, priority_sort_at';
const TASK_PAGE_SUMMARY_SQL = TASK_LIST_COLUMNS_SQL.split(', ').map(column => `page_task.${column}`).join(', ');
// Keep the exact predicate synchronized with 0105's two partial indexes.
const TASK_QUERY_COVER_BYTES_SQL = `octet_length(query) + octet_length(${taskQueryIdentitySql()})
  + octet_length(COALESCE(created_by_user_id, '')) + octet_length(COALESCE(assigned_to_user_id, ''))`;


function integerOption(value, fallback, name, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < minimum || integer > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return integer;
}

export function postgresPoolOptions(env = process.env) {
  return {
    max: integerOption(env.PG_POOL_MAX, 10, 'PG_POOL_MAX', 1, 100),
    connectionTimeoutMillis: integerOption(env.PG_CONNECTION_TIMEOUT_MS, 5_000, 'PG_CONNECTION_TIMEOUT_MS', 1, 120_000),
    idleTimeoutMillis: integerOption(env.PG_IDLE_TIMEOUT_MS, 30_000, 'PG_IDLE_TIMEOUT_MS', 0, 600_000),
    statement_timeout: integerOption(env.PG_STATEMENT_TIMEOUT_MS, 30_000, 'PG_STATEMENT_TIMEOUT_MS', 0, 600_000),
    idle_in_transaction_session_timeout: integerOption(env.PG_IDLE_TRANSACTION_TIMEOUT_MS, 60_000, 'PG_IDLE_TRANSACTION_TIMEOUT_MS', 0, 600_000),
  };
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
    ...priorityFrom(row),
    reviewAssignedToAccountId: row.review_assigned_to_account_id == null ? null : Number(row.review_assigned_to_account_id),
    query: row.query,
    input: row.input,
    requestedImageCount: row.requested_image_count === 'auto'
      ? 'auto'
      : Number(row.requested_image_count),
    aiDisclosureEnabled: row.ai_disclosure_enabled ?? true,
    skipCopyReview: row.skip_copy_review === true,
    sourceQueryPackageId: row.source_query_package_id !== undefined && row.source_query_package_id !== null
      ? Number(row.source_query_package_id)
      : row.source_query_package_snapshot_id !== undefined && row.source_query_package_snapshot_id !== null
        ? Number(row.source_query_package_snapshot_id) : null,
    sourceQueryPackageDeleted: row.source_query_package_id == null
      && row.source_query_package_snapshot_id != null,
    sourceQueryPackageName: row.source_query_package_name ?? null,
    sourceQueryPackageExternalId: row.source_query_package_external_id ?? null,
    sourceClientBatchCode: row.source_client_batch_code ?? null,
    productionBatchId: row.production_batch_id === undefined || row.production_batch_id === null
      ? null : Number(row.production_batch_id),
    deliveryStatus: row.delivery_ready === true ? 'READY' : null,
    mandatoryCopyQc: row.mandatory_copy_qc === true,
    copyQaPassMode: row.copy_qa_record_passed === true
      && row.copy_qc_released_revision_id != null
      && Number(row.copy_qc_released_revision_id) === Number(row.current_copy_revision_id)
      ? row.copy_qa_record_mode ?? null : null,
    copyQaAutoPassed: row.copy_qa_record_method === 'SYSTEM'
      && row.copy_qa_record_mode === 'ACCOUNT_DEFAULT'
      && row.copy_qa_record_passed === true
      && row.copy_qc_released_revision_id != null
      && Number(row.copy_qc_released_revision_id) === Number(row.current_copy_revision_id),
    copyQaReworkPending: row.copy_qa_rework_pending === true,
    mandatoryCopyQcOrigin: row.mandatory_copy_qc_origin ?? null,
    mandatoryImageQc: row.mandatory_image_qc === true,
    mandatoryImageQcOrigin: row.mandatory_image_qc_origin ?? null,
    reworkCount: Number(row.rework_count ?? 0),
    requeueReason: row.requeue_reason ?? null,
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
    assignedToRole: row.assigned_to_role ?? null,
    assigneeStatus: row.assignee_status ?? null,
    assignmentSource: row.assignment_source ?? null,
    assignedAt: row.assigned_at ?? null,
    copyExecutorNodeId: row.copy_executor_node_id,
    imageExecutorNodeId: row.image_executor_node_id ?? null,
    imageExecutorNodeName: row.image_executor_node_name ?? null,
    activeImageEditExecutions: Array.isArray(row.active_image_edit_executions)
      ? row.active_image_edit_executions : [],
    currentCopyRevisionId: row.current_copy_revision_id === null
      ? null
      : Number(row.current_copy_revision_id),
    currentImageRunId: row.current_image_run_id,
    imageProductionChainId: row.image_production_chain_id ?? null,
    imageProductionStartedAt: row.image_production_started_at ?? null,
    imageProductionDurationMs: Number(row.image_production_duration_ms ?? 0),
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

function activeBlindQaSql(taskAlias) {
  if (!['tasks', 'task'].includes(taskAlias)) throw new TypeError('blind QA task alias is invalid');
  return `(EXISTS (
    SELECT 1 FROM copy_sampling_items AS blind_item
    JOIN copy_sampling_freezes AS blind_freeze ON blind_freeze.id = blind_item.freeze_id
    WHERE blind_item.task_id = ${taskAlias}.id
      AND blind_freeze.blind_review_enabled = true
      AND (
        blind_freeze.status IN ('INSPECTING', 'REVIEW_REQUIRED')
        OR (blind_freeze.status = 'BATCH_RETURNED'
          AND ${taskAlias}.state IN ('COPY_REVIEW_PENDING', 'COPY_QC_PENDING'))
      )
  ) OR EXISTS (
    SELECT 1 FROM copy_qa_batch_members_v2 AS blind_v2_member
    JOIN copy_qa_batches_v2 AS blind_v2_batch ON blind_v2_batch.id = blind_v2_member.batch_id
    WHERE blind_v2_member.task_id = ${taskAlias}.id
      AND blind_v2_batch.blind_review_enabled = true
      AND (
        (blind_v2_batch.status = 'INSPECTING'
          AND blind_v2_member.copy_revision_id = ${taskAlias}.current_copy_revision_id
          AND ${taskAlias}.state = 'COPY_QC_PENDING')
        OR (blind_v2_member.status IN ('RETURNED', 'BATCH_AFFECTED')
          AND ${taskAlias}.copy_qa_rework_pending = true
          AND blind_v2_member.quality_cycle = ${taskAlias}.copy_qa_cycle
          AND ${taskAlias}.state = 'COPY_REVIEW_PENDING')
      )
  ) OR EXISTS (
    SELECT 1 FROM image_sampling_items AS blind_image_item
    JOIN image_sampling_freezes AS blind_image_freeze
      ON blind_image_freeze.id = blind_image_item.freeze_id
    WHERE blind_image_item.task_id = ${taskAlias}.id
      AND blind_image_freeze.blind_review_enabled = true
      AND (
        blind_image_freeze.status IN ('INSPECTING', 'REVIEW_REQUIRED')
        OR (blind_image_freeze.status = 'BATCH_RETURNED'
          AND ${taskAlias}.state IN ('IMAGE_REWORK_PENDING', 'IMAGE_QC_PENDING'))
      )
  ))`;
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
    copyReviewEnabled: row.copy_review_enabled !== false,
    copyQcEnabled: row.copy_qc_enabled === true,
    imageQcEnabled: row.image_qc_enabled === true,
    autoCopyBatchEnabled: row.auto_copy_batch_enabled === true,
    autoCopyBatchSize: Number(row.auto_copy_batch_size ?? 10),
    copyFullInspection: row.copy_full_inspection === true,
    defaultCopyQaPass: row.default_copy_qa_pass === true,
    credentialVersion: Number(row.credential_version),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function managedUserFrom(row) {
  if (!row) return null;
  return { ...publicUserFrom(row), copySamplingRateBpsOverride: row.copy_sampling_rate_bps_override ?? null };
}

async function recordAccountSamplingPolicy(client, accountId, previous, next, actor) {
  if (previous === next) return;
  await client.query(`INSERT INTO account_copy_sampling_policy_events(
    account_id, actor_account_id, actor_username, previous_rate_bps_override, rate_bps_override
  ) VALUES ($1, $2, $3, $4, $5)`, [accountId, actor?.userId ?? null, actor?.username ?? 'system', previous, next]);
}

function executionFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: Number(row.task_id),
    kind: row.kind,
    nodeId: row.node_id,
    imageProductionChainId: row.image_production_chain_id ?? null,
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

function imageRunFrom(row) {
  return {
    id: row.id, taskId: Number(row.task_id), executionId: row.execution_id,
    copyRevisionId: Number(row.copy_revision_id), status: row.status,
    ...(row.result !== undefined ? { result: row.result } : {}),
    createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

function taskAssetFrom(row) {
  return {
    id: Number(row.id), taskId: Number(row.task_id), imageRunId: row.image_run_id,
    mediaType: row.media_type, byteSize: Number(row.byte_size), sha256: row.sha256,
    originalName: row.original_name, url: `/v1/assets/${row.id}`, createdAt: row.created_at,
  };
}

const CURRENT_COPY_LINEAGE_SQL = `WITH RECURSIVE current_copy_lineage AS (
  SELECT revision.id, revision.parent_revision_id, revision.revision_origin
  FROM copy_revisions revision JOIN tasks task ON task.current_copy_revision_id = revision.id
  WHERE task.id = $1 AND revision.task_id = $1 AND revision.content_cleared_at IS NULL
  UNION
  SELECT parent.id, parent.parent_revision_id, parent.revision_origin
  FROM copy_revisions parent JOIN current_copy_lineage child ON parent.id = child.parent_revision_id
  WHERE parent.task_id = $1 AND parent.content_cleared_at IS NULL
    AND COALESCE(child.revision_origin, '') NOT IN ('QA_RETURN', 'FINAL_REWORK')
)`;

// UI draft/diff/rework controls read current content and the nearest returned
// baseline. Image versions also keep their pinned copy. Other ancestors carry
// only lineage metadata; their full content is available through history by ID.
const CURRENT_COPY_CONTEXT_SQL = `${CURRENT_COPY_LINEAGE_SQL}, current_copy_payload_ids AS (
  SELECT current_copy_revision_id AS id FROM tasks WHERE id = $1
  UNION SELECT id FROM current_copy_lineage WHERE revision_origin IN ('QA_RETURN', 'FINAL_REWORK')
  UNION SELECT run.copy_revision_id FROM image_runs run JOIN tasks owner ON owner.id = run.task_id
    WHERE owner.id = $1 AND run.content_cleared_at IS NULL
      AND run.id IN (owner.current_image_run_id, owner.image_rework_source_run_id)
)`;

const TASK_HISTORY_TYPES = Object.freeze({
  executions: { table: 'task_executions', time: 'started_at', idType: 'uuid',
    columns: 'id, task_id, kind, node_id, image_production_chain_id, status, stage, progress_percent, progress_message, error, started_at, last_activity_at, finished_at',
    cleared: true, map: executionFrom },
  copyRevisions: { table: 'copy_revisions', time: 'created_at', idType: 'bigint',
    columns: 'id, task_id, execution_id, revision, approved_at, approval_mode, approved_by_node_id, parent_revision_id, revision_origin, copy_content_changed_from_machine, copy_rework_satisfied, created_at',
    cleared: true, map: revisionFrom },
  imageRuns: { table: 'image_runs', time: 'created_at', idType: 'uuid',
    columns: 'id, task_id, execution_id, copy_revision_id, status, created_at, finished_at',
    cleared: true, map: imageRunFrom },
  assessments: { table: 'human_quality_assessments', time: 'created_at', idType: 'bigint',
    columns: 'id, task_id, stage, copy_revision_id, image_run_id, score_x10, rating_context, action, reason_codes, problem_asset_ids, note, reviewer_username, review_session_id, created_at',
    cleared: false, map: qualityAssessmentFrom },
});

function taskHistoryType(kind) {
  if (!Object.hasOwn(TASK_HISTORY_TYPES, kind)) throw new TypeError('task history kind is invalid');
  return TASK_HISTORY_TYPES[kind];
}

function taskHistoryId(value, descriptor) {
  return descriptor.idType === 'uuid' ? normalizeUuid(value, 'history item ID') : normalizeTaskId(value);
}

function isValidHistoryTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)$/u.test(value)
      || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (year < 1) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

function normalizedHistoryCursor(value, taskId, kind, descriptor) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('task history cursor is invalid');
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new TypeError('task history cursor is invalid'); }
  if (decoded?.v !== 1 || decoded.taskId !== taskId || decoded.kind !== kind
      || !isValidHistoryTimestamp(decoded.time)) {
    throw new TypeError('task history cursor does not match this task and history kind');
  }
  return { time: decoded.time, id: taskHistoryId(decoded.id, descriptor) };
}

function taskHistoryMetadata(row, descriptor) {
  const { content, result, snapshot, progressDetails, ...metadata } = descriptor.map(row);
  return metadata;
}

function nodeFrom(row, { includeRunningImageEdits = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    imageWorkerEnabled: row.image_worker_enabled,
    imageEditExecutorVersion: Number(row.image_edit_executor_version ?? 0),
    copyImagePlanRegenerationVersion: Number(row.copy_image_plan_regeneration_version ?? 0),
    copyConcurrency: row.copy_concurrency ?? 1,
    imageConcurrency: row.image_concurrency ?? 1,
    codexPoolId: row.codex_pool_id ?? null,
    codexTotalConcurrency: Number(row.codex_total_concurrency ?? row.copy_concurrency ?? 1),
    codexImageConcurrency: Number(row.codex_image_concurrency ?? row.image_concurrency ?? 1),
    codexRunningCount: Number(row.codex_running_count ?? 0),
    online: Boolean(row.online),
    copyQueuedCount: Number(row.copy_queued_count ?? 0),
    copyRunningCount: Number(row.copy_running_count ?? 0),
    imageRunningCount: Number(row.image_running_count ?? 0),
    imageEditRunningCount: Number(row.image_edit_running_count ?? 0),
    ...(includeRunningImageEdits ? { runningImageEdits: Array.isArray(row.running_image_edits)
      ? row.running_image_edits.map(edit => ({
          executionId: edit.executionId,
          taskId: Number(edit.taskId),
          progressMessage: edit.progressMessage,
          startedAt: edit.startedAt,
        })) : [] } : {}),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentWithReviewEdits(content, edits, { baseRevisionId, nodeId, copyChanged, imagePlanChanged }) {
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
      edited: copyChanged,
      imagePlanEdited: imagePlanChanged || original.manualReview?.imagePlanEdited === true,
      baseRevisionId,
      reviewedByNodeId: nodeId,
      submittedAt: new Date().toISOString(),
    },
  };
}

function normalizedArtifactKey(originalName, mediaType, sha256) {
  if (originalName === null || originalName === undefined || String(originalName).trim() === '') {
    return `${mediaType}:${sha256}`;
  }
  const key = String(originalName).normalize('NFC').replaceAll('\\', '/').split('/').at(-1)?.trim();
  if (!key || [...key].length > 255 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new TypeError('asset originalName is invalid');
  }
  return key;
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
  }, { allowImagePlanBulletOverflow: true }).copy;
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

async function copyReworkBaseline(client, taskId, revision) {
  if (['QA_RETURN', 'FINAL_REWORK'].includes(revision.revision_origin)) return revision;
  const result = await client.query(`
    WITH RECURSIVE rework_lineage AS (
      SELECT id, task_id, parent_revision_id, revision_origin, content, ARRAY[id] AS path
      FROM copy_revisions WHERE id = $1 AND task_id = $2
      UNION ALL
      SELECT parent.id, parent.task_id, parent.parent_revision_id, parent.revision_origin,
        parent.content, child.path || parent.id
      FROM copy_revisions parent
      JOIN rework_lineage child ON parent.id = child.parent_revision_id
      WHERE parent.task_id = $2
        AND COALESCE(child.revision_origin, '') NOT IN ('QA_RETURN', 'FINAL_REWORK')
        AND NOT parent.id = ANY(child.path)
    )
    SELECT id, revision_origin, content FROM rework_lineage
    WHERE revision_origin IN ('QA_RETURN', 'FINAL_REWORK')
    ORDER BY cardinality(path) LIMIT 1
  `, [revision.id, taskId]);
  return result.rows[0] ?? revision;
}

function revisionFrom(row) {
  if (!row) return null;
  const rework = row.revision_origin === 'FINAL_REWORK'
    ? row.content?.finalRework : row.content?.qualityReturn ?? row.content?.finalRework ?? null;
  const reworkOrigin = [rework?.origin, row.revision_origin]
    .find((origin) => origin === 'QA_RETURN' || origin === 'FINAL_REWORK') ?? null;
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
    reworkOrigin,
    reworkTarget: ['COPY', 'IMAGE', 'BOTH'].includes(rework?.target) ? rework.target : null,
    reworkReasonCodes: Array.isArray(rework?.reasonCodes) ? rework.reasonCodes : [],
    reworkReasonSnapshots: Array.isArray(rework?.reasonSnapshots)
      ? rework.reasonSnapshots.filter((entry) => entry && typeof entry === 'object')
      : [],
    reworkCopyFields: Array.isArray(rework?.copyFields)
      ? rework.copyFields.filter((field) => ['TITLE', 'BODY', 'TAGS', 'IMAGE_PLAN'].includes(field))
      : [],
    reworkProblemAssetIds: Array.isArray(rework?.problemAssetIds)
      ? rework.problemAssetIds.map(Number).filter(Number.isSafeInteger)
      : [],
    reworkNote: rework?.note ?? null,
    reworkRecommendation: rework?.recommendedDisposition === 'DISCARD' ? 'DISCARD' : 'REWORK',
    reworkSamplingItemId: typeof rework?.samplingItemId === 'string' ? rework.samplingItemId : null,
    createdAt: row.created_at,
  };
}

function imageQaReturnFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = ['COPY', 'IMAGE', 'BOTH'].includes(value.target) ? value.target : 'IMAGE';
  return {
    source: 'IMAGE_QA',
    target,
    reasonCodes: Array.isArray(value.reasonCodes) ? value.reasonCodes.map(String).filter(Boolean) : [],
    reasonSnapshots: Array.isArray(value.reasonSnapshots)
      ? value.reasonSnapshots.filter((entry) => entry && typeof entry === 'object')
      : [],
    copyFields: Array.isArray(value.copyFields)
      ? value.copyFields.filter((field) => ['TITLE', 'BODY', 'TAGS', 'IMAGE_PLAN'].includes(field))
      : [],
    problemAssetIds: Array.isArray(value.problemAssetIds)
      ? value.problemAssetIds.map(Number).filter(Number.isSafeInteger)
      : [],
    note: typeof value.note === 'string' && value.note.trim() ? value.note.trim() : null,
    sourceImageRunId: typeof value.sourceImageRunId === 'string' ? value.sourceImageRunId : null,
    returnedAt: value.returnedAt ?? null,
  };
}

function normalizedCompletionBoundary(value, label) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function personalTaskCompletionFrom(row) {
  const completions = Array.isArray(row.completions) ? row.completions : [];
  return {
    id: Number(row.id),
    query: row.query,
    state: row.state,
    completions: completions.map((completion) => ({
      stage: completion.stage,
      completedAt: completion.completedAt ?? completion.completed_at,
    })),
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
  reviewAssignmentOnly = false,
} = {}) {
  if (!allowedRoles.includes(actor.role)) {
    throw new ControlPlaneAuthorizationError('current role cannot perform this operation');
  }
  if (actor.role !== 'ADMIN' && actorRow?.copy_review_enabled === false) throw new ControlPlaneAuthorizationError('审核权限已关闭');
  if (reviewAssignmentOnly && actor.role !== 'ADMIN') {
    if (Number(task.review_assigned_to_account_id) !== actor.userId) {
      throw new ControlPlaneAuthorizationError('图片审核任务已分配给其他账号，请刷新后重试');
    }
    return;
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
  if ((ownerOnly || actor.role !== 'ADMIN')
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
    mode: normalizeAutoAssignmentMode(row.mode ?? 'CONTINUOUS'),
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
  const fixedQuantityAssignedTotal = Number(row.fixed_quantity_assigned_total ?? 0);
  const fixedQuantityAssignedToday = Number(row.fixed_quantity_assigned_today ?? 0);
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
    allocationCount: assignmentLimit,
    currentTaskCount,
    fixedQuantityAssignedTotal,
    fixedQuantityAssignedToday,
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

const FIXED_QUANTITY_ASSIGNMENT_REASON = '管理员按指定数量单次分配';

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
    ) AS current_task_count,
    fixed_quantity_stats.fixed_quantity_assigned_total,
    fixed_quantity_stats.fixed_quantity_assigned_today
  FROM task_auto_assignment_workers AS pool
  JOIN app_users AS app_user ON app_user.username = pool.username
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) AS fixed_quantity_assigned_total,
      COUNT(*) FILTER (
        WHERE assignment_event.created_at >= (
          date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
        )
          AND assignment_event.created_at < (
            (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day')
              AT TIME ZONE 'Asia/Shanghai'
          )
      ) AS fixed_quantity_assigned_today
    FROM task_assignment_events AS assignment_event
    WHERE assignment_event.assignee_user_id = pool.username
      AND assignment_event.source = 'AUTO'
      AND assignment_event.reason = '${FIXED_QUANTITY_ASSIGNMENT_REASON}'
  ) AS fixed_quantity_stats ON true
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
      WHERE username = $1 AND status = 'ACTIVE' AND role = 'USER' AND copy_review_enabled = true
      FOR UPDATE
    `, [username])
    : await client.query(`
      SELECT id, username FROM app_users
      WHERE id = $1 AND username = $2 AND status = 'ACTIVE' AND role = 'USER' AND copy_review_enabled = true
      FOR UPDATE
    `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '指定的标注不存在、已停用或不是标注');
  }
}

async function assertActiveNonAdminAssignee(client, username, accountId = null) {
  const result = accountId === null
    ? await client.query(`
      SELECT id, username FROM app_users
      WHERE username = $1 AND status = 'ACTIVE' AND role IN ('REVIEWER', 'USER') AND copy_review_enabled = true
      FOR UPDATE
    `, [username])
    : await client.query(`
      SELECT id, username FROM app_users
      WHERE id = $1 AND username = $2 AND status = 'ACTIVE'
        AND role IN ('REVIEWER', 'USER') AND copy_review_enabled = true
      FOR UPDATE
    `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError(
      'ASSIGNEE_UNAVAILABLE',
      '指定的负责人不存在、已停用或是管理员',
    );
  }
}

async function assertActiveManualAssignee(client, username, accountId, actor = null) {
  if (actor?.role === 'ADMIN'
      && username === actor.username
      && accountId === actor.userId) {
    await lockAssignmentUser(client, username, accountId);
    return;
  }
  await assertActiveNonAdminAssignee(client, username, accountId);
}

async function lockAccountIdentity(client, username, accountId) {
  const result = await client.query(`
    SELECT id, username FROM app_users
    WHERE id = $1 AND username = $2
    FOR UPDATE
  `, [accountId, username]);
  if (!result.rows[0]) {
    throw new ControlPlaneConflictError('ASSIGNEE_UNAVAILABLE', '指定的标注账号已变化，请刷新后重试');
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

const REWORK_COPY_FIELDS = Object.freeze(['TITLE', 'BODY', 'TAGS']);

function normalizedReworkCopyFields(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > REWORK_COPY_FIELDS.length) {
    throw new RangeError('copyFields must contain at most TITLE, BODY and TAGS');
  }
  const fields = value.map((entry, index) => {
    const field = String(entry ?? '').trim().toUpperCase();
    if (!REWORK_COPY_FIELDS.includes(field)) {
      throw new TypeError(`copyFields[${index}] must be TITLE, BODY or TAGS`);
    }
    return field;
  });
  if (new Set(fields).size !== fields.length) throw new TypeError('copyFields must not contain duplicates');
  return fields.toSorted();
}

function normalizedQualityNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('note must be a string');
  const note = value.replace(/\r\n?/gu, '\n').trim();
  if ([...note].length > 1_000) throw new RangeError('note cannot exceed 1000 characters');
  return note || null;
}

const COPY_REVIEW_DRAFT_HISTORY_LIMIT = 20;
const COPY_REVIEW_DRAFT_KINDS = Object.freeze(['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary']);

function copyReviewDraftText(value, field, max) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  if ([...value].length > max) throw new RangeError(`${field} cannot exceed ${max} characters`);
  return value.replace(/\r\n?/gu, '\n');
}

function normalizeCopyReviewDraftContent(value) {
  const content = normalizeJson(value, 'copy review draft', 200_000);
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.version !== 1) {
    throw new TypeError('copy review draft version is invalid');
  }
  const draft = content.draft;
  const copy = draft?.copy;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
      || !copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new TypeError('copy review draft content is invalid');
  }
  if (!Array.isArray(copy.tags) || copy.tags.length > 20) {
    throw new RangeError('copy review draft tags must contain at most 20 items');
  }
  if (!Array.isArray(draft.imagePlan) || draft.imagePlan.length < 3 || draft.imagePlan.length > 5) {
    throw new RangeError('copy review draft imagePlan must contain between 3 and 5 items');
  }
  const imagePlan = draft.imagePlan.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`copy review draft imagePlan[${index}] must be an object`);
    }
    const kind = String(item.kind ?? '').trim();
    if (!COPY_REVIEW_DRAFT_KINDS.includes(kind)) {
      throw new TypeError(`copy review draft imagePlan[${index}].kind is invalid`);
    }
    if (!Array.isArray(item.bullets) || item.bullets.length > 10) {
      throw new RangeError(`copy review draft imagePlan[${index}].bullets must contain at most 10 items`);
    }
    return {
      kind,
      headline: copyReviewDraftText(item.headline, `copy review draft imagePlan[${index}].headline`, 100),
      subtitle: copyReviewDraftText(item.subtitle, `copy review draft imagePlan[${index}].subtitle`, 100),
      bullets: item.bullets.map((bullet, bulletIndex) => copyReviewDraftText(
        bullet,
        `copy review draft imagePlan[${index}].bullets[${bulletIndex}]`,
        200,
      )),
      prompt: copyReviewDraftText(item.prompt, `copy review draft imagePlan[${index}].prompt`, 2_000),
      ...(item.layout === undefined ? {} : { layout: normalizePageLayout(item.layout, kind) }),
    };
  });
  const score = content.copyOriginalScore;
  if (score !== null && !HUMAN_QUALITY_SCORES.includes(score)) {
    throw new TypeError('copy review draft score is invalid');
  }
  if (typeof content.aiDisclosureEnabled !== 'boolean') {
    throw new TypeError('copy review draft aiDisclosureEnabled must be a boolean');
  }
  return {
    version: 1,
    draft: {
      copy: {
        title: copyReviewDraftText(copy.title, 'copy review draft title', 100),
        body: copyReviewDraftText(copy.body, 'copy review draft body', 2_000),
        tags: copy.tags.map((tag, index) => copyReviewDraftText(tag, `copy review draft tags[${index}]`, 100)),
      },
      imagePlan,
      imageSettings: normalizeImageSettings(draft.imageSettings ?? DEFAULT_IMAGE_SETTINGS),
    },
    aiDisclosureEnabled: content.aiDisclosureEnabled,
    copyOriginalScore: score,
    copyOriginalReasons: normalizedQualityReasonCodes(content.copyOriginalReasons),
    copyOriginalNote: copyReviewDraftText(content.copyOriginalNote ?? '', 'copy review draft note', 1_000),
  };
}

function copyReviewDraftFrom(row) {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    baseCopyRevisionId: Number(row.base_copy_revision_id),
    reviewerAccountId: Number(row.reviewer_account_id),
    reviewerUsername: row.reviewer_username,
    version: Number(row.draft_version),
    content: row.content,
    createdAt: row.created_at,
  };
}

function imagePlanRegenerationFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    taskId: Number(row.task_id),
    copyRevisionId: Number(row.copy_revision_id),
    requestedByAccountId: Number(row.requested_by_account_id),
    requestedByUsername: row.requested_by_username,
    copy: row.copy_payload,
    status: row.status,
    executionId: row.execution_id ?? null,
    claimedByNodeId: row.claimed_by_node_id ?? null,
    attempts: Number(row.attempts ?? 0),
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    updatedAt: row.updated_at,
  };
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
    ...(row.rework_details ? { reworkDetails: row.rework_details } : {}),
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
  reworkTarget = null, reworkDetails = null, reviewerUsername, reviewSessionId, requestFingerprint,
}) {
  const result = await client.query(`
    INSERT INTO human_quality_assessments(
      task_id, stage, copy_revision_id, image_run_id, score_x10,
      rating_context, action, reason_codes, problem_asset_ids, note,
      rework_target, reviewer_username, review_session_id, request_fingerprint, rework_details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *
  `, [
    taskId, stage, copyRevisionId, imageRunId, scoreX10,
    ratingContext, action, reasonCodes, problemAssetIds, note,
    reworkTarget, reviewerUsername, reviewSessionId, requestFingerprint, reworkDetails,
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

function taskStatePriority(state) {
  if (state === 'COPY_REVIEW_PENDING') return 1;
  if (state === 'COPY_QC_PENDING') return 2;
  if (['MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING'].includes(state)) return 3;
  if (state === 'COPY_RUNNING') return 4;
  if (state === 'IMAGE_RUNNING') return 5;
  if (['COPY_FAILED', 'IMAGE_FAILED'].includes(state)) return 6;
  if (['COPY_QUEUED', 'IMAGE_QUEUED'].includes(state)) return 7;
  if (state === 'REVIEWED') return 8;
  if (state === 'CANCELLED') return 9;
  return 10;
}

function taskSortOrder({ field, direction }, prefix = '', reverse = false) {
  if (!['', 'page.', 'cursor_page.'].includes(prefix)) throw new TypeError('task sort prefix is invalid');
  const effectiveDirection = reverse
    ? direction === 'ASC' ? 'DESC' : 'ASC'
    : direction;
  if (field === 'id') return `${prefix}id ${effectiveDirection}`;
  if (field === 'createdAt') {
    return `${prefix}created_at ${effectiveDirection}, ${prefix}id ${effectiveDirection}`;
  }
  return reverse
    ? `${prefix}priority_paused DESC, ${prefix}priority_sort_at DESC, ${prefix}id DESC`
    : `${prefix}priority_paused ASC, ${prefix}priority_sort_at ASC, ${prefix}id ASC`;
}

function taskPageCursor(sort, row, mode, scope) {
  if (!row) return null;
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime())) throw new TypeError('task cursor date is invalid');
  return Buffer.from(JSON.stringify({
    v: 1,
    mode,
    sortBy: sort.field,
    sortOrder: sort.direction.toLowerCase(),
    scope,
    id: normalizeTaskId(row.id),
    createdAt: createdAt.toISOString(),
    priority: taskStatePriority(row.state),
    priorityPaused: row.priority_paused === true,
    prioritySortAt: new Date(row.priority_sort_at ?? row.created_at).toISOString(),
  })).toString('base64url');
}

function normalizedTaskPageCursor(value, sort, scope) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('task page cursor is invalid');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('task page cursor is invalid');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || decoded.v !== 1 || !['AFTER', 'BEFORE'].includes(decoded.mode)
      || decoded.sortBy !== sort.field || decoded.sortOrder !== sort.direction.toLowerCase()
      || decoded.scope !== scope) {
    throw new TypeError('task page cursor does not match the requested filters and sort');
  }
  const createdAt = new Date(decoded.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new TypeError('task page cursor date is invalid');
  const priority = Number(decoded.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
    throw new TypeError('task page cursor priority is invalid');
  }
  return {
    mode: decoded.mode,
    id: normalizeTaskId(decoded.id),
    createdAt: createdAt.toISOString(),
    priority,
    priorityPaused: decoded.priorityPaused === true,
    prioritySortAt: (() => {
      const date = new Date(decoded.prioritySortAt);
      if (!Number.isFinite(date.getTime())) throw new TypeError('priority cursor is obsolete; refresh the queue');
      return date.toISOString();
    })(),
  };
}

function taskCursorPredicate(cursor, sort, values, prefix = 'cursor_page.') {
  if (!cursor) return '';
  const after = cursor.mode === 'AFTER';
  if (sort.field === 'id') {
    values.push(cursor.id);
    const ascending = sort.direction === 'ASC';
    const operator = after === ascending ? '>' : '<';
    return `${prefix}id ${operator} $${values.length}`;
  }
  if (sort.field === 'createdAt') {
    values.push(cursor.createdAt, cursor.id);
    const ascending = sort.direction === 'ASC';
    const operator = after === ascending ? '>' : '<';
    return `(${prefix}created_at, ${prefix}id) ${operator} ($${values.length - 1}::timestamptz, $${values.length}::bigint)`;
  }
  values.push(cursor.priorityPaused, cursor.prioritySortAt, cursor.id);
  return `(${prefix}priority_paused, ${prefix}priority_sort_at, ${prefix}id)
    ${after ? '>' : '<'} ($${values.length - 2}::boolean, $${values.length - 1}::timestamptz, $${values.length}::bigint)`;
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
  const client = taskListFactClient(await pool.connect(), pool);
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

async function clearQueryPackageAssignments(client, { id, username }) {
  await client.query(`
    UPDATE query_package_items
    SET screening_assigned_to_account_id = NULL,
      screening_assigned_to_username = NULL,
      screening_assigned_by_account_id = NULL,
      screening_assigned_by_username = NULL,
      screening_assigned_at = NULL,
      version = version + 1, updated_at = now()
    WHERE screening_assigned_to_account_id = $1
      AND screening_assigned_to_username = $2
  `, [Number(id), username]);
  await client.query(`
    UPDATE query_packages
    SET assigned_to_account_id = NULL, assigned_to_username = NULL,
      version = version + 1, updated_at = now()
    WHERE assigned_to_account_id = $1 AND assigned_to_username = $2
  `, [Number(id), username]);
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
      settings.rows.map((row) => [row.key, { version: Number(row.version),
        value: row.key === 'production' ? snapshotProductionSearchMode(row.value) : row.value }]),
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
  const supplementalRuntime = createPromptRuntime({ prompts: shared.prompts, settings: null });
  for (const [promptKind, item] of Object.entries(supplementalRuntime.prompts)) {
    if (item.source === 'BUNDLED_DEFAULT') shared.prompts[promptKind] = item;
  }
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
    SELECT t.id, t.assigned_to_user_id, t.created_by_user_id
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
      t.assigned_to_user_id, t.mandatory_copy_qc_origin
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
  return (await hydrateExecutionSnapshots(client, [row]))[0];
}

async function queueApprovedCopy(client, taskId, revisionId, aiDisclosureEnabled, message = '文案审核通过，等待图片执行机领取') {
  const updated = await client.query(`
    UPDATE tasks SET
      state = 'IMAGE_QUEUED', current_copy_revision_id = $2, copy_qc_released_revision_id = $2,
      ai_disclosure_enabled = $3,
      current_execution_id = NULL, current_image_run_id = NULL,
      current_stage = 'IMAGE_QUEUED', progress_percent = 0,
      progress_message = $4,
      image_production_chain_id = NULL, image_production_started_at = NULL,
      image_production_duration_ms = 0,
      execution_started_at = NULL, last_activity_at = now(), finished_at = NULL,
      error = NULL, pending_snapshot = NULL, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [taskId, revisionId, aiDisclosureEnabled, message]);
  return taskFrom(updated.rows[0]);
}


// Shared validation, identity mapping and SQL fragments for repository domains.
export {
  AUTO_ASSIGNABLE_TASK_STATES,
  AUTO_ASSIGNMENT_ACTOR,
  AUTO_ASSIGNMENT_WORKER_RECORD_SQL,
  BUILTIN_LAYOUT_CATALOG,
  COPY_REVIEW_DRAFT_HISTORY_LIMIT,
  COPY_REVIEW_DRAFT_KINDS,
  CURRENT_COPY_CONTEXT_SQL,
  CURRENT_COPY_LINEAGE_SQL,
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  DEFAULT_IMAGE_SETTINGS,
  FIXED_QUANTITY_ASSIGNMENT_REASON,
  HUMAN_QUALITY_SCORES,
  IMAGE_FORMATS,
  MAX_IMAGE_ATTEMPTS,
  PERMANENT_DELETE_STATES,
  Pool,
  REWORK_COPY_FIELDS,
  TASK_HISTORY_TYPES,
  TASK_LATEST_ACTIVITY_SQL,
  TASK_LIST_COLUMNS_SQL,
  TASK_PAGE_KEYS_SQL,
  TASK_PAGE_SUMMARY_SQL,
  TASK_QUERY_COVER_BYTES_SQL,
  TASK_STATES,
  UNASSIGNED_CREATOR_COPY_CONTROL_STATES,
  USER_ROLES,
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XIAOHONGSHU_SEARCH_SETTINGS_KEY,
  abandonQueryPackage,
  activeBlindQaSql,
  adjustTaskPriority,
  adminDirectApproveCopyQa,
  assertActiveAssignableUser,
  assertActiveManualAssignee,
  assertActiveNonAdminAssignee,
  assertAutoAssignmentVersion,
  assertImageResultSettings,
  assertLayoutCapability,
  assertLockedImageText,
  assertPermanentDeletionActor,
  assertPermanentlyDeletableTask,
  assertQualityExplanation,
  assertTaskActorAccess,
  assertTaskReadyForDelivery,
  assertTasksReadyForDelivery,
  assignQueryPackage,
  assignQueryPackageItems,
  attemptAutomaticCopySamplingFreeze,
  autoAssignmentAdminEventFrom,
  autoAssignmentSettingsFrom,
  autoAssignmentWorkerFrom,
  autoCreateCopyQaBatchesV2,
  automaticReviewImagePlan,
  batchReassignmentCases,
  batchReturnCopyQa,
  batchReturnImageQa,
  blockXhsQuerySearch,
  canAdminDiscardTask,
  changeLayoutCatalog,
  claimDeliveryPreviewRevocationJobs,
  claimQualityReviewSubmission,
  claimRequestExpiry,
  claimXhsQuerySearch,
  clearQueryPackageAssignments,
  closeImageSamplingTail,
  completeXhsQuerySearch,
  configurationSnapshots,
  confirmDeliveryBatch,
  confirmDeliveryBatchMembers,
  contentWithAutomaticReviewLayouts,
  contentWithImagePlanRetry,
  contentWithReviewEdits,
  copyDiffersFromMachineAncestor,
  copyQualityImageGate,
  copyReviewDraftFrom,
  copyReviewDraftText,
  copyReworkBaseline,
  copyReworkChanges,
  createCopyQaReasonTag,
  createDeliveryBatch,
  createHash,
  createPromptRuntime,
  createQueryPackage,
  createQueryPackageProductionBatch,
  createReadyDeliveryEntry,
  discardDuplicateQueries,
  discardImageQaItem,
  discardReturnedCopy,
  discardTaskImages,
  disposeReassignmentCase,
  escalateQualityToAdmin,
  executionFrom,
  failDeliveryPreviewRevocationJob,
  failXhsQuerySearch,
  findCopyReworkBaseline,
  finishReassignmentBaseline,
  flushExpiredCopyQualityBatches,
  flushExpiredImageQualityBatches,
  freezeCopySamplingBatch,
  getCopyQaBatchReturnPreview,
  getCopyQaItem,
  getCopyQaStatistics,
  getDeliveryBatch,
  getDeliveryBatchArtifact,
  getDeliveryBatchSpreadsheet,
  getImageQaAsset,
  getImageQaBatchReturnPreview,
  getModelCall,
  getProductionBatchSamplingReadiness,
  getQueryPackage,
  getQueryPackageItemAssignmentSummary,
  getReassignmentCase,
  hasImageControls,
  hasLayoutCatalog,
  hashUserPassword,
  heartbeatExecutions,
  imagePlanRegenerationFrom,
  imageQaReturnFrom,
  imageRunFrom,
  imageTextHash,
  insertQualityAssessment,
  integerOption,
  invalidateTaskTotals,
  isDeepStrictEqual,
  isStableUnassignedTaskCreator,
  isTaskAssignmentLocked,
  isValidHistoryTimestamp,
  latestImageRetryFailures,
  layoutCatalogRecord,
  listAllDeliveryPoolTaskIds,
  listCopyQaItems,
  listCopyQaReasonTags,
  listCopyQaWorkItemsV2,
  listDeliveryBatches,
  listDeliveryPool,
  listDeliveryPoolTaskIdsForPreview,
  listImageQaItems,
  listModelCalls,
  listQueryPackages,
  listReassignmentCases,
  listXhsQuerySearchNodes,
  loadMigrations,
  lockAccountIdentity,
  lockAdministratorRoster,
  lockAssignmentUser,
  lockAutoAssignmentMember,
  lockCurrentActor,
  lockTaskForActor,
  lockedExecution,
  managedUserFrom,
  markDeliveryPreviewRevoked,
  migrateDatabase,
  nodeFrom,
  normalizeAssigneeUserId,
  normalizeAssignmentSource,
  normalizeAutoAssignmentEnabled,
  normalizeAutoAssignmentExpectedVersion,
  normalizeAutoAssignmentLimit,
  normalizeAutoAssignmentMode,
  normalizeAutoAssignmentWorkerStatus,
  normalizeConcurrency,
  normalizeCopyReviewDraftContent,
  normalizeCopyReviewEdits,
  normalizeCopyReviewImagePlan,
  normalizeCopySamplingRateOverride,
  normalizeCreateTask,
  normalizeCreatorUserId,
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
  normalizeImageEditRepairMaxAttempts,
  normalizeImageSettings,
  normalizeJson,
  normalizeLayoutCatalog,
  normalizeLayoutPresets,
  normalizeNodeId,
  normalizeNodeName,
  normalizePageLayout,
  normalizePriorityMode,
  normalizeProgress,
  normalizeSavedTaskView,
  normalizeTaskAttention,
  normalizeTaskBatch,
  normalizeTaskCreatorRole,
  normalizeTaskDateRange,
  normalizeTaskId,
  normalizeUuid,
  normalizeXiaohongshuSearchSettings,
  normalizedActorIdentity,
  normalizedArtifactKey,
  normalizedAssignmentTaskIds,
  normalizedCompletionBoundary,
  normalizedDisplayName,
  normalizedHistoryCursor,
  normalizedHumanQualityScore,
  normalizedPermanentDeletionTaskIds,
  normalizedQualityNote,
  normalizedQualityProblemAssetIds,
  normalizedQualityReasonCodes,
  normalizedQueryPackageNameFilter,
  normalizedReviewCopy,
  normalizedReworkCopyFields,
  normalizedTaskPageCursor,
  normalizedTaskQuery,
  normalizedTaskSort,
  normalizedTaskStates,
  normalizedUserRole,
  normalizedUsername,
  parseVisualPlanOutput,
  passCopyQaItem,
  passImageQaItem,
  pendingMigrations,
  permanentlyDeleteQueryPackage,
  personalTaskCompletionFrom,
  pg,
  previewDuplicateQueryDiscard,
  previewPermanentQueryPackageDeletion,
  priorityFrom,
  priorityOrderSql,
  publicUserFrom,
  qualityAssessmentFrom,
  qualityReviewFingerprint,
  queueApprovedCopy,
  randomUUID,
  readAutoAssignmentWorker,
  readOperatorPerformance,
  readPersonalQualityActivity,
  readPersonalWorkspace,
  readPriorityScope,
  readSecondaryAssignmentFeedback,
  readTaskTotal,
  readWorkflowQualitySettings,
  recordAccountSamplingPolicy,
  recordAutoAssignmentAdminEvent,
  recordDeliveryBatchDownload,
  recordDeliveryPreviewLinks,
  recoverStaleExecutions,
  redactExecutionError,
  regenerateReassignmentBaseline,
  releaseCopyQaFreeze,
  releaseCopySamplingBatch,
  restoreDiscardedTask,
  restoreReassignmentCase,
  resumeXhsQuerySearch,
  retryFailedXhsQuerySearch,
  retryReassignmentReset,
  returnCopyQaItem,
  returnImageQaItem,
  reviseTaskImages,
  revisionFrom,
  routeManualCopyApproval,
  runAutoAssignmentReplenishment,
  saveModelCall,
  savedTaskViewFrom,
  snapshotProductionSearchMode,
  submitImageSelfReview,
  taskAssetFrom,
  taskCursorPredicate,
  taskFrom,
  taskHistoryId,
  taskHistoryMetadata,
  taskHistoryType,
  taskListFactClient,
  taskListFactQueryable,
  taskListFactVersion,
  taskPageCursor,
  taskQueryIdentitySql,
  taskSortOrder,
  taskStateOrder,
  taskStatePriority,
  transaction,
  updateCopyQaReasonTag,
  updateQueryPackageScreening,
  updateWorkflowQualitySettings,
  verifyUserPassword,
  visualPlanPost,
  withSavedVisualPlan,
  withdrawReadyDeliveryEntries
};
