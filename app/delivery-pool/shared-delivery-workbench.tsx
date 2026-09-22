'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, PackageCheck, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { apiRequest, ApiRequestError } from '../components/api-client';
import { subscribeWorkspaceUpdates } from '../components/workspace-updates';
import { WorkbenchPagination } from '../workbench/workbench-pagination';
import { normalizePreparedDeliveryExport } from './types';
import styles from './shared-delivery.module.css';

type Item = {
  itemId: number | null; entryId: number | null; taskId: number; query: string; copyRevisionId: number; imageRunId: string;
  packageName: string | null; clientBatchCode: string | null; assigneeUsername: string | null; ownerUsername: string | null;
  batchCode: string | null; state: 'UNPACKED' | 'PACKED' | 'DELIVERED'; packedAt: string | null; packedBy: string | null;
  deliveredAt: string | null; deliveredBy: string | null; readyAt: string; updatedAt: string; archivedAt: string | null;
  canConfirm: boolean; downloadedByMe: boolean; isCurrent: boolean; versionUpdated: boolean;
  batchVisibleCount: number; batchDeliveredCount: number;
};
type Filters = { view: string; state: string; dateField: string; from: string; to: string; search: string;
  assigneeId: string; deliveredById: string; packedById: string; archiveState: string; versionState: string; packageName: string; clientBatchCode: string };
type Summary = { total: number; unpacked: number; packed: number; delivered: number; updated: number };
type Page = { items: Item[]; total: number; summary: Summary; updatedAt: string };
type Job = { id: number; kind: string; status: string; itemCount: number; createdBy: string; createdAt: string; finishedAt: string | null; error: string | null;
  downloadCount: number; lastDownloadedAt: string | null;
  artifacts: { part: number; fileName: string; byteSize: number }[] };
type DownloadState = { job: Job; phase: 'WAITING' | 'STARTED' | 'FAILED'; error: string };
type UserOption = { id: number; username: string; displayName?: string; role?: string; status?: string };
const emptySummary: Summary = { total: 0, unpacked: 0, packed: 0, delivered: 0, updated: 0 };
const labels = { UNPACKED: '待打包', PACKED: '已打包，待交付', DELIVERED: '已交付' };
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const key = (item: Item) => `${item.taskId}:${item.copyRevisionId}:${item.imageRunId}`;
function initialFilters(history: boolean): Filters {
  return { view: history ? 'HISTORY' : 'CURRENT', state: 'ALL', dateField: history ? 'DELIVERED' : 'READY', from: '', to: '', search: '',
    assigneeId: '', deliveredById: '', packedById: '', archiveState: 'ALL', versionState: 'ALL', packageName: '', clientBatchCode: '' };
}
function download(url: string, name: string) {
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
}
function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <label className={styles.field}><span>{label}</span><Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>
      {options.map(([id, text]) => <SelectItem key={id} value={id}>{text}</SelectItem>)}
    </SelectContent></Select></label>;
}

export function SharedDeliveryWorkbench({ role, historyOnly = false, refreshKey = 0, initialState = 'ALL' }: { role: 'ADMIN' | 'USER'; historyOnly?: boolean; refreshKey?: number; initialState?: string }) {
  const confirm = useConfirmDialog();
  const [filters, setFilters] = useState(() => initialFilters(historyOnly));
  const [draft, setDraft] = useState(filters);
  const [initialized, setInitialized] = useState(false);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState<Page>({ items: [], total: 0, summary: emptySummary, updatedAt: '' });
  const [selected, setSelected] = useState<Item[]>([]), [allFiltered, setAllFiltered] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]), [jobTotal, setJobTotal] = useState(0), [jobPage, setJobPage] = useState(1);
  const [showJobs, setShowJobs] = useState(false), [busy, setBusy] = useState(''), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const pendingDownloadId = downloadState?.phase === 'WAITING' ? downloadState.job.id : null;
  const [users, setUsers] = useState<UserOption[]>([]);
  const requestId = useRef(0), jobRequestId = useRef(0), failures = useRef(0), mounted = useRef(true);

  useEffect(() => {
    const restore = () => {
      const value = { ...initialFilters(historyOnly), state: initialState };
      if (!historyOnly) {
        const query = new URLSearchParams(window.location.search);
        for (const field of Object.keys(value) as (keyof Filters)[]) if (query.has(`dl_${field}`)) value[field] = query.get(`dl_${field}`)!;
      }
      setFilters(value); setDraft(value); setPage(1); setSelected([]); setAllFiltered(false); setInitialized(true);
    };
    restore(); window.addEventListener('popstate', restore);
    mounted.current = true;
    return () => { mounted.current = false; window.removeEventListener('popstate', restore); requestId.current++; jobRequestId.current++; };
  }, [historyOnly, initialState]);

  const apply = useCallback((value: Filters) => {
    setFilters(value); setDraft(value); setPage(1); setSelected([]); setAllFiltered(false);
    if (!historyOnly) {
      const url = new URL(window.location.href);
      for (const field of Object.keys(value) as (keyof Filters)[]) {
        if (value[field]) url.searchParams.set(`dl_${field}`, value[field]); else url.searchParams.delete(`dl_${field}`);
      }
      window.history.replaceState(null, '', url);
    }
  }, [historyOnly]);

  const load = useCallback(async (silent = false) => {
    const id = ++requestId.current;
    if (!silent) setLoading(true);
    try {
      const query = new URLSearchParams({ ...filters, limit: String(pageSize), offset: String((page - 1) * pageSize) });
      const data = await apiRequest<Page>(`/api/control-plane/v1/delivery-items?${query}`, { cache: 'no-store' });
      if (id !== requestId.current || !mounted.current) return;
      setResult(data); failures.current = 0; setError('');
      if (page > Math.max(1, Math.ceil(data.total / pageSize))) setPage(Math.max(1, Math.ceil(data.total / pageSize)));
      setSelected(previous => previous.map(item => data.items.find(row => key(row) === key(item)) ?? item));
    } catch (caught) {
      if (id === requestId.current && mounted.current) {
        failures.current++;
        setError(caught instanceof ApiRequestError && caught.status === 404
          ? '中心服务尚未启用共享交付，请先升级中心并应用交付迁移' : caught instanceof Error ? caught.message : '交付记录读取失败');
      }
    } finally { if (id === requestId.current && mounted.current) setLoading(false); }
  }, [filters, page, pageSize]);

  const loadJobs = useCallback(async () => {
    const id = ++jobRequestId.current;
    try {
      const data = await apiRequest<{ items: Job[]; total: number }>(`/api/control-plane/v1/delivery-archives?limit=10&offset=${(jobPage - 1) * 10}`, { cache: 'no-store' });
      if (id !== jobRequestId.current || !mounted.current) return;
      setJobs(data.items); setJobTotal(data.total);
    } catch (caught) { if (id === jobRequestId.current && mounted.current) setError(caught instanceof Error ? caught.message : '文件记录读取失败'); }
  }, [jobPage]);

  useEffect(() => {
    if (pendingDownloadId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const job = await apiRequest<Job>(`/api/control-plane/v1/delivery-archives/${pendingDownloadId}`, { cache: 'no-store', signal: controller.signal });
        if (cancelled) return;
        setJobs(previous => previous.map(value => value.id === job.id ? job : value));
        if (job.status === 'FAILED' || (job.status === 'SUCCEEDED' && !job.artifacts.length)) {
          setDownloadState({ job, phase: 'FAILED', error: job.error || (job.status === 'FAILED' ? '文件生成失败，请按原范围重试' : '文件生成完成，但没有可下载的文件') });
          return;
        }
        if (job.status === 'SUCCEEDED') {
          setDownloadState({ job, phase: 'STARTED', error: '' });
          for (const artifact of job.artifacts) download(`/api/control-plane/v1/delivery-archives/${job.id}/download/${artifact.part}`, artifact.fileName);
          window.setTimeout(() => { if (mounted.current) void load(true); }, 1500);
          return;
        }
        setDownloadState({ job, phase: 'WAITING', error: '' });
        timer = setTimeout(() => void poll(), 2000);
      } catch (caught) {
        if (cancelled) return;
        const stop = caught instanceof ApiRequestError && [400, 401, 403, 404].includes(caught.status);
        setDownloadState(previous => previous && { ...previous, phase: stop ? 'FAILED' : 'WAITING',
          error: `读取文件进度失败：${caught instanceof Error ? caught.message : '网络异常'}。${stop ? '请在文件记录中查看或重新登录后重试。' : '正在自动重试。'}` });
        if (!stop) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [pendingDownloadId, load]);

  useEffect(() => { if (initialized) void load(); }, [load, initialized, refreshKey]);
  useEffect(() => { if (showJobs) void loadJobs(); }, [loadJobs, showJobs]);
  useEffect(() => {
    if (!initialized) return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { if (document.visibilityState === 'visible' && !busy) { void load(true); if (showJobs) void loadJobs(); } };
    const tick = () => { refresh(); timer = setTimeout(tick, failures.current ? 60_000 : 15_000); };
    timer = setTimeout(tick, 15_000);
    const unsubscribe = subscribeWorkspaceUpdates(refresh);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearTimeout(timer); unsubscribe(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [initialized, load, loadJobs, showJobs, busy]);

  useEffect(() => {
    if (role !== 'ADMIN') return;
    let cancelled = false;
    void apiRequest<{ items?: UserOption[] } | UserOption[]>('/api/control-plane/v1/users')
      .then(data => { if (!cancelled) setUsers(Array.isArray(data) ? data : data.items ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [role]);

  const perform = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(''); setMessage('');
    try { await action(); await load(true); if (showJobs) await loadJobs(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '操作失败'); }
    finally { setBusy(''); }
  };
  const toggle = (items: Item[], checked: boolean) => {
    setAllFiltered(false);
    setSelected(previous => checked ? [...new Map([...previous, ...items].map(item => [key(item), item])).values()].slice(0, 200)
      : previous.filter(item => !items.some(row => key(row) === key(item))));
  };
  const selectedKeys = new Set(selected.map(key));
  const allPageChecked = result.items.length > 0 && result.items.every(item => selectedKeys.has(key(item)));
  const canPack = selected.length > 0 && selected.every(item => item.state === 'UNPACKED' && item.isCurrent);
  const canDownload = selected.length > 0 && selected.every(item => item.itemId !== null);
  const canConfirm = selected.length > 0 && selected.every(item => item.canConfirm);
  const canArchive = selected.length > 0 && selected.every(item => item.state === 'DELIVERED');

  const pack = () => perform('打包', async () => {
    if (!await confirm({ title: `打包 ${selected.length} 条内容？`, description: '将冻结当前选择的文案和图片版本并下载。实际发送给接收方后，再确认交付。', confirmLabel: '打包并下载' })) return;
    const prepared = normalizePreparedDeliveryExport(await apiRequest('/api/control-plane/v1/delivery-pool/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'SELECTED', taskIds: selected.map(item => item.taskId),
        expectedBindings: selected.map(item => ({ taskId: item.taskId, copyRevisionId: item.copyRevisionId, imageRunId: item.imageRunId })) }),
    }));
    download(`/api/control-plane/v1/delivery-pool/archive/${encodeURIComponent(prepared.downloadId)}`, prepared.fileName);
    setSelected([]); setMessage(`${prepared.batchCode ?? '交付包'}已创建并开始下载；实际发送后，请确认已交付。`);
    window.setTimeout(() => { if (mounted.current) void load(true); }, 1500);
  });
  const confirmItems = () => perform('确认交付', async () => {
    if (!await confirm({ title: `确认 ${selected.length} 条已实际交付？`, description: `任务：${selected.map(item => `#${item.taskId}`).join('、')}。提交后管理员和标注共同看到确认人及确认时间。`, confirmLabel: '确认已交付' })) return;
    const response = await apiRequest<{ confirmed: number; alreadyConfirmed: number }>('/api/control-plane/v1/delivery-items/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: selected.map(item => item.itemId) }),
    });
    setMessage(`已确认 ${response.confirmed} 条${response.alreadyConfirmed ? `，另 ${response.alreadyConfirmed} 条已由其他操作确认` : ''}。双方交付状态已更新。`); setSelected([]);
  });
  const createArchive = (kind: 'DOWNLOAD' | 'ARCHIVE') => perform(kind === 'ARCHIVE' ? '汇总保存' : '准备下载', async () => {
    const preview = await apiRequest<{ token: string; itemCount: number; totalBytes: number; batchCount: number }>('/api/control-plane/v1/delivery-archives/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind,
        ...(allFiltered && kind === 'ARCHIVE' ? { filters } : { itemIds: selected.map(item => item.itemId) }) }),
    });
    if (!await confirm({ title: `${kind === 'ARCHIVE' ? '汇总保存' : '下载'} ${preview.itemCount} 条内容？`,
      description: `涉及 ${preview.batchCount} 个原批次，内容约 ${(preview.totalBytes / 1024 / 1024).toFixed(1)} MB。按冻结版本生成文件，保留原交付人和交付时间。${kind === 'DOWNLOAD' ? '请保持本页面打开，生成完成后自动开始下载；离开后仍可从“文件记录”下载。' : '生成完成后可在“文件记录”下载。'}`, confirmLabel: kind === 'DOWNLOAD' ? '生成并下载' : '生成文件' })) return;
    const job = await apiRequest<Job>('/api/control-plane/v1/delivery-archives', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: preview.token, requestId: crypto.randomUUID() }) });
    if (kind === 'DOWNLOAD') setDownloadState({ job, phase: 'WAITING', error: '' });
    else setMessage(`文件任务 HG-${job.id} 已创建，共 ${job.itemCount} 条。可离开页面，稍后从文件记录下载。`);
    setSelected([]); setAllFiltered(false); setShowJobs(true); setJobPage(1); await loadJobs();
  });
  const quickDate = (days: number, yesterday = false) => {
    const today = new Date(Date.now() + 8 * 3600_000); today.setUTCHours(0, 0, 0, 0);
    const end = new Date(today.getTime() - (yesterday ? 86400_000 : 0));
    apply({ ...draft, from: new Date(end.getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
  };
  const changeDraft = (field: keyof Filters, value: string) => setDraft(previous => ({ ...previous, [field]: value }));
  const userById = new Map(users.map(user => [String(user.id), user]));
  const userByUsername = new Map(users.map(user => [user.username, user]));
  const userLabel = (id: string) => {
    const user = userById.get(id);
    return user ? `${user.displayName || user.username}（${user.username}）` : `历史账号 #${id}`;
  };
  const displayUsername = (username: string | null) => {
    if (!username) return null;
    const user = userByUsername.get(username);
    return user?.displayName ? `${user.displayName}（${username}）` : username;
  };
  const personnelScope = ([['assigneeId', '负责人'], ['packedById', '打包人'], ['deliveredById', '交付确认人']] as const)
    .filter(([field]) => Boolean(filters[field]))
    .map(([field, label]) => `${label}：${userLabel(filters[field])}`);

  return <section className={styles.workbench} aria-label={historyOnly ? '我的共享交付记录' : '共享交付池'}>
    <div className={styles.toolbar}>
      <div><h2>{historyOnly ? '我的交付记录' : role === 'ADMIN' ? '总交付池' : '我的交付池'}</h2>
        <p className="subtle">双方共用交付状态；下载后，实际发送给接收方再确认。时间均为北京时间。</p></div>
      <Button unstyled type="button" className="button small" disabled={loading || Boolean(busy)} onClick={() => { void load(); if (showJobs) void loadJobs(); }}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新</Button>
    </div>
    {!historyOnly && <div className={styles.tabs} role="group" aria-label="交付视图">
      <Button unstyled className={`button ${filters.view === 'CURRENT' ? 'primary' : ''}`} onClick={() => apply({ ...filters, view: 'CURRENT', versionState: 'ALL' })}>当前交付内容</Button>
      <Button unstyled className={`button ${filters.view === 'HISTORY' ? 'primary' : ''}`} onClick={() => apply({ ...filters, view: 'HISTORY' })}>交付记录（含历史版本）</Button>
    </div>}
    <div className={styles.cards}>
      {([['ALL', '全部内容', result.summary.total], ['PENDING', '未交付', result.summary.unpacked + result.summary.packed], ['DELIVERED', '已交付', result.summary.delivered]] as const)
        .map(([state, label, count]) => <button type="button" key={state} className={styles.card} aria-pressed={filters.state === state} disabled={Boolean(busy)} onClick={() => apply({ ...filters, state })}>
          <span>{label}</span><strong>{result.updatedAt ? count : '—'}</strong>{state === 'PENDING' && result.updatedAt && <small>待打包 {result.summary.unpacked} · 已打包 {result.summary.packed}</small>}</button>)}
      <button type="button" className={styles.card} disabled={Boolean(busy)} onClick={() => apply({ ...filters, state: 'ALL', versionState: 'UPDATED' })}><span>版本更新待重交</span><strong>{result.updatedAt ? result.summary.updated : '—'}</strong></button>
    </div>
    <form className={styles.filters} onSubmit={event => { event.preventDefault(); apply(draft); }}>
      <fieldset disabled={Boolean(busy)} className={styles.filterGrid}>
        <FilterSelect label="交付状态" value={draft.state} onChange={value => changeDraft('state', value)} options={[
          ['ALL', '全部状态'], ['PENDING', '未交付'], ['UNPACKED', '待打包'], ['PACKED', '已打包，待交付'], ['DELIVERED', '已交付']]} />
        <FilterSelect label="日期依据" value={draft.dateField} onChange={value => changeDraft('dateField', value)} options={[
          ['READY', '可交付时间'], ['PACKED', '打包时间'], ['DELIVERED', '交付确认时间'], ['UPDATED', '最近状态变更']]} />
        <div className={styles.field}><DatePicker name="delivery-from" label="开始日期" aria-label="交付开始日期" value={draft.from} onValueChange={value => changeDraft('from', value)} /></div>
        <div className={styles.field}><DatePicker name="delivery-to" label="结束日期" aria-label="交付结束日期" value={draft.to} onValueChange={value => changeDraft('to', value)} /></div>
        <label className={styles.field}><span>搜索</span><Input aria-label="搜索交付内容" placeholder="任务号、Query、批次号" value={draft.search} onChange={event => changeDraft('search', event.target.value)} /></label>
        <FilterSelect label="版本情况" value={draft.versionState} onChange={value => changeDraft('versionState', value)} options={[
          ['ALL', '全部版本情况'], ['UPDATED', '版本更新待重交'], ...(filters.view === 'HISTORY' ? [['HISTORICAL', '历史版本'] as [string, string]] : [])]} />
        {role === 'ADMIN' && <>
          {([['assigneeId', '负责人'], ['packedById', '打包人'], ['deliveredById', '交付确认人']] as const).map(([field, label]) =>
            <FilterSelect key={field} label={label} value={draft[field] || 'ALL'} onChange={value => changeDraft(field, value === 'ALL' ? '' : value)}
              options={[['ALL', '全部人员'], ...users.map(user => [String(user.id), `${user.displayName || user.username}（${user.username}）${user.status === 'DISABLED' ? ' · 已停用' : ''}`] as [string, string])]} />)}
          <FilterSelect label="汇总保存" value={draft.archiveState} onChange={value => changeDraft('archiveState', value)} options={[
            ['ALL', '全部'], ['NO', '未汇总保存'], ['YES', '已汇总保存']]} />
          <label className={styles.field}><span>词包名称</span><Input value={draft.packageName} onChange={event => changeDraft('packageName', event.target.value)} placeholder="精确词包名" /></label>
          <label className={styles.field}><span>甲方批次</span><Input value={draft.clientBatchCode} onChange={event => changeDraft('clientBatchCode', event.target.value)} placeholder="甲方批次编号" /></label>
        </>}
        <div className={styles.actions}><Button unstyled type="submit" className="button primary"><Search size={14} />查询</Button>
          <Button unstyled type="button" className="button" onClick={() => apply(initialFilters(historyOnly))}>重置</Button></div>
      </fieldset>
      <div className={styles.actions}>
        {([['今天', 1, false], ['昨天', 1, true], ['近 7 天', 7, false], ['近 30 天', 30, false]] as const).map(([label, days, yesterday]) =>
          <Button key={label} unstyled type="button" className="button small" disabled={Boolean(busy)} onClick={() => quickDate(days, yesterday)}>{label}</Button>)}
        <Button unstyled type="button" className="button small" disabled={Boolean(busy)} onClick={() => apply({ ...draft, from: '', to: '' })}>不限日期</Button>
      </div>
      <p className={styles.hint}>卡片按人员、来源和日期统计全部状态；列表应用所选状态。查询未交付内容的日期时，请选择“可交付时间”。</p>
    </form>
    {role === 'ADMIN' && personnelScope.length > 0 && <div className={styles.personnelSummary} role="status">
      <div><strong>人员筛选结果</strong><span>{personnelScope.join(' · ')}</span></div>
      <div className={styles.actions}><span>{loading ? '正在汇总人员范围…' : `全部 ${result.summary.total} 条 · 未交付 ${result.summary.unpacked + result.summary.packed} 条 · 已交付 ${result.summary.delivered} 条`}</span>
        <Button unstyled type="button" className="button small" disabled={Boolean(busy)} onClick={() => apply({ ...filters, assigneeId: '', packedById: '', deliveredById: '' })}>清除人员筛选</Button></div>
    </div>}
    <div className={styles.actions}>
      <span>{allFiltered ? `已选择符合筛选的全部 ${result.total} 条` : `已选 ${selected.length} 条（最多 200 条）`}</span>
      <Button unstyled className="button small" disabled={Boolean(busy) || !canPack || allFiltered} onClick={() => void pack()}><PackageCheck size={14} />打包并下载</Button>
      <Button unstyled className="button small" disabled={Boolean(busy) || pendingDownloadId !== null || !canDownload || allFiltered} onClick={() => void createArchive('DOWNLOAD')}><Download size={14} />下载所选冻结内容</Button>
      <Button unstyled className="button small primary" disabled={Boolean(busy) || !canConfirm || allFiltered} onClick={() => void confirmItems()}><CheckCircle2 size={14} />确认所选已交付</Button>
      {role === 'ADMIN' && <Button unstyled className="button small" disabled={Boolean(busy) || (!canArchive && !allFiltered)} onClick={() => void createArchive('ARCHIVE')}>汇总保存已交付内容</Button>}
      {role === 'ADMIN' && filters.state === 'DELIVERED' && result.total > 0 && <Button unstyled className="button small" disabled={Boolean(busy) || result.total > 2000} onClick={() => { setAllFiltered(true); setSelected([]); }}>选择全部筛选结果（{result.total} 条）</Button>}
      <Button unstyled className="button small" disabled={Boolean(busy)} onClick={() => { setSelected([]); setAllFiltered(false); }}>清空选择</Button>
    </div>
    {selected.some(item => item.state === 'PACKED' && !item.downloadedByMe) && <p className={styles.hint}>所选内容中有本人尚未下载的条目。请先下载并实际发送，再确认交付。</p>}
    {busy && <p role="status">正在{busy}…</p>}
    {message && <div className="notice" role="status">{message}</div>}
    {downloadState && <div className={`notice ${downloadState.phase === 'FAILED' ? 'error' : ''}`} role={downloadState.phase === 'FAILED' ? 'alert' : 'status'} aria-label="冻结内容下载进度">
      {downloadState.phase === 'WAITING' && <p>文件任务 HG-{downloadState.job.id}：{downloadState.job.status === 'QUEUED' ? '排队中' : '正在生成文件'}，共 {downloadState.job.itemCount} 条。请保持本页面打开，完成后将自动下载。</p>}
      {downloadState.phase === 'FAILED' && <p>文件任务 HG-{downloadState.job.id} 未能自动下载，请在文件记录中查看或重试。</p>}
      {downloadState.error && <p>{downloadState.error}</p>}
      {downloadState.phase === 'STARTED' && <>
        <p>文件任务 HG-{downloadState.job.id} 已生成，已发起 {downloadState.job.artifacts.length} 个文件的下载。{downloadState.job.artifacts.length > 1 && '浏览器提示时请允许下载多个文件。'}若未开始，可点击下面的链接下载。</p>
        <div className={styles.actions}>{downloadState.job.artifacts.map(artifact => <a key={artifact.part} className="button small"
          href={`/api/control-plane/v1/delivery-archives/${downloadState.job.id}/download/${artifact.part}`} download={artifact.fileName}
          onClick={() => window.setTimeout(() => { if (mounted.current) void load(true); }, 1500)}><Download size={14} />重新下载第 {artifact.part} 卷</a>)}</div>
      </>}
    </div>}
    {error && <div className="notice error" role="alert">{error}。当前内容可能尚未更新，请重试刷新。</div>}
    <p className={styles.hint}>共 {result.updatedAt ? result.total : '—'} 条 · 最近同步：{time(result.updatedAt || null)} · 页面打开时每 15 秒自动同步</p>
    <div className="table-wrap mobile-cards" role="region" aria-label="共享交付内容" tabIndex={0}>
      <table><thead><tr><th><Checkbox aria-label="选择本页交付内容" checked={allPageChecked || allFiltered} disabled={Boolean(busy)} onChange={event => toggle(result.items, event.target.checked)} /></th>
        <th>内容与版本</th><th>交付状态</th><th>打包信息</th><th>交付信息</th>{role === 'ADMIN' && <th>汇总保存</th>}</tr></thead>
        <tbody>{result.items.map(item => <tr key={key(item)}>
          <td data-label="选择"><Checkbox aria-label={`选择交付任务 ${item.taskId}`} checked={selectedKeys.has(key(item)) || allFiltered}
            disabled={Boolean(busy) || (!selectedKeys.has(key(item)) && selected.length >= 200)} onChange={event => toggle([item], event.target.checked)} /></td>
          <td data-label="内容与版本"><strong>#{item.taskId} {item.query}</strong><small className={styles.meta}>文案 #{item.copyRevisionId} · 图片 {item.imageRunId.slice(0, 8)}</small>
            <small className={styles.meta}>负责人 {filters.view === 'HISTORY' ? displayUsername(item.ownerUsername) ?? '历史未记录' : displayUsername(item.assigneeUsername) ?? '未分配'}</small>
            {role === 'ADMIN' && <small className={styles.meta}>{item.packageName ?? '未归属词包'}</small>}</td>
          <td data-label="交付状态"><span className={`pill ${item.state === 'DELIVERED' ? styles.delivered : ''}`}>{labels[item.state]}</span>
            {item.versionUpdated && <small className={styles.warning}>版本更新待重交</small>}{!item.isCurrent && <small className={styles.meta}>历史版本 / 当前已不可交付</small>}
            <small className={styles.meta}>可交付 {time(item.readyAt)}</small></td>
          <td data-label="打包信息">{displayUsername(item.packedBy) ?? '—'}<small className={styles.meta}>{time(item.packedAt)}</small><small className={styles.meta}>{item.batchCode}</small>
            {item.batchCode && <small className={styles.meta}>{role === 'USER' ? '本人可见内容' : '本批次'}已交付 {item.batchDeliveredCount} / {item.batchVisibleCount}</small>}</td>
          <td data-label="交付信息">{displayUsername(item.deliveredBy) ?? '尚未确认'}<small className={styles.meta}>{time(item.deliveredAt)}</small></td>
          {role === 'ADMIN' && <td data-label="汇总保存">{item.archivedAt ? '已汇总保存' : '未汇总保存'}<small className={styles.meta}>{time(item.archivedAt)}</small></td>}
        </tr>)}</tbody></table>
      {!result.items.length && <div className="empty-state">{loading ? '正在读取交付内容…' : error ? '交付内容读取失败，请查看上方提示。' : '没有符合条件的内容，请调整日期或状态筛选。'}</div>}
    </div>
    <WorkbenchPagination page={page} pageSize={pageSize} total={result.total} offset={(page - 1) * pageSize} count={result.items.length} busy={loading || Boolean(busy)}
      loadError={error} onRetry={() => void load()} onPageChange={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} />
    <div className={styles.toolbar}><h3>文件记录</h3><Button unstyled className="button small" onClick={() => setShowJobs(value => !value)}>{showJobs ? '收起' : '查看下载与汇总保存记录'}</Button></div>
    {showJobs && <>
      <div className={styles.jobList}>{jobs.map(job => <article key={job.id} className={styles.job}>
        <div><strong>HG-{job.id} · {job.kind === 'ARCHIVE' ? '汇总保存' : '下载所选内容'} · {job.itemCount} 条</strong>
          <small className={styles.meta}>{job.createdBy} · {time(job.createdAt)}</small>
          <span>{({ QUEUED: '排队中', RUNNING: '生成中', SUCCEEDED: '文件已保存，可下载', FAILED: '生成失败' } as Record<string, string>)[job.status]}</span>
          {job.status === 'SUCCEEDED' && <small className={styles.meta}>下载记录 {job.downloadCount ?? 0} 次{job.lastDownloadedAt ? ` · 最近 ${time(job.lastDownloadedAt)}` : ''}</small>}
          {job.error && <p className={styles.warning}>{job.error}</p>}</div>
        <div className={styles.actions}>{job.artifacts.map(artifact => <a key={artifact.part} className="button small"
          href={`/api/control-plane/v1/delivery-archives/${job.id}/download/${artifact.part}`} download={artifact.fileName}
          onClick={() => window.setTimeout(() => { if (mounted.current) void load(true); }, 1500)}><Download size={14} />下载第 {artifact.part} 卷</a>)}
          {job.status === 'FAILED' && <Button unstyled className="button small" disabled={Boolean(busy) || (job.kind === 'DOWNLOAD' && pendingDownloadId !== null)} onClick={() => void perform('重试', async () => {
            const retried = await apiRequest<Job>(`/api/control-plane/v1/delivery-archives/${job.id}/retry`, { method: 'POST' });
            if (job.kind === 'DOWNLOAD') setDownloadState({ job: retried, phase: 'WAITING', error: '' });
            await loadJobs();
          })}>按原范围重试</Button>}</div>
      </article>)}</div>
      {!jobs.length && <p className={styles.hint}>暂无文件记录。</p>}
      <div className={styles.actions}><Button unstyled className="button small" disabled={jobPage <= 1} onClick={() => setJobPage(value => value - 1)}>上一页</Button>
        <span>第 {jobPage} 页，共 {jobTotal} 条</span><Button unstyled className="button small" disabled={jobPage * 10 >= jobTotal} onClick={() => setJobPage(value => value + 1)}>下一页</Button></div>
    </>}
  </section>;
}
