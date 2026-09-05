'use client';

import {
  ChevronLeft,
  ChevronRight,
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
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { parseQueryBatch } from '../../src/control-plane/query-batch.mjs';
import { selectCopyExecutor } from '../../src/control-plane/copy-executor-selection.mjs';
import { imageExecutorLabel } from '../../src/control-plane/image-executor-label.mjs';
import { TaskReviewDialog } from './task-review-dialog';

import { compareTasksByStatePriority, WORKBENCH_VIEWS, matchesWorkbenchView, type TaskState, type ViewKey } from './views';

type DistributedTask = {
  id: number;
  query: string;
  state: TaskState;
  copyExecutorNodeId: string;
  imageExecutorNodeId?: string | null;
  imageExecutorNodeName?: string | null;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
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
  COPY_QUEUED: '待执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  MANUAL_ARCHIVE: '人工归档',
  CANCELLED: '已取消',
};

const STAGE_LABELS: Record<string, string> = {
  IMAGE_RETRY_EXHAUSTED: IMAGE_RETRY_EXHAUSTED_LABEL,
  STARTING_COPY: '准备生成文案',
  STARTING_IMAGE: '准备生成图片',
  SEARCHING_IMAGES: '联网搜索图片',
  SELECTING_IMAGES: '筛选并校验图片',
  UPLOADING_IMAGES: '上传图片到中心服务',
  QUERY_REVIEW: '选题审核',
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
  COPY_QUEUED: '待执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  MANUAL_ARCHIVE: '人工归档',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};

function stageLabel(task: DistributedTask) {
  return task.currentStage ? STAGE_LABELS[task.currentStage] ?? STATE_LABELS[task.state] : STATE_LABELS[task.state];
}

const STALE_AFTER_MS = 30 * 60_000;
const PAGE_SIZE = 20;
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

function timeLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未开始';
}

export function CreationWorkbench({ nodeId, creatorUserId, role, viewKey: activeView }: { nodeId: string; creatorUserId: string; role: string; viewKey: ViewKey }) {
  const router = useRouter();
  const activeDefinition = WORKBENCH_VIEWS.find((view) => view.key === activeView)!;
  const executorColumnLabel = activeView === 'IMAGE_WORK' ? '生图执行机' : '文案执行机';
  const confirm = useConfirmDialog();
  const [tasks, setTasks] = useState<DistributedTask[]>([]);
  const [total, setTotal] = useState(0);
  const [nodes, setNodes] = useState<ExecutorNode[]>([]);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [queryText, setQueryText] = useState('');
  const [createError, setCreateError] = useState('');
  const queryBatch = useMemo(() => parseQueryBatch(queryText), [queryText]);
  const [imageCount, setImageCount] = useState('auto');
  const [targetNodeId, setTargetNodeId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingTaskId, setActingTaskId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const legacyStateFilterMode = useRef(false);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setRefreshing(true);
      setLoading(true);
    }
    try {
      const view = activeDefinition;
      const search = new URLSearchParams(legacyStateFilterMode.current
        ? { limit: '200', offset: '0' }
        : {
            states: view.states.join(','),
            limit: String(PAGE_SIZE),
            offset: String((page - 1) * PAGE_SIZE),
            includeTotal: 'true',
          });
      if (view.personalOnly) search.set('mine', 'true');
      if (searchKeyword) search.set('query', searchKeyword);
      let compatibilityTasks: DistributedTask[] | null = null;
      const taskPageRequest = apiRequest<TaskPage | DistributedTask[]>(apiPath(`/v1/tasks?${search}`))
        .catch(async (caught) => {
          if (!(caught instanceof Error) || caught.message !== 'task state filter is invalid') throw caught;
          legacyStateFilterMode.current = true;
          const compatibilitySearch = new URLSearchParams({ limit: '200', offset: '0' });
          if (view.personalOnly) compatibilitySearch.set('mine', 'true');
          compatibilityTasks = await apiRequest<DistributedTask[]>(apiPath(`/v1/tasks?${compatibilitySearch}`));
          return compatibilityTasks;
        });
      const [rawTaskPage, nextNodes] = await Promise.all([
        taskPageRequest,
        apiRequest<ExecutorNode[]>(apiPath('/v1/nodes')),
      ]);
      let taskPage: TaskPage;
      if (Array.isArray(rawTaskPage)) {
        // Older services return arrays. Filter by account explicitly; missing ownership
        // must never fall back to the creating or executing node.
        const legacySearch = new URLSearchParams({ limit: '200', offset: '0' });
        if (view.personalOnly) legacySearch.set('mine', 'true');
        if (legacyStateFilterMode.current && compatibilityTasks === null) compatibilityTasks = rawTaskPage;
        const legacyTasks = compatibilityTasks
          ?? await apiRequest<DistributedTask[]>(apiPath(`/v1/tasks?${legacySearch}`));
        const keyword = searchKeyword.toLocaleLowerCase('zh-CN');
        const filtered = legacyTasks.filter((task) => matchesWorkbenchView(task, view, creatorUserId)
          && (!keyword || task.query.toLocaleLowerCase('zh-CN').includes(keyword)))
          .sort(compareTasksByStatePriority);
        taskPage = {
          items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
          total: filtered.length,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        };
      } else {
        taskPage = rawTaskPage;
      }
      if (view.personalOnly && taskPage.items.some((task) => task.createdByUserId !== creatorUserId)) {
        throw new Error('中心服务尚未支持个人任务筛选，请更新并重启中心服务。');
      }
      setTasks(taskPage.items);
      setTotal(taskPage.total);
      const lastPage = Math.max(1, Math.ceil(taskPage.total / PAGE_SIZE));
      if (page > lastPage) setPage(lastPage);
      setNodes(nextNodes);
      setTargetNodeId((current) => nextNodes.some((node) => node.online && node.id === current) ? current : '');
      setError('');
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : '任务读取失败');
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, [activeDefinition, creatorUserId, page, role, searchKeyword]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh({ silent: true }); }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const visibleTasks = tasks;

  const onlineNodes = useMemo(() => nodes.filter((node) => node.online), [nodes]);
  const selectedExecutor = selectCopyExecutor(nodes, targetNodeId);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      description: '任务会随机绑定其它在线文案执行机，使用最新提示词、知识库和生产配置进入新执行机的待执行队列。正在进行的旧执行将作废。',
      confirmLabel: '重试',
    })) return;
    setActingTaskId(task.id);
    try {
      const queuedTask = await apiRequest<DistributedTask>(apiPath(`/v1/tasks/${task.id}/retry`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLatestConfig: true }),
      });
      const executorName = nodes.find((node) => node.id === queuedTask.copyExecutorNodeId)?.name
        || queuedTask.copyExecutorNodeId;
      setMessage(`任务 #${task.id} 已重新绑定 ${executorName}，进入该执行机的文案待执行队列。`);
      setError('');
      await refresh({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新生成文案失败');
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

  function taskActions(task: DistributedTask) {
    const busy = actingTaskId === task.id;
    const canDiscard = role === 'ADMIN' || task.createdByUserId === creatorUserId;
    const canRetryCopy = canDiscard && ['COPY_RUNNING', 'COPY_FAILED'].includes(task.state);
    if (activeView === 'ALL_COPY') return <div className="workbench-row-actions">
      <button className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</button>
      {canRetryCopy && <button className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</button>}
      {canDiscard && <button className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</button>}
    </div>;
    if (activeView === 'COPY_REVIEW') return <div className="workbench-row-actions">
      <button className="button small primary" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><FileCheck2 size={14} />审核</button>
      {canDiscard && <button className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</button>}
    </div>;
    if (activeView === 'IMAGE_WORK') return <div className="workbench-row-actions">
      <button className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</button>
    </div>;
    if (activeView === 'MANUAL_ARCHIVE') return <div className="workbench-row-actions">
      <button className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</button>
      {canDiscard && <button className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</button>}
    </div>;
    return <div className="workbench-row-actions">
      <button className="button small" type="button" disabled={busy} onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</button>
      {activeView === 'PERSONAL' && canRetryCopy && <button className="button small" type="button" disabled={busy} onClick={() => { void retryCopy(task); }}><RotateCcw size={14} />重试</button>}
      {canDiscard && <button className="button small danger" type="button" disabled={busy} onClick={() => { void discardTask(task); }}><Trash2 size={14} />废弃</button>}
    </div>;
  }

  function resetCreateForm() {
    setQueryText('');
    setCreateError('');
    setImageCount('auto');
  }

  async function createTasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const { queries, error: validationError } = queryBatch;
    if (!selectedExecutor) {
      setCreateError('当前没有可分配的在线执行机，请先完整启动至少一台执行机。');
      return;
    }
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
          copyExecutorNodeId: selectedExecutor.id,
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
      setMessage(`已创建 ${queries.length} 条笔记并分配给 ${selectedExecutor.name}；该执行机空闲后会从第一条开始依次生成文案。`);
      await refresh({ silent: true });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '笔记创建失败');
    } finally {
      setCreating(false);
    }
  }


  return <div className="creation-workbench">
    <section className="panel workbench-task-panel">
      <div className="workbench-toolbar">
        <div>
          <span className="section-kicker">Task lifecycle</span>
          <h2>{activeDefinition.label}</h2>
          <p>{activeDefinition.description}</p>
        </div>
        <div className="workbench-toolbar-actions">
          <button className="button small" type="button" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} aria-hidden="true" size={14} />刷新
          </button>
          <Dialog open={createOpen} onOpenChange={(open) => {
            if (creating) return;
            if (open) {
              setTargetNodeId('');
              void refresh({ silent: true });
            }
            setCreateOpen(open);
          }}>
            <DialogTrigger asChild>
              <button className="button primary" type="button"><Plus aria-hidden="true" size={16} />创建笔记</button>
            </DialogTrigger>
            <DialogContent className="workbench-create-dialog">
              <div className="workbench-create-heading">
                <span className="section-kicker">Create notes</span>
                <DialogTitle>创建 Query 作业</DialogTitle>
                <DialogDescription>
                  可同时录入多条 Query。任务归属当前账号，由所选执行机按创建顺序逐条生成文案。
                </DialogDescription>
              </div>
              <form className="workbench-create-form" onSubmit={createTasks}>
                {onlineNodes.length === 0 && <div className="notice error" role="alert">
                  当前没有在线执行机。执行机只有完成中心服务、工作目录和 OpenClaw 就绪检查后才会上线。
                </div>}
                <div className="field">
                  <label htmlFor="workbench-query-text">笔记选题（Query）</label>
                  <textarea
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
                    <label htmlFor="workbench-copy-executor">文案执行机</label>
                    <Select value={selectedExecutor?.id ?? ''} onValueChange={setTargetNodeId} disabled={creating || onlineNodes.length === 0}>
                      <SelectTrigger id="workbench-copy-executor" aria-describedby="workbench-executor-help"><SelectValue placeholder="暂无在线执行机" /></SelectTrigger>
                      <SelectContent>
                        {onlineNodes.map((node) => <SelectItem key={node.id} value={node.id}>
                          {node.name}（待执行 {node.copyQueuedCount} / 执行中 {node.copyRunningCount}）
                        </SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="workbench-query-help" id="workbench-executor-help">默认选择文案任务最少的在线执行机，可手动调整。</p>
                  </div>
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
                <div className="workbench-create-footer">
                  <span aria-live="polite">已识别 {queryBatch.queries.length} 条 Query，按输入顺序加入队列。</span>
                  <div>
                    <DialogClose asChild><button className="button" type="button" disabled={creating}>取消</button></DialogClose>
                    <button className="button primary" type="submit" disabled={creating || !selectedExecutor || Boolean(queryBatch.error)}>
                      {creating ? <><LoaderCircle className="animate-spin" size={16} />正在创建…</> : <>创建并加入队列</>}
                    </button>
                  </div>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="workbench-list-tools">
        <form className="workbench-query-search" role="search" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="workbench-query-search">搜索 Query</label>
          <Search aria-hidden="true" size={15} />
          <input
            id="workbench-query-search"
            value={searchInput}
            maxLength={500}
            placeholder="按 Query 关键字搜索"
            onChange={(event) => setSearchInput(event.target.value)}
          />
          {searchKeyword && <button className="button small" type="button" onClick={clearSearch}>清除</button>}
          <button className="button small" type="submit">搜索</button>
        </form>
        <span>共 {total} 条{searchKeyword ? `匹配“${searchKeyword}”` : ''}</span>
      </div>

      {loading
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取远端任务…</div>
        : visibleTasks.length === 0
          ? <div className="workbench-empty">
            <span>{activeView === 'PERSONAL' ? '当前没有你创建的 Query 任务。' : `当前没有${activeDefinition.label}任务。`}</span>
            {activeView === 'PERSONAL' && <button className="button small" type="button" onClick={() => setCreateOpen(true)}><Plus size={14} />创建第一条笔记</button>}
          </div>
          : <div className="table-wrap mobile-cards workbench-table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Query</th><th>创建者</th><th>状态</th><th>{executorColumnLabel}</th>{activeView === 'MANUAL_ARCHIVE' && <th>生图执行机</th>}<th>开始时间</th><th>阶段 / 进度</th><th>耗时</th><th>操作</th></tr></thead>
              <tbody>{visibleTasks.map((task) => <tr key={task.id}>
                <td className="mono" data-label="ID">#{task.id}</td>
                <td className="query-cell" data-label="Query">{task.query}</td>
                <td data-label="创建者">{task.createdByDisplayName || task.createdByUserId || '历史任务'}</td>
                <td data-label="状态">
                  <span className={`pill ${isImageRetryExhausted(task) ? 'pill-rejected' : `workbench-state-${task.state.toLowerCase()}`}${isStale(task) ? ' pill-rejected' : ''}`}>{isImageRetryExhausted(task) ? IMAGE_RETRY_EXHAUSTED_LABEL : STATE_LABELS[task.state]}</span>
                </td>
                <td className="mono" data-label={executorColumnLabel}>{activeView === 'IMAGE_WORK'
                  ? imageExecutorLabel(task)
                  : nodes.find((node) => node.id === task.copyExecutorNodeId)?.name ?? task.copyExecutorNodeId}</td>
                {activeView === 'MANUAL_ARCHIVE' && <td className="mono" data-label="生图执行机">{imageExecutorLabel(task)}</td>}
                <td data-label="开始时间">{timeLabel(task.executionStartedAt)}</td>
                <td data-label="阶段 / 进度">
                  <div className="distributed-progress">
                    <span>{stageLabel(task)} · {task.progressPercent}%</span>
                    <small>{isStale(task) ? '超过 30 分钟没有进度，请进入详情处理' : task.progressMessage}</small>
                  </div>
                </td>
                <td data-label="耗时"><span className="workbench-elapsed"><Clock3 aria-hidden="true" size={13} />{elapsed(task)}</span></td>
                <td data-label="操作">{taskActions(task)}</td>
              </tr>)}</tbody>
            </table>
          </div>}

      {!loading && total > 0 && <nav className="workbench-pagination" aria-label="任务列表分页">
        <button className="button small" type="button" disabled={page <= 1 || refreshing} onClick={() => setPage((value) => Math.max(1, value - 1))}>
          <ChevronLeft size={14} />上一页
        </button>
        <span>第 {page} / {totalPages} 页</span>
        <button className="button small" type="button" disabled={page >= totalPages || refreshing} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
          下一页<ChevronRight size={14} />
        </button>
      </nav>}
    </section>

    <TaskReviewDialog
      taskId={selectedTaskId}
      nodeId={nodeId}
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
