'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';

import {
  AlertTriangle,
  Ban,
  Clock3,
  Download,
  Eye,
  FileCheck2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
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
import {
  DEFAULT_WORKBENCH_LIST_STATE,
  workbenchListSearch,
  type TaskAttention,
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

type DistributedTask = {
  id: number;
  query: string;
  state: TaskState;
  cancelledFromState?: TaskState | null;
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
const PERMANENT_DELETE_STATES: TaskState[] = ['COPY_FAILED', 'IMAGE_FAILED', 'REVIEWED', 'CANCELLED'];
const CANCELLED_EXECUTION_SETTLE_MS = 3 * 60_000;
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
  const lastProgressAt = task.lastActivityAt || task.executionStartedAt || task.updatedAt || task.createdAt;
  return ['COPY_RUNNING', 'IMAGE_RUNNING'].includes(task.state)
    && Number.isFinite(Date.parse(lastProgressAt))
    && Date.now() - Date.parse(lastProgressAt) >= STALE_AFTER_MS;
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

export function CreationWorkbench({ nodeId, creatorUserId, role, viewKey: activeView, initialListState = DEFAULT_WORKBENCH_LIST_STATE }: {
  nodeId: string; creatorUserId: string; role: string; viewKey: ViewKey; initialListState?: WorkbenchListState;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeDefinition = WORKBENCH_VIEWS.find((view) => view.key === activeView)!;
  const isAllJobs = activeView === 'ALL_JOBS';
  const executorColumnLabel = activeView === 'IMAGE_WORK' ? '生图执行机' : '文案执行机';
  const confirm = useConfirmDialog();
  const [tasks, setTasks] = useState<DistributedTask[]>([]);
  const [total, setTotal] = useState(0);
  const [nodes, setNodes] = useState<ExecutorNode[]>([]);
  const [page, setPage] = useState(initialListState.page);
  const [pageSize, setPageSize] = useState(initialListState.pageSize);
  const [resultOffset, setResultOffset] = useState(0);
  const [searchInput, setSearchInput] = useState(initialListState.query);
  const [searchKeyword, setSearchKeyword] = useState(initialListState.query);
  const [sort, setSort] = useState<TaskSort>(initialListState.sort);
  const [deduplicateQuery, setDeduplicateQuery] = useState(initialListState.deduplicateQuery);
  const [creatorRoleFilter, setCreatorRoleFilter] = useState(initialListState.createdByRole);
  const [creatorFilter, setCreatorFilter] = useState<JobCreator | null>(initialListState.createdByUserId && isAllJobs
    ? { username: initialListState.createdByUserId, displayName: initialListState.createdByUserId, role: '', status: 'ACTIVE' } : null);
  const [stateFilter, setStateFilter] = useState(initialListState.state);
  const [attentionFilter, setAttentionFilter] = useState<TaskAttention>(initialListState.attention);
  const [fetchError, setFetchError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshRequestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const listStart = useRef<HTMLDivElement | null>(null);
  const scrollAfterPageLoad = useRef(false);
  const leavingWorkbenchView = useRef(false);
  const [queryText, setQueryText] = useState('');
  const [createError, setCreateError] = useState('');
  const queryBatch = useMemo(() => parseQueryBatch(queryText), [queryText]);
  const [imageCount, setImageCount] = useState('auto');
  const [skipCopyReview, setSkipCopyReview] = useState(role === 'ADMIN');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialListState.taskId);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [batchAction, setBatchAction] = useState<'RETRY' | 'CANCEL_QUEUE' | 'EXPORT' | 'PERMANENT_DELETE' | null>(null);
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
      const searchedTaskId = taskIdSearch(searchKeyword);
      if (searchedTaskId) search.set('taskId', String(searchedTaskId));
      else if (searchKeyword) search.set('query', searchKeyword);
      if (deduplicateQuery) search.set('deduplicateQuery', 'true');
      if (role === 'ADMIN' && isAllJobs && attentionFilter !== 'NONE') search.set('attention', attentionFilter);
      const { sortBy, sortOrder } = taskSortParams(sort);
      search.set('sortBy', sortBy);
      search.set('sortOrder', sortOrder);
      let compatibilityTasks: DistributedTask[] | null = null;
      const taskPageRequest = isAllJobs ? loadAdminTaskPage(request, {
        createdByUserId: creatorFilter?.username,
        createdByRole: creatorRoleFilter === 'ALL' ? undefined : creatorRoleFilter,
        state: stateFilter === 'ALL' ? undefined : stateFilter,
        taskId: searchedTaskId ?? undefined,
        query: searchedTaskId ? undefined : searchKeyword,
        deduplicateQuery,
        attention: attentionFilter === 'NONE' ? undefined : attentionFilter,
        sortBy,
        sortOrder,
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
          && matchesAttention(task, attentionFilter)
          && (!keyword || (searchedTaskId ? task.id === searchedTaskId : task.query.toLocaleLowerCase('zh-CN').includes(keyword))))
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
  }, [activeDefinition, creatorUserId, page, pageSize, isAllJobs, creatorFilter, creatorRoleFilter, stateFilter, searchKeyword, deduplicateQuery, sort, attentionFilter, role]);

  useEffect(() => {
    if (leavingWorkbenchView.current) return;
    const search = workbenchListSearch({
      page,
      pageSize: pageSize as WorkbenchListState['pageSize'],
      query: searchKeyword,
      sort,
      deduplicateQuery,
      createdByUserId: isAllJobs ? creatorFilter?.username ?? '' : '',
      createdByRole: isAllJobs ? creatorRoleFilter : 'ALL',
      state: activeView === 'PERSONAL' || isAllJobs ? stateFilter : 'ALL',
      attention: isAllJobs ? attentionFilter : 'NONE',
      taskId: selectedTaskId,
    }, { includeAdminFilters: role === 'ADMIN' && isAllJobs });
    const href = search.size ? `${pathname}?${search}` : pathname;
    if (`${window.location.pathname}${window.location.search}` !== href) {
      router.replace(href, { scroll: false });
    }
  }, [activeView, attentionFilter, creatorFilter, creatorRoleFilter, deduplicateQuery, isAllJobs,
    page, pageSize, pathname, role, router, searchKeyword, selectedTaskId, sort, stateFilter]);

  const loadSavedViews = useCallback(async () => {
    if (role !== 'ADMIN') return;
    try {
      const views = await apiRequest<SavedTaskView[]>(apiPath('/v1/task-views'));
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
  const retryableTasks = selectedTasks.filter((task) => ['COPY_RUNNING', 'COPY_FAILED', 'IMAGE_RUNNING', 'IMAGE_FAILED'].includes(task.state)
    || isImageRetryExhausted(task));
  const queuedTasks = selectedTasks.filter((task) => ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state));
  const exportableTasks = selectedTasks.filter((task) => ['MANUAL_ARCHIVE', 'REVIEWED'].includes(task.state));
  const permanentlyDeletableTasks = selectedTasks.filter(isPermanentlyDeletableTask);
  const availableSavedViews = savedViews.filter((view) => view.viewKey === activeView);
  const allVisibleSelected = visibleTasks.length > 0 && visibleTasks.every((task) => selectedTaskIds.includes(task.id));

  const hasFilters = Boolean(searchInput || searchKeyword || deduplicateQuery || creatorFilter || creatorRoleFilter !== 'ALL'
    || stateFilter !== 'ALL' || attentionFilter !== 'NONE');

  function currentSavedFilters(): SavedTaskView['filters'] {
    return {
      query: searchKeyword,
      sort,
      deduplicateQuery,
      createdByUserId: isAllJobs ? creatorFilter?.username ?? '' : '',
      createdByRole: isAllJobs ? creatorRoleFilter : 'ALL',
      state: activeView === 'PERSONAL' || isAllJobs ? stateFilter : 'ALL',
      attention: isAllJobs ? attentionFilter : 'NONE',
      pageSize: pageSize as WorkbenchListState['pageSize'],
    };
  }

  function applyDefaultView() {
    setSearchInput(DEFAULT_WORKBENCH_LIST_STATE.query);
    setSearchKeyword(DEFAULT_WORKBENCH_LIST_STATE.query);
    setSort(DEFAULT_WORKBENCH_LIST_STATE.sort);
    setDeduplicateQuery(DEFAULT_WORKBENCH_LIST_STATE.deduplicateQuery);
    setCreatorRoleFilter(DEFAULT_WORKBENCH_LIST_STATE.createdByRole);
    setCreatorFilter(null);
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
    setSort(view.filters.sort);
    setDeduplicateQuery(view.filters.deduplicateQuery);
    setCreatorRoleFilter(isAllJobs ? view.filters.createdByRole : 'ALL');
    setCreatorFilter(isAllJobs && view.filters.createdByUserId
      ? { username: view.filters.createdByUserId, displayName: view.filters.createdByUserId === creatorUserId ? '我' : view.filters.createdByUserId, role: '', status: 'ACTIVE' }
      : null);
    setStateFilter(activeView === 'PERSONAL' || isAllJobs ? view.filters.state : 'ALL');
    setAttentionFilter(isAllJobs ? view.filters.attention : 'NONE');
    setPageSize(view.filters.pageSize);
    setPage(1);
    setSavedViewId(String(view.id));
    setMessage(`已应用常用视图“${view.name}”。`);
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
    setCreatorFilter({ username: creatorUserId, displayName: '我', role: role, status: 'ACTIVE' });
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

  async function runBatchAction(action: 'RETRY' | 'CANCEL_QUEUE', eligible: DistributedTask[]) {
    if (eligible.length === 0 || batchAction) return;
    const retry = action === 'RETRY';
    if (!await confirm({
      title: retry ? `批量重试 ${eligible.length} 条任务？` : `取消 ${eligible.length} 条任务的排队？`,
      description: retry
        ? '仅处理当前所选的执行中或失败任务；正在执行的旧流程会作废，并按文案或图片阶段重新排队。'
        : '仅处理当前所选的待文案、待生图任务；数据会保留，之后仍可重新排队。',
      confirmLabel: retry ? '批量重试' : '取消排队',
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
      const label = retry ? '重试' : '取消排队';
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
    if (exportableTasks.length === 0 || exportableTasks.length > 20 || batchAction) return;
    setBatchAction('EXPORT');
    try {
      const response = await fetch(apiPath('/v1/tasks/batch-archive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: exportableTasks.map((task) => task.id) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `导出失败（${response.status}）`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = '批量作业资源.zip';
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`已导出 ${exportableTasks.length} 条任务的资源包。`);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批量导出失败');
    } finally {
      setBatchAction(null);
    }
  }

  function clearFilters() {
    setSearchInput('');
    setSearchKeyword('');
    setDeduplicateQuery(false);
    setCreatorFilter(null);
    setCreatorRoleFilter('ALL');
    setStateFilter('ALL');
    setAttentionFilter('NONE');
    setSavedViewId('');
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

  async function cancelQueuedTask(task: DistributedTask) {
    if (!['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state)) return;
    if (!await confirm({
      title: '取消这条任务的排队？',
      description: '任务会停止等待执行机，但保留全部数据。之后可点击“一键排队”恢复到当前队列。',
      confirmLabel: '确认取消排队',
      tone: 'danger',
    })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest(apiPath(`/v1/tasks/${task.id}/cancel`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      setMessage(`任务 #${task.id} 已取消排队，可随时一键重新排队。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消排队失败');
    } finally { setActingTaskId(null); }
  }

  async function requeueCancelledTask(task: DistributedTask) {
    if (!await confirm({ title: '重新加入队列？', description: '任务会恢复到取消前的队列，并由空闲执行机按顺序领取。', confirmLabel: '确认重新排队' })) return;
    setActingTaskId(task.id);
    try {
      await apiRequest(apiPath(`/v1/tasks/${task.id}/requeue`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setMessage(`任务 #${task.id} 已重新加入队列。`); setError(''); await refresh({ silent: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重新排队失败'); } finally { setActingTaskId(null); }
  }

  async function permanentlyDeleteTask() {
    if (!permanentDeleteTask || !deletionPassword) return;
    setActingTaskId(permanentDeleteTask.id);
    try {
      const result = await apiRequest<{ id: number; deleted: boolean; cleanupPending?: boolean }>(apiPath(`/v1/tasks/${permanentDeleteTask.id}/permanent`), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletionPassword }),
      });
      setMessage(result.cleanupPending
        ? `任务 #${permanentDeleteTask.id} 已删除；素材已隔离，中心服务将继续清理。`
        : `任务 #${permanentDeleteTask.id} 及其关联数据已永久删除。`);
      setError(''); setDeletionError(''); setDeletionPassword(''); setPermanentDeleteTask(null); await refresh({ silent: true });
    } catch (caught) {
      setDeletionError(caught instanceof Error ? caught.message : '永久删除失败');
      setDeletionPassword('');
    } finally { setActingTaskId(null); }
  }

  async function permanentlyDeleteSelectedTasks() {
    if (!batchPermanentDeleteTasks.length || batchPermanentDeleteTasks.length > 20 || !deletionPassword || batchAction) return;
    setBatchAction('PERMANENT_DELETE');
    try {
      const result = await apiRequest<BatchPermanentDeleteResult>(apiPath('/v1/tasks/batch-permanent-delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds: batchPermanentDeleteTasks.map((task) => task.id),
          deletionPassword,
        }),
      });
      setSelectedTaskIds((current) => current.filter((id) => !result.succeeded.includes(id)));
      setMessage(`批量永久删除完成：成功 ${result.succeeded.length} 条${result.cleanupPending.length ? `，其中 ${result.cleanupPending.length} 条素材正在后台清理` : ''}${result.failed.length ? `，未删除 ${result.failed.length} 条` : ''}。`);
      setError(result.failed.length ? result.failed.map((item) => `#${item.id}：${item.message}`).join('；') : '');
      setDeletionError('');
      setDeletionPassword('');
      setBatchPermanentDeleteTasks([]);
      await refresh({ silent: true });
    } catch (caught) {
      setDeletionError(caught instanceof Error ? caught.message : '批量永久删除失败');
      setDeletionPassword('');
    } finally {
      setBatchAction(null);
    }
  }

  function taskActions(task: DistributedTask) {
    const busy = actingTaskId === task.id;
    const canPermanentlyDelete = role === 'ADMIN' && isPermanentlyDeletableTask(task);
    const permanentDeleteButton = canPermanentlyDelete && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { setDeletionError(''); setDeletionPassword(''); setPermanentDeleteTask(task); }}><Trash2 size={14} />永久删除</Button>;
    if (isAllJobs) return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {task.state === 'CANCELLED' && ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.cancelledFromState || '') && <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => { void requeueCancelledTask(task); }}><RotateCcw size={14} />一键排队</Button>}
      {['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state) && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void cancelQueuedTask(task); }}><Trash2 size={14} />取消排队</Button>}
      {permanentDeleteButton}
    </TaskRowActions>;
    const canDiscard = role === 'ADMIN' || task.createdByUserId === creatorUserId;
    const canCancelQueue = role === 'ADMIN' && ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.state);
    const canRequeue = role === 'ADMIN' && task.state === 'CANCELLED' && ['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task.cancelledFromState || '');
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
      {permanentDeleteButton}
    </TaskRowActions>;
    if (activeView === 'COPY_REVIEW') return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</Button>
      {canDiscard && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
      {permanentDeleteButton}
    </TaskRowActions>;
    if (activeView === 'IMAGE_WORK') return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {retryImageButton}
      {permanentDeleteButton}
    </TaskRowActions>;
    if (task.state === 'REVIEWED') return <TaskRowActions taskId={task.id} busy={busy}><Button unstyled className="button small" type="button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>{permanentDeleteButton}</TaskRowActions>;
    if (task.state === 'MANUAL_ARCHIVE' && ['ADMIN', 'REVIEWER'].includes(role)) return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</Button>
      <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>
    </TaskRowActions>;
    return <TaskRowActions taskId={task.id} busy={busy}>
      <Button unstyled className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
      {canCancelQueue && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void cancelQueuedTask(task); }}><Trash2 size={14} />取消排队</Button>}
      {canRequeue && <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => { void requeueCancelledTask(task); }}><RotateCcw size={14} />一键排队</Button>}
      {canDiscard && canResumeImageTask(task) && <Button unstyled className="button small primary" type="button" disabled={busy} onClick={() => { void resumeImages(task); }}><RotateCcw size={14} />从失败步骤继续</Button>}
      {activeView === 'PERSONAL' && canRetryCopy && <Button unstyled className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</Button>}
      {activeView === 'PERSONAL' && retryImageButton}
      {canDiscard && !canCancelQueue && <Button unstyled className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</Button>}
      {permanentDeleteButton}
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
      if (activeView !== 'PERSONAL') {
        leavingWorkbenchView.current = true;
        router.push('/workbench/personal');
      }
      setMessage(`已创建 ${queries.length} 条笔记并加入共享文案队列，空闲执行机会按队列顺序领取。${role === 'ADMIN' && skipCopyReview ? '本批次免人工文案审核，文案生成后自动进入生图队列。' : ''}`);
      await refresh({ silent: true });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '笔记创建失败');
    } finally {
      setCreating(false);
    }
  }


  return <div className="creation-workbench">
    <Dialog open={Boolean(permanentDeleteTask)} onOpenChange={(open) => { if (!open && !actingTaskId) { setPermanentDeleteTask(null); setDeletionPassword(''); setDeletionError(''); } }}>
      <DialogContent className="workbench-create-dialog">
        <div className="workbench-create-heading"><span className="section-kicker">Irreversible action</span><DialogTitle>永久删除任务 #{permanentDeleteTask?.id}</DialogTitle><DialogDescription>此操作会永久清除任务、执行记录、文案、图片和素材，无法撤销。请输入个人信息中设置的删除二级密码确认。</DialogDescription></div>
        <div className="notice error">请确认这不是仅需“取消排队”或“废弃”的任务。</div>
        {deletionError && <div className="notice error" role="alert">{deletionError}</div>}
        <div className="field"><label htmlFor="task-deletion-password">删除二级密码</label><input className="input" id="task-deletion-password" type="password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} autoComplete="current-password" /></div>
        <div className="profile-form-actions"><Button unstyled className="button" type="button" disabled={Boolean(actingTaskId)} onClick={() => { setPermanentDeleteTask(null); setDeletionPassword(''); }}>取消</Button><Button unstyled className="button danger" type="button" disabled={!deletionPassword || Boolean(actingTaskId)} onClick={() => { void permanentlyDeleteTask(); }}>{actingTaskId ? '删除中…' : '确认永久删除'}</Button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={batchPermanentDeleteTasks.length > 0} onOpenChange={(open) => { if (!open && batchAction !== 'PERMANENT_DELETE') { setBatchPermanentDeleteTasks([]); setDeletionPassword(''); setDeletionError(''); } }}>
      <DialogContent className="workbench-create-dialog">
        <div className="workbench-create-heading"><span className="section-kicker">Irreversible batch action</span><DialogTitle>批量永久删除 {batchPermanentDeleteTasks.length} 条任务</DialogTitle><DialogDescription>此操作会永久清除所列任务、执行记录、文案、图片和素材，无法撤销。二级密码只校验一次，任务删除在同一数据库事务中完成。</DialogDescription></div>
        <div className="notice error">即将永久删除：{batchPermanentDeleteTasks.map((task) => `#${task.id}`).join('、')}。请确认这些任务不再需要恢复或重新排队。</div>
        {deletionError && <div className="notice error" role="alert">{deletionError}</div>}
        <div className="field"><label htmlFor="batch-task-deletion-password">删除二级密码</label><input className="input" id="batch-task-deletion-password" type="password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} autoComplete="current-password" /></div>
        <div className="profile-form-actions"><Button unstyled className="button" type="button" disabled={batchAction === 'PERMANENT_DELETE'} onClick={() => { setBatchPermanentDeleteTasks([]); setDeletionPassword(''); }}>取消</Button><Button unstyled className="button danger" type="button" disabled={!deletionPassword || batchAction === 'PERMANENT_DELETE'} onClick={() => { void permanentlyDeleteSelectedTasks(); }}>{batchAction === 'PERMANENT_DELETE' ? '删除中…' : `确认永久删除 ${batchPermanentDeleteTasks.length} 条`}</Button></div>
      </DialogContent>
    </Dialog>
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
      {role === 'ADMIN' && <div className="workbench-admin-list-controls">
        <div className="workbench-saved-views">
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
        </div>
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
          {searchKeyword && <Button unstyled className="button small" type="button" onClick={clearSearch}>清除</Button>}
          <Button unstyled className="button small" type="submit">搜索</Button>
        </form>
        <div className="workbench-sort-control">
          <label htmlFor="workbench-task-sort">排序</label>
          <Select value={sort} onValueChange={(value) => { setSort(value as TaskSort); setPage(1); }}>
            <SelectTrigger id="workbench-task-sort"><SelectValue /></SelectTrigger>
            <SelectContent>{TASK_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
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
            ? `去重后 ${total} 个 Query${searchKeyword ? `匹配“${searchKeyword}”` : ''}`
            : `共 ${total} 条${searchKeyword ? `匹配“${searchKeyword}”` : ''}`
          : '尚未读取任务'}</span>
        {hasFilters && <Button unstyled className="button small" type="button" onClick={clearFilters}>清空筛选</Button>}
      </div>

      {fetchError && <div className="notice error workbench-refresh-notice" role="alert">
        <div>刷新失败：{fetchError}{lastUpdatedAt && ' 以下保留上次成功读取的数据，可能不符合当前筛选或最新状态。'}</div>
        <Button unstyled className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>重新读取</Button>
      </div>}
      {lastUpdatedAt && <p className="workbench-updated-at" role="status">{loading ? `正在读取第 ${page} 页，暂时保留上次结果…` : `最近成功刷新：${timeLabel(lastUpdatedAt)} · 每 30 秒自动刷新`}</p>}

      {role === 'ADMIN' && selectedTasks.length > 0 && <div className="workbench-batch-actions" role="region" aria-label="批量任务操作">
        <strong>已选 {selectedTasks.length} 条（当前页）</strong>
        <Button unstyled className="button small" type="button" disabled={Boolean(batchAction) || retryableTasks.length === 0} onClick={() => { void runBatchAction('RETRY', retryableTasks); }}><RotateCcw size={14} />重试 {retryableTasks.length}</Button>
        <Button unstyled className="button small danger" type="button" disabled={Boolean(batchAction) || queuedTasks.length === 0} onClick={() => { void runBatchAction('CANCEL_QUEUE', queuedTasks); }}><Ban size={14} />取消排队 {queuedTasks.length}</Button>
        <Button unstyled className="button small danger" type="button" title={permanentlyDeletableTasks.length > 20 ? '单次最多永久删除 20 条，请减少选择' : '仅永久删除已失败、已审核或已废弃且执行已停止的任务'} disabled={Boolean(batchAction) || permanentlyDeletableTasks.length === 0 || permanentlyDeletableTasks.length > 20} onClick={() => { setDeletionError(''); setDeletionPassword(''); setBatchPermanentDeleteTasks(permanentlyDeletableTasks); }}><Trash2 size={14} />永久删除 {permanentlyDeletableTasks.length}</Button>
        <Button unstyled className="button small" type="button" title={exportableTasks.length > 20 ? '单次最多导出 20 条，请减少选择' : '导出已审核或待人工归档任务'} disabled={Boolean(batchAction) || exportableTasks.length === 0 || exportableTasks.length > 20} onClick={() => { void exportSelectedTasks(); }}><Download size={14} />导出 {exportableTasks.length}</Button>
        <Button unstyled className="button small" type="button" disabled={Boolean(batchAction)} onClick={() => setSelectedTaskIds([])}>清除选择</Button>
        {batchAction && <span role="status">正在处理…</span>}
      </div>}

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
              <thead><tr>{role === 'ADMIN' && <th className="workbench-col-select"><Checkbox aria-label="选择当前页全部任务" checked={allVisibleSelected} onChange={(event) => setSelectedTaskIds(event.target.checked ? visibleTasks.map((task) => task.id) : [])} /></th>}<th className="workbench-col-query">作业 / Query</th><th className="workbench-col-creator">作业员</th><th className="workbench-col-progress">状态 / 进度</th><th className="workbench-col-executor">执行机</th><th className="workbench-col-time">创建 / 开始 / 耗时</th><th className="workbench-col-actions">操作</th></tr></thead>
              <tbody>{visibleTasks.map((task) => <tr key={task.id}>
                {role === 'ADMIN' && <td className="workbench-col-select" data-label="选择"><Checkbox aria-label={`选择任务 #${task.id}`} checked={selectedTaskIds.includes(task.id)} onChange={(event) => toggleTaskSelection(task.id, event.target.checked)} /></td>}
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
                <td data-label="创建 / 开始 / 耗时"><div className="workbench-cell-stack">
                  <time dateTime={task.createdAt}>{timeLabel(task.createdAt)}</time>
                  <small>开始：<time dateTime={task.executionStartedAt || undefined}>{timeLabel(task.executionStartedAt, task.state)}</time></small>
                  <small className="workbench-elapsed"><Clock3 aria-hidden="true" size={13} />{elapsed(task)}</small>
                </div></td>
                <td className="workbench-col-actions" data-label="操作">{taskActions(task)}</td>
              </tr>)}</tbody>
            </table>
          </div>}

      {lastUpdatedAt && <WorkbenchPagination page={page} pageSize={pageSize} total={total} offset={resultOffset} count={tasks.length} busy={loading || refreshing}
        loadError={fetchError} onRetry={() => { void refresh(); }}
        onPageChange={(nextPage) => { if (nextPage !== page) { scrollAfterPageLoad.current = true; setPage(nextPage); } }}
        onPageSizeChange={(size) => { scrollAfterPageLoad.current = true; setPageSize(size as WorkbenchListState['pageSize']); setPage(1); }} />}
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
