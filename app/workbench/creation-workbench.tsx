'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';

import {
  Clock3,
  Eye,
  FileCheck2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
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

import { apiRequest } from '../components/api-client';
import { resumeImageTask } from '../components/resume-image-task';
import { canResumeImageTask } from '../../src/control-plane/image-resume.mjs';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { parseQueryBatch } from '../../src/control-plane/query-batch.mjs';
import { imageExecutorLabel } from '../../src/control-plane/image-executor-label.mjs';
import { TaskReviewDialog } from './task-review-dialog';
import { TaskRowActions } from './task-row-actions';
import { AdminJobFilters, CREATOR_ROLE_LABELS } from './admin-job-filters';
import type { JobCreator } from './admin-creator-filter';
import { loadAdminTaskPage } from '../../src/control-plane/admin-task-page.mjs';
import { WorkbenchPagination } from './workbench-pagination';
import { PersonalOverview } from '../workbench-statistics/personal-overview';
import { STATE_GROUPS } from '../../src/web-statistics/summary.mjs';
import type { StateGroup } from '../workbench-statistics/types';

import { compareTasksByStatePriority, WORKBENCH_VIEWS, matchesWorkbenchView, type TaskState, type ViewKey } from './views';

type DistributedTask = {
  id: number;
  query: string;
  state: TaskState;
  currentImageRunId: string | null;
  copyExecutorNodeId: string | null;
  imageExecutorNodeId?: string | null;
  imageExecutorNodeName?: string | null;
  currentCopyRevisionId: number | null;
  currentExecutionId?: string | null;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
  createdByRole?: string | null;
  currentStage: string | null;
  progressPercent: number;
  progressMessage: string;
  executionStartedAt: string | null;
  lastActivityAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

type TaskPage = { items: DistributedTask[]; total: number; limit: number; offset: number };

const STATE_LABELS: Record<TaskState, string> = {
  COPY_QUEUED: '待文案执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  MANUAL_ARCHIVE: '人工归档',
  REVIEWED: '已审核',
  CANCELLED: '已废弃',
};

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
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  MANUAL_ARCHIVE: '人工归档',
  REVIEWED: '已审核',
  FAILED: '执行失败',
  CANCELLED: '已废弃',
};

function stageLabel(task: DistributedTask) {
  const label = task.currentStage ? STAGE_LABELS[task.currentStage] ?? STATE_LABELS[task.state] : STATE_LABELS[task.state];
  return task.state.endsWith('_FAILED') && task.currentStage && !['FAILED', task.state].includes(task.currentStage)
    ? `失败阶段：${label}` : label;
}

function copyExecutorLabel(task: DistributedTask, nodes: ExecutorNode[]) {
  if (!task.copyExecutorNodeId) return task.state === 'COPY_QUEUED' ? '待领取' : '—';
  return nodes.find((node) => node.id === task.copyExecutorNodeId)?.name ?? task.copyExecutorNodeId;
}

function canRequeueImages(task: DistributedTask) {
  return task.currentCopyRevisionId !== null
    && (['IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE'].includes(task.state)
      || isImageRetryExhausted(task));
}

const STALE_AFTER_MS = 30 * 60_000;
function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

function isStale(task: DistributedTask) {
  return ['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.state)
    && Boolean(task.lastActivityAt)
    && Date.now() - Date.parse(task.lastActivityAt as string) >= STALE_AFTER_MS;
}

function elapsed(task: DistributedTask) {
  if (!task.executionStartedAt) return '—';
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(task.executionStartedAt)) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function timeLabel(value: string | null, state?: TaskState) {
  if (value) return new Date(value).toLocaleString('zh-CN', { hour12: false });
  return state && !state.endsWith('_QUEUED') ? '开始时间未记录' : '尚未开始';
}

export function CreationWorkbench({ nodeId, creatorUserId, role, viewKey: activeView, initialCreator = '', initialTaskId = null }: {
  nodeId: string; creatorUserId: string; role: string; viewKey: ViewKey; initialCreator?: string; initialTaskId?: number | null;
}) {
  const router = useRouter();
  const activeDefinition = WORKBENCH_VIEWS.find((view) => view.key === activeView)!;
  const isAllJobs = activeView === 'ALL_JOBS';
  const executorColumnLabel = activeView === 'IMAGE_WORK' ? '生图执行机' : '文案执行机';
  const confirm = useConfirmDialog();
  const [tasks, setTasks] = useState<DistributedTask[]>([]);
  const [total, setTotal] = useState(0);
  const [nodes, setNodes] = useState<ExecutorNode[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [resultOffset, setResultOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [deduplicateQuery, setDeduplicateQuery] = useState(false);
  const [creatorRoleFilter, setCreatorRoleFilter] = useState('ALL');
  const [creatorFilter, setCreatorFilter] = useState<JobCreator | null>(initialCreator && isAllJobs
    ? { username: initialCreator, displayName: initialCreator, role: '', status: 'ACTIVE' } : null);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [fetchError, setFetchError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshRequestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const listStart = useRef<HTMLDivElement | null>(null);
  const scrollAfterPageLoad = useRef(false);
  const [queryText, setQueryText] = useState('');
  const [createError, setCreateError] = useState('');
  const queryBatch = useMemo(() => parseQueryBatch(queryText), [queryText]);
  const [imageCount, setImageCount] = useState('auto');
  const [skipCopyReview, setSkipCopyReview] = useState(role === 'ADMIN');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(isAllJobs ? initialTaskId : null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingTaskId, setActingTaskId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const legacyStateFilterMode = useRef(false);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++refreshRequestId.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const request = <T,>(path: string) => apiRequest<T>(path, { signal: controller.signal });
    if (!silent) {
      setRefreshing(true);
      setLoading(true);
    }
    try {
      const view = activeDefinition;
      const personalStates = view.personalOnly ? Object.hasOwn(STATE_GROUPS, stateFilter)
        ? STATE_GROUPS[stateFilter as StateGroup] : Object.values(STATE_GROUPS).flat() : null;
      const search = new URLSearchParams(legacyStateFilterMode.current
        ? { limit: '200', offset: '0' }
        : {
            states: (personalStates ?? view.states).join(','),
            limit: String(pageSize),
            offset: String((page - 1) * pageSize),
            includeTotal: 'true',
          });
      if (view.personalOnly) search.set('mine', 'true');
      if (searchKeyword) search.set('query', searchKeyword);
      if (deduplicateQuery) search.set('deduplicateQuery', 'true');
      let compatibilityTasks: DistributedTask[] | null = null;
      const taskPageRequest = isAllJobs ? loadAdminTaskPage(request, {
        createdByUserId: creatorFilter?.username,
        createdByRole: creatorRoleFilter === 'ALL' ? undefined : creatorRoleFilter,
        state: stateFilter === 'ALL' ? undefined : stateFilter,
        query: searchKeyword,
        deduplicateQuery,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }) : request<TaskPage | DistributedTask[]>(apiPath(`/v1/tasks?${search}`))
        .catch(async (caught) => {
          if (!(caught instanceof Error) || caught.message !== 'task state filter is invalid') throw caught;
          legacyStateFilterMode.current = true;
          const compatibilitySearch = new URLSearchParams({ limit: '200', offset: '0' });
          if (view.personalOnly) compatibilitySearch.set('mine', 'true');
          compatibilityTasks = await request<DistributedTask[]>(apiPath(`/v1/tasks?${compatibilitySearch}`));
          return compatibilityTasks;
        });
      const [rawTaskPage, nextNodes] = await Promise.all([
        taskPageRequest,
        request<ExecutorNode[]>(apiPath('/v1/nodes')),
      ]);
      let taskPage: TaskPage;
      if (Array.isArray(rawTaskPage)) {
        // Older services return arrays. Filter by account explicitly; missing ownership
        // must never fall back to the creating or executing node.
        const legacySearch = new URLSearchParams({ limit: '200', offset: '0' });
        if (view.personalOnly) legacySearch.set('mine', 'true');
        if (legacyStateFilterMode.current && compatibilityTasks === null) compatibilityTasks = rawTaskPage;
        const legacyTasks = compatibilityTasks
          ?? await request<DistributedTask[]>(apiPath(`/v1/tasks?${legacySearch}`));
        const keyword = searchKeyword.toLocaleLowerCase('zh-CN');
        const filtered = legacyTasks.filter((task) => (personalStates
          ? task.createdByUserId === creatorUserId && personalStates.includes(task.state)
          : matchesWorkbenchView(task, view, creatorUserId))
          && (!keyword || task.query.toLocaleLowerCase('zh-CN').includes(keyword)))
          .sort(compareTasksByStatePriority);
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
      if (view.personalOnly && taskPage.items.some((task) => task.createdByUserId !== creatorUserId)) {
        throw new Error('中心服务尚未支持个人任务筛选，请更新并重启中心服务。');
      }
      if (requestId !== refreshRequestId.current) return;
      setTasks(taskPage.items);
      setTotal(taskPage.total);
      setResultOffset(taskPage.offset);
      const lastPage = Math.max(1, Math.ceil(taskPage.total / pageSize));
      if (page > lastPage) setPage(lastPage);
      setNodes(nextNodes);
      setFetchError('');
      setLastUpdatedAt(new Date().toISOString());
    } catch (caught) {
      if (requestId === refreshRequestId.current) {
        setFetchError(caught instanceof Error ? caught.message : '任务读取失败');
      }
    } finally {
      controller.abort();
      if (requestId === refreshRequestId.current) {
        activeRequest.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeDefinition, creatorUserId, page, pageSize, isAllJobs, creatorFilter, creatorRoleFilter, stateFilter, searchKeyword, deduplicateQuery]);

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

  const hasFilters = Boolean(searchInput || searchKeyword || deduplicateQuery || creatorFilter || creatorRoleFilter !== 'ALL' || stateFilter !== 'ALL');

  function clearFilters() {
    setSearchInput('');
    setSearchKeyword('');
    setDeduplicateQuery(false);
    setCreatorFilter(null);
    setCreatorRoleFilter('ALL');
    setStateFilter('ALL');
    setPage(1);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearchKeyword(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput('');
    setSearchKeyword('');
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
    if (!await confirm({
      title: '废弃这条笔记创作？',
      description: '任务会被标记为已废弃并从工作台列表隐藏，历史文案、执行记录和图片仍会保留。',
      confirmLabel: '确认废弃',
      tone: 'danger',
    })) return;
    setActingTaskId(task.id);
    try {
      const imageReview = task.state === 'MANUAL_ARCHIVE' && ['ADMIN', 'REVIEWER'].includes(role);
      await apiRequest(apiPath(imageReview ? `/v1/tasks/${task.id}/review-images` : `/v1/tasks/${task.id}/cancel`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: imageReview ? JSON.stringify({ imageRunId: task.currentImageRunId, decision: 'DISCARD' }) : '{}',
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

  function taskActions(task: DistributedTask) {
    const busy = actingTaskId === task.id;
    if (isAllJobs) return <Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>;
    const canDiscard = role === 'ADMIN' || task.createdByUserId === creatorUserId;
    const canRetryCopy = canDiscard && ['COPY_RUNNING', 'COPY_FAILED'].includes(task.state);
    const canRetryImages = canDiscard && canRequeueImages(task);
    const retryImageButton = <Button unstyled
      className="button small"
      type="button"
      disabled={busy || !canRetryImages}
      title={canRetryImages ? '重新进入待生图队列' : '文案尚未审核通过，暂不能重试生图'}
      onClick={() => { void retryImages(task); }}
    ><RotateCcw size={14} />重试生图</Button>;
    if (activeView === 'ALL_COPY') return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canRetryCopy && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {canDiscard && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
    </TaskRowActions>;
    if (activeView === 'COPY_REVIEW') return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</Button>
      {canDiscard && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
    </TaskRowActions>;
    if (activeView === 'IMAGE_WORK') return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {retryImageButton}
    </TaskRowActions>;
    if (task.state === 'REVIEWED') return <Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>;
    if (task.state === 'MANUAL_ARCHIVE' && ['ADMIN', 'REVIEWER'].includes(role)) return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</Button>
      <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>
    </TaskRowActions>;
    return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canDiscard && canResumeImageTask(task) && <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => { void resumeImages(task); }}><RotateCcw size={14} />从失败步骤继续</Button>}
      {activeView === 'PERSONAL' && canRetryCopy && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {activeView === 'PERSONAL' && retryImageButton}
      {canDiscard && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
    </TaskRowActions>;
  }

  function resetCreateForm() {
    setQueryText('');
    setCreateError('');
    setImageCount('auto');
    setSkipCopyReview(role === 'ADMIN');
  }

  async function createTasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const { queries, error: validationError } = queryBatch;
    if (validationError) {
      setCreateError(validationError);
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
          skipCopyReview: role === 'ADMIN' && skipCopyReview,
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
      if (activeView !== 'PERSONAL') router.push('/workbench/personal');
      setMessage(`已创建 ${queries.length} 条笔记并加入共享文案队列，空闲执行机会按队列顺序领取。${role === 'ADMIN' && skipCopyReview ? '本批次免人工文案审核，文案生成后自动进入生图队列。' : ''}`);
      await refresh({ silent: true });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '笔记创建失败');
    } finally {
      setCreating(false);
    }
  }


  return <div className="creation-workbench">
    {activeView === 'PERSONAL' && <PersonalOverview filter={stateFilter} onFilter={value => { setStateFilter(value); setPage(1); }} />}
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
          <Dialog open={createOpen} onOpenChange={(open) => {
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
                  可同时录入多条 Query。任务归属当前账号，并进入共享队列等待空闲文案执行机领取。
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
                    <Checkbox id="workbench-skip-copy-review" checked={skipCopyReview} disabled={creating}
                      aria-describedby="workbench-skip-copy-review-help"
                      onChange={(event) => setSkipCopyReview(event.target.checked)} />
                    <span>免人工文案审核，直接生图</span>
                  </label>
                  <p className="workbench-query-help" id="workbench-skip-copy-review-help">应用于本批次全部笔记。取消勾选后，文案生成完成会等待人工审核。</p>
                </div>}
                <div className="workbench-create-footer">
                  <span aria-live="polite">已识别 {queryBatch.queries.length} 条 Query，按输入顺序加入队列。</span>
                  <div>
                    <DialogClose asChild><Button unstyled className="button" type="button" disabled={creating}>取消</Button></DialogClose>
                    <Button unstyled className="button primary" type="submit" disabled={creating || Boolean(queryBatch.error)}>
                      {creating ? <><LoaderCircle className="animate-spin" size={16} />正在创建…</> : <>创建并加入队列</>}
                    </Button>
                  </div>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isAllJobs && <AdminJobFilters
        role={creatorRoleFilter}
        state={stateFilter}
        creator={creatorFilter}
        stateLabels={STATE_LABELS}
        onCreatorChange={(value) => { setCreatorFilter(value); setPage(1); }}
        onRoleChange={(value) => { setCreatorRoleFilter(value); setPage(1); }}
        onStateChange={(value) => { setStateFilter(value); setPage(1); }}
      />}
      <div className="workbench-list-tools">
        <form className="workbench-query-search" role="search" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="workbench-query-search">搜索 Query</label>
          <SearchInput
            id="workbench-query-search"
            value={searchInput}
            maxLength={500}
            placeholder="按 Query 关键字搜索"
            onValueChange={(value) => setSearchInput(value)}
          />
          {searchKeyword && <Button unstyled className="button small" type="button" onClick={clearSearch}>清除</Button>}
          <Button unstyled className="button small" type="submit">搜索</Button>
        </form>
        <label className="switch-field workbench-query-deduplicate" htmlFor="workbench-query-deduplicate">
          <Checkbox
            id="workbench-query-deduplicate"
            checked={deduplicateQuery}
            onChange={(event) => { setDeduplicateQuery(event.target.checked); setPage(1); }}
          />
          <span>按 Query 去重</span>
        </label>
        <span>{lastUpdatedAt ? `共 ${total} 条${deduplicateQuery ? '（已按 Query 去重）' : ''}${searchKeyword ? `匹配“${searchKeyword}”` : ''}` : '尚未读取任务'}</span>
        {hasFilters && <Button unstyled className="button small" type="button" onClick={clearFilters}>清空筛选</Button>}
      </div>

      {fetchError && <div className="notice error workbench-refresh-notice" role="alert">
        <div>刷新失败：{fetchError}{lastUpdatedAt && ' 以下保留上次成功读取的数据，可能不符合当前筛选或最新状态。'}</div>
        <Button unstyled className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>重新读取</Button>
      </div>}
      {lastUpdatedAt && <p className="workbench-updated-at" role="status">{loading ? `正在读取第 ${page} 页，暂时保留上次结果…` : `最近成功刷新：${timeLabel(lastUpdatedAt)} · 每 30 秒自动刷新`}</p>}

      {loading && !lastUpdatedAt
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取中心任务…</div>
        : fetchError && !lastUpdatedAt ? <div className="empty-state">暂时无法读取任务，请重试。</div>
        : visibleTasks.length === 0
          ? <div className="workbench-empty">
            <span>{isAllJobs || hasFilters ? '没有符合当前筛选条件的作业。' : activeView === 'PERSONAL' ? '当前没有你创建的 Query 任务。' : `当前没有${activeDefinition.label}任务。`}</span>
            {activeView === 'PERSONAL' && <Button unstyled className="button small" type="button" onClick={() => setCreateOpen(true)}><Plus size={14} />创建第一条笔记</Button>}
          </div>
          : <div ref={listStart} className="table-wrap mobile-cards workbench-table-wrap" tabIndex={0} role="region" aria-label="作业列表，可横向滚动查看完整列" aria-busy={loading} inert={loading}>
            <table>
              <thead><tr><th className="workbench-col-query">作业 / Query</th><th className="workbench-col-creator">作业员</th><th className="workbench-col-progress">状态 / 进度</th><th className="workbench-col-executor">执行机</th><th className="workbench-col-time">开始时间 / 耗时</th><th className="workbench-col-actions">操作</th></tr></thead>
              <tbody>{visibleTasks.map((task) => <tr key={task.id}>
                <td className="query-cell" data-label="作业 / Query">
                  <div className="workbench-cell-stack">
                    <span className="mono workbench-task-id">#{task.id}</span>
                    <Button unstyled className="workbench-query-preview workbench-text-preview" type="button" title={task.query} aria-label={`查看作业 #${task.id}：${task.query}`} onClick={() => setSelectedTaskId(task.id)}>{task.query}</Button>
                  </div>
                </td>
                <td data-label="作业员"><div className="workbench-cell-stack">
                  <span className="workbench-text-preview" title={task.createdByDisplayName || task.createdByUserId || '历史任务'}>{task.createdByDisplayName || task.createdByUserId || '历史任务'}</span>
                  {task.createdByUserId && <small className="mono workbench-text-preview" title={task.createdByUserId}>{task.createdByUserId}</small>}
                  {isAllJobs && <small>{CREATOR_ROLE_LABELS[task.createdByRole || 'UNKNOWN'] || '未知角色'}</small>}
                </div></td>
                <td data-label="状态 / 进度">
                  <div className="distributed-progress">
                    <span className={`pill ${isImageRetryExhausted(task) ? 'pill-rejected' : `workbench-state-${task.state.toLowerCase()}`}${isStale(task) ? ' pill-rejected' : ''}`}>{isImageRetryExhausted(task) ? IMAGE_RETRY_EXHAUSTED_LABEL : STATE_LABELS[task.state]}</span>
                    <span>{stageLabel(task)} · {task.state.endsWith('_FAILED') && !task.executionStartedAt && task.progressPercent === 0 ? '进度未记录' : `${task.progressPercent}%`}</span>
                    <small className="workbench-text-preview" title={isStale(task) ? '超过 30 分钟没有进度，请进入详情处理' : task.progressMessage}>{isStale(task) ? '超过 30 分钟没有进度，请进入详情处理' : task.progressMessage}</small>
                  </div>
                </td>
                <td data-label="执行机"><div className="workbench-cell-stack workbench-executors">
                  <div><small>{executorColumnLabel}</small><span className="mono workbench-text-preview" title={activeView === 'IMAGE_WORK' ? imageExecutorLabel(task) : copyExecutorLabel(task, nodes)}>{activeView === 'IMAGE_WORK' ? imageExecutorLabel(task) : copyExecutorLabel(task, nodes)}</span></div>
                  {(activeView === 'MANUAL_ARCHIVE' || isAllJobs) && <div><small>生图执行机</small><span className="mono workbench-text-preview" title={imageExecutorLabel(task)}>{imageExecutorLabel(task)}</span></div>}
                  {activeView === 'PERSONAL' && (task.state.startsWith('IMAGE_') || task.imageExecutorNodeId || isImageRetryExhausted(task)) && <div><small>生图执行机</small><span className="mono workbench-text-preview" title={imageExecutorLabel(task)}>{imageExecutorLabel(task)}</span></div>}
                </div></td>
                <td data-label="开始 / 耗时"><div className="workbench-cell-stack">
                  <time dateTime={task.executionStartedAt || undefined}>{timeLabel(task.executionStartedAt, task.state)}</time>
                  <small className="workbench-elapsed"><Clock3 aria-hidden="true" size={13} />{elapsed(task)}</small>
                </div></td>
                <td className="workbench-col-actions" data-label="操作">{taskActions(task)}</td>
              </tr>)}</tbody>
            </table>
          </div>}

      {lastUpdatedAt && <WorkbenchPagination page={page} pageSize={pageSize} total={total} offset={resultOffset} count={tasks.length} busy={loading || refreshing}
        loadError={fetchError} onRetry={() => { void refresh(); }}
        onPageChange={(nextPage) => { if (nextPage !== page) { scrollAfterPageLoad.current = true; setPage(nextPage); } }}
        onPageSizeChange={(size) => { scrollAfterPageLoad.current = true; setPageSize(size); setPage(1); }} />}
    </section>

    <TaskReviewDialog
      taskId={selectedTaskId}
      nodeId={nodeId}
      role={role}
      onOpenChange={(open) => { if (!open) setSelectedTaskId(null); }}
      onUpdated={async (notice) => {
        setMessage(notice);
        setError('');
        await refresh({ silent: true });
      }}
    />

    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
