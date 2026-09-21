export type BackgroundTask = {
  id: string;
  kind: 'IMAGE_PLAN' | 'IMAGE_EDIT' | 'STANDALONE_IMAGE_EDIT';
  taskId: number;
  page?: number;
  status: string;
  createdAt: number;
  updatedAt?: number;
  read: boolean;
  consumed?: boolean;
  error?: string | null;
  pollError?: string;
  payload?: unknown;
};

export function isBackgroundTaskRunning(task: Pick<BackgroundTask, 'status'>) {
  return ['QUEUED', 'RUNNING'].includes(task.status);
}

export function backgroundTaskGroup(task: BackgroundTask) {
  if (isBackgroundTaskRunning(task)) return 'running';
  if (task.status === 'PREVIEW_READY' || task.status === 'SUCCEEDED' && !task.consumed) return 'ready';
  if (!task.read && ['FAILED', 'STALE', 'UNAVAILABLE'].includes(task.status)) return 'failed';
  return 'history';
}

export function backgroundTaskStatus(task: BackgroundTask) {
  if (task.status === 'QUEUED') return '排队中';
  if (task.status === 'RUNNING') return '处理中';
  if (backgroundTaskGroup(task) === 'ready') return '待确认';
  if (['FAILED', 'STALE', 'UNAVAILABLE'].includes(task.status)) return '失败';
  if (task.status === 'SUCCEEDED' && task.consumed) return '已载入草稿';
  if (task.status === 'ACCEPTED') return '已采用';
  return task.status === 'CANCELLED' ? '已取消' : '已拒绝';
}

export function isPlanSourceCurrent(job: { copyRevisionId: number; copy?: { title: string; body: string; tags: string[] } },
  revisionId: number | undefined, copy: { title: string; body: string; tags: string[] } | undefined) {
  return job.copyRevisionId === revisionId && Boolean(job.copy && copy
    && job.copy.title === copy.title && job.copy.body === copy.body
    && JSON.stringify(job.copy.tags) === JSON.stringify(copy.tags));
}

export function backgroundTaskTitle(task: BackgroundTask) {
  if (task.kind === 'STANDALONE_IMAGE_EDIT') return `独立图片编辑 #${task.taskId} · 第 ${task.page ?? 1} 页`;
  return `任务 #${task.taskId} · ${task.kind === 'IMAGE_PLAN' ? '文案规划' : `第 ${task.page ?? 1} 页图片修复`}`;
}

export function backgroundTaskMessage(task: BackgroundTask) {
  if (task.pollError) return '暂时无法获取进度，正在自动重连；后台任务不会因此取消。';
  if (task.status === 'QUEUED') return '排队中，可关闭窗口，完成后会提醒。';
  if (task.status === 'RUNNING') return '处理中，可关闭窗口，完成后会提醒。';
  if (task.status === 'SUCCEEDED') return task.consumed ? '规划已载入草稿，请核对并保存图片规划。' : '规划已完成，请打开任务载入并核对新规划。';
  if (task.status === 'PREVIEW_READY') return '图片修复已完成，请打开“修改图片”检查并采用预览。';
  if (task.status === 'ACCEPTED') return '图片修复结果已采用。';
  if (task.status === 'CANCELLED') return '任务已取消。';
  if (task.status === 'REJECTED') return '图片修复结果已拒绝。';
  if (task.status === 'STALE') return '文案版本已变化，本次规划已失效，请重新生成。';
  if (task.status === 'UNAVAILABLE') return '任务已不存在或当前账号无权查看。';
  return task.error || '处理失败，请打开任务查看原因并重试。';
}

export function backgroundTaskPath(task: BackgroundTask) {
  if (task.kind === 'STANDALONE_IMAGE_EDIT') return `/v1/image-editor/edits/${encodeURIComponent(task.id)}`;
  return task.kind === 'IMAGE_PLAN'
    ? `/v1/tasks/${task.taskId}/regenerate-image-plan/${encodeURIComponent(task.id)}`
    : `/v1/image-edits/${encodeURIComponent(task.id)}`;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
type Snapshot = { status: string; error?: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const statuses = new Set(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STALE', 'PREVIEW_READY', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'UNAVAILABLE']);
const advisoryImageEditPreflightErrors = [
  '源图视觉验收不确定或必需文字缺失，不能安全编辑',
  '真实产品替换前置检查未通过，尚未调用图片编辑模型',
];

function isAdvisoryImageEditPreflightFailure(task: Pick<BackgroundTask, 'kind' | 'status' | 'error'>) {
  return task.kind === 'IMAGE_EDIT' && task.status === 'FAILED' && typeof task.error === 'string'
    && advisoryImageEditPreflightErrors.some(prefix => task.error?.includes(prefix));
}

export function createBackgroundTaskStore({ storage, storageKey, request, onComplete }: {
  storage?: Storage;
  storageKey: string;
  request: (path: string) => Promise<Snapshot>;
  onComplete: (task: BackgroundTask) => void;
}) {
  let tasks: BackgroundTask[] = [];
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  let stopped = false;

  function readSaved(serialized?: string) {
    try {
      const saved: unknown = JSON.parse(serialized ?? storage?.getItem(storageKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter((task): task is BackgroundTask => task
      && uuid.test(task.id) && ['IMAGE_PLAN', 'IMAGE_EDIT', 'STANDALONE_IMAGE_EDIT'].includes(task.kind)
      && Number.isSafeInteger(task.taskId) && task.taskId > 0 && statuses.has(task.status)
      && Number.isFinite(task.createdAt) && typeof task.read === 'boolean'
      && (task.updatedAt === undefined || Number.isFinite(task.updatedAt))
      && (task.consumed === undefined || typeof task.consumed === 'boolean'))
      .map(({ payload: _payload, pollError: _pollError, ...task }) => isAdvisoryImageEditPreflightFailure(task)
        ? { ...task, read: true }
        : task) : [];
    } catch { return []; }
  }
  tasks = readSaved();

  function sync(serialized?: string) {
    if (stopped) return;
    let changed = false;
    const merged = new Map(tasks.map(task => [task.id, task]));
    // Merge the event snapshot too: a second tab may already have overwritten
    // the shared array before this tab receives the first storage event.
    for (const saved of [...(serialized === undefined ? [] : readSaved(serialized)), ...readSaved()]) {
      const local = merged.get(saved.id);
      if (!local || saved.createdAt > local.createdAt) { merged.set(saved.id, saved); changed = true; continue; }
      if (saved.createdAt < local.createdAt) continue;
      const savedTime = saved.updatedAt ?? saved.createdAt, localTime = local.updatedAt ?? local.createdAt;
      const savedFinished = !isBackgroundTaskRunning(saved), localFinished = !isBackgroundTaskRunning(local);
      const latest = savedFinished !== localFinished ? savedFinished ? saved : local : savedTime > localTime ? saved : local;
      const next = { ...latest, read: saved.status === local.status ? local.read || saved.read : latest.read, consumed: local.consumed || saved.consumed,
        ...(latest.status === local.status ? { payload: local.payload, pollError: local.pollError } : {}) };
      if (next.updatedAt !== local.updatedAt || next.status !== local.status || next.read !== local.read
          || Boolean(next.consumed) !== Boolean(local.consumed) || next.error !== local.error) { merged.set(saved.id, next); changed = true; }
    }
    if (changed) {
      tasks = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      if (serialized !== undefined) publish();
      else listeners.forEach(listener => listener());
    }
  }

  function publish() {
    if (stopped) return;
    // Keep unfinished work and unacknowledged results even when history grows.
    let history = 0;
    tasks = tasks.filter(task => isBackgroundTaskRunning(task) || !task.read
      || backgroundTaskGroup(task) === 'ready' || ++history <= 50);
    try { storage?.setItem(storageKey, JSON.stringify(tasks.map(({ payload: _payload, pollError: _pollError, ...task }) => task))); } catch {}
    listeners.forEach(listener => listener());
  }

  function track(input: Pick<BackgroundTask, 'id' | 'kind' | 'taskId' | 'status'> & Partial<BackgroundTask>, restart = false) {
    if (stopped || !uuid.test(input.id) || !statuses.has(input.status)
        || !Number.isSafeInteger(input.taskId) || input.taskId <= 0) return;
    sync();
    const current = tasks.find(task => task.id === input.id);
    if (current && !restart) return;
    const createdAt = Math.max(Date.now(), (current?.createdAt ?? 0) + 1);
    const candidate: BackgroundTask = { ...input, createdAt, updatedAt: createdAt, read: false };
    const task: BackgroundTask = isAdvisoryImageEditPreflightFailure(candidate) ? { ...candidate, read: true } : candidate;
    tasks = [task, ...tasks.filter(item => item.id !== task.id)];
    publish();
    if (!isBackgroundTaskRunning(task) && !isAdvisoryImageEditPreflightFailure(task)) onComplete(task);
  }

  async function poll() {
    if (stopped) return;
    sync();
    await Promise.allSettled(tasks.filter(task => isBackgroundTaskRunning(task)
      || ['IMAGE_EDIT','STANDALONE_IMAGE_EDIT'].includes(task.kind) && task.status === 'PREVIEW_READY'
      || task.kind === 'IMAGE_PLAN' && task.status === 'SUCCEEDED' && !task.consumed && !task.payload).map(async task => {
      if (inFlight.has(task.id)) return;
      inFlight.add(task.id);
      try {
        const payload = await request(backgroundTaskPath(task));
        sync();
        if (stopped || tasks.find(item => item.id === task.id) !== task) return;
        if (!payload || !statuses.has(payload.status)) throw new Error('任务状态暂不可用');
        const finished = isBackgroundTaskRunning(task) && !isBackgroundTaskRunning(payload);
        const candidate = { ...task, status: payload.status, error: payload.error, pollError: undefined, payload, read: finished ? false : task.read,
          updatedAt: Math.max(Date.now(), (task.updatedAt ?? task.createdAt) + 1) };
        const next = isAdvisoryImageEditPreflightFailure(candidate) ? { ...candidate, read: true } : candidate;
        tasks = tasks.map(item => item.id === task.id ? next : item);
        publish();
        if (finished && !isAdvisoryImageEditPreflightFailure(next)) onComplete(next);
      } catch (error) {
        sync();
        if (stopped || tasks.find(item => item.id === task.id) !== task) return;
        const status = (error as { status?: number })?.status;
        const unavailable = status === 403 || status === 404;
        const next = { ...task, ...(unavailable ? { status: 'UNAVAILABLE', read: false } : {}),
          pollError: unavailable ? undefined : '暂时无法获取进度', updatedAt: Math.max(Date.now(), (task.updatedAt ?? task.createdAt) + 1) };
        tasks = tasks.map(item => item.id === task.id ? next : item);
        publish();
        if (unavailable) onComplete(next);
      } finally { inFlight.delete(task.id); }
    }));
  }

  return {
    getSnapshot: () => tasks,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    track,
    poll,
    sync,
    stop() { stopped = true; },
    markRead(id: string) { sync(); tasks = tasks.map(task => task.id === id && !isBackgroundTaskRunning(task) ? { ...task, read: true } : task); publish(); },
    markAllRead() { sync(); tasks = tasks.map(task => isBackgroundTaskRunning(task) ? task : { ...task, read: true }); publish(); },
    consumePlan(id: string) { sync(); tasks = tasks.map(task => task.id === id ? { ...task, consumed: true, read: true } : task); publish(); },
  };
}
