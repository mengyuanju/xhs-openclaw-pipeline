'use client';

import { CheckCheck, ClipboardCheck, History, LoaderCircle, PanelLeftClose, PanelLeftOpen, RefreshCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest } from '../components/api-client';
import { useBackgroundTasks } from '../components/background-tasks';
import { backgroundTaskGroup, backgroundTaskStatus, type BackgroundTask } from '../components/background-task-store';
import { subscribeWorkspaceUpdates } from '../components/workspace-updates';
import { TaskReviewDialog } from '../workbench/task-review-dialog';
import { normalizeCopyQaItem, copyRevisionView } from '../copy-qa/types';
import { normalizeImageQaItem } from '../image-qa/types';
import { WorkQualityEditor } from './work-quality-editor';
import { WORK_LABELS, isTaskPending, workItemKey, type WorkItem, type WorkKind, type WorkPage } from './types';
import styles from './work-mode.module.css';

const apiPath = (path: string) => `/api/control-plane${path}`;
const PAGE_SIZE = 50;
type CopyQaKindFilter = 'ALL' | 'RANDOM' | 'MANDATORY_RECHECK';
const COPY_QA_KIND_LABELS: Record<CopyQaKindFilter, string> = {
  ALL: '全部', MANDATORY_RECHECK: '强制复检', RANDOM: '第一次抽检',
};
const COPY_QA_KIND_OPTIONS: CopyQaKindFilter[] = ['ALL', 'MANDATORY_RECHECK', 'RANDOM'];

export function WorkMode({ kinds: initialKinds, role, nodeId, username, accountId }: {
  kinds: WorkKind[]; role: string; nodeId: string; username: string; accountId: number;
}) {
  const { tasks: backgroundTasks, registerTaskOpener } = useBackgroundTasks();
  const [kinds, setKinds] = useState(initialKinds);
  const [kind, setKind] = useState(initialKinds[0]);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [counts, setCounts] = useState<Partial<Record<WorkKind, string>>>({});
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [copyQaKind, setCopyQaKind] = useState<CopyQaKindFilter>('ALL');
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const queueContentsId = useId();
  const [history, setHistory] = useState<Array<{ key: string; label: string; kind: WorkKind; message: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const selectedRef = useRef<WorkItem | null>(null);
  const kindRef = useRef(kind);
  const copyQaKindRef = useRef(copyQaKind);
  const itemsRef = useRef(items);
  const requestId = useRef(0);
  const completedKeys = useRef(new Set<string>());
  const navigationGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const navigatingRef = useRef(false);
  const preferenceKey = `xhs.work-mode.kind.${accountId}`;
  const positionKey = `xhs.work-mode.position.${accountId}`;
  const queuePreferenceKey = `xhs.work-mode.queue-collapsed.${accountId}`;

  useEffect(() => {
    try { setQueueCollapsed(localStorage.getItem(queuePreferenceKey) === 'true'); }
    catch { setQueueCollapsed(false); }
  }, [queuePreferenceKey]);

  function toggleQueue() {
    const collapsed = !queueCollapsed;
    setQueueCollapsed(collapsed);
    try { localStorage.setItem(queuePreferenceKey, String(collapsed)); } catch { /* optional preference */ }
  }

  const select = useCallback((item: WorkItem | null) => {
    selectedRef.current = item; setSelected(item);
    try {
      if (item) sessionStorage.setItem(positionKey, JSON.stringify({ kind: item.kind, id: item.id }));
      else sessionStorage.removeItem(positionKey);
    } catch { /* Position is optional and local to this tab. */ }
  }, [positionKey]);
  const updateItems = useCallback((next: WorkItem[]) => { itemsRef.current = next; setItems(next); }, []);

  const fetchPage = useCallback(async (requestedKind: WorkKind, offset = 0, itemId?: string, requestedCopyQaKind: CopyQaKindFilter = copyQaKindRef.current) => {
      const page = await apiRequest<WorkPage>(apiPath(`/v1/work-mode/items?kind=${requestedKind}&limit=${PAGE_SIZE}&offset=${offset}${requestedKind === 'COPY_QA' ? `&sampleKind=${requestedCopyQaKind}` : ''}${itemId ? `&itemId=${encodeURIComponent(itemId)}` : ''}`));
      if (!page || page.kind !== requestedKind || !Array.isArray(page.items) || !Array.isArray(page.kinds)) throw new Error('中心返回的作业数据不完整，请更新中心服务后重试。');
      const rows = page.items.map(item => {
        if (item.kind !== requestedKind) throw new Error('中心返回了不同类型的作业，请刷新后重试。');
        if (item.kind === 'COPY_QA') {
          const qa = normalizeCopyQaItem(item.qa, { role });
          if (!qa) throw new Error('文案质检数据不完整');
          if (requestedCopyQaKind !== 'ALL' && qa.sampleKind !== requestedCopyQaKind) throw new Error('中心返回了不同分类的文案质检项，请更新中心服务后重试。');
          return { ...item, qa, label: copyRevisionView(qa.approvedRevision.content).title || qa.anonymousCode };
        }
        if (item.kind === 'IMAGE_QA') {
          const qa = normalizeImageQaItem(item.qa, role as 'ADMIN' | 'REVIEWER');
          if (!qa) throw new Error('图片质检数据不完整');
          return { ...item, qa };
        }
        return item;
      });
      return { ...page, items: rows };
  }, [role]);

  const load = useCallback(async (requestedKind: WorkKind, { append = false, autoSelect = false, selectId }: { append?: boolean; autoSelect?: boolean; selectId?: string } = {}) => {
    const sequence = ++requestId.current;
    const requestedCopyQaKind = copyQaKindRef.current;
    const offset = append ? itemsRef.current.length : 0;
    setLoading(true); setError('');
    try {
      const page = await fetchPage(requestedKind, offset, undefined, requestedCopyQaKind);
      const rows = page.items;
      const restored = selectId ? rows.find(row => row.id === selectId)
        ?? (await fetchPage(requestedKind, 0, selectId, requestedCopyQaKind)).items.find(row => row.id === selectId) : undefined;
      if (sequence !== requestId.current || kindRef.current !== requestedKind || (requestedKind === 'COPY_QA' && copyQaKindRef.current !== requestedCopyQaKind)) return;
      const merged = append ? [...itemsRef.current, ...rows.filter(row => !itemsRef.current.some(old => workItemKey(old) === workItemKey(row)))] : rows;
      updateItems(merged); setHasMore(page.hasMore); setKinds(page.kinds);
      setCounts(old => ({ ...old, [requestedKind]: page.total === null ? `${merged.length}+` : String(page.total) }));
      if (autoSelect || !selectedRef.current) select(restored ?? merged[0] ?? null);
      if (selectId && !restored) setNotice('上次作业已不在当前待办中，已为你打开下一条。');
      // Keep the mounted editor and its draft if the task was changed elsewhere.
      // The existing mutation APIs verify ownership and version at submission.
      if (!append && !restored && selectedRef.current && !merged.some(row => workItemKey(row) === workItemKey(selectedRef.current!))) {
        setNotice('当前内容已不在首批待办中。编辑内容已保留；可保存草稿后切换，提交时系统会再次校验当前版本和权限。');
      }
    } catch (caught) {
      if (sequence === requestId.current) setError(caught instanceof Error ? caught.message : '待办读取失败，请重试');
    } finally { if (sequence === requestId.current) setLoading(false); }
  }, [fetchPage, select, updateItems]);

  useEffect(() => {
    let preferred = initialKinds[0];
    let selectId: string | undefined;
    try { const saved = localStorage.getItem(preferenceKey) as WorkKind; if (initialKinds.includes(saved)) preferred = saved; } catch { /* optional preference */ }
    try {
      const saved = JSON.parse(sessionStorage.getItem(positionKey) ?? 'null');
      const validId = typeof saved?.id === 'string' && (['COPY', 'IMAGE'].includes(saved.kind)
        ? /^[1-9]\d*$/u.test(saved.id) && Number.isSafeInteger(Number(saved.id))
        : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(saved.id));
      if (saved && initialKinds.includes(saved.kind) && validId) {
        preferred = saved.kind; selectId = saved.id;
      }
    } catch { /* Ignore invalid saved positions. */ }
    kindRef.current = preferred; setKind(preferred); void load(preferred, { autoSelect: true, selectId });
    return () => { requestId.current += 1; };
  }, [initialKinds, load, preferenceKey, positionKey]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && !loading && !navigatingRef.current && itemsRef.current.length <= PAGE_SIZE) void load(kindRef.current);
    };
    const timer = window.setInterval(refresh, 30_000);
    const unsubscribe = subscribeWorkspaceUpdates(refresh);
    return () => { window.clearInterval(timer); unsubscribe(); };
  }, [load, loading]);

  const navigate = useCallback(async (action: () => void, prepare?: () => Promise<boolean>) => {
    if (navigatingRef.current) return false;
    navigatingRef.current = true; setNavigating(true);
    try {
      if (prepare && !await prepare()) return false;
      // Save immediately before switching, including edits made during lookup.
      if (navigationGuardRef.current && !await navigationGuardRef.current()) return false;
      action(); return true;
    }
    finally { navigatingRef.current = false; setNavigating(false); }
  }, []);

  useEffect(() => registerTaskOpener(async (task: BackgroundTask) => {
    let target: WorkItem | undefined;
    let firstPage: WorkPage | undefined;
    const preferred: WorkKind = task.kind === 'IMAGE_PLAN' ? 'COPY' : 'IMAGE';
    return navigate(() => {
      if (!target) return;
      requestId.current += 1; setLoading(false); setError(''); setQuery('');
      if (firstPage) {
        const page = firstPage, nextKind = target.kind;
        kindRef.current = nextKind; setKind(nextKind); updateItems(page.items);
        setHasMore(page.hasMore); setKinds(page.kinds);
        setCounts(old => ({ ...old, [nextKind]: page.total === null ? `${page.items.length}+` : String(page.total) }));
        try { localStorage.setItem(preferenceKey, target.kind); } catch { /* optional preference */ }
      }
      select(target);
      setNotice(`已打开作业 #${task.taskId}。${task.kind === 'IMAGE_PLAN' ? '请在图片文案规划中核对生成结果。' : `请打开第 ${task.page ?? 1} 页的“修改图片”检查并采用预览。`}`);
    }, async () => {
      for (const candidate of [preferred, preferred === 'COPY' ? 'IMAGE' : 'COPY'] as WorkKind[]) {
        if (!kinds.includes(candidate)) continue;
        const page = await fetchPage(candidate, 0, String(task.taskId));
        target = page.items.find(row => row.taskId === task.taskId);
        if (target) break;
      }
      if (!target) { setError('该任务已不在你的文案或图片待办中，可能已提交、暂停或转交。当前编辑内容已保留，可在作业进度与历史中查看。'); return false; }
      if (target.kind !== kindRef.current) firstPage = await fetchPage(target.kind);
      return true;
    });
  }), [fetchPage, kinds, navigate, preferenceKey, registerTaskOpener, select, updateItems]);

  function switchKind(next: WorkKind) {
    if (next === kind) return;
    void navigate(() => {
      kindRef.current = next; setKind(next); updateItems([]); select(null); setQuery(''); setNotice(''); setHasMore(false);
      try { localStorage.setItem(preferenceKey, next); } catch { /* optional preference */ }
      void load(next, { autoSelect: true });
    });
  }

  function switchCopyQaKind(next: CopyQaKindFilter) {
    if (next === copyQaKind) return;
    void navigate(() => {
      copyQaKindRef.current = next; setCopyQaKind(next); updateItems([]); select(null); setQuery(''); setNotice(''); setHasMore(false);
      setCounts(old => ({ ...old, COPY_QA: undefined }));
      void load('COPY_QA', { autoSelect: true });
    });
  }

  function skip(item: WorkItem) {
    if (!selectedRef.current || workItemKey(selectedRef.current) !== workItemKey(item)) return;
    void navigate(() => {
      const rest = itemsRef.current.filter(row => workItemKey(row) !== workItemKey(item));
      if (!rest.length) { setNotice('这是当前最后一条已加载待办，暂跳过不会将它移出。'); return; }
      const wasLoaded = rest.length !== itemsRef.current.length;
      updateItems(wasLoaded ? [...rest, item] : rest); select(rest[0]); setNotice('已暂跳过，本条仍保留在待办中。');
    });
  }

  function finish(item: WorkItem, message: string, submitted = true) {
    const receipt = `${workItemKey(item)}:${item.version ?? ''}`;
    if (submitted && !completedKeys.current.has(receipt)) {
      completedKeys.current.add(receipt);
      setHistory(old => [...old, { key: receipt, label: item.label, kind: item.kind, message }]);
    }
    if (kindRef.current !== item.kind) return;
    requestId.current += 1;
    const rest = itemsRef.current.filter(row => workItemKey(row) !== workItemKey(item));
    updateItems(rest);
    if (selectedRef.current && workItemKey(selectedRef.current) === workItemKey(item)) select(rest[0] ?? null);
    setNotice(message); setQuery('');
    // Restart at the first page after a removal: an incrementing offset skips
    // rows in a shrinking queue. Fetch failures never undo a confirmed receipt.
    void load(item.kind);
  }

  function detailLoaded(item: WorkItem, task: { id: number; state: string }) {
    if (task.id === item.taskId && !isTaskPending(item.kind, task.state)) finish(item, `作业 #${task.id} 已转入后续流程，已移出当前待办。`, false);
  }

  // A directly opened task may be beyond the loaded page. Keep it visible without
  // including it in pagination offsets, which would skip a queued row.
  const queueItems = selected && !items.some(item => workItemKey(item) === workItemKey(selected)) ? [selected, ...items] : items;
  const visible = queueItems.filter(item => !query.trim() || `${item.label} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <div className={styles.page}>
    <header className={styles.heading}><div><h1>作业模式</h1><p>专注当前内容，处理完就进入下一条。</p></div>
      <Button unstyled className={styles.historyButton} onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}><History size={16} />本次已提交 <strong>{history.length}</strong></Button>
    </header>
    <div className={styles.types} role="group" aria-label="作业类型">{kinds.map(value => <Button unstyled key={value} aria-pressed={kind === value} disabled={navigating}
      onClick={() => switchKind(value)}>{WORK_LABELS[value]}{counts[value] !== undefined && <span>{value === 'COPY_QA' && copyQaKind !== 'ALL' ? `${COPY_QA_KIND_LABELS[copyQaKind]} ${counts[value]}` : counts[value]}</span>}</Button>)}</div>
    {kind === 'COPY_QA' && <div className={styles.copyQaKinds} role="group" aria-label="文案质检分类"><span>分类</span>{COPY_QA_KIND_OPTIONS.map(value =>
      <Button unstyled key={value} type="button" aria-pressed={copyQaKind === value} disabled={navigating} onClick={() => switchCopyQaKind(value)}>{COPY_QA_KIND_LABELS[value]}</Button>)}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {error && <div className="notice error" role="alert">{error} <Button unstyled className="button small" disabled={loading} onClick={() => void load(kind)}>重试读取</Button></div>}
    {showHistory && <section className={styles.history}><h2>本次提交记录</h2>{!history.length && <p>保存草稿和暂跳过不计入已提交。</p>}{[...history].reverse().map(row => <div key={row.key}><strong>{row.label}</strong><span>{WORK_LABELS[row.kind]} · {row.message}</span></div>)}</section>}
    <div className={styles.workspace} data-queue-collapsed={queueCollapsed}>
      <aside className={styles.queue} aria-label="待处理作业">
        <div className={styles.queueHeading}>
          <strong>待处理 {counts[kind] ?? '—'}</strong>
          <div className={styles.queueActions}>
            <Button unstyled className={styles.queueRefresh} aria-label="刷新待办" disabled={loading} onClick={() => void load(kind)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></Button>
            <Button unstyled type="button" aria-label={queueCollapsed ? '展开待办侧栏' : '收起待办侧栏'} title={queueCollapsed ? '展开待办侧栏' : '收起待办侧栏'}
              aria-expanded={!queueCollapsed} aria-controls={queueContentsId} onClick={toggleQueue}>
              {queueCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
        </div>
        {queueCollapsed && <span className={styles.queueCount} title={`待处理 ${counts[kind] ?? '—'}`} aria-label={`待处理 ${counts[kind] ?? '—'}`}>{counts[kind] ?? '—'}</span>}
        <div id={queueContentsId} className={styles.queueContents} hidden={queueCollapsed}>
          <label className={styles.search}><Search size={15} /><Input aria-label="筛选已加载待办" placeholder="筛选已加载待办" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className={styles.list}>{visible.map(item => <Button unstyled className={styles.item} key={workItemKey(item)} disabled={navigating}
            aria-pressed={selected !== null && workItemKey(selected) === workItemKey(item)} onClick={() => { if (selected?.id !== item.id) void navigate(() => select(item)); }}>
            <span className={styles.itemMeta}>{item.taskId ? `#${item.taskId}` : item.qa?.anonymousCode}{item.kind === 'COPY_QA'
              ? <em data-kind={item.qa?.sampleKind === 'MANDATORY_RECHECK' ? 'mandatory' : 'random'}>{item.qa?.sampleKind === 'MANDATORY_RECHECK' ? '强制复检' : '第一次抽检'}</em>
              : item.rework && <em>{item.kind.endsWith('QA') ? '强制复检' : '需要返工'}</em>}</span>
            <strong>{item.label}</strong><small>{item.source || (item.qa?.blindReview ? '匿名内容' : '分配给我的作业')}</small>
            {item.taskId && <span className={styles.backgroundStates}>{backgroundTasks.filter(task => task.taskId === item.taskId
              && backgroundTaskGroup(task) !== 'history').map(task => <span key={task.id} data-state={backgroundTaskGroup(task)}>
                {task.kind === 'IMAGE_PLAN' ? '规划' : `第 ${task.page ?? 1} 页修复`} · {backgroundTaskStatus(task)}
              </span>)}</span>}
          </Button>)}</div>
          {loading && !items.length && <div className={styles.queueEmpty}><LoaderCircle className="animate-spin" size={18} />正在读取待办…</div>}
          {!loading && !visible.length && <p className={styles.queueEmpty}>{query ? '没有匹配的已加载待办' : error ? '读取失败，请重试' : kind === 'COPY_QA' && copyQaKind !== 'ALL' ? `当前没有待处理的${COPY_QA_KIND_LABELS[copyQaKind]}项` : '当前暂无待办'}</p>}
          {hasMore && <Button unstyled className={styles.loadMore} disabled={loading} onClick={() => void load(kind, { append: true })}>{loading ? '正在加载…' : '加载更多待办'}</Button>}
        </div>
      </aside>
      <div className={styles.editor}>
        {selected?.taskId ? <TaskReviewDialog key={workItemKey(selected)} embedded taskId={selected.taskId} nodeId={nodeId}
          role={role} currentUsername={username} currentAccountId={accountId} navigationGuardRef={navigationGuardRef}
          onDetailLoaded={task => detailLoaded(selected, task)}
          onOpenChange={open => { if (!open) skip(selected); }}
          onUpdated={(message, completedTaskId) => { if (completedTaskId === selected.taskId) finish(selected, message); else { setNotice(message); void load(selected.kind); } }} />
          : selected?.qa ? <WorkQualityEditor key={workItemKey(selected)} item={selected}
            navigationGuardRef={navigationGuardRef} onSkip={() => skip(selected)} onCompleted={message => finish(selected, message)} />
          : <div className={styles.empty}><ClipboardCheck size={36} /><h2>{loading ? '正在读取待办' : error ? '暂时无法读取作业' : '当前暂无待处理作业'}</h2>
            <p>{error ? '请重试读取，已有提交记录不会丢失。' : '新的作业和需要返工的内容会显示在这里。'}</p>
            <Button unstyled className="button" disabled={loading} onClick={() => void load(kind, { autoSelect: true })}>刷新待办</Button></div>}
      </div>
    </div>
    <footer className={styles.caption}><span><CheckCheck size={15} />只展示当前需要你处理的内容</span><Link href="/workbench/personal">查看作业进度与历史</Link></footer>
  </div>;
}
