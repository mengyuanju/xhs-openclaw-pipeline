'use client';

import {
  CheckCircle2,
  Clock3,
  FilePlus2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';

type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'DELIVERY_REVIEW_PENDING' | 'COMPLETED' | 'CANCELLED';

type DistributedTask = {
  id: number;
  query: string;
  input: Record<string, unknown>;
  requestedImageCount: 'auto' | number;
  state: TaskState;
  createdByNodeId: string;
  copyExecutorNodeId: string;
  currentCopyRevisionId: number | null;
  currentImageRunId: string | null;
  currentExecutionId: string | null;
  currentStage: string | null;
  progressPercent: number;
  progressMessage: string;
  executionStartedAt: string | null;
  lastActivityAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type CopyRevision = {
  id: number;
  revision: number;
  content: any;
  approvedAt: string | null;
};

type TaskDetail = DistributedTask & {
  copyRevisions: CopyRevision[];
  imageRuns: Array<{ id: string; status: string; result: any }>;
  assets: Array<{
    id: number;
    imageRunId: string;
    mediaType: string;
    originalName: string | null;
    url: string;
  }>;
};

const STATE_LABELS: Record<TaskState, string> = {
  COPY_QUEUED: '准备中',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '文案待审核',
  COPY_FAILED: '文案失败',
  IMAGE_QUEUED: '待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  DELIVERY_REVIEW_PENDING: '图文待审核',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

const ACTIVE_STATES = new Set<TaskState>([
  'COPY_QUEUED', 'COPY_RUNNING', 'IMAGE_QUEUED', 'IMAGE_RUNNING',
]);
const RETRY_STATES = new Set<TaskState>([
  'COPY_RUNNING', 'COPY_FAILED', 'IMAGE_RUNNING', 'IMAGE_FAILED',
]);
const STALE_AFTER_MS = 30 * 60_000;

function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

function copyFromRevision(revision: CopyRevision | undefined) {
  const content = revision?.content;
  return {
    copy: content?.copy ?? content?.reviewed?.copy ?? null,
    imagePlan: content?.imagePlan ?? content?.reviewed?.imagePlan ?? [],
    research: content?.generation?.research ?? null,
  };
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
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function DistributedJobsWorkbench({
  nodeId,
  creationOnly = false,
  initialTaskId = null,
}: {
  nodeId: string;
  creationOnly?: boolean;
  initialTaskId?: number | null;
}) {
  const confirm = useConfirmDialog();
  const [tasks, setTasks] = useState<DistributedTask[]>([]);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async ({ silent = false } = {}) => {
    try {
      const data = await apiRequest<DistributedTask[]>(apiPath('/v1/tasks?limit=100&offset=0'));
      setTasks(data);
      setError('');
      if (selected) {
        const detail = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${selected.id}`));
        setSelected(detail);
      }
    } catch (refreshError) {
      if (!silent) setError(refreshError instanceof Error ? refreshError.message : '任务读取失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [selected?.id]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActiveTasks = useMemo(() => tasks.some((task) => ACTIVE_STATES.has(task.state)), [tasks]);
  useEffect(() => {
    if (!hasActiveTasks) return undefined;
    const timer = window.setInterval(() => { void refresh({ silent: true }); }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, refresh]);

  async function createTasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const queries = [...new Set(String(form.get('queries') ?? '')
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
    if (queries.length < 1 || queries.length > 100) {
      setError('每次请输入 1–100 个不重复选题，每行一个。');
      return;
    }
    const imageCountRaw = String(form.get('imageCount') ?? 'auto');
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await apiRequest(apiPath('/v1/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          copyExecutorNodeId: nodeId,
          tasks: queries.map((query) => ({
            query,
            input: {},
            imageCount: imageCountRaw === 'auto' ? 'auto' : Number(imageCountRaw),
          })),
        }),
      });
      event.currentTarget.reset();
      setMessage(`已创建 ${queries.length} 条远端任务，本机执行代理会按顺序生成文案。`);
      await refresh({ silent: true });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '任务创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function openTask(taskId: number) {
    setBusy(true);
    try {
      setSelected(await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${taskId}`)));
      setError('');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '任务详情读取失败');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialTaskId) void openTask(initialTaskId);
  }, [initialTaskId]);

  async function approveCopy() {
    if (!selected?.currentCopyRevisionId) return;
    if (!await confirm({
      title: '审核通过并进入生图队列？',
      description: '将锁定当前文案版本并进入全局生图队列；任意已启用图片能力的空闲执行机都可以领取。',
      confirmLabel: '审核通过并排队',
    })) return;
    setBusy(true);
    try {
      await apiRequest(apiPath(`/v1/tasks/${selected.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: selected.currentCopyRevisionId, nodeId }),
      });
      setMessage('文案已审核通过，任务已进入全局生图队列。');
      await refresh({ silent: true });
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : '文案审核提交失败');
    } finally {
      setBusy(false);
    }
  }

  async function retryTask(useLatestConfig: boolean) {
    if (!selected || !RETRY_STATES.has(selected.state)) return;
    if (!await confirm({
      title: selected.currentExecutionId ? '作废当前执行并重新开始？' : '重新执行失败任务？',
      description: useLatestConfig
        ? '会作废旧执行并使用当前最新提示词、知识库和生产配置。旧执行的迟到结果将被拒绝。'
        : '会作废旧执行并复用上次配置快照。旧执行的迟到结果将被拒绝。',
      confirmLabel: '确认重新执行',
      tone: selected.currentExecutionId ? 'danger' : 'default',
    })) return;
    setBusy(true);
    try {
      await apiRequest(apiPath(`/v1/tasks/${selected.id}/retry`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLatestConfig }),
      });
      setMessage('已创建新的待执行代次。');
      await refresh({ silent: true });
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '重新执行失败');
    } finally {
      setBusy(false);
    }
  }

  async function approveDelivery() {
    if (!selected || selected.state !== 'DELIVERY_REVIEW_PENDING') return;
    if (!await confirm({
      title: '确认图文审核通过？',
      description: '确认后任务进入已完成状态，图片运行及审核记录仍会保留。',
      confirmLabel: '审核通过',
    })) return;
    setBusy(true);
    try {
      await apiRequest(apiPath(`/v1/tasks/${selected.id}/approve-delivery`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      setMessage('图文审核已通过，任务完成。');
      await refresh({ silent: true });
    } catch (deliveryError) {
      setError(deliveryError instanceof Error ? deliveryError.message : '图文审核提交失败');
    } finally {
      setBusy(false);
    }
  }

  const revision = selected?.copyRevisions.find((item) => item.id === selected.currentCopyRevisionId)
    ?? selected?.copyRevisions[0];
  const reviewed = copyFromRevision(revision);
  const selectedAssets = selected?.assets.filter((asset) => asset.imageRunId === selected.currentImageRunId) ?? [];

  return <div className="distributed-jobs-stack">
    <form className="panel" onSubmit={createTasks}>
      <div className="panel-head">
        <div><span className="section-kicker">Create queries</span><h2>创建本机文案队列</h2></div>
        <FilePlus2 aria-hidden="true" size={20} />
      </div>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="distributed-queries">选题 Query</label>
          <textarea className="textarea" id="distributed-queries" name="queries" required maxLength={50_100} placeholder={'每行一个选题；支持单条或批量创建\n例如：租房桌面怎么低成本整理？'} />
          <small>创建后立即写入远端中心；本机执行代理将严格按任务 ID 顺序逐条生成文案。</small>
        </div>
        <div className="field">
          <label htmlFor="distributed-image-count">配图页数</label>
          <select className="input" id="distributed-image-count" name="imageCount" defaultValue="auto">
            <option value="auto">自动（3–5 页）</option>
            <option value="3">3 页</option>
            <option value="4">4 页</option>
            <option value="5">5 页</option>
          </select>
        </div>
        <div className="field distributed-node-field">
          <label>文案执行节点</label>
          <code>{nodeId}</code>
        </div>
        <div className="field full inline">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <><LoaderCircle className="animate-spin" size={16} />正在提交…</> : <>创建远端任务</>}
          </button>
          <span className="subtle">这里只创建任务，不在页面请求中直接调用模型。</span>
        </div>
      </div>
    </form>

    {!creationOnly && <section className="panel">
      <div className="panel-head">
        <div><span className="section-kicker">Remote source of truth</span><h2>全部作业</h2></div>
        <button className="button small" type="button" disabled={loading || busy} onClick={() => { void refresh(); }}>
          <RefreshCw aria-hidden="true" size={14} />刷新
        </button>
      </div>
      {loading
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取中心任务…</div>
        : tasks.length === 0
          ? <div className="empty-state">中心服务还没有任务。</div>
          : <div className="table-wrap mobile-cards">
            <table>
              <thead><tr><th>ID</th><th>Query</th><th>状态</th><th>节点</th><th>阶段 / 进度</th><th>耗时</th><th>操作</th></tr></thead>
              <tbody>{tasks.map((task) => <tr key={task.id}>
                <td className="mono" data-label="ID">#{task.id}</td>
                <td className="query-cell" data-label="Query">{task.query}</td>
                <td data-label="状态"><span className={`pill${isStale(task) ? ' pill-rejected' : ''}`}>{STATE_LABELS[task.state]}</span></td>
                <td className="mono" data-label="节点">{task.copyExecutorNodeId}</td>
                <td data-label="阶段 / 进度"><div className="distributed-progress"><span>{task.currentStage || '—'} · {task.progressPercent}%</span><small>{isStale(task) ? '长时间无进度，可人工重新执行' : task.progressMessage}</small></div></td>
                <td data-label="耗时"><Clock3 aria-hidden="true" size={13} /> {elapsed(task)}</td>
                <td data-label="操作"><button className="button small" type="button" onClick={() => { void openTask(task.id); }}>查看 / 审核</button></td>
              </tr>)}</tbody>
            </table>
          </div>}
    </section>}

    {selected && <section className="panel distributed-task-detail" aria-live="polite">
      <div className="panel-head">
        <div><span className="section-kicker">Task #{selected.id}</span><h2>{selected.query}</h2></div>
        <button className="button small" type="button" onClick={() => setSelected(null)}>关闭</button>
      </div>
      <dl className="distributed-task-facts">
        <div><dt>状态</dt><dd>{STATE_LABELS[selected.state]}</dd></div>
        <div><dt>开始时间</dt><dd>{selected.executionStartedAt ? new Date(selected.executionStartedAt).toLocaleString('zh-CN') : '—'}</dd></div>
        <div><dt>最后进度</dt><dd>{selected.lastActivityAt ? new Date(selected.lastActivityAt).toLocaleString('zh-CN') : '—'}</dd></div>
        <div><dt>执行代次</dt><dd className="mono">{selected.currentExecutionId ?? '—'}</dd></div>
      </dl>
      {selected.error && <div className="notice error" role="alert">{selected.error}</div>}
      {reviewed.copy && <article className="distributed-copy-review">
        <div className="panel-head"><div><span className="section-kicker">Copy revision {revision?.revision}</span><h3>{reviewed.copy.title}</h3></div></div>
        <div className="review-copy-body">{reviewed.copy.body}</div>
        <div className="review-copy-tags">{reviewed.copy.tags?.map((tag: string) => <span className="pill" key={tag}>{tag}</span>)}</div>
        <details><summary>查看配图策划（{reviewed.imagePlan.length} 页）</summary><pre>{JSON.stringify(reviewed.imagePlan, null, 2)}</pre></details>
      </article>}
      {selectedAssets.length > 0 && <div className="distributed-asset-grid">
        {selectedAssets.map((asset) => <figure key={asset.id}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={apiPath(asset.url)} alt={asset.originalName || `任务 ${selected.id} 图片`} />
          <figcaption>{asset.originalName || `图片 #${asset.id}`}</figcaption>
        </figure>)}
      </div>}
      <div className="inline distributed-task-actions">
        {selected.state === 'COPY_REVIEW_PENDING' && <button className="button primary" type="button" disabled={busy} onClick={() => { void approveCopy(); }}><CheckCircle2 size={15} />审核通过，进入生图队列</button>}
        {selected.state === 'DELIVERY_REVIEW_PENDING' && <button className="button primary" type="button" disabled={busy} onClick={() => { void approveDelivery(); }}><CheckCircle2 size={15} />图文审核通过</button>}
        {RETRY_STATES.has(selected.state) && <>
          <button className="button" type="button" disabled={busy} onClick={() => { void retryTask(false); }}><RotateCcw size={15} />复用原配置重试</button>
          <button className="button" type="button" disabled={busy} onClick={() => { void retryTask(true); }}>使用最新配置重试</button>
        </>}
      </div>
    </section>}

    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
