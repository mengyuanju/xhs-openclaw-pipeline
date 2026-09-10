'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CheckCircle2,
  FilePlus2,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';
import { canCommitLatestRequest } from '../components/latest-request';
import { createRequestId } from '../components/request-id';
import styles from './query-packages.module.css';
import {
  applyQueryPackageScreening,
  normalizePackageDetail,
  normalizePackagePage,
  normalizePackageSummary,
  parseQueryPackageText,
  queryPackageItemMatchesFilter,
  queryPackageItemPage,
  QUERY_PACKAGE_ITEM_PAGE_SIZE,
  updateQueryItemSelection,
  type QueryPackageDecision,
  type QueryPackageDetail,
  type QueryPackageItemFilter,
  type QueryPackageSummary,
  type QueryPackageValidationStatus,
} from './types';

const apiPath = (path: string) => `/api/control-plane${path}`;
const QUERY_PACKAGE_LIST_LIMIT = 200;
const PACKAGE_STATUS_LABELS: Record<string, string> = {
  DRAFT: '待筛选',
  IMPORTED: '待筛选',
  SCREENING: '筛选中',
  READY: '筛选完成',
  PARTIALLY_USED: '部分已创建',
  USED_UP: '已全部创建',
  ABANDONED: '已停用',
  PRODUCED: '已创建作业',
  CLOSED: '已完成',
};
const DECISION_LABELS: Record<QueryPackageDecision, string> = {
  PENDING: '待筛选',
  SELECTED: '已通过',
  REJECTED: '已淘汰',
};
const VALIDATION_STATUS_LABELS: Record<QueryPackageValidationStatus, string> = {
  READY: '可筛选', INVALID: '内容无效', DUPLICATE: '重复项', TASK_CREATED: '已创建作业',
};

type ConfirmedScreening = {
  summary: QueryPackageSummary;
  itemIds: number[];
  decision: Exclude<QueryPackageDecision, 'PENDING'>;
  reason?: string;
};

function timeLabel(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    : '时间未记录';
}

export function QueryPackageWorkbench() {
  const [packages, setPackages] = useState<QueryPackageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMorePackages, setLoadingMorePackages] = useState(false);
  const [nextPackageOffset, setNextPackageOffset] = useState(0);
  const [packageTotal, setPackageTotal] = useState<number | null>(null);
  const [hasMorePackages, setHasMorePackages] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [importOpen, setImportOpen] = useState(false);
  const [packageName, setPackageName] = useState('');
  const [sourceFileName, setSourceFileName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [importError, setImportError] = useState('');
  const [readingImportFile, setReadingImportFile] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<QueryPackageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemStatus, setItemStatus] = useState<QueryPackageItemFilter>('PENDING');
  const [itemPage, setItemPage] = useState(1);
  const [checkedItemIds, setCheckedItemIds] = useState<number[]>([]);
  const [screeningReason, setScreeningReason] = useState('');
  const [acting, setActing] = useState('');
  const [deletePackage, setDeletePackage] = useState<QueryPackageSummary | null>(null);
  const [deletePreview, setDeletePreview] = useState<{ packageId: number; version: number; eligible: boolean; itemCount: number; productionBatchCount: number; detachedTaskCount: number; tasksWillBeDeleted: boolean } | null>(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [confirmationName, setConfirmationName] = useState('');
  const [deletionReason, setDeletionReason] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [abandonPackage, setAbandonPackage] = useState<QueryPackageSummary | null>(null);
  const [abandonReason, setAbandonReason] = useState('');
  const [abandonError, setAbandonError] = useState('');
  const packageListRequestId = useRef(0);
  const packageDetailRequestId = useRef(0);
  const packageDetailRequestController = useRef<AbortController | null>(null);
  const deletePreviewRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const importFileRequestId = useRef(0);

  const parsedImport = useMemo(() => parseQueryPackageText(queryText), [queryText]);

  const load = useCallback(async ({ silent = false, offset = 0 } = {}) => {
    const append = offset > 0;
    const currentRequestId = ++packageListRequestId.current;
    if (append) setLoadingMorePackages(true);
    else {
      if (!silent) setRefreshing(true);
      if (!silent) setLoading(true);
    }
    try {
      const packagePayload = await apiRequest<unknown>(
        apiPath(`/v1/query-packages?limit=${QUERY_PACKAGE_LIST_LIMIT}&offset=${offset}`),
      );
      if (currentRequestId !== packageListRequestId.current) return;
      const page = normalizePackagePage(packagePayload);
      const followingOffset = offset + page.returnedCount;
      setPackages((current) => {
        if (!append) return page.items;
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setNextPackageOffset(followingOffset);
      setPackageTotal(page.total);
      setHasMorePackages(page.total === null
        ? page.returnedCount === QUERY_PACKAGE_LIST_LIMIT
        : followingOffset < page.total);
      setError('');
    } catch (caught) {
      if (currentRequestId !== packageListRequestId.current) return;
      setError(caught instanceof Error ? caught.message : 'Query 词包读取失败');
    } finally {
      if (currentRequestId === packageListRequestId.current) {
        setLoading(false);
        setLoadingMorePackages(false);
        if (!silent) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => {
    packageDetailRequestId.current += 1;
    packageDetailRequestController.current?.abort();
    deletePreviewRequest.current?.controller.abort();
    importFileRequestId.current += 1;
  }, []);

  const visiblePackages = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return packages.filter((item) => (status === 'ALL' || item.status === status)
      && (!keyword || item.name.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [packages, search, status]);

  const visibleItems = useMemo(() => {
    if (!detail) return [];
    const keyword = itemSearch.trim().toLocaleLowerCase('zh-CN');
    return detail.items.filter((item) => queryPackageItemMatchesFilter(item, itemStatus)
      && (!keyword || `${item.query} ${item.externalId ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [detail, itemSearch, itemStatus]);

  useEffect(() => { setItemPage(1); }, [detail?.id, itemSearch, itemStatus]);

  const itemPageView = queryPackageItemPage(visibleItems, itemPage);
  const { currentPage: currentItemPage, pageCount: itemPageCount, start: itemPageStart, items: pagedItems } = itemPageView;
  const checkedItemIdSet = useMemo(() => new Set(checkedItemIds), [checkedItemIds]);

  const totalCounts = useMemo(() => packages.reduce((total, item) => ({
    packages: total.packages + 1,
    queries: total.queries + item.counts.total,
    selected: total.selected + item.counts.selected,
    produced: total.produced + item.counts.produced,
  }), { packages: 0, queries: 0, selected: 0, produced: 0 }), [packages]);

  async function openPackage(
    id: number,
    { preserveFilters = false, confirmedScreening }: { preserveFilters?: boolean; confirmedScreening?: ConfirmedScreening } = {},
  ) {
    const currentRequestId = packageDetailRequestId.current + 1;
    packageDetailRequestId.current = currentRequestId;
    packageDetailRequestController.current?.abort();
    const controller = new AbortController();
    packageDetailRequestController.current = controller;
    setDetailLoading(true);
    setDetailError('');
    setDetail((current) => current?.id === id ? current : null);
    setCheckedItemIds([]);
    setScreeningReason('');
    if (!preserveFilters) {
      setItemSearch('');
      setItemStatus('PENDING');
    }
    try {
      const payload = await apiRequest<unknown>(apiPath(`/v1/query-packages/${id}`), { signal: controller.signal });
      if (!canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      let next = normalizePackageDetail(payload);
      if (!next) throw new Error('中心返回的词包详情不完整');
      if (confirmedScreening) {
        next = applyQueryPackageScreening(
          next,
          confirmedScreening.summary,
          confirmedScreening.itemIds,
          confirmedScreening.decision,
          confirmedScreening.reason,
        );
      }
      setDetail(next);
    } catch (caught) {
      if (!canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setDetailError(caught instanceof Error ? caught.message : '词包详情读取失败');
    } finally {
      if (canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) {
        packageDetailRequestController.current = null;
        setDetailLoading(false);
      }
    }
  }

  function closePackageDetail() {
    packageDetailRequestId.current += 1;
    packageDetailRequestController.current?.abort();
    packageDetailRequestController.current = null;
    setDetail(null);
    setDetailLoading(false);
    setDetailError('');
  }

  async function readImportFile(file: File | null) {
    const currentRequestId = importFileRequestId.current + 1;
    importFileRequestId.current = currentRequestId;
    setReadingImportFile(false);
    setSourceFileName('');
    if (!file) return;
    setReadingImportFile(true);
    setQueryText('');
    setImportError('');
    try {
      const content = await file.text();
      if (!canCommitLatestRequest(importFileRequestId.current, currentRequestId)) return;
      setSourceFileName(file.name.slice(0, 255));
      setQueryText(content);
    } catch {
      if (!canCommitLatestRequest(importFileRequestId.current, currentRequestId)) return;
      setImportError('文件读取失败，请改用 UTF-8 文本文件或直接粘贴 Query。');
    } finally {
      if (canCommitLatestRequest(importFileRequestId.current, currentRequestId)) setReadingImportFile(false);
    }
  }

  function changeImportText(value: string) {
    importFileRequestId.current += 1;
    setReadingImportFile(false);
    setSourceFileName('');
    setQueryText(value);
    setImportError('');
  }

  function closeImportDialog() {
    importFileRequestId.current += 1;
    setReadingImportFile(false);
    setImportError('');
    setImportOpen(false);
  }

  async function createPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || readingImportFile || parsedImport.error) return;
    setCreating(true);
    setImportError('');
    setMessage('');
    try {
      await apiRequest(apiPath('/v1/query-packages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: packageName.trim(),
          ...(sourceFileName ? { sourceFileName } : {}),
          items: parsedImport.queries.map((query) => ({ query, input: {}, requestedImageCount: 'auto' })),
          requestId: createRequestId(),
        }),
      });
      closeImportDialog();
      setPackageName('');
      setSourceFileName('');
      setQueryText('');
      setMessage(`已导入 ${parsedImport.queries.length} 条 Query${parsedImport.duplicates ? `，自动忽略 ${parsedImport.duplicates} 条重复项` : ''}。`);
      await load({ silent: true });
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : '词包导入失败');
    } finally {
      setCreating(false);
    }
  }

  async function screen(decision: 'SELECT' | 'REJECT') {
    if (!detail || !checkedItemIds.length || acting) return;
    if (decision === 'REJECT' && !screeningReason.trim()) {
      setDetailError('淘汰 Query 时请填写筛选原因。');
      return;
    }
    setActing(`screen-${decision}`);
    setDetailError('');
    try {
      const payload = await apiRequest<unknown>(apiPath(`/v1/query-packages/${detail.id}/screening`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: detail.version,
          decisions: checkedItemIds.map((itemId) => ({
            itemId,
            decision,
            ...(decision === 'REJECT' ? { reason: screeningReason.trim() } : {}),
          })),
          requestId: createRequestId(),
        }),
      });
      const response = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const summarySource = response?.queryPackage && typeof response.queryPackage === 'object'
        ? response.queryPackage
        : payload;
      const summary = normalizePackageSummary(summarySource);
      if (!summary || summary.id !== detail.id) throw new Error('筛选已提交，但中心没有返回有效的新版本');
      const nextDecision = decision === 'SELECT' ? 'SELECTED' : 'REJECTED';
      const changedItemIds = [...checkedItemIds];
      setDetail((current) => current?.id === detail.id
        ? applyQueryPackageScreening(
            current,
            summary,
            changedItemIds,
            nextDecision,
            decision === 'REJECT' ? screeningReason : undefined,
          )
        : current);
      setCheckedItemIds([]);
      setScreeningReason('');
      setMessage(decision === 'SELECT'
        ? `已将 ${changedItemIds.length} 条 Query 标记为通过，并自动进入文案生成。`
        : `已淘汰 ${changedItemIds.length} 条 Query。`);
      await Promise.all([
        openPackage(detail.id, {
          preserveFilters: true,
          confirmedScreening: {
            summary,
            itemIds: changedItemIds,
            decision: nextDecision,
            ...(decision === 'REJECT' ? { reason: screeningReason } : {}),
          },
        }),
        load({ silent: true }),
      ]);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : '筛选结果保存失败');
    } finally {
      setActing('');
    }
  }

  async function permanentlyDelete() {
    if (!deletePackage || acting) return;
    if (deletePreview?.packageId !== deletePackage.id || !deletePreview.eligible || deletePreview.tasksWillBeDeleted || !deletionPassword || !deletionReason.trim() || confirmationName !== deletePackage.name) {
      setDeleteError('请填写删除原因和二级密码，并完整输入词包名称确认。');
      return;
    }
    setActing('delete');
    setDeleteError('');
    try {
      await apiRequest(apiPath(`/v1/query-packages/${deletePackage.id}/permanent`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: deletePreview.version,
          reason: deletionReason.trim(),
          deletionPassword,
          confirmationName,
          requestId: createRequestId(),
        }),
      });
      setDetail((current) => current?.id === deletePackage.id ? null : current);
      setDeletePackage(null);
      setDeletionPassword('');
      setConfirmationName('');
      setDeletionReason('');
      setMessage(`词包“${deletePackage.name}”已永久删除；已经创建的正式作业保持不变。`);
      await load({ silent: true });
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '词包永久删除失败');
    } finally {
      setActing('');
    }
  }

  async function preparePermanentDelete(item: QueryPackageSummary) {
    deletePreviewRequest.current?.controller.abort();
    const controller = new AbortController();
    const request = { id: item.id, controller };
    deletePreviewRequest.current = request;
    setDetail((current) => current?.id === item.id ? null : current);
    setDeletePackage(item);
    setDeletePreview(null);
    setDeletionPassword('');
    setConfirmationName('');
    setDeletionReason('');
    setDeleteError('');
    setDeletePreviewLoading(true);
    try {
      const payload = await apiRequest<Record<string, unknown>>(
        apiPath(`/v1/query-packages/${item.id}/permanent-delete-preview`),
        { signal: controller.signal },
      );
      if (deletePreviewRequest.current !== request) return;
      const version = Number(payload.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('中心返回的删除影响预检不完整');
      setDeletePreview({
        packageId: item.id,
        version,
        eligible: payload.eligible === true,
        itemCount: Math.max(0, Number(payload.itemCount) || 0),
        productionBatchCount: Math.max(0, Number(payload.productionBatchCount) || 0),
        detachedTaskCount: Math.max(0, Number(payload.detachedTaskCount) || 0),
        tasksWillBeDeleted: payload.tasksWillBeDeleted === true,
      });
    } catch (caught) {
      if (deletePreviewRequest.current !== request || controller.signal.aborted) return;
      setDeleteError(caught instanceof Error ? caught.message : '删除影响预检失败');
    } finally {
      if (deletePreviewRequest.current === request) setDeletePreviewLoading(false);
    }
  }

  function closePermanentDelete() {
    deletePreviewRequest.current?.controller.abort();
    deletePreviewRequest.current = null;
    setDeletePackage(null);
    setDeletePreview(null);
    setDeletePreviewLoading(false);
    setDeleteError('');
  }

  async function abandon() {
    if (!abandonPackage || !abandonReason.trim() || acting) return;
    setActing('abandon');
    setAbandonError('');
    try {
      await apiRequest(apiPath(`/v1/query-packages/${abandonPackage.id}/abandon`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: abandonPackage.version, reason: abandonReason.trim(), requestId: createRequestId() }),
      });
      setAbandonPackage(null);
      setMessage(`词包“${abandonPackage.name}”已废弃；已经创建的正式作业保持不变。`);
      await load({ silent: true });
    } catch (caught) {
      setAbandonError(caught instanceof Error ? caught.message : '词包废弃失败');
    } finally {
      setActing('');
    }
  }

  function prepareAbandon(item: QueryPackageSummary) {
    setDetail((current) => current?.id === item.id ? null : current);
    setAbandonPackage(item);
    setAbandonReason('');
    setAbandonError('');
  }

  const screenableItems = pagedItems.filter((item) => item.validationStatus === 'READY' && !item.taskId);
  const allVisibleChecked = screenableItems.length > 0 && screenableItems.every((item) => checkedItemIdSet.has(item.id));
  const availableStatuses = Object.keys(PACKAGE_STATUS_LABELS);
  const packageTotalDisplay = packageTotal === null
    ? `${packages.length.toLocaleString('zh-CN')}${hasMorePackages ? '+' : ''}`
    : packageTotal.toLocaleString('zh-CN');

  return <div className={styles.stack}>
    <section className={styles.summary} aria-label="已加载词包概况">
      <article><strong>{packageTotalDisplay}</strong><span>词包总数{packageTotal === null && hasMorePackages ? '（至少）' : ''}</span></article>
      <article><strong>{totalCounts.queries.toLocaleString('zh-CN')}</strong><span>已加载词包的 Query</span></article>
      <article><strong>{totalCounts.selected.toLocaleString('zh-CN')}</strong><span>已加载词包筛选通过</span></article>
      <article><strong>{totalCounts.produced.toLocaleString('zh-CN')}</strong><span>已加载词包已创建作业</span></article>
    </section>

    <section className="panel" aria-labelledby="query-package-list-title">
      <div className={styles.toolbar}>
        <div>
          <h2 id="query-package-list-title">词包列表</h2>
          <p className="subtle">管理员可按词包集中导入和筛选；通过的 Query 会自动创建正式作业并进入文案生成。</p>
        </div>
        <div className={styles.toolbarGroup}>
          <Button unstyled className="button small" type="button" disabled={refreshing || loadingMorePackages} onClick={() => { void load(); }}>
            <RefreshCw aria-hidden="true" className={refreshing ? 'animate-spin' : ''} size={14} />刷新
          </Button>
          <Button unstyled className="button primary" type="button" onClick={() => { setImportError(''); setImportOpen(true); }}>
            <Upload aria-hidden="true" size={15} />导入 Query 词包
          </Button>
        </div>
      </div>
      <div className={styles.scopeNote}>名称和状态筛选当前覆盖已加载的 {packages.length} 个词包。{hasMorePackages ? '仍有更多词包，可继续加载后再筛选。' : '词包列表已全部加载。'}</div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <SearchInput className={styles.search} value={search} onValueChange={setSearch} placeholder="搜索词包名称" />
          <label>状态
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部状态</SelectItem>
                {availableStatuses.map((value) => <SelectItem key={value} value={value}>{PACKAGE_STATUS_LABELS[value] ?? value}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      </div>

      {message && <div className="notice success" role="status">{message}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取 Query 词包…</div>
        : visiblePackages.length === 0
          ? <div className="empty-state">{search || status !== 'ALL' ? `已加载范围内没有符合筛选条件的词包${hasMorePackages ? '；可继续加载后查找。' : '。'}` : '还没有 Query 词包。'}</div>
          : <div className={`table-wrap mobile-cards ${styles.table}`}><table>
            <thead><tr><th>词包</th><th>筛选进度</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>{visiblePackages.map((item) => {
              const decided = item.counts.selected + item.counts.rejected;
              return <tr key={item.id}>
                <td data-label="词包"><div className={styles.nameCell}><strong>{item.name}</strong><small>#{item.id}</small></div></td>
                <td data-label="筛选进度"><div className={styles.counts}>
                  <progress className={styles.progress} max={Math.max(1, item.counts.total)} value={decided} aria-label={`${item.name} 筛选进度`} />
                  <div className={styles.countLine}><span>待筛 {item.counts.pending}</span><span>通过 {item.counts.selected}</span><span>淘汰 {item.counts.rejected}</span><span>已创建 {item.counts.produced}</span></div>
                </div></td>
                <td data-label="状态"><span className="pill">{PACKAGE_STATUS_LABELS[item.status] ?? item.status}</span></td>
                <td data-label="创建时间"><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time></td>
                <td className="row-action" data-label="操作"><div className={styles.actions}>
                  <Button unstyled className="button small primary" type="button" onClick={() => { void openPackage(item.id); }}><Search size={14} />筛选 Query</Button>
                  {['USED_UP', 'ABANDONED'].includes(item.status)
                    ? <Button unstyled className="button small danger" type="button" onClick={() => { void preparePermanentDelete(item); }}><Trash2 size={14} />永久删除</Button>
                    : <Button unstyled className="button small danger" type="button" onClick={() => prepareAbandon(item)}><XCircle size={14} />废弃词包</Button>}
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>}
      {hasMorePackages && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMorePackages || refreshing} onClick={() => { void load({ silent: true, offset: nextPackageOffset }); }}>{loadingMorePackages ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : '加载更多词包'}</Button></div>}
    </section>

    <Dialog open={importOpen} onOpenChange={(open) => { if (creating) return; if (open) setImportOpen(true); else closeImportDialog(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>导入 Query 词包</DialogTitle><DialogDescription>每行一条 Query，最多 5000 条；导入后进入人工筛选，通过后自动创建正式作业。</DialogDescription></div>
        <form className={styles.importForm} onSubmit={createPackage}>
          <div className={styles.importFields}>
            <div className="field"><label htmlFor="query-package-name">词包名称</label><Input id="query-package-name" value={packageName} maxLength={120} required disabled={creating} onChange={(event) => setPackageName(event.target.value)} /></div>
            <div className="field"><label htmlFor="query-package-file">读取文本文件</label><Input id="query-package-file" type="file" accept=".txt,.csv,text/plain,text/csv" disabled={creating} onChange={(event) => { void readImportFile(event.target.files?.[0] ?? null); }} /></div>
          </div>
          <div className="field"><label htmlFor="query-package-content">Query 内容</label><Textarea id="query-package-content" className={styles.queryInput} value={queryText} rows={12} required disabled={creating} placeholder={'每行一条，例如：\n租房桌面收纳\n通勤穿搭\n周末露营装备'} onChange={(event) => changeImportText(event.target.value)} /></div>
          {readingImportFile && <div className="notice" role="status"><LoaderCircle className="animate-spin" size={15} />正在读取文件…</div>}
          {importError && <div className="notice error" role="alert">{importError}</div>}
          {queryText && parsedImport.error && <div className="notice error" role="alert">{parsedImport.error}</div>}
          <div className={styles.fileRow}><span>{sourceFileName ? `来源文件：${sourceFileName}` : '也可以直接粘贴纯文本或单列 CSV'}</span><small>识别 {parsedImport.queries.length} 条 · 重复 {parsedImport.duplicates} 条</small></div>
          <div className={styles.dialogFooter}><span>这里只导入候选 Query；点击“通过”后会自动进入文案生成。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={creating}>取消</Button></DialogClose><Button unstyled className="button primary" disabled={creating || readingImportFile || !packageName.trim() || Boolean(parsedImport.error)}>{creating ? '导入中…' : readingImportFile ? '读取文件中…' : '创建词包'}</Button></div></div>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={detail !== null || detailLoading} onOpenChange={(open) => { if (!open && !acting) closePackageDetail(); }}>
      <DialogContent className={styles.screeningDialog}>
        <div className={styles.screeningHead}><div><DialogTitle>{detail?.name ?? '读取词包'}</DialogTitle><DialogDescription>{detail ? `词包 #${detail.id} · 通过的 Query 会自动创建作业并进入文案生成。` : '正在读取词包详情…'}</DialogDescription></div>{detail && <span className="pill">{PACKAGE_STATUS_LABELS[detail.status] ?? detail.status}</span>}</div>
        {detail && <div className={styles.screeningStats}><span className="pill">全部 {detail.counts.total}</span><span className="pill">待筛 {detail.counts.pending}</span><span className="pill">通过 {detail.counts.selected}</span><span className="pill">淘汰 {detail.counts.rejected}</span><span className="pill">已创建作业 {detail.counts.produced}</span></div>}
        {detail && <div className={styles.screeningToolbar}><div className={styles.toolbarGroup}><SearchInput className={styles.search} value={itemSearch} onValueChange={setItemSearch} placeholder="搜索 Query 或外部编号" /><Select value={itemStatus} onValueChange={(value) => setItemStatus(value as QueryPackageItemFilter)}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部筛选结果</SelectItem><SelectItem value="PENDING">待筛选</SelectItem><SelectItem value="SELECTED">已通过</SelectItem><SelectItem value="REJECTED">已淘汰</SelectItem><SelectItem value="INVALID">内容无效</SelectItem><SelectItem value="DUPLICATE">重复项</SelectItem><SelectItem value="TASK_CREATED">已创建作业</SelectItem></SelectContent></Select></div><div className={styles.toolbarGroup}><Input value={screeningReason} maxLength={300} placeholder="批量淘汰时填写原因" aria-label="筛选原因" onChange={(event) => setScreeningReason(event.target.value)} /><Button unstyled className="button small primary" type="button" disabled={!checkedItemIds.length || Boolean(acting)} onClick={() => { void screen('SELECT'); }}><CheckCircle2 size={14} />通过 {checkedItemIds.length || ''}</Button><Button unstyled className="button small danger" type="button" disabled={!checkedItemIds.length || Boolean(acting)} onClick={() => { void screen('REJECT'); }}><XCircle size={14} />淘汰 {checkedItemIds.length || ''}</Button></div></div>}
        <div className={styles.screeningList}>
          {detailLoading && !detail ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取词包详情…</div>
            : detailError && !detail ? <div className="notice error" role="alert">{detailError}</div>
              : detail && visibleItems.length ? <><div className="table-wrap"><table>
                <thead><tr><th><Checkbox aria-label="选择本页可筛选 Query" checked={allVisibleChecked} onChange={(event) => setCheckedItemIds((current) => updateQueryItemSelection(current, screenableItems.map((item) => item.id), event.target.checked))} /></th><th>序号</th><th>Query</th><th>筛选结果</th><th>正式作业</th></tr></thead>
                <tbody>{pagedItems.map((item) => {
                  const screenable = item.validationStatus === 'READY' && !item.taskId;
                  return <tr key={item.id}><td data-label="筛选选择"><Checkbox aria-label={`选择第 ${item.rowNumber} 条 Query 进行筛选`} checked={checkedItemIdSet.has(item.id)} disabled={!screenable} onChange={(event) => setCheckedItemIds((current) => updateQueryItemSelection(current, [item.id], event.target.checked))} /></td><td data-label="序号">{item.rowNumber}</td><td className={styles.queryCell} data-label="Query"><strong>{item.query}</strong>{item.externalId && <div className={styles.reason}>外部编号：{item.externalId}</div>}{item.screeningReason && <div className={styles.reason}>筛选说明：{item.screeningReason}</div>}</td><td data-label="筛选结果"><span className="pill">{['INVALID', 'DUPLICATE'].includes(item.validationStatus) ? VALIDATION_STATUS_LABELS[item.validationStatus] : DECISION_LABELS[item.screeningDecision]}</span></td><td data-label="正式作业">{item.taskId ? `#${item.taskId}` : item.screeningDecision === 'SELECTED' ? '创建中' : '—'}</td></tr>;
                })}</tbody>
              </table></div><div className={styles.pagination}><span>显示 {itemPageStart + 1}–{Math.min(itemPageStart + QUERY_PACKAGE_ITEM_PAGE_SIZE, visibleItems.length)} / {visibleItems.length} 条</span><div><Button unstyled className="button small" type="button" disabled={currentItemPage <= 1 || Boolean(acting)} onClick={() => setItemPage((page) => Math.max(1, page - 1))}>上一页</Button><span>第 {currentItemPage} / {itemPageCount} 页</span><Button unstyled className="button small" type="button" disabled={currentItemPage >= itemPageCount || Boolean(acting)} onClick={() => setItemPage((page) => Math.min(itemPageCount, page + 1))}>下一页</Button></div></div></> : <div className="empty-state">没有符合当前筛选条件的 Query。</div>}
        </div>
        <div className={styles.screeningFooter}>{detailError ? <span className="notice error" role="alert">{detailError}</span> : <span className="subtle">已选择 {checkedItemIds.length} 条待筛 Query；通过后将自动进入文案生成。</span>}<div><Button unstyled className="button" type="button" disabled={Boolean(acting)} onClick={closePackageDetail}>关闭</Button>{detail && ['USED_UP', 'ABANDONED'].includes(detail.status) ? <Button unstyled className="button danger" type="button" disabled={Boolean(acting)} onClick={() => { void preparePermanentDelete(detail); }}><Trash2 size={14} />永久删除词包</Button> : detail && <Button unstyled className="button danger" type="button" disabled={Boolean(acting)} onClick={() => prepareAbandon(detail)}><XCircle size={14} />废弃词包</Button>}</div></div>
      </DialogContent>
    </Dialog>

    <Dialog open={abandonPackage !== null} onOpenChange={(open) => { if (!open && acting !== 'abandon') setAbandonPackage(null); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>废弃 Query 词包</DialogTitle><DialogDescription>停止继续筛选这个词包。已经创建的正式作业及其审核、图片和交付数据全部保留。</DialogDescription></div>
        {abandonPackage && <form className={styles.deleteForm} onSubmit={(event) => { event.preventDefault(); void abandon(); }}>
          <div className={styles.fileRow}><strong>{abandonPackage.name}</strong><small>候选 {abandonPackage.counts.total} 条 · 已创建作业 {abandonPackage.counts.produced} 条</small></div>
          <div className="field"><label htmlFor="query-package-abandon-reason">废弃原因</label><Textarea id="query-package-abandon-reason" value={abandonReason} maxLength={500} rows={4} required disabled={acting === 'abandon'} placeholder="说明停止使用此词包的原因，内容将进入审计记录" onChange={(event) => { setAbandonReason(event.target.value); setAbandonError(''); }} /></div>
          {abandonError && <div className="notice error" role="alert">{abandonError}</div>}
          <div className={styles.dialogFooter}><span>词包废弃后如需真删除，可再执行影响预检和二级密码确认。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={acting === 'abandon'}>取消</Button></DialogClose><Button unstyled className="button danger" disabled={acting === 'abandon' || !abandonReason.trim()}>{acting === 'abandon' ? '废弃中…' : '确认废弃词包'}</Button></div></div>
        </form>}
      </DialogContent>
    </Dialog>

    <Dialog open={deletePackage !== null} onOpenChange={(open) => { if (!open && acting !== 'delete') closePermanentDelete(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>永久删除 Query 词包</DialogTitle><DialogDescription>此操作会删除词包及其候选 Query，无法恢复。已经创建的正式作业、文案、图片和审核记录全部保留。</DialogDescription></div>
        {deletePackage && <form className={styles.deleteForm} onSubmit={(event) => { event.preventDefault(); void permanentlyDelete(); }}>
          {deletePreviewLoading ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在由中心预检删除影响…</div> : deletePreview?.packageId === deletePackage.id && <div className={styles.dangerBox}><ShieldAlert size={20} /><strong>{deletePreview.eligible ? '符合永久删除条件；正式作业不会被删除' : '当前状态不允许永久删除'}</strong><p>预检范围：候选 {deletePreview.itemCount} 条、生产批次 {deletePreview.productionBatchCount} 个、已脱离词包独立保留的正式作业 {deletePreview.detachedTaskCount} 条。正式作业删除数：{deletePreview.tasksWillBeDeleted ? '异常，请停止操作' : '0'}。</p></div>}
          <div className="field"><label htmlFor="query-package-delete-reason">永久删除原因</label><Textarea id="query-package-delete-reason" value={deletionReason} maxLength={500} rows={3} required disabled={acting === 'delete'} placeholder="说明删除范围和业务原因，内容将进入审计记录" onChange={(event) => { setDeletionReason(event.target.value); setDeleteError(''); }} /></div>
          <div className="field"><label htmlFor="query-package-delete-password">管理员二级密码</label><Input id="query-package-delete-password" type="password" value={deletionPassword} autoComplete="current-password" required disabled={acting === 'delete'} onChange={(event) => { setDeletionPassword(event.target.value); setDeleteError(''); }} /></div>
          <div className="field"><label htmlFor="query-package-delete-confirmation">输入词包名称“{deletePackage.name}”确认</label><Input id="query-package-delete-confirmation" value={confirmationName} required disabled={acting === 'delete'} onChange={(event) => { setConfirmationName(event.target.value); setDeleteError(''); }} /></div>
          {deleteError && <div className="notice error" role="alert">{deleteError}</div>}
          <div className={styles.dialogFooter}><span>删除范围：词包和候选数据；保留范围：所有正式作业。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={acting === 'delete'}>取消</Button></DialogClose><Button unstyled className="button danger" disabled={deletePreviewLoading || deletePreview?.packageId !== deletePackage.id || !deletePreview.eligible || deletePreview.tasksWillBeDeleted || acting === 'delete' || !deletionReason.trim() || !deletionPassword || confirmationName !== deletePackage.name}>{acting === 'delete' ? <><LoaderCircle className="animate-spin" size={15} />删除中…</> : <><Trash2 size={15} />永久删除</>}</Button></div></div>
        </form>}
      </DialogContent>
    </Dialog>
  </div>;
}
