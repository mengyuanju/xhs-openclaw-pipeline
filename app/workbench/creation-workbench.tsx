'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { Button } from '@/components/ui/button';
import { ToastFeedback } from '@/components/ui/sonner';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';

import {
  AlertTriangle,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  UserRound,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTextInputDialog } from '@/components/ui/text-input-dialog';

import { apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import { resumeImageTask } from '../components/resume-image-task';
import { canResumeImageTask } from '../../src/control-plane/image-resume.mjs';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { parseQueryBatch } from '../../src/control-plane/query-batch.mjs';
import { imageExecutorLabel } from '../../src/control-plane/image-executor-label.mjs';
import {
  CREATE_ASSIGNMENT_MODES,
  canManageTaskAssignment,
  createAssignmentFields,
} from '../../src/control-plane/task-assignment.mjs';
import { TaskReviewDialog } from './task-review-dialog';
import { TaskPriorityControl, PrioritySummary, type PriorityTask } from './task-priority-control';
import { TaskRowActions } from './task-row-actions';
import { AdminJobFilters, CREATOR_ROLE_LABELS } from './admin-job-filters';
import type { JobCreator } from './admin-creator-filter';
import { JobUserPicker } from './job-user-picker';
import { TaskAssignmentDialog } from './task-assignment-dialog';
import { loadAdminTaskPage } from '../../src/control-plane/admin-task-page.mjs';
import { createActionLock } from '../../src/control-plane/action-lock.mjs';
import { WorkbenchPagination } from './workbench-pagination';
import { PersonalTaskControls, PersonalWorkDetails } from './personal-controls';
import { appendPersonalOptions, DEFAULT_PERSONAL_OPTIONS, parsePersonalOptions, type PersonalOptions, type PersonalWork, type PersonalEvent } from './personal-filters';
import { subscribeWorkspaceUpdates } from '../components/workspace-updates';
import { normalizePersonalFilters } from '../../src/personal-workspace.mjs';
import personalStyles from './personal-workspace.module.css';
import { normalizePreparedDeliveryExport } from '../delivery-pool/types';
import { OperatorDeliveryHistory } from './operator-delivery-history';
import { personalStateFilterStates } from './personal-state-filters';
import { isLegacyTaskStateFilterError } from './task-list-compatibility';
import { shanghaiCalendarDate } from '../../src/control-plane/task-date-filter.mjs';
import {
  DEFAULT_WORKBENCH_LIST_STATE,
  workbenchListSearch,
  type TaskAttention,
  type PersonalTaskScope,
  type WorkbenchListState,
} from './list-state';

import {
  TASK_SORT_OPTIONS,
  compareTasks,
  taskSortParams,
  WORKBENCH_VIEWS,
  matchesWorkbenchView,
  type TaskSort,
  type TaskState,
  type ViewKey,
} from './views';

type DistributedTask = PriorityTask & {
  canOpen?: boolean;
  personalWork?: PersonalWork | null;
  personalHistory?: PersonalEvent[];
  id: number;
  query: string;
  sourceQueryPackageName?: string | null;
  state: TaskState;
  skipCopyReview: boolean;
  cancelledFromState?: TaskState | null;
  currentImageRunId: string | null;
  copyExecutorNodeId: string | null;
  imageExecutorNodeId?: string | null;
  imageExecutorNodeName?: string | null;
  currentCopyRevisionId: number | null;
  mandatoryCopyQc?: boolean;
  mandatoryCopyQcOrigin?: 'QA_RETURN' | 'FINAL_REWORK' | 'IMAGE_RETRY_REVIEW' | 'DISCARD_RESTORE' | 'SECOND_ASSIGNMENT' | null;
  currentExecutionId?: string | null;
  createdByUserId: string | null;
  createdByAccountId?: number | null;
  createdByDisplayName: string | null;
  createdByRole?: string | null;
  assignedToUserId: string | null;
  assignedToAccountId?: number | null;
  assignedToDisplayName: string | null;
  assigneeStatus?: string | null;
  assignmentSource?: 'SELF' | 'MANUAL' | 'AUTO' | null;
  assignedAt?: string | null;
  currentStage: string | null;
  progressPercent: number;
  progressMessage: string;
  imageProductionChainId?: string | null;
  imageProductionStartedAt?: string | null;
  imageProductionDurationMs?: number;
  executionStartedAt: string | null;
  lastActivityAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveryStatus?: 'READY' | null;
};

type ExecutorNode = {
  id: string;
  name: string;
  online: boolean;
  imageWorkerEnabled: boolean;
  copyQueuedCount: number;
  copyRunningCount: number;
  lastSeenAt: string;
};

type TaskPage = {
  counts?: Record<string, number>;
  updatedAt?: string;
  items: DistributedTask[];
  total: number;
  limit: number;
  offset: number;
  previousCursor?: string | null;
  nextCursor?: string | null;
};

type SavedTaskView = {
  id: number;
  name: string;
  viewKey: ViewKey;
  filters: Omit<WorkbenchListState, 'page' | 'taskId'>;
  updatedAt: string;
};

type BatchActionResult = {
  action: 'RETRY' | 'CANCEL_QUEUE';
  succeeded: number[];
  failed: Array<{ id: number; code: string; message: string }>;
};

type BatchPermanentDeleteResult = {
  action: 'PERMANENT_DELETE';
  succeeded: number[];
  failed: Array<{ id: number; code: string; message: string }>;
  cleanupPending: number[];
};

type DuplicateQueryTaskSummary = {
  id: number;
  query: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  assignedToUserId: string | null;
  sourceQueryPackageName: string | null;
};

type DuplicateQuerySkippedTask = DuplicateQueryTaskSummary & {
  reasonCode: 'DIFFERENT_BUSINESS_CONTEXT' | 'ALREADY_CANCELLED' | 'NOT_PRISTINE_COPY_QUEUED' | string;
};

type DuplicateQueryDiscardPreview = {
  version: 1;
  representativeTaskIds: number[];
  previewFingerprint: string;
  groups: Array<{
    query: string;
    keeper: DuplicateQueryTaskSummary | null;
    discardable: DuplicateQueryTaskSummary[];
    skipped: DuplicateQuerySkippedTask[];
  }>;
  summary: {
    queryGroupCount: number;
    discardableCount: number;
    skippedCount: number;
  };
};

type DuplicateQueryDiscardResult = {
  requestId: string;
  discardedTaskIds: number[];
  keeperTaskIds: number[];
  discardedCount: number;
  skippedCount: number;
};

const STATE_LABELS: Record<TaskState, string> = {
  COPY_QUEUED: '待文案执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  PENDING_SECOND_ASSIGNMENT: '待二次分配',
  COPY_QC_PENDING: '待文案质检',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '图片生成失败',
  MANUAL_ARCHIVE: '待图片初审',
  IMAGE_QC_PENDING: '待图片质检',
  IMAGE_REWORK_PENDING: '图片质检打回',
  REVIEWED: '交付池',
  CANCELLED: '已废弃',
};
const PERMANENT_DELETE_STATES: TaskState[] = ['COPY_FAILED', 'IMAGE_FAILED', 'REVIEWED', 'CANCELLED'];
const CANCELLED_EXECUTION_SETTLE_MS = 3 * 60_000;
const LIST_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_TASK_VIEW_VALUE = 'DEFAULT';

const STAGE_LABELS: Record<string, string> = {
  IMAGE_RETRY_EXHAUSTED: IMAGE_RETRY_EXHAUSTED_LABEL,
  STARTING_COPY: '准备生成文案',
  STARTING_IMAGE: '准备生成图片',
  SEARCHING_IMAGES: '联网搜索图片',
  SELECTING_IMAGES: '筛选并校验图片',
  UPLOADING_IMAGES: '上传图片到中心服务',
  QUERY_REVIEW: '选题审核',
  KNOWLEDGE_MATCH: '优秀案例匹配',
  RESEARCH: '全网搜索与资料整理',
  ORIGINAL_GENERATION: '标题、正文与配图策划生成',
  COPY_LENGTH_REPAIR: '正文定向修复',
  COPY_CONTRACT_REPAIR: '文案格式修复',
  ORIGINAL_REVIEW: '首稿质检',
  REVIEWED_GENERATION: '文案改写',
  REVIEWED_REVIEW: '改写稿质检',
  PREPARING: '生图准备',
  PLANNING: '画面规划',
  GENERATING: '图片生成',
  ALIGNING: '图片校验与对齐',
  QUALITY_CHECK: '图片质检',
  FINALIZING: '图片整理',
  COPY_QUEUED: '待文案执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  PENDING_SECOND_ASSIGNMENT: '待二次分配',
  COPY_QC_PENDING: '待文案质检',
  QC_SAMPLE_PENDING: '待文案抽检',
  QC_NON_SAMPLE_HELD: '等待批次抽检结果',
  QC_MANDATORY_RECHECK: '待强制复检',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  MANUAL_ARCHIVE: '待图片初审',
  IMAGE_QC_PENDING: '待图片质检',
  IMAGE_REWORK_PENDING: '图片质检打回',
  REVIEWED: '交付池',
  FAILED: '执行失败',
  CANCELLED: '已废弃',
};

function visibleStateLabel(state: TaskState, role: string) {
  return role === 'USER' && state === 'REVIEWED' ? '已完成' : STATE_LABELS[state];
}

function stageLabel(task: DistributedTask, role: string) {
  const internalLabel = task.currentStage
    ? STAGE_LABELS[task.currentStage] ?? STATE_LABELS[task.state]
    : STATE_LABELS[task.state];
  const label = role === 'USER' && (task.currentStage === 'REVIEWED' || task.state === 'REVIEWED')
    ? '已完成'
    : internalLabel;
  return task.state.endsWith('_FAILED') && task.currentStage && !['FAILED', task.state].includes(task.currentStage)
    ? `失败阶段：${label}` : label;
}

function taskStateLabel(task: DistributedTask, role: string) {
  if(task.canOpen===false && String(task.state)==='HISTORY_ONLY') return '历史记录';
  return task.currentStage === 'QC_MANDATORY_RECHECK' ? '待强制复检' : visibleStateLabel(task.state, role);
}

function taskOwnerId(task: Pick<DistributedTask, 'assignedToUserId' | 'createdByUserId'>) {
  return Object.hasOwn(task, 'assignedToUserId') ? task.assignedToUserId : task.createdByUserId;
}

function isTaskCreator(task: DistributedTask, username: string, accountId: number) {
  return task.createdByUserId === username
    && task.createdByAccountId === accountId;
}

function isTaskAssignee(task: DistributedTask, username: string, accountId: number) {
  if (!Object.hasOwn(task, 'assignedToUserId')) return isTaskCreator(task, username, accountId);
  return task.assignedToUserId === username
    && task.assignedToAccountId === accountId;
}

function isPersonalTask(task: DistributedTask, username: string, accountId: number) {
  return isTaskAssignee(task, username, accountId) || isTaskCreator(task, username, accountId);
}

function matchesPersonalScope(task: DistributedTask, scope: PersonalTaskScope, username: string, accountId: number) {
  if (scope === 'ASSIGNED') return isTaskAssignee(task, username, accountId);
  if (scope === 'CREATED') return isTaskCreator(task, username, accountId);
  return isPersonalTask(task, username, accountId);
}

function personalOwnershipLabel(task: DistributedTask, username: string, accountId: number) {
  const assigned = isTaskAssignee(task, username, accountId);
  const created = isTaskCreator(task, username, accountId);
  if (assigned && created) return '我创建并负责';
  if (assigned) return '我负责';
  return created ? '我创建' : '';
}

function assignmentLabel(task: DistributedTask) {
  if (task.assignedToDisplayName || task.assignedToUserId) {
    return task.assignedToDisplayName || task.assignedToUserId || '';
  }
  if (['COPY_QUEUED', 'COPY_RUNNING'].includes(task.state)) return '尚未到派单节点';
  if (task.state === 'COPY_FAILED') return '未分配（生成异常）';
  if (task.state === 'COPY_REVIEW_PENDING') return '待分配';
  return '未分配';
}

function taskProgressMessage(task: DistributedTask) {
  if (task.currentStage === 'QC_MANDATORY_RECHECK') {
    return '返工稿已提交强制复检；复检通过后才进入待生图队列';
  }
  if (task.progressMessage === '图文终审要求文案返工，修改后将强制重新质检') {
    return '图片质检已退回文案；实际修改后须提交强制复检，复检通过后才进入待生图队列';
  }
  if (task.state === 'COPY_QUEUED' && taskOwnerId(task) === null
    && ['等待分配负责人', '等待负责人分配'].includes(task.progressMessage)) {
    return '等待文案执行机领取';
  }
  return task.progressMessage;
}

function copyExecutorLabel(task: DistributedTask, nodes: ExecutorNode[]) {
  if (!task.copyExecutorNodeId) {
    return task.state === 'COPY_QUEUED' ? '待领取' : '—';
  }
  return nodes.find((node) => node.id === task.copyExecutorNodeId)?.name ?? task.copyExecutorNodeId;
}

function canRequeueImages(task: DistributedTask) {
  return task.currentCopyRevisionId !== null
    && ['IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE'].includes(task.state);
}

const STALE_AFTER_MS = 30 * 60_000;
function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

class DuplicateQueryCleanupRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DuplicateQueryCleanupRequestError';
    this.status = status;
  }
}

async function duplicateQueryCleanupRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as {
    data?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      throw new DuplicateQueryCleanupRequestError(401, '登录已过期，请重新登录');
    }
    const responseMessage = typeof payload?.error?.message === 'string'
      ? payload.error.message
      : `请求失败（${response.status}）`;
    throw new DuplicateQueryCleanupRequestError(response.status, responseMessage);
  }
  return payload?.data as T;
}

function isPositiveTaskId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function sameTaskIds(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  const leftSorted = left.toSorted((first, second) => first - second);
  const rightSorted = right.toSorted((first, second) => first - second);
  return leftSorted.every((id, index) => id === rightSorted[index]);
}

function isDuplicateQueryTaskSummary(value: unknown): value is DuplicateQueryTaskSummary {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return isPositiveTaskId(task.id)
    && typeof task.query === 'string'
    && typeof task.state === 'string'
    && Object.hasOwn(STATE_LABELS, task.state)
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string'
    && (task.createdByUserId === null || typeof task.createdByUserId === 'string')
    && (task.assignedToUserId === null || typeof task.assignedToUserId === 'string')
    && (task.sourceQueryPackageName === null || typeof task.sourceQueryPackageName === 'string');
}

function isDuplicateQueryDiscardPreview(value: unknown): value is DuplicateQueryDiscardPreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Record<string, unknown>;
  if (preview.version !== 1
    || !Array.isArray(preview.representativeTaskIds)
    || !preview.representativeTaskIds.every(isPositiveTaskId)
    || new Set(preview.representativeTaskIds).size !== preview.representativeTaskIds.length
    || typeof preview.previewFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(preview.previewFingerprint)
    || !Array.isArray(preview.groups)
    || !preview.summary || typeof preview.summary !== 'object') return false;
  const groups = preview.groups as Array<Record<string, unknown>>;
  if (!groups.every((group) => typeof group.query === 'string'
    && (group.keeper === null || isDuplicateQueryTaskSummary(group.keeper))
    && Array.isArray(group.discardable)
    && group.discardable.every(isDuplicateQueryTaskSummary)
    && (group.discardable.length === 0 || group.keeper !== null)
    && Array.isArray(group.skipped)
    && group.skipped.every((task) => isDuplicateQueryTaskSummary(task)
      && typeof (task as DuplicateQuerySkippedTask).reasonCode === 'string'))) return false;
  const summary = preview.summary as Record<string, unknown>;
  const discardableCount = groups.reduce((total, group) => total + (group.discardable as unknown[]).length, 0);
  const skippedCount = groups.reduce((total, group) => total + (group.skipped as unknown[]).length, 0);
  return summary.queryGroupCount === groups.length
    && summary.discardableCount === discardableCount
    && summary.skippedCount === skippedCount;
}

function isDuplicateQueryDiscardResult(value: unknown): value is DuplicateQueryDiscardResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.requestId === 'string'
    && Array.isArray(result.discardedTaskIds)
    && result.discardedTaskIds.every(isPositiveTaskId)
    && Array.isArray(result.keeperTaskIds)
    && result.keeperTaskIds.every(isPositiveTaskId)
    && Number.isSafeInteger(result.discardedCount)
    && Number(result.discardedCount) === result.discardedTaskIds.length
    && Number.isSafeInteger(result.skippedCount)
    && Number(result.skippedCount) >= 0;
}

function isStale(task: DistributedTask) {
  const lastProgressAt = task.lastActivityAt || task.executionStartedAt || task.updatedAt || task.createdAt;
  return ['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.state)
    && Number.isFinite(Date.parse(lastProgressAt))
    && Date.now() - Date.parse(lastProgressAt) >= STALE_AFTER_MS;
}

function taskLatestActivityAt(task: DistributedTask) {
  return [task.updatedAt, task.lastActivityAt, task.createdAt]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? task.createdAt;
}

function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function elapsed(task: DistributedTask) {
  if (!task.executionStartedAt) return '—';
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  return durationLabel(end - Date.parse(task.executionStartedAt));
}

function cumulativeImageElapsed(task: DistributedTask) {
  if (!task.imageProductionChainId) return null;
  const completedDuration = Number.isFinite(task.imageProductionDurationMs)
    ? Math.max(0, Number(task.imageProductionDurationMs)) : 0;
  const runningDuration = task.state === 'IMAGE_RUNNING' && task.executionStartedAt
    ? Math.max(0, Date.now() - Date.parse(task.executionStartedAt)) : 0;
  return durationLabel(completedDuration + runningDuration);
}

function timeLabel(value: string | null, state?: TaskState) {
  if (value) return new Date(value).toLocaleString('zh-CN', { hour12: false });
  return state && !state.endsWith('_QUEUED') ? '开始时间未记录' : '尚未开始';
}

function matchesAttention(task: DistributedTask, attention: TaskAttention) {
  const failed = ['COPY_FAILED', 'IMAGE_FAILED'].includes(task.state) || isImageRetryExhausted(task);
  if (attention === 'NONE') return true;
  if (attention === 'STALE') return isStale(task);
  if (attention === 'FAILED') return failed;
  return isStale(task) || failed;
}

function taskIdSearch(value: string) {
  const match = value.trim().match(/^#(\d+)$/u);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isPermanentlyDeletableTask(task: DistributedTask) {
  const cancelledExecutionSettled = !['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.cancelledFromState || '')
    || Date.now() - Date.parse(task.updatedAt) >= CANCELLED_EXECUTION_SETTLE_MS;
  return PERMANENT_DELETE_STATES.includes(task.state) && cancelledExecutionSettled;
}

function PermanentDeleteDialog({
  tasks,
  batch,
  password,
  error,
  busy,
  onPasswordChange,
  onCancel,
  onConfirm,
}: {
  tasks: DistributedTask[];
  batch: boolean;
  password: string;
  error: string;
  busy: boolean;
  onPasswordChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const passwordHelpId = batch ? 'batch-task-deletion-password-help' : 'task-deletion-password-help';
  const passwordErrorId = batch ? 'batch-task-deletion-password-error' : 'task-deletion-password-error';
  const inputId = batch ? 'batch-task-deletion-password' : 'task-deletion-password';

  return <AlertDialogPrimitive.Root open={tasks.length > 0} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50" />
      <AlertDialogPrimitive.Content className="permanent-delete-dialog fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
        <form className="permanent-delete-form" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
          <header className="permanent-delete-header">
            <span className="permanent-delete-icon" aria-hidden="true"><Trash2 size={22} /></span>
            <div>
              <span className="section-kicker">高风险操作</span>
              <AlertDialogPrimitive.Title className="permanent-delete-title">
                {batch ? <>批量永久删除 {tasks.length} 条任务</> : <>永久删除任务 #{tasks[0]?.id}</>}
              </AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="permanent-delete-description">
                {batch
                  ? '所选任务会在同一操作中删除，二级密码仅校验一次。'
                  : '这条任务及其全部关联数据将从系统中移除。'}
              </AlertDialogPrimitive.Description>
            </div>
          </header>

          <div className="permanent-delete-body">
            <section className="permanent-delete-warning" aria-labelledby={`${inputId}-warning`}>
              <ShieldAlert aria-hidden="true" size={20} />
              <div>
                <strong id={`${inputId}-warning`}>删除后无法恢复</strong>
                <p>任务记录、执行记录、文案版本、生成图片和已保存素材都会被永久清除。</p>
                <div className="permanent-delete-impact" aria-label="将被删除的数据">
                  <span>任务记录</span><span>执行记录</span><span>文案版本</span><span>图片素材</span>
                </div>
              </div>
            </section>

            <section className="permanent-delete-targets" aria-labelledby={`${inputId}-targets`}>
              <div className="permanent-delete-targets-head">
                <strong id={`${inputId}-targets`}>待删除任务</strong>
                <span>{tasks.length} 条</span>
              </div>
              <ul className="permanent-delete-target-list">
                {tasks.map((task) => <li key={task.id}>
                  <div><strong>#{task.id}</strong><span>{STATE_LABELS[task.state]}</span></div>
                  <p>{task.query || '未命名 Query'}</p>
                </li>)}
              </ul>
              <p className="permanent-delete-alternative">如果仍可能恢复任务，请返回并从“更多操作”重新排队。</p>
            </section>

            {error && <div className="notice error permanent-delete-error" role="alert" id={passwordErrorId}><AlertTriangle aria-hidden="true" size={16} /><span>{error}</span></div>}

            <div className="field permanent-delete-password-field">
              <label htmlFor={inputId}><LockKeyhole aria-hidden="true" size={16} />删除二级密码</label>
              <input
                className="input"
                id={inputId}
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                aria-describedby={`${passwordHelpId}${error ? ` ${passwordErrorId}` : ''}`}
                aria-invalid={Boolean(error)}
                autoComplete="current-password"
                autoFocus
                disabled={busy}
                placeholder="请输入删除二级密码"
              />
              <small id={passwordHelpId}>请输入“个人信息”中设置的删除二级密码，确认操作由你本人发起。</small>
            </div>
          </div>

          <footer className="permanent-delete-footer">
            <span><ShieldAlert aria-hidden="true" size={15} />确认后将立即开始删除</span>
            <div>
              <Button unstyled className="button" type="button" disabled={busy} onClick={onCancel}>取消</Button>
              <Button unstyled className="button permanent-delete-confirm" type="submit" disabled={!password || busy}>
                {busy
                  ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />删除中…</>
                  : <><Trash2 aria-hidden="true" size={16} />{batch ? `永久删除 ${tasks.length} 条任务` : '永久删除这条任务'}</>}
              </Button>
            </div>
          </footer>
        </form>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  </AlertDialogPrimitive.Root>;
}

const DUPLICATE_QUERY_SKIP_LABELS: Record<string, string> = {
  DIFFERENT_BUSINESS_CONTEXT: '业务设置不同，不能自动判断为同一任务',
  ALREADY_CANCELLED: '已经废弃，无需重复处理',
  NOT_PRISTINE_COPY_QUEUED: '已经开始处理或留有成果，为避免误伤已跳过',
};

function duplicateQuerySkipLabel(reasonCode: string) {
  return DUPLICATE_QUERY_SKIP_LABELS[reasonCode] ?? '不符合安全废弃条件，已跳过';
}

function DuplicateQueryDiscardDialog({
  preview,
  error,
  previewing,
  discarding,
  requestReady,
  onClose,
  onConfirm,
  onRepreview,
}: {
  preview: DuplicateQueryDiscardPreview | null;
  error: string;
  previewing: boolean;
  discarding: boolean;
  requestReady: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onRepreview: () => void;
}) {
  const busy = previewing || discarding;

  return <Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="duplicate-query-dialog" showCloseButton={!busy}>
      {preview && <>
        <header className="duplicate-query-dialog-header">
          <span className="duplicate-query-dialog-icon" aria-hidden="true"><Eye size={22} /></span>
          <div>
            <span className="section-kicker">安全去重</span>
            <DialogTitle>预览重复 Query</DialogTitle>
            <DialogDescription>
              这里只预览所选 Query 的完整重复组。确认后只废弃尚未开始、没有成果且业务设置一致的排队任务。
            </DialogDescription>
          </div>
        </header>

        <div className="duplicate-query-dialog-body">
          <section className="duplicate-query-summary" aria-label="重复 Query 处理汇总">
            <div><strong>{preview.summary.queryGroupCount}</strong><span>组 Query</span></div>
            <div><strong>{preview.summary.discardableCount}</strong><span>可安全废弃</span></div>
            <div><strong>{preview.summary.skippedCount}</strong><span>跳过保护</span></div>
          </section>

          {preview.summary.discardableCount === 0 && <div className="duplicate-query-empty" role="status">
            <ShieldAlert aria-hidden="true" size={18} />
            <div>
              <strong>没有可安全废弃的重复任务</strong>
              <p>本次不会修改任何任务。请查看下方保留项与跳过原因；若任务刚刚变化，可重新预览。</p>
            </div>
          </div>}

          {error && <div className="notice error duplicate-query-error" role="alert">
            <AlertTriangle aria-hidden="true" size={16} /><span>{error}</span>
          </div>}

          <div className="duplicate-query-groups">
            {preview.groups.length === 0
              ? <p className="duplicate-query-no-groups">所选 Query 当前没有重复项，或重复项已经全部处理。</p>
              : preview.groups.map((group, groupIndex) => <section className="duplicate-query-group" key={`${group.query}-${group.keeper?.id ?? 'none'}-${groupIndex}`}>
                <header>
                  <div>
                    <span>Query</span>
                    <strong title={group.query}>{group.query || '未命名 Query'}</strong>
                  </div>
                  <small>可废弃 {group.discardable.length} 条 · 跳过 {group.skipped.length} 条</small>
                </header>

                <div className="duplicate-query-keeper">
                  <span>保留</span>
                  {group.keeper
                    ? <div>
                      <strong>#{group.keeper.id}</strong>
                      <span>{STATE_LABELS[group.keeper.state]}</span>
                      <small>创建于 {timeLabel(group.keeper.createdAt)} · 词包：{group.keeper.sourceQueryPackageName || '未归属'}</small>
                    </div>
                    : <p>这一组没有仍需保留的有效任务。</p>}
                </div>

                <div className="duplicate-query-group-list">
                  <strong>确认后废弃 <span>{group.discardable.length}</span></strong>
                  {group.discardable.length === 0
                    ? <p>这一组没有符合安全条件的待废弃任务。</p>
                    : <ul>{group.discardable.map((task) => <li key={task.id}>
                      <div><strong>#{task.id}</strong><span>{STATE_LABELS[task.state]}</span></div>
                      <small>创建于 {timeLabel(task.createdAt)} · 词包：{task.sourceQueryPackageName || '未归属'}</small>
                    </li>)}</ul>}
                </div>

                <div className="duplicate-query-group-list duplicate-query-skipped">
                  <strong>为安全起见跳过 <span>{group.skipped.length}</span></strong>
                  {group.skipped.length === 0
                    ? <p>这一组没有需要额外保护的任务。</p>
                    : <ul>{group.skipped.map((task) => <li key={task.id}>
                      <div><strong>#{task.id}</strong><span>{STATE_LABELS[task.state]}</span></div>
                      <small>{duplicateQuerySkipLabel(task.reasonCode)}</small>
                    </li>)}</ul>}
                </div>
              </section>)}
          </div>
        </div>

        <footer className="duplicate-query-dialog-footer">
          <span><ShieldAlert aria-hidden="true" size={15} />不会永久删除；任务只会标记为已废弃</span>
          <div>
            <Button unstyled className="button" type="button" disabled={busy} onClick={onClose}>关闭</Button>
            {error && <Button unstyled className="button" type="button" disabled={busy} onClick={onRepreview}>
              {previewing ? <><LoaderCircle className="animate-spin" size={15} />重新预览中…</> : '重新预览'}
            </Button>}
            <Button unstyled className="button danger" type="button"
              disabled={busy || !requestReady || preview.summary.discardableCount === 0} onClick={onConfirm}>
              {discarding
                ? <><LoaderCircle className="animate-spin" size={15} />正在废弃…</>
                : <><Trash2 size={15} />确认废弃 {preview.summary.discardableCount} 条</>}
            </Button>
          </div>
        </footer>
      </>}
    </DialogContent>
  </Dialog>;
}

export function CreationWorkbench({ nodeId, creatorUserId, creatorAccountId, role, viewKey: activeView, initialListState = DEFAULT_WORKBENCH_LIST_STATE, initialPersonalOptions = DEFAULT_PERSONAL_OPTIONS, initialPriorityMode = '' }: {
  nodeId: string; creatorUserId: string; creatorAccountId: number; role: string; viewKey: ViewKey; initialListState?: WorkbenchListState; initialPersonalOptions?: PersonalOptions; initialPriorityMode?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeDefinition = WORKBENCH_VIEWS.find((view) => view.key === activeView)!;
  const isAllJobs = activeView === 'ALL_JOBS';
  const defaultCreatedDate = useMemo(() => shanghaiCalendarDate(), []);
  const canUseQueryPackageFilter = role !== 'USER';
  const executorColumnLabel = activeView === 'IMAGE_WORK' ? '生图执行机' : '文案执行机';
  const confirm = useConfirmDialog();
  const requestText = useTextInputDialog();
  const [tasks, setTasks] = useState<DistributedTask[]>([]);
  const [total, setTotal] = useState(0);
  const [nodes, setNodes] = useState<ExecutorNode[]>([]);
  const [page, setPage] = useState(initialListState.page);
  const [pageSize, setPageSize] = useState(initialListState.pageSize);
  const [resultOffset, setResultOffset] = useState(0);
  const [searchInput, setSearchInput] = useState(initialListState.query);
  const [searchKeyword, setSearchKeyword] = useState(initialListState.query);
  const [queryPackageInput, setQueryPackageInput] = useState(
    canUseQueryPackageFilter ? initialListState.queryPackageName : '',
  );
  const [queryPackageName, setQueryPackageName] = useState(
    canUseQueryPackageFilter ? initialListState.queryPackageName : '',
  );
  const [sort, setSort] = useState<TaskSort>(initialListState.sort);
  const [priorityMode, setPriorityMode] = useState(initialPriorityMode);
  const [deduplicateQuery, setDeduplicateQuery] = useState(initialListState.deduplicateQuery);
  const [creatorRoleFilter, setCreatorRoleFilter] = useState(initialListState.createdByRole);
  const [creatorFilter, setCreatorFilter] = useState<JobCreator | null>(initialListState.createdByUserId
    && initialListState.createdByAccountId && isAllJobs
    ? { id: initialListState.createdByAccountId, username: initialListState.createdByUserId,
        displayName: initialListState.createdByUserId, role: '', status: 'ACTIVE' } : null);
  const [assigneeFilter, setAssigneeFilter] = useState<JobCreator | null>(initialListState.assignedToUserId
    && initialListState.assignedToAccountId && isAllJobs
    ? { id: initialListState.assignedToAccountId, username: initialListState.assignedToUserId,
        displayName: initialListState.assignedToUserId, role: '', status: 'ACTIVE' } : null);
  const [createdDateFrom, setCreatedDateFrom] = useState(
    isAllJobs ? initialListState.createdDateFrom || defaultCreatedDate : '',
  );
  const [createdDateTo, setCreatedDateTo] = useState(
    isAllJobs ? initialListState.createdDateTo || defaultCreatedDate : '',
  );
  const [stateFilter, setStateFilter] = useState(initialListState.state);
  const [personalScope, setPersonalScope] = useState<PersonalTaskScope>(
    activeView === 'PERSONAL' ? initialListState.personalScope : 'ALL',
  );
  const [personalOptions, setPersonalOptions] = useState(initialPersonalOptions);
  const [personalCounts, setPersonalCounts] = useState<Record<string, number> | null>(null);
  const [deliveryHistoryOpen, setDeliveryHistoryOpen] = useState(false);
  const [attentionFilter, setAttentionFilter] = useState<TaskAttention>(initialListState.attention);
  const [fetchError, setFetchError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshRequestId = useRef(0);
  const nodesLoadedAt = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const taskPageCursors = useRef<{ scope: string; values: Map<number, string | null> }>({
    scope: '', values: new Map([[1, null]]),
  });
  const requestedLastPage = useRef<number | null>(null);
  const listStart = useRef<HTMLDivElement | null>(null);
  const scrollAfterPageLoad = useRef(false);
  const leavingWorkbenchView = useRef(false);
  const [queryText, setQueryText] = useState('');
  const [createError, setCreateError] = useState('');
  const queryBatch = useMemo(() => parseQueryBatch(queryText), [queryText]);
  const [imageCount, setImageCount] = useState('auto');
  const [skipCopyReview, setSkipCopyReview] = useState(false);
  const [createAssignee, setCreateAssignee] = useState<JobCreator | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialListState.taskId);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [assignmentTasks, setAssignmentTasks] = useState<DistributedTask[]>([]);
  const [batchAction, setBatchAction] = useState<'RETRY' | 'CANCEL_QUEUE' | 'EXPORT' | 'PERMANENT_DELETE' | null>(null);
  const [deliveryHistoryVersion, setDeliveryHistoryVersion] = useState(0);
  const [duplicateQueryPreview, setDuplicateQueryPreview] = useState<DuplicateQueryDiscardPreview | null>(null);
  const [duplicateQueryRequestId, setDuplicateQueryRequestId] = useState<string | null>(null);
  const [duplicateQueryError, setDuplicateQueryError] = useState('');
  const [duplicateQueryPreviewing, setDuplicateQueryPreviewing] = useState(false);
  const [duplicateQueryDiscarding, setDuplicateQueryDiscarding] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedTaskView[]>([]);
  const [savedViewId, setSavedViewId] = useState(DEFAULT_TASK_VIEW_VALUE);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [savingView, setSavingView] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingTaskId, setActingTaskId] = useState<number | null>(null);
  const [permanentDeleteTask, setPermanentDeleteTask] = useState<DistributedTask | null>(null);
  const [batchPermanentDeleteTasks, setBatchPermanentDeleteTasks] = useState<DistributedTask[]>([]);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [deletionError, setDeletionError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [permanentDeletionLock] = useState(createActionLock);
  const [duplicateQueryCleanupLock] = useState(createActionLock);
  const legacyStateFilterMode = useRef(false);
  const copyReviewBypassAllowed = role === 'ADMIN';
  const effectiveSkipCopyReview = copyReviewBypassAllowed && skipCopyReview;
  const duplicateQueryCleanupBusy = duplicateQueryPreviewing || duplicateQueryDiscarding;
  const currentAdmin = useMemo<JobCreator>(() => ({
    id: creatorAccountId,
    username: creatorUserId,
    displayName: '我',
    role: 'ADMIN',
    status: 'ACTIVE',
  }), [creatorAccountId, creatorUserId]);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++refreshRequestId.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LIST_REFRESH_TIMEOUT_MS);
    activeRequest.current = controller;
    const request = <T,>(path: string) => apiRequest<T>(path, { signal: controller.signal });
    if (!silent) {
      setRefreshing(true);
      setLoading(true);
    }
    try {
      const view = activeDefinition;
      if (view.personalOnly) {
        const search = appendPersonalOptions(new URLSearchParams({
          personalScope, category:stateFilter, query:searchKeyword, page:String(page), pageSize:String(pageSize),
          sort, priorityMode, deduplicateQuery:deduplicateQuery ? '1' : '',
          ...(canUseQueryPackageFilter && queryPackageName ? {queryPackageName} : {}),
        }), personalOptions);
        const taskPage = await request<TaskPage>(apiPath(`/v1/personal-workspace/tasks?${search}`));
        if (!Array.isArray(taskPage.items) || !taskPage.counts || !Number.isSafeInteger(taskPage.total)) throw new Error('个人作业数据格式不完整，请更新中心服务后重试');
        if (requestId !== refreshRequestId.current) return;
        setTasks(taskPage.items); setTotal(taskPage.total); setResultOffset(taskPage.offset); setPersonalCounts(taskPage.counts);
        const lastPage = Math.max(1, Math.ceil(taskPage.total/pageSize));
        if (page > lastPage) setPage(lastPage);
        requestedLastPage.current = null;
        setFetchError(''); setLastUpdatedAt(taskPage.updatedAt || new Date().toISOString());
        return;
      }
      const paginationScope = JSON.stringify([
        activeView, creatorUserId, creatorAccountId, pageSize, creatorFilter?.username,
        creatorFilter?.id, assigneeFilter?.username, assigneeFilter?.id, creatorRoleFilter,
        createdDateFrom, createdDateTo, personalScope, stateFilter, searchKeyword, queryPackageName,
        deduplicateQuery, sort, priorityMode, attentionFilter, role,
      ]);
      if (taskPageCursors.current.scope !== paginationScope) {
        taskPageCursors.current = { scope: paginationScope, values: new Map([[1, null]]) };
        requestedLastPage.current = null;
      }
      const pageCursor = taskPageCursors.current.values.get(page);
      const useLastPage = requestedLastPage.current === page;
      const copyQaReturnedOnly = view.personalOnly && stateFilter === 'copyQaReturned';
      const personalStates = view.personalOnly ? personalStateFilterStates(stateFilter) : null;
      const search = new URLSearchParams(legacyStateFilterMode.current
        ? { limit: '200', offset: '0' }
        : {
            states: (personalStates ?? view.states).join(','),
            limit: String(pageSize),
            offset: String((page - 1) * pageSize),
            includeTotal: 'true',
          });
      if (view.personalOnly) {
        search.set('mine', 'true');
        if (personalScope !== 'ALL') search.set('personalScope', personalScope);
        if (copyQaReturnedOnly) search.set('copyQaReturned', 'true');
      }
      if (view.unassignedOnly) search.set('unassigned', 'true');
      const searchedTaskId = taskIdSearch(searchKeyword);
      if (searchedTaskId) search.set('taskId', String(searchedTaskId));
      else if (searchKeyword) search.set('query', searchKeyword);
      if (canUseQueryPackageFilter && queryPackageName) search.set('queryPackageName', queryPackageName);
      if (deduplicateQuery) search.set('deduplicateQuery', 'true');
      if (pageCursor) search.set('cursor', pageCursor);
      if (useLastPage) search.set('lastPage', 'true');
      if (role === 'ADMIN' && isAllJobs && attentionFilter !== 'NONE') search.set('attention', attentionFilter);
      const { sortBy, sortOrder } = taskSortParams(sort);
      search.set('sortBy', sortBy);
      if (priorityMode) search.set('priorityMode', priorityMode);
      search.set('sortOrder', sortOrder);
      let compatibilityTasks: DistributedTask[] | null = null;
      const taskPageRequest = isAllJobs ? loadAdminTaskPage(request, {
        createdByUserId: creatorFilter?.username,
        createdByAccountId: creatorFilter?.id ?? undefined,
        assignedToUserId: assigneeFilter?.username,
        assignedToAccountId: assigneeFilter?.id ?? undefined,
        createdByRole: creatorRoleFilter === 'ALL' ? undefined : creatorRoleFilter,
        createdDateFrom: createdDateFrom || undefined,
        createdDateTo: createdDateTo || undefined,
        state: stateFilter === 'ALL' ? undefined : stateFilter,
        taskId: searchedTaskId ?? undefined,
        query: searchedTaskId ? undefined : searchKeyword,
        queryPackageName: canUseQueryPackageFilter ? queryPackageName || undefined : undefined,
        deduplicateQuery,
        attention: attentionFilter === 'NONE' ? undefined : attentionFilter,
        sortBy,
        sortOrder,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        ...(pageCursor ? { cursor: pageCursor } : {}),
        ...(useLastPage ? { lastPage: true } : {}),
      }) : request<TaskPage | DistributedTask[]>(apiPath(`/v1/tasks?${search}`))
        .catch(async (caught) => {
          if (!isLegacyTaskStateFilterError(caught)) throw caught;
          legacyStateFilterMode.current = true;
          const compatibilitySearch = new URLSearchParams({ limit: '200', offset: '0' });
          if (view.personalOnly) {
            compatibilitySearch.set('mine', 'true');
            if (personalScope !== 'ALL') compatibilitySearch.set('personalScope', personalScope);
          }
          compatibilityTasks = await request<DistributedTask[]>(apiPath(`/v1/tasks?${compatibilitySearch}`));
          return compatibilityTasks;
        });
      const shouldRefreshNodes = nodesLoadedAt.current === 0
        || Date.now() - nodesLoadedAt.current >= 30_000;
      const [rawTaskPage, nextNodes] = await Promise.all([
        taskPageRequest,
        shouldRefreshNodes ? request<ExecutorNode[]>(apiPath('/v1/nodes')) : Promise.resolve(null),
      ]);
      let taskPage: TaskPage;
      if (Array.isArray(rawTaskPage)) {
        // Older services return arrays. Filter by account explicitly; missing ownership
        // must never fall back to the creating or executing node.
        const legacySearch = new URLSearchParams({ limit: '200', offset: '0' });
        if (view.personalOnly) {
          legacySearch.set('mine', 'true');
          if (personalScope !== 'ALL') legacySearch.set('personalScope', personalScope);
        }
        if (legacyStateFilterMode.current && compatibilityTasks === null) compatibilityTasks = rawTaskPage;
        const legacyTasks = compatibilityTasks
          ?? await request<DistributedTask[]>(apiPath(`/v1/tasks?${legacySearch}`));
        const keyword = searchKeyword.toLocaleLowerCase('zh-CN');
        const packageKeyword = canUseQueryPackageFilter
          ? queryPackageName.toLocaleLowerCase('zh-CN')
          : '';
        const filtered = legacyTasks.filter((task) => (personalStates
          ? matchesPersonalScope(task, personalScope, creatorUserId, creatorAccountId)
            && personalStates.includes(task.state)
          : matchesWorkbenchView(task, view, creatorUserId, creatorAccountId))
          && (!copyQaReturnedOnly
            || task.mandatoryCopyQc === true && task.mandatoryCopyQcOrigin === 'QA_RETURN')
          && matchesAttention(task, attentionFilter)
          && (!keyword || (searchedTaskId ? task.id === searchedTaskId : task.query.toLocaleLowerCase('zh-CN').includes(keyword)))
          && (!packageKeyword || (task.sourceQueryPackageName ?? '').toLocaleLowerCase('zh-CN').includes(packageKeyword)))
          .sort((left, right) => compareTasks(left, right, sort));
        const uniqueTasks = deduplicateQuery ? filtered.filter((task, index, all) => {
          const identity = task.query.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
          return all.findIndex((candidate) => candidate.query.trim().replace(/\s+/gu, ' ')
            .toLocaleLowerCase('zh-CN') === identity) === index;
        }) : filtered;
        taskPage = {
          items: uniqueTasks.slice((page - 1) * pageSize, page * pageSize),
          total: uniqueTasks.length,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        };
      } else {
        taskPage = rawTaskPage;
      }
      if (view.personalOnly && taskPage.items.some((task) => (
        !matchesPersonalScope(task, personalScope, creatorUserId, creatorAccountId)
      ))) {
        throw new Error('中心服务尚未支持个人任务筛选，请更新并重启中心服务。');
      }
      if (view.personalOnly && personalStates && taskPage.items.some((task) => !personalStates.includes(task.state))) {
        throw new Error('中心服务返回了不符合当前状态筛选的作业，请刷新或联系管理员。');
      }
      if (copyQaReturnedOnly && taskPage.items.some((task) => (
        task.mandatoryCopyQc !== true || task.mandatoryCopyQcOrigin !== 'QA_RETURN'
      ))) {
        throw new Error('中心服务尚未支持质检打回筛选，请更新并重启中心服务。');
      }
      if (requestId !== refreshRequestId.current) return;
      setTasks(taskPage.items);
      setTotal(taskPage.total);
      setResultOffset(taskPage.offset);
      if (typeof taskPage.previousCursor === 'string' && page > 1) {
        taskPageCursors.current.values.set(page - 1, taskPage.previousCursor);
      }
      if (typeof taskPage.nextCursor === 'string') {
        taskPageCursors.current.values.set(page + 1, taskPage.nextCursor);
      } else {
        taskPageCursors.current.values.delete(page + 1);
      }
      requestedLastPage.current = null;
      const lastPage = Math.max(1, Math.ceil(taskPage.total / pageSize));
      if (page > lastPage) setPage(lastPage);
      if (nextNodes) {
        setNodes(nextNodes);
        nodesLoadedAt.current = Date.now();
      }
      setFetchError('');
      setLastUpdatedAt(new Date().toISOString());
    } catch (caught) {
      if (requestId === refreshRequestId.current) {
        setFetchError(timedOut ? '任务读取超时，请重试' : caught instanceof Error ? caught.message : '任务读取失败');
      }
    } finally {
      window.clearTimeout(timeoutId);
      controller.abort();
      if (requestId === refreshRequestId.current) {
        activeRequest.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeDefinition, creatorUserId, creatorAccountId, page, pageSize, isAllJobs, creatorFilter,
    assigneeFilter, creatorRoleFilter, createdDateFrom, createdDateTo, personalScope, stateFilter, searchKeyword, queryPackageName,
    deduplicateQuery, sort, priorityMode, attentionFilter, role, canUseQueryPackageFilter, personalOptions]);

  useEffect(() => {
    if (leavingWorkbenchView.current) return;
    const search = workbenchListSearch({
      page,
      pageSize: pageSize as WorkbenchListState['pageSize'],
      query: searchKeyword,
      queryPackageName: canUseQueryPackageFilter ? queryPackageName : '',
      sort,
      deduplicateQuery,
      createdByUserId: isAllJobs ? creatorFilter?.username ?? '' : '',
      createdByAccountId: isAllJobs ? creatorFilter?.id ?? null : null,
      assignedToUserId: isAllJobs ? assigneeFilter?.username ?? '' : '',
      assignedToAccountId: isAllJobs ? assigneeFilter?.id ?? null : null,
      createdByRole: isAllJobs ? creatorRoleFilter : 'ALL',
      createdDateFrom: isAllJobs ? createdDateFrom : '',
      createdDateTo: isAllJobs ? createdDateTo : '',
      personalScope: activeView === 'PERSONAL' ? personalScope : 'ALL',
      state: activeView === 'PERSONAL' || isAllJobs ? stateFilter : 'ALL',
      attention: isAllJobs ? attentionFilter : 'NONE',
      taskId: selectedTaskId,
    }, { includeAdminFilters: role === 'ADMIN' && isAllJobs });
    if (activeView === 'PERSONAL') {
      appendPersonalOptions(search, personalOptions);
      search.set('personalScope', personalScope);
      if (priorityMode) search.set('priorityMode', priorityMode);
    }
    const href = search.size ? `${pathname}?${search}` : pathname;
    if (`${window.location.pathname}${window.location.search}` !== href) {
      if (activeView === 'PERSONAL') window.history.replaceState(null, '', href);
      else router.replace(href, { scroll: false });
    }
  }, [activeView, assigneeFilter, attentionFilter, creatorFilter, creatorRoleFilter, createdDateFrom, createdDateTo, deduplicateQuery, isAllJobs,
    page, pageSize, pathname, queryPackageName, role, router, searchKeyword, selectedTaskId, sort, stateFilter,
    canUseQueryPackageFilter, personalScope, personalOptions, priorityMode]);

  useEffect(() => {
    if (activeView !== 'PERSONAL') return;
    const restore = () => {
      const input = Object.fromEntries(new URLSearchParams(window.location.search));
      const options = parsePersonalOptions(input);
      const filters = normalizePersonalFilters({ ...input,...options });
      setPersonalOptions(options); setPersonalScope(filters.personalScope as PersonalTaskScope);
      setStateFilter(filters.category); setPage(filters.page); setPageSize(filters.pageSize as WorkbenchListState['pageSize']);
      setSearchInput(filters.query); setSearchKeyword(filters.query); setSort(filters.sort as TaskSort);
      setPriorityMode(filters.priorityMode); setDeduplicateQuery(filters.deduplicateQuery);
      setQueryPackageInput(filters.queryPackageName); setQueryPackageName(filters.queryPackageName); setSelectedTaskId(filters.taskId);
    };
    window.addEventListener('popstate',restore);
    return () => window.removeEventListener('popstate',restore);
  },[activeView]);

  useEffect(() => activeView === 'PERSONAL' ? subscribeWorkspaceUpdates(()=>void refresh({silent:true})) : undefined,[activeView,refresh]);

  const loadSavedViews = useCallback(async () => {
    if (role !== 'ADMIN') return;
    try {
      const views = await apiRequest<SavedTaskView[]>(apiPath('/v1/task-views'));
      if (!Array.isArray(views)) throw new Error('中心服务返回的常用视图数据无效');
      setSavedViews(views);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '常用视图读取失败');
    }
  }, [role]);

  useEffect(() => { void loadSavedViews(); }, [loadSavedViews]);

  useEffect(() => {
    void refresh();
    const refreshVisible = () => {
      if (document.visibilityState === 'visible' && !activeRequest.current) void refresh({ silent: true });
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      refreshRequestId.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (!loading && !fetchError && scrollAfterPageLoad.current) {
      scrollAfterPageLoad.current = false;
      listStart.current?.scrollIntoView({ block: 'start' });
    }
  }, [loading, fetchError, tasks]);

  const visibleTasks = tasks;

  useEffect(() => {
    const visibleIds = new Set(tasks.map((task) => task.id));
    setSelectedTaskIds((current) => current.filter((taskId) => visibleIds.has(taskId)));
  }, [tasks]);

  const selectedTasks = useMemo(() => {
    const selected = new Set(selectedTaskIds);
    return visibleTasks.filter((task) => selected.has(task.id));
  }, [selectedTaskIds, visibleTasks]);
  const assignmentEligibleTasks = selectedTasks.filter(canManageTaskAssignment);
  const retryableTasks = selectedTasks.filter((task) => ['COPY_RUNNING', 'COPY_FAILED', 'IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state));
  const queuedTasks = selectedTasks.filter((task) => ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state));
  const operatorDeliveryMode = role === 'USER' && activeView === 'PERSONAL';
  const canOperatorDeliverTask = (task: DistributedTask) => operatorDeliveryMode
    && task.canOpen !== false && task.state === 'REVIEWED' && (task.deliveryStatus === 'READY' || task.personalWork?.categories.includes('ready'))
    && isTaskAssignee(task, creatorUserId, creatorAccountId);
  const exportableTasks = selectedTasks.filter((task) => task.state === 'REVIEWED'
    && (task.deliveryStatus === 'READY' || task.personalWork?.categories.includes('ready'))
    && (role === 'ADMIN' || canOperatorDeliverTask(task)));
  const selectionCandidates = role === 'ADMIN'
    ? visibleTasks.filter(task => task.canOpen !== false) : operatorDeliveryMode ? visibleTasks.filter(canOperatorDeliverTask) : [];
  const showTaskSelection = role === 'ADMIN' || operatorDeliveryMode;
  const permanentlyDeletableTasks = selectedTasks.filter(isPermanentlyDeletableTask);
  const permanentDeletionSettlingTasks = selectedTasks.filter((task) => task.state === 'CANCELLED'
    && ['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.cancelledFromState || '')
    && !isPermanentlyDeletableTask(task));
  const availableSavedViews = savedViews.filter((view) => view.viewKey === activeView);
  const allVisibleSelected = selectionCandidates.length > 0
    && selectionCandidates.every((task) => selectedTaskIds.includes(task.id));

  const hasFilters = Boolean(searchInput || searchKeyword
    || canUseQueryPackageFilter && (queryPackageInput || queryPackageName)
    || deduplicateQuery || creatorFilter || assigneeFilter || creatorRoleFilter !== 'ALL'
    || createdDateFrom || createdDateTo
    || personalScope !== 'ALL'
    || stateFilter !== 'ALL' || attentionFilter !== 'NONE' || priorityMode
    || activeView === 'PERSONAL' && JSON.stringify(personalOptions) !== JSON.stringify(DEFAULT_PERSONAL_OPTIONS));
  const searchScopeLabel = [
    searchKeyword ? `Query“${searchKeyword}”` : '',
    canUseQueryPackageFilter && queryPackageName ? `词包“${queryPackageName}”` : '',
  ].filter(Boolean).join('、');

  function currentSavedFilters(): SavedTaskView['filters'] {
    return {
      query: searchKeyword,
      queryPackageName: canUseQueryPackageFilter ? queryPackageName : '',
      sort,
      deduplicateQuery,
      createdByUserId: isAllJobs ? creatorFilter?.username ?? '' : '',
      createdByAccountId: isAllJobs ? creatorFilter?.id ?? null : null,
      assignedToUserId: isAllJobs ? assigneeFilter?.username ?? '' : '',
      assignedToAccountId: isAllJobs ? assigneeFilter?.id ?? null : null,
      createdByRole: isAllJobs ? creatorRoleFilter : 'ALL',
      createdDateFrom: isAllJobs ? createdDateFrom : '',
      createdDateTo: isAllJobs ? createdDateTo : '',
      personalScope: activeView === 'PERSONAL' ? personalScope : 'ALL',
      state: activeView === 'PERSONAL' || isAllJobs ? stateFilter : 'ALL',
      attention: isAllJobs ? attentionFilter : 'NONE',
      pageSize: pageSize as WorkbenchListState['pageSize'],
    };
  }

  function applyDefaultView() {
    setSearchInput(DEFAULT_WORKBENCH_LIST_STATE.query);
    setSearchKeyword(DEFAULT_WORKBENCH_LIST_STATE.query);
    setQueryPackageInput(DEFAULT_WORKBENCH_LIST_STATE.queryPackageName);
    setQueryPackageName(DEFAULT_WORKBENCH_LIST_STATE.queryPackageName);
    setSort(DEFAULT_WORKBENCH_LIST_STATE.sort);
    setDeduplicateQuery(DEFAULT_WORKBENCH_LIST_STATE.deduplicateQuery);
    setCreatorRoleFilter(DEFAULT_WORKBENCH_LIST_STATE.createdByRole);
    setCreatorFilter(null);
    setAssigneeFilter(null);
    setCreatedDateFrom(isAllJobs ? defaultCreatedDate : DEFAULT_WORKBENCH_LIST_STATE.createdDateFrom);
    setCreatedDateTo(isAllJobs ? defaultCreatedDate : DEFAULT_WORKBENCH_LIST_STATE.createdDateTo);
    setPersonalScope(DEFAULT_WORKBENCH_LIST_STATE.personalScope);
    setStateFilter(DEFAULT_WORKBENCH_LIST_STATE.state);
    setAttentionFilter(DEFAULT_WORKBENCH_LIST_STATE.attention);
    setPageSize(DEFAULT_WORKBENCH_LIST_STATE.pageSize);
    setPage(DEFAULT_WORKBENCH_LIST_STATE.page);
    setSelectedTaskId(DEFAULT_WORKBENCH_LIST_STATE.taskId);
    setSavedViewId(DEFAULT_TASK_VIEW_VALUE);
    setMessage('已恢复默认视图。');
    setError('');
  }

  function applySavedView(view: SavedTaskView) {
    setSearchInput(view.filters.query);
    setSearchKeyword(view.filters.query);
    setQueryPackageInput(view.filters.queryPackageName ?? '');
    setQueryPackageName(view.filters.queryPackageName ?? '');
    setSort(view.filters.sort);
    setDeduplicateQuery(view.filters.deduplicateQuery);
    setCreatorRoleFilter(isAllJobs ? view.filters.createdByRole : 'ALL');
    setCreatorFilter(isAllJobs && view.filters.createdByUserId && view.filters.createdByAccountId
      ? { id: view.filters.createdByAccountId, username: view.filters.createdByUserId,
          displayName: view.filters.createdByUserId === creatorUserId ? '我' : view.filters.createdByUserId,
          role: '', status: 'ACTIVE' }
      : null);
    setAssigneeFilter(isAllJobs && view.filters.assignedToUserId && view.filters.assignedToAccountId
      ? { id: view.filters.assignedToAccountId, username: view.filters.assignedToUserId,
          displayName: view.filters.assignedToUserId === creatorUserId ? '我' : view.filters.assignedToUserId,
          role: '', status: 'ACTIVE' }
      : null);
    setCreatedDateFrom(isAllJobs ? view.filters.createdDateFrom ?? '' : '');
    setCreatedDateTo(isAllJobs ? view.filters.createdDateTo ?? '' : '');
    setPersonalScope(activeView === 'PERSONAL' ? view.filters.personalScope ?? 'ALL' : 'ALL');
    setStateFilter(activeView === 'PERSONAL' || isAllJobs ? view.filters.state : 'ALL');
    setAttentionFilter(isAllJobs ? view.filters.attention : 'NONE');
    setPageSize(view.filters.pageSize);
    setPage(1);
    setSavedViewId(String(view.id));
    setMessage(view.filters.createdByUserId && !view.filters.createdByAccountId
      || view.filters.assignedToUserId && !view.filters.assignedToAccountId
      ? `已应用常用视图“${view.name}”；旧版人员筛选已失效，请重新选择对应人员。`
      : `已应用常用视图“${view.name}”。`);
    setError('');
  }

  async function saveCurrentView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = saveViewName.replace(/\s+/gu, ' ').trim();
    if (!name || savingView) return;
    setSavingView(true);
    try {
      const saved = await apiRequest<SavedTaskView>(apiPath('/v1/task-views'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, viewKey: activeView, filters: currentSavedFilters() }),
      });
      await loadSavedViews();
      setSavedViewId(String(saved.id));
      setSaveViewName('');
      setSaveViewOpen(false);
      setMessage(`常用视图“${saved.name}”已保存；同名视图会自动更新。`);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '常用视图保存失败');
    } finally {
      setSavingView(false);
    }
  }

  async function deleteSavedView() {
    const view = savedViews.find((item) => String(item.id) === savedViewId);
    if (!view || !await confirm({
      title: `删除常用视图“${view.name}”？`,
      description: '只会删除保存的筛选组合，不会影响任何任务。',
      confirmLabel: '删除视图',
      tone: 'danger',
    })) return;
    try {
      await apiRequest(apiPath(`/v1/task-views/${view.id}`), { method: 'DELETE' });
      setSavedViewId('');
      await loadSavedViews();
      setMessage(`常用视图“${view.name}”已删除。`);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '常用视图删除失败');
    }
  }

  function showMyFailedTasks() {
    setCreatorFilter({ id: creatorAccountId, username: creatorUserId, displayName: '我', role: role, status: 'ACTIVE' });
    setAssigneeFilter(null);
    setCreatorRoleFilter('ALL');
    setStateFilter('ALL');
    setAttentionFilter('FAILED');
    setPage(1);
    setSavedViewId('');
  }

  function toggleTaskSelection(taskId: number, checked: boolean) {
    setSelectedTaskIds((current) => checked
      ? current.includes(taskId) ? current : [...current, taskId]
      : current.filter((id) => id !== taskId));
  }

  function closeDuplicateQueryPreview() {
    if (duplicateQueryCleanupBusy || duplicateQueryCleanupLock.isLocked()) return;
    setDuplicateQueryPreview(null);
    setDuplicateQueryRequestId(null);
    setDuplicateQueryError('');
  }

  async function previewDuplicateQueries(representativeTaskIds = selectedTasks.map((task) => task.id)) {
    if (role !== 'ADMIN' || activeView !== 'ALL_JOBS' || !deduplicateQuery
      || representativeTaskIds.length === 0 || !duplicateQueryCleanupLock.acquire()) return;
    const replacingPreview = duplicateQueryPreview !== null;
    setDuplicateQueryPreviewing(true);
    setDuplicateQueryRequestId(null);
    setDuplicateQueryError('');
    if (!replacingPreview) {
      setMessage('');
      setError('');
    }
    try {
      const nextPreview = await duplicateQueryCleanupRequest<unknown>(
        '/v1/tasks/duplicate-query-discard-preview',
        { representativeTaskIds },
      );
      if (!isDuplicateQueryDiscardPreview(nextPreview)
        || !sameTaskIds(nextPreview.representativeTaskIds, representativeTaskIds)) {
        throw new Error('预览内容不完整，请刷新列表后重试');
      }
      setDuplicateQueryPreview(nextPreview);
      setDuplicateQueryRequestId(createRequestId());
      setDuplicateQueryError('');
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : '暂时无法读取重复项';
      if (replacingPreview) {
        setDuplicateQueryError(`重新预览失败：${detail}。原预览仍保留，请稍后再次重新预览。`);
      } else {
        setError(`重复项预览失败：${detail}`);
      }
    } finally {
      duplicateQueryCleanupLock.release();
      setDuplicateQueryPreviewing(false);
    }
  }

  async function discardDuplicateQueries() {
    const preview = duplicateQueryPreview;
    const requestId = duplicateQueryRequestId;
    if (!preview || !requestId || preview.summary.discardableCount === 0
      || duplicateQueryDiscarding || !duplicateQueryCleanupLock.acquire()) return;
    setDuplicateQueryDiscarding(true);
    setDuplicateQueryError('');
    try {
      const result = await duplicateQueryCleanupRequest<unknown>('/v1/tasks/duplicate-query-discard', {
        requestId,
        representativeTaskIds: preview.representativeTaskIds,
        previewFingerprint: preview.previewFingerprint,
        confirmedDiscardCount: preview.summary.discardableCount,
      });
      const expectedDiscardedTaskIds = preview.groups.flatMap((group) => group.discardable.map((task) => task.id));
      const expectedKeeperTaskIds = [...new Set(preview.groups
        .filter((group) => group.discardable.length > 0 && group.keeper !== null)
        .map((group) => group.keeper!.id))];
      if (!isDuplicateQueryDiscardResult(result)
        || result.requestId !== requestId
        || !sameTaskIds(result.discardedTaskIds, expectedDiscardedTaskIds)
        || !sameTaskIds(result.keeperTaskIds, expectedKeeperTaskIds)
        || result.skippedCount !== preview.summary.skippedCount) {
        throw new Error('处理结果不完整，暂时无法确认是否已经完成');
      }
      const handledRepresentativeIds = new Set(preview.representativeTaskIds);
      setSelectedTaskIds((current) => current.filter((id) => !handledRepresentativeIds.has(id)));
      setDuplicateQueryPreview(null);
      setDuplicateQueryRequestId(null);
      setDuplicateQueryError('');
      setMessage(`重复 Query 处理完成：已废弃 ${result.discardedCount} 条，保留 ${result.keeperTaskIds.length} 条，跳过 ${result.skippedCount} 条。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      if (caught instanceof DuplicateQueryCleanupRequestError && caught.status === 409) {
        setDuplicateQueryError(`任务状态已经变化，本次没有执行废弃。${caught.message}。预览已保留，请重新预览后再确认。`);
      } else {
        const detail = caught instanceof Error ? caught.message : '请求未完成';
        setDuplicateQueryError(`暂时无法确认处理结果：${detail}。预览已保留；可以再次确认，或重新预览核对最新状态。`);
      }
    } finally {
      duplicateQueryCleanupLock.release();
      setDuplicateQueryDiscarding(false);
    }
  }

  async function runBatchAction(action: 'RETRY' | 'CANCEL_QUEUE', eligible: DistributedTask[]) {
    if (eligible.length === 0 || batchAction) return;
    const retry = action === 'RETRY';
    if (!await confirm({
      title: retry ? `批量重试 ${eligible.length} 条任务？` : `废弃 ${eligible.length} 条排队任务？`,
      description: retry
        ? '仅处理当前所选的执行中或失败任务；正在执行的旧流程会作废，并按文案或图片阶段重新排队。'
        : '任务会立即退出文案或生图队列并标记为已废弃；数据仍会保留，之后可以永久删除或重新排队。',
      confirmLabel: retry ? '批量重试' : '批量废弃',
      ...(retry ? {} : { tone: 'danger' as const }),
    })) return;
    setBatchAction(action);
    try {
      const result = await apiRequest<BatchActionResult>(apiPath('/v1/tasks/batch-actions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, taskIds: eligible.map((task) => task.id) }),
      });
      setSelectedTaskIds((current) => current.filter((id) => !result.succeeded.includes(id)));
      const label = retry ? '重试' : '废弃';
      setMessage(`批量${label}完成：成功 ${result.succeeded.length} 条${result.failed.length ? `，未处理 ${result.failed.length} 条` : ''}。`);
      setError(result.failed.length ? result.failed.map((item) => `#${item.id}：${item.message}`).join('；') : '');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批量操作失败');
    } finally {
      setBatchAction(null);
    }
  }

  async function exportSelectedTasks() {
    const maximum = role === 'USER' ? 200 : 20;
    if (exportableTasks.length === 0 || exportableTasks.length > maximum || batchAction) return;
    setBatchAction('EXPORT');
    try {
      const operatorDelivery = role === 'USER';
      const response = await fetch(apiPath(operatorDelivery
        ? '/v1/delivery-pool/archive' : '/v1/tasks/batch-archive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operatorDelivery
          ? { scope: 'SELECTED', taskIds: exportableTasks.map((task) => task.id) }
          : { taskIds: exportableTasks.map((task) => task.id) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `导出失败（${response.status}）`);
      }
      if (operatorDelivery) {
        const prepared = normalizePreparedDeliveryExport(await response.json().catch(() => null));
        const link = document.createElement('a');
        link.href = apiPath(`/v1/delivery-pool/archive/${encodeURIComponent(prepared.downloadId)}`);
        link.download = prepared.fileName;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        setSelectedTaskIds([]);
        setDeliveryHistoryVersion((current) => current + 1);
        window.setTimeout(() => setDeliveryHistoryVersion((current) => current + 1), 1500);
        setMessage(`${prepared.batchCode ? `交付批次 ${prepared.batchCode}` : '交付包'}已创建并开始下载；文件交给接收方后，请在“我的交付记录”中确认已交付。`);
        await refresh({ silent: true });
      } else {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = '批量作业资源.zip';
        link.click();
        URL.revokeObjectURL(url);
        setMessage(`已导出 ${exportableTasks.length} 条任务的资源包。`);
      }
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批量导出失败');
    } finally {
      setBatchAction(null);
    }
  }

  function clearFilters() {
    setPersonalOptions(DEFAULT_PERSONAL_OPTIONS);
    setPriorityMode('');
    setSearchInput('');
    setSearchKeyword('');
    setQueryPackageInput('');
    setQueryPackageName('');
    setDeduplicateQuery(false);
    setCreatorFilter(null);
    setAssigneeFilter(null);
    setCreatorRoleFilter('ALL');
    setPersonalScope(activeView === 'PERSONAL' ? 'ASSIGNED' : 'ALL');
    setStateFilter('ALL');
    setAttentionFilter('NONE');
    setSavedViewId('');
    setPage(1);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearchKeyword(searchInput.trim());
    setQueryPackageName(canUseQueryPackageFilter
      ? queryPackageInput.replace(/\s+/gu, ' ').trim()
      : '');
  }

  function clearSearch() {
    setSearchInput('');
    setSearchKeyword('');
    setQueryPackageInput('');
    setQueryPackageName('');
    setPage(1);
  }

  async function retryCopy(task: DistributedTask) {
    if (!['COPY_RUNNING', 'COPY_FAILED'].includes(task.state)) return;
    if (!await confirm({
      title: '重新生成这条文案？',
      description: '任务会回到共享文案队列，使用最新提示词、知识库和生产配置，等待任一有空闲容量的执行机领取。正在进行的旧执行将作废。',
      confirmLabel: '重试',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest<DistributedTask>(apiPath(`/v1/tasks/${task.id}/retry`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLatestConfig: true }),
      });
      setMessage(`任务 #${task.id} 已回到共享文案队列，等待空闲执行机领取。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新生成文案失败');
    } finally {
      setActingTaskId(null);
    }
  }

  async function adminDirectApproveCopyQa(task: DistributedTask) {
    if (role !== 'ADMIN' || task.state !== 'COPY_QC_PENDING') return;
    const note = await requestText({
      title: '填写质检通过原因',
      description: '本次说明将写入质检记录，作为管理员单独通过当前文案的审计依据。',
      label: '通过原因（必填）',
      placeholder: '请说明当前文案符合质检要求的具体依据',
      confirmLabel: '填写完成，继续',
      maxLength: 1_000,
    });
    if (!note) return;
    if (!await confirm({
      title: '单独通过这条文案质检？',
      description: '本次通过当前已抽中的文案。仍须等待该人员批次的全部质检与强制复检完成；系统记录通过原因。',
      confirmLabel: '记录质检通过',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest<DistributedTask>(apiPath(`/v1/tasks/${task.id}/admin-direct-copy-qa`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: createRequestId(),
          note,
          expectedCopyRevisionId: task.currentCopyRevisionId,
        }),
      });
      setMessage(`任务 #${task.id} 已记录文案质检通过，批次关卡全部完成后进入生图。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '单独通过文案质检失败');
    } finally {
      setActingTaskId(null);
    }
  }

  async function resumeImages(task: DistributedTask) {
    if (!canResumeImageTask(task)) return;
    if (!await confirm({
      title: '从失败步骤继续生图？',
      description: '沿用已审核文案和原配置，复用已完成的规划、图片与检查点，只继续未完成步骤。原执行机离线时需等待其恢复；检查点缺失会明确报错。',
      confirmLabel: '继续未完成步骤',
    })) return;
    setActingTaskId(task.id);
    try {
      await resumeImageTask(task.id);
      setMessage(`任务 #${task.id} 已等待原执行机从失败步骤继续。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '断点续跑提交失败');
    } finally { setActingTaskId(null); }
  }

  async function retryImages(task: DistributedTask) {
    if (!canRequeueImages(task)) return;
    if (!await confirm({
      title: '重新生成这组图片？',
      description: '正在执行的生图任务会立即作废；系统将保留历史记录，清除旧恢复快照，并使用已审核文案重新进入全局待生图队列。',
      confirmLabel: '重试生图',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest<DistributedTask>(apiPath(`/v1/tasks/${task.id}/retry-image`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      setMessage(`任务 #${task.id} 已进入待生图队列，等待图片执行机领取。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新生成图片失败');
    } finally {
      setActingTaskId(null);
    }
  }

  async function discardTask(task: DistributedTask) {
    if (['COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE'].includes(task.state)) {
      setSelectedTaskId(task.id);
      return;
    }
    if (!await confirm({
      title: '废弃这条笔记创作？',
      description: '任务会被标记为已废弃并从工作台列表隐藏，历史文案、执行记录和图片仍会保留。',
      confirmLabel: '确认废弃',
      tone: 'danger',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest(apiPath(`/v1/tasks/${task.id}/cancel`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      setMessage(`任务 #${task.id} 已废弃。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '废弃任务失败');
    } finally {
      setActingTaskId(null);
    }
  }

  async function discardQueuedTask(task: DistributedTask) {
    if (!['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state)) return;
    if (!await confirm({
      title: '废弃这条排队任务？',
      description: '任务会立即退出队列并标记为已废弃，但保留全部数据。管理员之后可以从废弃池恢复任务。',
      confirmLabel: '确认废弃',
      tone: 'danger',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest(apiPath(`/v1/tasks/${task.id}/cancel`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      setMessage(`任务 #${task.id} 已废弃；管理员可从废弃池恢复任务。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '废弃排队任务失败');
    } finally { setActingTaskId(null); }
  }

  async function restoreCancelledTask(task: DistributedTask) {
    if (role !== 'ADMIN' || task.state !== 'CANCELLED') return;
    if (!await confirm({ title: '从废弃池恢复任务？',
      description: '保留历史文案、图片和审核记录，根据现有内容恢复到待执行、待审核或图片返修。恢复后需要重新审核和质检；待执行任务将由空闲执行机领取。',
      confirmLabel: '确认恢复' })) return;
    setActingTaskId(task.id);
    try {
      const restored = await apiRequest<DistributedTask>(apiPath(`/v1/tasks/${task.id}/restore`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: task.updatedAt }),
      });
      setMessage(`任务 #${task.id} 已恢复到“${STATE_LABELS[restored.state]}”。`);
      setSelectedTaskIds(current => current.filter(id => id !== task.id));
      setError(''); await refresh({ silent: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : '恢复任务失败'); } finally { setActingTaskId(null); }
  }

  async function permanentlyDeleteTask() {
    const task = permanentDeleteTask;
    const password = deletionPassword;
    if (!task || !password || !permanentDeletionLock.acquire()) return;
    let refreshPage: number | null = null;
    setActingTaskId(task.id);
    try {
      const result = await apiRequest<{ id: number; deleted: boolean; cleanupPending?: boolean }>(apiPath(`/v1/tasks/${task.id}/permanent`), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletionPassword: password }),
      });
      setMessage(result.cleanupPending
        ? `任务 #${task.id} 已删除；素材已隔离，中心服务将继续清理。`
        : `任务 #${task.id} 及其关联数据已永久删除。`);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      const nextTotal = Math.max(0, total - 1);
      const nextPage = Math.min(page, Math.max(1, Math.ceil(nextTotal / pageSize)));
      setTotal(nextTotal);
      setPage(nextPage);
      refreshPage = nextPage;
      setSelectedTaskIds((current) => current.filter((id) => id !== task.id));
      setError('');
      setDeletionError('');
      setDeletionPassword('');
      setPermanentDeleteTask(null);
    } catch (caught) {
      setDeletionError(caught instanceof Error ? caught.message : '永久删除失败');
      setDeletionPassword('');
    } finally {
      permanentDeletionLock.release();
      setActingTaskId(null);
    }
    if (refreshPage === page) await refresh({ silent: true });
  }

  async function permanentlyDeleteSelectedTasks() {
    const tasksToDelete = batchPermanentDeleteTasks;
    const password = deletionPassword;
    if (!tasksToDelete.length || tasksToDelete.length > 20 || !password || batchAction || !permanentDeletionLock.acquire()) return;
    let refreshPage: number | null = null;
    setBatchAction('PERMANENT_DELETE');
    try {
      const result = await apiRequest<BatchPermanentDeleteResult>(apiPath('/v1/tasks/batch-permanent-delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds: tasksToDelete.map((task) => task.id),
          deletionPassword: password,
        }),
      });
      const succeeded = new Set(result.succeeded);
      setTasks((current) => current.filter((task) => !succeeded.has(task.id)));
      const nextTotal = Math.max(0, total - result.succeeded.length);
      const nextPage = Math.min(page, Math.max(1, Math.ceil(nextTotal / pageSize)));
      setTotal(nextTotal);
      setPage(nextPage);
      refreshPage = nextPage;
      setSelectedTaskIds((current) => current.filter((id) => !result.succeeded.includes(id)));
      setMessage(`批量永久删除完成：成功 ${result.succeeded.length} 条${result.cleanupPending.length ? `，其中 ${result.cleanupPending.length} 条素材正在后台清理` : ''}${result.failed.length ? `，未删除 ${result.failed.length} 条` : ''}。`);
      setError(result.failed.length ? result.failed.map((item) => `#${item.id}：${item.message}`).join('；') : '');
      setDeletionError('');
      setDeletionPassword('');
      setBatchPermanentDeleteTasks([]);
    } catch (caught) {
      setDeletionError(caught instanceof Error ? caught.message : '批量永久删除失败');
      setDeletionPassword('');
    } finally {
      permanentDeletionLock.release();
      setBatchAction(null);
    }
    if (refreshPage === page) await refresh({ silent: true });
  }

  function taskActions(task: DistributedTask) {
    if (task.canOpen === false) return <span className="muted">历史记录 · 无当前详情权限</span>;
    const busy = actingTaskId === task.id;
    const queued = ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state);
    const currentUserIsAssignee = isTaskAssignee(task, creatorUserId, creatorAccountId);
    const canHandleAssignedImages = ['ADMIN', 'USER'].includes(role) && currentUserIsAssignee;
    const canPermanentlyDelete = role === 'ADMIN' && isPermanentlyDeletableTask(task);
    const visibleActionCount = role === 'ADMIN' && activeView !== 'UNASSIGNED' ? 2 : 1;
    const assignmentButton = role === 'ADMIN' && canManageTaskAssignment(task) && <Button unstyled className="button small" type="button"
      disabled={busy} onClick={() => setAssignmentTasks([task])}><UserRound size={14} />{task.assignedToUserId === null ? '分配' : '改派'}</Button>;
    const permanentDeleteButton = canPermanentlyDelete && <Button unstyled className="button small danger" type="button" disabled={busy || Boolean(batchAction) || batchPermanentDeleteTasks.length > 0} onClick={() => { setDeletionError(''); setDeletionPassword(''); setPermanentDeleteTask(task); }}><Trash2 size={14} />永久删除</Button>;
    const restoreButton = role === 'ADMIN' && task.state === 'CANCELLED'
      && <Button unstyled className="button small primary" type="button" disabled={busy || Boolean(batchAction)}
        onClick={() => { void restoreCancelledTask(task); }}><RotateCcw size={14} />恢复任务</Button>;
    const directCopyQaButton = role === 'ADMIN' && task.state === 'COPY_QC_PENDING'
      && <Button unstyled className="button small primary" type="button" disabled={busy}
        onClick={() => { void adminDirectApproveCopyQa(task); }}
        title="管理员单独审核通过，不等待整批完成">
        <ShieldCheck size={14} />单独通过质检
      </Button>;
    const allJobsDetailButton = canHandleAssignedImages && task.state === 'MANUAL_ARCHIVE'
      ? <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />图片初审</Button>
      : canHandleAssignedImages && task.state === 'IMAGE_REWORK_PENDING'
        ? <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><RotateCcw size={14} />返修图片</Button>
        : <Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>;
    if (isAllJobs) return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      {directCopyQaButton}
      {allJobsDetailButton}
      {restoreButton}
      {['COPY_RUNNING', 'COPY_FAILED'].includes(task.state) && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {queued && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardQueuedTask(task); }}><Trash2 size={14} />废弃</Button>}
      {permanentDeleteButton}
    </TaskRowActions>;
    const hasOwnerControl = role === 'ADMIN' || isTaskAssignee(task, creatorUserId, creatorAccountId);
    const creatorCanControlMachineCopy = taskOwnerId(task) === null
      && isTaskCreator(task, creatorUserId, creatorAccountId)
      && ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'].includes(task.state);
    const canDiscard = (hasOwnerControl || creatorCanControlMachineCopy) && task.state !== 'CANCELLED';
    const canDiscardQueue = role === 'ADMIN' && queued;
    const canRetryCopy = (hasOwnerControl || creatorCanControlMachineCopy)
      && ['COPY_RUNNING', 'COPY_FAILED'].includes(task.state);
    const canRetryImages = hasOwnerControl && task.state !== 'MANUAL_ARCHIVE' && canRequeueImages(task);
    const retryImageButton = <Button unstyled
      className="button small"
      type="button"
      disabled={busy || !canRetryImages}
      title={canRetryImages ? '重新进入待生图队列'
        : task.state === 'MANUAL_ARCHIVE' ? '请进入审核，完成图片评分后选择重试生图'
          : isImageRetryExhausted(task) ? '生图重试已用尽，请进入详情修改文案并提交强制复检'
          : '文案尚未审核通过，暂不能重试生图'}
      onClick={() => { void retryImages(task); }}
    ><RotateCcw size={14} />重试生图</Button>;
    if (activeView === 'ALL_COPY') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      {directCopyQaButton}
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canRetryCopy && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {canDiscard && !['COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE'].includes(task.state) && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
      {permanentDeleteButton}
    </TaskRowActions>;
    if (activeView === 'COPY_REVIEW') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      {taskOwnerId(task) === null
        ? <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
        : <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</Button>}
      {permanentDeleteButton}
    </TaskRowActions>;
    if (activeView === 'IMAGE_WORK') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canDiscardQueue && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardQueuedTask(task); }}><Trash2 size={14} />废弃</Button>}
      {retryImageButton}
      {permanentDeleteButton}
    </TaskRowActions>;
    if (task.state === 'REVIEWED') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>{assignmentButton}<Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>{permanentDeleteButton}</TaskRowActions>;
    if (task.state === 'MANUAL_ARCHIVE') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      <Button unstyled className={`button small ${canHandleAssignedImages ? 'primary' : ''}`} type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />{canHandleAssignedImages ? '图片初审' : '查看'}</Button>
    </TaskRowActions>;
    if (task.state === 'IMAGE_REWORK_PENDING') return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      <Button unstyled className={`button small ${canHandleAssignedImages ? 'primary' : ''}`} type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><RotateCcw size={14} />{canHandleAssignedImages ? '返修图片' : '查看返修'}</Button>
    </TaskRowActions>;
    return <TaskRowActions taskId={task.id} busy={busy} visibleActionCount={visibleActionCount}>
      {assignmentButton}
      {directCopyQaButton}
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canDiscardQueue && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardQueuedTask(task); }}><Trash2 size={14} />废弃</Button>}
      {restoreButton}
      {permanentDeleteButton}
      {canDiscard && canResumeImageTask(task) && <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => { void resumeImages(task); }}><RotateCcw size={14} />从失败步骤继续</Button>}
      {activeView === 'PERSONAL' && canRetryCopy && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {activeView === 'PERSONAL' && retryImageButton}
      {canDiscard && !canDiscardQueue && !['COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE'].includes(task.state) && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
    </TaskRowActions>;
  }

  function resetCreateForm() {
    setQueryText('');
    setCreateError('');
    setImageCount('auto');
    setSkipCopyReview(false);
    setCreateAssignee(null);
  }

  async function createTasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (role !== 'ADMIN') {
      setCreateError('标注不能直接创建作业。');
      return;
    }
    const { queries, error: validationError } = queryBatch;
    if (validationError) {
      setCreateError(validationError);
      return;
    }
    let assignmentFields: { assignedToUserId?: string | null; assignedToAccountId?: number | null };
    try {
      assignmentFields = createAssignmentFields({
        role,
        mode: effectiveSkipCopyReview ? CREATE_ASSIGNMENT_MODES.MANUAL : CREATE_ASSIGNMENT_MODES.UNASSIGNED,
        assigneeUserId: createAssignee?.username ?? null,
        assigneeAccountId: createAssignee?.id ?? null,
      });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '任务分配方式无效');
      return;
    }
    setCreating(true);
    setCreateError('');
    setError('');
    setMessage('');
    try {
      await apiRequest(apiPath('/v1/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          skipCopyReview: effectiveSkipCopyReview,
          ...assignmentFields,
          tasks: queries.map((query) => ({
            query,
            input: {},
            imageCount: imageCount === 'auto' ? 'auto' : Number(imageCount),
          })),
        }),
      });
      resetCreateForm();
      setCreateOpen(false);
      setPage(1);
      setSearchInput('');
      setSearchKeyword('');
      setQueryPackageInput('');
      setQueryPackageName('');
      if (role !== 'ADMIN' && activeView !== 'PERSONAL') {
        leavingWorkbenchView.current = true;
        router.push('/workbench/personal');
      }
      const assignmentMessage = effectiveSkipCopyReview && createAssignee
        ? `免审任务已由 ${createAssignee.displayName}（${createAssignee.username}）负责，文案生成后自动进入生图队列。`
        : '已进入文案生成队列，文案完成后再分配审核负责人。';
      setMessage(`已创建 ${queries.length} 条笔记。${assignmentMessage}`);
      await refresh({ silent: true });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '笔记创建失败');
    } finally {
      setCreating(false);
    }
  }


  return <div className="creation-workbench">
    <TaskAssignmentDialog
      tasks={assignmentTasks}
      open={assignmentTasks.length > 0}
      currentAdmin={currentAdmin}
      onOpenChange={(open) => { if (!open) setAssignmentTasks([]); }}
      onAssigned={async (notice) => {
        setMessage(notice);
        setError('');
        setSelectedTaskIds([]);
        await refresh({ silent: true });
      }}
    />
    <PermanentDeleteDialog
      tasks={permanentDeleteTask ? [permanentDeleteTask] : []}
      batch={false}
      password={deletionPassword}
      error={deletionError}
      busy={Boolean(actingTaskId) || batchAction === 'PERMANENT_DELETE'}
      onPasswordChange={(value) => { setDeletionPassword(value); if (deletionError) setDeletionError(''); }}
      onCancel={() => { setPermanentDeleteTask(null); setDeletionPassword(''); setDeletionError(''); }}
      onConfirm={() => { void permanentlyDeleteTask(); }}
    />
    <PermanentDeleteDialog
      tasks={batchPermanentDeleteTasks}
      batch
      password={deletionPassword}
      error={deletionError}
      busy={batchAction === 'PERMANENT_DELETE' || Boolean(actingTaskId)}
      onPasswordChange={(value) => { setDeletionPassword(value); if (deletionError) setDeletionError(''); }}
      onCancel={() => { setBatchPermanentDeleteTasks([]); setDeletionPassword(''); setDeletionError(''); }}
      onConfirm={() => { void permanentlyDeleteSelectedTasks(); }}
    />
    <DuplicateQueryDiscardDialog
      preview={duplicateQueryPreview}
      error={duplicateQueryError}
      previewing={duplicateQueryPreviewing}
      discarding={duplicateQueryDiscarding}
      requestReady={Boolean(duplicateQueryRequestId)}
      onClose={closeDuplicateQueryPreview}
      onConfirm={() => { void discardDuplicateQueries(); }}
      onRepreview={() => {
        if (duplicateQueryPreview) void previewDuplicateQueries(duplicateQueryPreview.representativeTaskIds);
      }}
    />
    {activeView === 'PERSONAL' && <PersonalTaskControls
      options={personalOptions} onChange={value => { setPersonalOptions(value); setPage(1); }}
      category={stateFilter} onCategory={value => { setStateFilter(value); setPage(1); }}
      scope={personalScope} onScope={value => { setPersonalScope(value); setPage(1); }}
      counts={personalCounts} onDelivery={operatorDeliveryMode ? () => setDeliveryHistoryOpen(true) : undefined}
    />}
    {operatorDeliveryMode && <Dialog open={deliveryHistoryOpen} onOpenChange={setDeliveryHistoryOpen}>
      <DialogContent className={personalStyles.deliveryDialog}><DialogTitle>我的交付记录</DialogTitle>
        <DialogDescription>查看下载记录并确认交付。</DialogDescription>
        {deliveryHistoryOpen && <OperatorDeliveryHistory refreshKey={deliveryHistoryVersion} />}
      </DialogContent>
    </Dialog>}
    <section className="panel workbench-task-panel">
      <div className="workbench-toolbar">
        <div>
          <span className="section-kicker">Task lifecycle</span>
          <h2>{activeDefinition.label}</h2>
          <p>{activeDefinition.description}</p>
        </div>
        <div className="workbench-toolbar-actions">
          <Button unstyled className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} aria-hidden="true" size={14} />刷新
          </Button>
          {role === 'ADMIN' && <Dialog open={createOpen} onOpenChange={(open) => {
            if (creating) return;
            if (open) {
              void refresh({ silent: true });
            }
            setCreateOpen(open);
          }}>
            <DialogTrigger asChild>
              <Button unstyled className="button primary" type="button"><Plus aria-hidden="true" size={16} />创建笔记</Button>
            </DialogTrigger>
            <DialogContent className="workbench-create-dialog">
              <div className="workbench-create-heading">
                <span className="section-kicker">Create notes</span>
                <DialogTitle>创建 Query 作业</DialogTitle>
                <DialogDescription>
                  可同时录入多条 Query。任务先进入共享文案队列；文案生成完成后，系统才会分配审核负责人。
                </DialogDescription>
              </div>
              <form className="workbench-create-form" onSubmit={createTasks}>
                <div className="field">
                  <label htmlFor="workbench-query-text">笔记选题（Query）</label>
                  <Textarea
                    className="textarea workbench-query-textarea"
                    id="workbench-query-text"
                    value={queryText}
                    onChange={(event) => { setQueryText(event.target.value); setCreateError(''); }}
                    placeholder={'例如：\n租房桌面收纳\n通勤穿搭，周末露营装备'}
                    rows={7}
                    disabled={creating}
                    required
                    autoFocus
                    aria-describedby="workbench-query-help workbench-query-validation"
                    aria-invalid={Boolean(queryText && queryBatch.error)}
                  />
                  <p className="workbench-query-help" id="workbench-query-help">每行一条，或用中文逗号（，）、英文逗号（,）分隔。空白项自动忽略；最多 100 条，每条不超过 500 个字符。</p>
                  <div id="workbench-query-validation" aria-live="polite">
                    {queryText && queryBatch.error && <p className="workbench-query-validation">{queryBatch.error}</p>}
                  </div>
                </div>
                {createError && <div className="notice error" role="alert">{createError}</div>}
                <div className="workbench-create-options">
                  <div className="field">
                    <label htmlFor="workbench-image-count">配图页数</label>
                    <Select value={imageCount} onValueChange={setImageCount} disabled={creating}>
                      <SelectTrigger id="workbench-image-count"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动（3–5 页）</SelectItem>
                        <SelectItem value="3">3 页</SelectItem>
                        <SelectItem value="4">4 页</SelectItem>
                        <SelectItem value="5">5 页</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {role === 'ADMIN' && <div className="field">
                  <label className="switch-field" htmlFor="workbench-skip-copy-review">
                    <Checkbox id="workbench-skip-copy-review" checked={effectiveSkipCopyReview}
                      disabled={creating || !copyReviewBypassAllowed}
                      aria-describedby="workbench-skip-copy-review-help"
                      onChange={(event) => {
                        setSkipCopyReview(event.target.checked);
                        if (!event.target.checked) setCreateAssignee(null);
                        setCreateError('');
                      }} />
                    <span>免人工文案审核，直接生图</span>
                  </label>
                  <p className="workbench-query-help" id="workbench-skip-copy-review-help">
                    免审任务不会经过文案派单节点，因此必须现在明确指定负责人；普通任务会在文案生成完成后自动派单。
                  </p>
                </div>}
                {role === 'ADMIN' && effectiveSkipCopyReview && <JobUserPicker
                  value={createAssignee}
                  label="免审任务负责人"
                  triggerId="workbench-create-assignee"
                  emptyLabel="请选择负责人"
                  dialogTitle="选择免审任务负责人"
                  dialogDescription="可选择已启用的质检或标注，也可由当前管理员自己负责；其他管理员不可选。"
                  roleLabels={CREATOR_ROLE_LABELS}
                  eligibleRoles={['REVIEWER', 'USER']}
                  additionallyEligibleUserIds={[creatorAccountId]}
                  activeOnly
                  allowEmptyOption={false}
                  disabled={creating}
                  onChange={(value) => { setCreateAssignee(value); setCreateError(''); }}
                />}
                <div className="workbench-create-footer">
                  <span aria-live="polite">已识别 {queryBatch.queries.length} 条 Query。{effectiveSkipCopyReview
                    ? '指定负责人后将按免审流程执行。'
                    : '文案执行不需要负责人，生成完成后再进入审核派单。'}</span>
                  <div>
                    <DialogClose asChild><Button unstyled className="button" type="button" disabled={creating}>取消</Button></DialogClose>
                    <Button unstyled className="button primary" type="submit"
                      disabled={creating || Boolean(queryBatch.error) || (effectiveSkipCopyReview && !createAssignee)}>
                      {creating ? <><LoaderCircle className="animate-spin" size={16} />正在创建…</> : <>创建并加入队列</>}
                    </Button>
                  </div>
                </div>
              </form>
            </DialogContent>
          </Dialog>}
        </div>
      </div>

      {isAllJobs && <AdminJobFilters
        role={creatorRoleFilter}
        state={stateFilter}
        creator={creatorFilter}
        assignee={assigneeFilter}
        createdDateFrom={createdDateFrom}
        createdDateTo={createdDateTo}
        stateLabels={STATE_LABELS}
        onCreatorChange={(value) => { setCreatorFilter(value); setPage(1); }}
        onAssigneeChange={(value) => { setAssigneeFilter(value); setPage(1); }}
        onRoleChange={(value) => { setCreatorRoleFilter(value); setPage(1); }}
        onStateChange={(value) => { setStateFilter(value); setPage(1); }}
        onCreatedDateFromChange={(value) => {
          setCreatedDateFrom(value);
          if (value && createdDateTo && value > createdDateTo) setCreatedDateTo(value);
          setPage(1);
        }}
        onCreatedDateToChange={(value) => {
          setCreatedDateTo(value);
          if (value && createdDateFrom && value < createdDateFrom) setCreatedDateFrom(value);
          setPage(1);
        }}
      />}
      {role === 'ADMIN' && <div className="workbench-admin-list-controls">
        {role === 'ADMIN' && <div className="workbench-saved-views">
          <span>常用视图</span>
          <Select value={savedViewId || undefined} onValueChange={(value) => {
            if (value === DEFAULT_TASK_VIEW_VALUE) {
              applyDefaultView();
              return;
            }
            const view = savedViews.find((item) => String(item.id) === value);
            if (view) applySavedView(view);
          }}>
            <SelectTrigger aria-label="选择常用筛选视图"><SelectValue placeholder="当前筛选" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_TASK_VIEW_VALUE}>默认视图</SelectItem>
              {availableSavedViews.map((view) => <SelectItem key={view.id} value={String(view.id)}>{view.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Dialog open={saveViewOpen} onOpenChange={(open) => { if (!savingView) { setSaveViewOpen(open); if (open) setSaveViewName(''); } }}>
            <DialogTrigger asChild><Button unstyled className="button small" type="button"><Save size={14} />保存当前视图</Button></DialogTrigger>
            <DialogContent className="workbench-save-view-dialog">
              <DialogTitle>保存常用筛选视图</DialogTitle>
              <DialogDescription>保存当前列表的搜索、筛选、排序和每页条数。使用同名名称会更新原视图。</DialogDescription>
              <form onSubmit={saveCurrentView}>
                <div className="field"><label htmlFor="workbench-view-name">视图名称</label><Input id="workbench-view-name" value={saveViewName} maxLength={50} autoFocus required placeholder="例如：我的失败任务" onChange={(event) => setSaveViewName(event.target.value)} /></div>
                <div className="profile-form-actions"><Button unstyled className="button" type="button" disabled={savingView} onClick={() => setSaveViewOpen(false)}>取消</Button><Button unstyled className="button primary" type="submit" disabled={savingView || !saveViewName.trim()}>{savingView ? '保存中…' : '保存视图'}</Button></div>
              </form>
            </DialogContent>
          </Dialog>
          {savedViewId && savedViewId !== DEFAULT_TASK_VIEW_VALUE && <Button unstyled className="button small danger" type="button" onClick={() => { void deleteSavedView(); }}>删除视图</Button>}
        </div>}
        {isAllJobs && <div className="workbench-attention-entry" aria-label="异常任务集中处理">
          <span><AlertTriangle size={15} />集中处理</span>
          <Button unstyled className="button small" type="button" aria-pressed={attentionFilter === 'ANOMALY'} onClick={() => { setAttentionFilter(attentionFilter === 'ANOMALY' ? 'NONE' : 'ANOMALY'); setPage(1); }}>全部异常</Button>
          <Button unstyled className="button small" type="button" aria-pressed={attentionFilter === 'STALE'} onClick={() => { setAttentionFilter(attentionFilter === 'STALE' ? 'NONE' : 'STALE'); setPage(1); }}>长期无进度</Button>
          <Button unstyled className="button small" type="button" aria-pressed={attentionFilter === 'FAILED'} onClick={() => { setAttentionFilter(attentionFilter === 'FAILED' ? 'NONE' : 'FAILED'); setPage(1); }}>失败任务</Button>
          <Button unstyled className="button small" type="button" onClick={showMyFailedTasks}>我的失败任务</Button>
        </div>}
      </div>}
      <div className="workbench-list-tools">
        <form className="workbench-query-search" role="search" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="workbench-query-search">搜索 Query 关键词或 Query ID</label>
          <SearchInput
            id="workbench-query-search"
            value={searchInput}
            maxLength={500}
            placeholder="Query 关键词或 #ID（如 #1024）"
            onValueChange={(value) => setSearchInput(value)}
          />
          {canUseQueryPackageFilter && <>
            <label className="sr-only" htmlFor="workbench-query-package-search">搜索词包名称</label>
            <SearchInput
              id="workbench-query-package-search"
              value={queryPackageInput}
              maxLength={200}
              placeholder="词包名称"
              onValueChange={(value) => setQueryPackageInput(value)}
            />
          </>}
          {(searchKeyword || canUseQueryPackageFilter && queryPackageName) && <Button unstyled className="button small" type="button" onClick={clearSearch}>清除</Button>}
          <Button unstyled className="button small" type="submit">搜索</Button>
        </form>
        <div className="workbench-sort-control">
          <div className="workbench-sort-field">
            <label htmlFor="workbench-priority-filter">优先级来源 / 调整</label>
            <Select value={priorityMode || "ALL"} onValueChange={value => { setPriorityMode(value === "ALL" ? "" : value); setPage(1); }}><SelectTrigger id="workbench-priority-filter"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="ALL">全部优先级</SelectItem><SelectItem value="SYSTEM">跟随系统</SelectItem>
              <SelectItem value="HIGHEST">最高优先</SelectItem><SelectItem value="HIGH">高优先</SelectItem>
              <SelectItem value="NORMAL">普通</SelectItem><SelectItem value="DEFER">暂缓</SelectItem><SelectItem value="PAUSE">暂停</SelectItem>
            </SelectContent></Select>
          </div>
          <div className="workbench-sort-field">
            <label htmlFor="workbench-task-sort">排序</label>
            <Select value={sort} onValueChange={(value) => { setSort(value as TaskSort); setPage(1); }}>
              <SelectTrigger id="workbench-task-sort"><SelectValue /></SelectTrigger>
              <SelectContent>{activeView === 'PERSONAL' && <SelectItem value="waiting:desc">待处理等待最长</SelectItem>}{TASK_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <label className="switch-field workbench-query-deduplicate" htmlFor="workbench-query-deduplicate">
          <Checkbox
            id="workbench-query-deduplicate"
            checked={deduplicateQuery}
            onChange={(event) => { setDeduplicateQuery(event.target.checked); setPage(1); }}
          />
          <span>按 Query 去重</span>
        </label>
        <span>{lastUpdatedAt
          ? deduplicateQuery
            ? `去重后 ${total} 个 Query${searchScopeLabel ? ` · 匹配${searchScopeLabel}` : ''}`
            : `共 ${total} 条${searchScopeLabel ? ` · 匹配${searchScopeLabel}` : ''}`
          : '尚未读取任务'}</span>
        {hasFilters && <Button unstyled className="button small" type="button" onClick={clearFilters}>清空筛选</Button>}
      </div>

      {fetchError && <div className="notice error workbench-refresh-notice" role="alert">
        <div>刷新失败：{fetchError}{lastUpdatedAt && ' 以下保留上次成功读取的数据，可能不符合当前筛选或最新状态。'}</div>
        <Button unstyled className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>重新读取</Button>
      </div>}
      {lastUpdatedAt && <p className="workbench-updated-at" role="status">{loading ? `正在读取第 ${page} 页，暂时保留上次结果…` : `最近成功刷新：${timeLabel(lastUpdatedAt)} · 每 30 秒自动刷新`}</p>}

        {operatorDeliveryMode && selectedTasks.length > 0 && <div className="workbench-batch-actions" role="region" aria-label="标注交付操作">
          <strong>已选 {selectedTasks.length} 条（当前页）</strong>
          <Button unstyled className="button small primary" type="button"
            title={exportableTasks.length > 200 ? '单次最多交付 200 条，请减少选择' : '仅可交付本人负责且已进入交付池的作业'}
            disabled={Boolean(batchAction) || exportableTasks.length === 0 || exportableTasks.length > 200}
            onClick={() => { void exportSelectedTasks(); }}><PackageCheck size={14} />创建交付包 {exportableTasks.length}</Button>
          <Button unstyled className="button small" type="button" disabled={Boolean(batchAction)} onClick={() => setSelectedTaskIds([])}>清除选择</Button>
          {batchAction && <span role="status">正在创建并校验交付包…</span>}
        </div>}

        {role === 'ADMIN' && selectedTasks.length > 0 && <div className="workbench-batch-actions" role="region" aria-label="批量任务操作">
          <strong>已选 {selectedTasks.length} 条（当前页）</strong>
          <TaskPriorityControl tasks={selectedTasks} onChanged={() => refresh()} />
        {role === 'ADMIN' && activeView === 'ALL_JOBS' && deduplicateQuery && selectedTasks.length > 0 && <Button
          unstyled className="button small" type="button" disabled={Boolean(batchAction) || duplicateQueryCleanupBusy}
          title="先查看每个 Query 将保留、废弃和跳过哪些任务"
          onClick={() => { void previewDuplicateQueries(); }}><Eye size={14} />预览重复项</Button>}
        <Button unstyled className="button small primary" type="button"
          disabled={Boolean(batchAction) || duplicateQueryCleanupBusy || assignmentEligibleTasks.length === 0}
          title={assignmentEligibleTasks.length === 0 ? '所选任务尚未进入可派单阶段' : '分配或改派可处理的任务'}
          onClick={() => setAssignmentTasks(assignmentEligibleTasks)}><UserRound size={14} />批量分配/改派 {assignmentEligibleTasks.length}</Button>
        <Button unstyled className="button small" type="button" disabled={Boolean(batchAction) || duplicateQueryCleanupBusy || retryableTasks.length === 0} onClick={() => { void runBatchAction('RETRY', retryableTasks); }}><RotateCcw size={14} />重试 {retryableTasks.length}</Button>
        <Button unstyled className="button small danger" type="button" disabled={Boolean(batchAction) || duplicateQueryCleanupBusy || queuedTasks.length === 0} onClick={() => { void runBatchAction('CANCEL_QUEUE', queuedTasks); }}><Trash2 size={14} />废弃排队中 {queuedTasks.length}</Button>
        <Button unstyled className="button small danger" type="button" title={permanentlyDeletableTasks.length > 20 ? '单次最多永久删除 20 条，请减少选择' : permanentDeletionSettlingTasks.length ? '所选任务仍在等待执行机停止，废弃满 3 分钟后可永久删除' : '仅永久删除已失败、已审核或已废弃且执行已停止的任务'} disabled={Boolean(batchAction) || duplicateQueryCleanupBusy || Boolean(actingTaskId) || Boolean(permanentDeleteTask) || permanentlyDeletableTasks.length === 0 || permanentlyDeletableTasks.length > 20} onClick={() => { setDeletionError(''); setDeletionPassword(''); setBatchPermanentDeleteTasks(permanentlyDeletableTasks); }}><Trash2 size={14} />永久删除 {permanentlyDeletableTasks.length}</Button>
        <Button unstyled className="button small" type="button" title={exportableTasks.length > 20 ? '单次最多导出 20 条，请减少选择' : '仅可导出已进入交付池的任务'} disabled={Boolean(batchAction) || duplicateQueryCleanupBusy || exportableTasks.length === 0 || exportableTasks.length > 20} onClick={() => { void exportSelectedTasks(); }}><Download size={14} />导出 {exportableTasks.length}</Button>
        <Button unstyled className="button small" type="button" disabled={Boolean(batchAction) || duplicateQueryCleanupBusy} onClick={() => setSelectedTaskIds([])}>清除选择</Button>
        {permanentDeletionSettlingTasks.length > 0 && <span role="status">{permanentDeletionSettlingTasks.length} 条仍在等待执行停止，废弃满 3 分钟后可删除</span>}
        {batchAction && <span role="status">正在处理…</span>}
        {duplicateQueryPreviewing && <span role="status">正在核对重复项…</span>}
      </div>}

      {loading && !lastUpdatedAt
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取中心任务…</div>
        : fetchError && !lastUpdatedAt ? <div className="empty-state">暂时无法读取任务，请重试。</div>
        : visibleTasks.length === 0
          ? <div className="workbench-empty">
            <span>{isAllJobs || hasFilters ? '没有符合当前筛选条件的作业。' : activeView === 'PERSONAL'
              ? '当前没有符合所选归属和状态的个人作业。'
              : `当前没有${activeDefinition.label}任务。`}</span>
            {activeView === 'PERSONAL' && role === 'ADMIN'
              && <Button unstyled className="button small" type="button" onClick={() => setCreateOpen(true)}><Plus size={14} />创建第一条笔记</Button>}
          </div>
          : <div ref={listStart} className="table-wrap mobile-cards workbench-table-wrap" tabIndex={0} role="region" aria-label="作业列表，可横向滚动查看完整列" aria-busy={loading} inert={loading}>
            <table>
              <thead><tr>{showTaskSelection && <th className="workbench-col-select"><Checkbox aria-label="选择当前页全部任务中的可交付项" checked={allVisibleSelected} disabled={selectionCandidates.length === 0} onChange={(event) => setSelectedTaskIds(event.target.checked ? selectionCandidates.map((task) => task.id) : [])} /></th>}<th className="workbench-col-query">作业 / Query</th><th className="workbench-col-creator">负责人 / 创建人</th><th className="workbench-col-progress">状态 / 进度</th><th className="workbench-col-executor">执行机</th><th className="workbench-col-time">{isAllJobs ? '变更 / 创建 / 耗时' : '创建 / 开始 / 耗时'}</th><th className="workbench-col-actions">操作</th></tr></thead>
              <tbody>{visibleTasks.map((task) => <tr key={task.id}>
                {showTaskSelection && <td className="workbench-col-select" data-label="选择"><Checkbox aria-label={`选择任务 #${task.id}`} checked={selectedTaskIds.includes(task.id)} disabled={role === 'USER' && !canOperatorDeliverTask(task)} title={role === 'USER' && !canOperatorDeliverTask(task) ? '仅可交付本人负责且已完成的作业' : undefined} onChange={(event) => toggleTaskSelection(task.id, event.target.checked)} /></td>}
                <td className="query-cell workbench-col-query" data-label="作业 / Query">
                  <div className="workbench-cell-stack">
                    <span className="mono workbench-task-id">#{task.id}</span>
                    <Button unstyled className="workbench-query-preview workbench-text-preview" type="button" disabled={task.canOpen === false} title={task.query} aria-label={`查看作业 #${task.id}：${task.query}`} onClick={() => setSelectedTaskId(task.id)}>{task.query}</Button>
                    {role !== 'USER' && <small className="workbench-text-preview" title={task.sourceQueryPackageName || '未归属词包'}>词包：{task.sourceQueryPackageName || '未归属词包'}</small>}
                  </div>
                </td>
                <td className="workbench-col-creator" data-label="负责人 / 创建人"><div className="workbench-cell-stack">
                  <span className={`workbench-text-preview${!task.assignedToUserId && task.state === 'COPY_REVIEW_PENDING' ? ' pill pill-rejected' : ''}`}
                    title={assignmentLabel(task)}>
                    负责人：{assignmentLabel(task)}
                  </span>
                  {task.assignedToUserId && <small className="mono workbench-text-preview" title={task.assignedToUserId}>{task.assignedToUserId}</small>}
                  <small className="workbench-text-preview" title={task.createdByDisplayName || task.createdByUserId || '历史任务'}>
                    创建人：{task.createdByDisplayName || task.createdByUserId || '历史任务'}
                  </small>
                  {activeView === 'PERSONAL' && <small className="pill">
                    {task.canOpen === false ? '本人完成历史' : personalOwnershipLabel(task, creatorUserId, creatorAccountId)}
                  </small>}
                  {isAllJobs && <small>{CREATOR_ROLE_LABELS[task.createdByRole || 'UNKNOWN'] || '未知创建者角色'}</small>}
                </div></td>
                <td className="workbench-col-progress" data-label="状态 / 进度">
                  <div className="distributed-progress">
                    {activeView === 'PERSONAL' && <PersonalWorkDetails work={task.personalWork} events={personalOptions.mode !== 'CURRENT' ? task.personalHistory : undefined} />}
                    {task.canOpen === false ? <small>仅展示历史记录</small> : <>
                    <small><PrioritySummary task={task} /></small>
                    {role === 'ADMIN' && <TaskPriorityControl tasks={[task]} onChanged={() => refresh()} />}
                    <span className={`pill ${isImageRetryExhausted(task) ? 'pill-rejected' : `workbench-state-${task.state.toLowerCase()}`}${isStale(task) ? ' pill-rejected' : ''}`}>{isImageRetryExhausted(task) ? IMAGE_RETRY_EXHAUSTED_LABEL : taskStateLabel(task, role)}</span>
                    <span>{stageLabel(task, role)} · {task.state.endsWith('_FAILED') && !task.executionStartedAt && task.progressPercent === 0 ? '进度未记录' : `${task.progressPercent}%`}</span>
                    <small className="workbench-text-preview" title={isStale(task) ? '超过 30 分钟没有进度，请进入详情处理' : taskProgressMessage(task)}>{isStale(task) ? '超过 30 分钟没有进度，请进入详情处理' : taskProgressMessage(task)}</small>
                    </>}
                  </div>
                </td>
                <td className="workbench-col-executor" data-label="执行机"><div className="workbench-cell-stack workbench-executors">
                  <div><small>{executorColumnLabel}</small><span className="mono workbench-text-preview" title={activeView === 'IMAGE_WORK' ? imageExecutorLabel(task) : copyExecutorLabel(task, nodes)}>{activeView === 'IMAGE_WORK' ? imageExecutorLabel(task) : copyExecutorLabel(task, nodes)}</span></div>
                  {(activeView === 'MANUAL_ARCHIVE' || isAllJobs) && <div><small>生图执行机</small><span className="mono workbench-text-preview" title={imageExecutorLabel(task)}>{imageExecutorLabel(task)}</span></div>}
                  {activeView === 'PERSONAL' && (task.state.startsWith('IMAGE_') || task.imageExecutorNodeId || isImageRetryExhausted(task)) && <div><small>生图执行机</small><span className="mono workbench-text-preview" title={imageExecutorLabel(task)}>{imageExecutorLabel(task)}</span></div>}
                </div></td>
                <td className="workbench-col-time" data-label={isAllJobs ? '变更 / 创建 / 耗时' : '创建 / 开始 / 耗时'}><div className="workbench-cell-stack">
                  {isAllJobs
                    ? <><time dateTime={taskLatestActivityAt(task)}>最近变更：{timeLabel(taskLatestActivityAt(task))}</time>
                      <small>创建：<time dateTime={task.createdAt}>{timeLabel(task.createdAt)}</time></small></>
                    : <time dateTime={task.createdAt}>{timeLabel(task.createdAt)}</time>}
                  <small>开始：<time dateTime={task.executionStartedAt || undefined}>{timeLabel(task.executionStartedAt, task.state)}</time></small>
                  <small className="workbench-elapsed"><Clock3 aria-hidden="true" size={13} />本次：{elapsed(task)}</small>
                  {cumulativeImageElapsed(task) && <small className="workbench-elapsed" title="包含同一恢复链中失败运行与续跑的累计图片生产耗时"><Clock3 aria-hidden="true" size={13} />生图累计：{cumulativeImageElapsed(task)}</small>}
                </div></td>
                <td className="workbench-col-actions" data-label="操作">{taskActions(task)}</td>
              </tr>)}</tbody>
            </table>
          </div>}

      {lastUpdatedAt && <WorkbenchPagination page={page} pageSize={pageSize} total={total} offset={resultOffset} count={tasks.length} busy={loading || refreshing}
        loadError={fetchError} onRetry={() => { void refresh(); }}
        onPageChange={(nextPage, intent) => { if (nextPage !== page) {
          requestedLastPage.current = intent === 'last' ? nextPage : null;
          scrollAfterPageLoad.current = true;
          setPage(nextPage);
        } }}
        onPageSizeChange={(size) => { requestedLastPage.current = null; scrollAfterPageLoad.current = true; setPageSize(size as WorkbenchListState['pageSize']); setPage(1); }} />}
    </section>

    <TaskReviewDialog
      taskId={selectedTaskId}
      nodeId={nodeId}
      role={role}
      currentUsername={creatorUserId}
      currentAccountId={creatorAccountId}
      onOpenChange={(open) => { if (!open) setSelectedTaskId(null); }}
      onUpdated={async (notice) => {
        setMessage(notice);
        setError('');
        await refresh({ silent: true });
      }}
    />

    <ToastFeedback id="creation-workbench-feedback" message={message} />
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
