'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToastFeedback } from '@/components/ui/sonner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Download, ExternalLink, Eye, FileSpreadsheet, History, Images, ListChecks, LoaderCircle, PackageCheck, RefreshCw, Search, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { DeliveryPreviewDialog } from './delivery-preview-dialog';
import styles from './delivery-pool.module.css';
import {
  DELIVERY_POOL_LIST_LIMIT,
  DELIVERY_POOL_SELECTION_LIMIT,
  DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT,
  DELIVERY_PREVIEW_UPLOAD_LIMITS,
  buildDeliveryPoolExportInput,
  filterDeliveryPoolEntries,
  mergeDeliveryPoolEntries,
  normalizeDeliveryPoolPage,
  normalizeDeliveryBatchDetail,
  normalizeDeliveryBatchPage,
  normalizePreparedDeliveryExport,
  normalizePreparedDeliveryXlsxExport,
  normalizeDeliveryPreviewPublishResult,
  parseDeliveryPoolSearchTerms,
  updateTaskSelection,
  type DeliveryEntry,
  type DeliveryBatchDetail,
  type DeliveryBatchSummary,
  type DeliveryClientBatchFacet,
  type DeliveryPoolSummary,
  type DeliveryQueryPackageFacet,
  type DeliveryUnassignedFacet,
} from './types';

type ExportScope = 'ALL_READY' | 'CLIENT_BATCH' | 'SELECTED';
type PackingFilter = 'PENDING' | 'PACKED' | 'ALL';
type WorkspaceView = 'CONTENT' | 'PREVIEW' | 'HISTORY';
const ALL_CLIENT_BATCHES = '__ALL_CLIENT_BATCHES__';
const UNASSIGNED_PREVIEW_LABEL = '历史未归属内容';

function timeLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function byteLabel(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function DeliveryPoolWorkbench({ role }: { role: 'ADMIN' }) {
  const confirm = useConfirmDialog();
  const [entries, setEntries] = useState<DeliveryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [activeView, setActiveView] = useState<WorkspaceView>('CONTENT');
  const [previewEntry, setPreviewEntry] = useState<DeliveryEntry | null>(null);
  const [search, setSearch] = useState('');
  const [clientBatchCode, setClientBatchCode] = useState('');
  const [packingFilter, setPackingFilter] = useState<PackingFilter>('PENDING');
  const [summary, setSummary] = useState<DeliveryPoolSummary>({
    readyCount: 0,
    pendingCount: 0,
    packedCount: 0,
    updatedCount: 0,
  });
  const [deliveryBatches, setDeliveryBatches] = useState<DeliveryBatchSummary[]>([]);
  const [deliveryBatchTotal, setDeliveryBatchTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [batchDetail, setBatchDetail] = useState<DeliveryBatchDetail | null>(null);
  const [batchDetailLoading, setBatchDetailLoading] = useState(false);
  const [queryPackages, setQueryPackages] = useState<DeliveryQueryPackageFacet[]>([]);
  const [clientBatches, setClientBatches] = useState<DeliveryClientBatchFacet[]>([]);
  const [previewUnassigned, setPreviewUnassigned] = useState<DeliveryUnassignedFacet | null>(null);
  const [previewPackageSearch, setPreviewPackageSearch] = useState('');
  const [selectedPreviewPackageIds, setSelectedPreviewPackageIds] = useState<number[]>([]);
  const [selectedPreviewUnassigned, setSelectedPreviewUnassigned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [xlsxExporting, setXlsxExporting] = useState(false);
  const [previewPublishing, setPreviewPublishing] = useState(false);
  const [previewUploadLimit, setPreviewUploadLimit] = useState<number>(50);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'warning'>('info');
  const searchInputRef = useRef<HTMLTextAreaElement>(null);
  const listRequestId = useRef(0);
  const historyRequestId = useRef(0);

  const load = useCallback(async (offset = 0) => {
    const currentRequestId = ++listRequestId.current;
    const append = offset > 0;
    if (append) setLoadingMore(true);
    else setRefreshing(true);
    try {
      const query = new URLSearchParams({
        limit: String(DELIVERY_POOL_LIST_LIMIT),
        offset: String(offset),
        includeTotal: 'true',
      });
      if (clientBatchCode) query.set('clientBatchCode', clientBatchCode);
      query.set('packingState', packingFilter);
      const page = normalizeDeliveryPoolPage(await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-pool?${query}`,
      ));
      if (currentRequestId !== listRequestId.current) return;
      const followingOffset = offset + page.items.length;
      setEntries((current) => append ? mergeDeliveryPoolEntries(current, page.items) : page.items);
      setTotal(page.total);
      setSummary(page.summary);
      setQueryPackages(page.facets.queryPackages);
      setClientBatches(page.facets.clientBatches);
      setPreviewUnassigned(page.facets.unassigned);
      if (!page.facets.unassigned) setSelectedPreviewUnassigned(false);
      const availablePackageIds = new Set(page.facets.queryPackages.map((facet) => facet.id));
      setSelectedPreviewPackageIds((current) => current.filter((id) => availablePackageIds.has(id)));
      setNextOffset(followingOffset);
      setHasMore(page.items.length > 0 && followingOffset < page.total);
      if (!append) {
        const availableTaskIds = new Set(page.items.map((entry) => entry.taskId));
        setSelected((current) => current.filter((taskId) => availableTaskIds.has(taskId)));
      }
      setError('');
    } catch (caught) {
      if (currentRequestId !== listRequestId.current) return;
      setError(caught instanceof Error ? caught.message : '交付池读取失败');
    } finally {
      if (currentRequestId === listRequestId.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [clientBatchCode, packingFilter]);

  const loadHistory = useCallback(async () => {
    const currentRequestId = ++historyRequestId.current;
    setHistoryLoading(true);
    try {
      const query = new URLSearchParams({ limit: '50', offset: '0' });
      if (clientBatchCode) query.set('clientBatchCode', clientBatchCode);
      const page = normalizeDeliveryBatchPage(await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-batches?${query}`,
      ));
      if (currentRequestId !== historyRequestId.current) return;
      setDeliveryBatches(page.items);
      setDeliveryBatchTotal(page.total);
    } catch (caught) {
      if (currentRequestId !== historyRequestId.current) return;
      setError(caught instanceof Error ? caught.message : '交付批次历史读取失败');
    } finally {
      if (currentRequestId === historyRequestId.current) setHistoryLoading(false);
    }
  }, [clientBatchCode]);
  useEffect(() => {
    setEntries([]);
    setTotal(0);
    setSummary({ readyCount: 0, pendingCount: 0, packedCount: 0, updatedCount: 0 });
    setNextOffset(0);
    setHasMore(false);
    setSelected([]);
    setLoading(true);
    void load();
  }, [load]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => () => {
    listRequestId.current += 1;
    historyRequestId.current += 1;
  }, []);

  const searchTermCount = useMemo(() => parseDeliveryPoolSearchTerms(search).length, [search]);
  const visible = useMemo(() => filterDeliveryPoolEntries(entries, search), [entries, search]);
  const selectionCandidates = visible.slice(0, DELIVERY_POOL_SELECTION_LIMIT);
  const allChecked = selectionCandidates.length > 0
    && selectionCandidates.every((entry) => selected.includes(entry.taskId));
  const selectedTaskIdSet = useMemo(() => new Set(selected), [selected]);
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedTaskIdSet.has(entry.taskId)),
    [entries, selectedTaskIdSet],
  );
  const selectedPackableCount = selectedEntries.filter((entry) => entry.packingState !== 'PACKED').length;
  const selectedPreviewEntries = useMemo(
    () => entries.filter((entry) => selectedTaskIdSet.has(entry.taskId) && entry.preview === null),
    [entries, selectedTaskIdSet],
  );
  const selectedPreviewEntryCount = selectedPreviewEntries.length;
  const previewSearchTerm = previewPackageSearch.trim().toLocaleLowerCase('zh-CN');
  const visiblePreviewPackages = useMemo(() => previewSearchTerm
    ? queryPackages.filter((facet) => `${facet.name} ${facet.clientBatchCode ?? ''}`
      .toLocaleLowerCase('zh-CN').includes(previewSearchTerm))
    : queryPackages, [previewSearchTerm, queryPackages]);
  const visiblePreviewUnassigned = previewUnassigned !== null
    && (!previewSearchTerm
      || UNASSIGNED_PREVIEW_LABEL.toLocaleLowerCase('zh-CN').includes(previewSearchTerm));
  const selectedPreviewPackages = useMemo(() => {
    const selectedIds = new Set(selectedPreviewPackageIds);
    return queryPackages.filter((facet) => selectedIds.has(facet.id));
  }, [queryPackages, selectedPreviewPackageIds]);
  const selectedPreviewScopeCount = selectedPreviewPackageIds.length
    + Number(selectedPreviewUnassigned);
  const selectedPreviewUnuploadedCount = selectedPreviewPackages.reduce(
    (sum, facet) => sum + facet.unuploadedCount,
    0,
  ) + (selectedPreviewUnassigned ? previewUnassigned?.unuploadedCount ?? 0 : 0);
  const visiblePreviewScopeCount = visiblePreviewPackages.length + Number(visiblePreviewUnassigned);
  const allVisiblePreviewScopesChecked = visiblePreviewScopeCount > 0
    && visiblePreviewPackages.every((facet) => selectedPreviewPackageIds.includes(facet.id))
    && (!visiblePreviewUnassigned || selectedPreviewUnassigned);
  const exportBusy = exporting !== null || xlsxExporting || previewPublishing;
  const xlsxExportCount = selected.length || summary.readyCount;
  const filteredExportScope: Exclude<ExportScope, 'SELECTED'> = clientBatchCode
    ? 'CLIENT_BATCH'
    : 'ALL_READY';

  function changeSelection(candidateIds: number[], checked: boolean) {
    const requestedCount = new Set([...selected, ...candidateIds]).size;
    const next = updateTaskSelection(selected, candidateIds, checked);
    setSelected(next);
    if (checked && requestedCount > DELIVERY_POOL_SELECTION_LIMIT) {
      setMessageTone('warning');
      setMessage(`单次最多选择 ${DELIVERY_POOL_SELECTION_LIMIT} 条；其余条目可分批上传或下载。`);
    }
  }

  function changePreviewScopeSelection(
    candidateIds: number[],
    candidateIncludesUnassigned: boolean,
    checked: boolean,
  ) {
    const candidates = new Set(candidateIds);
    if (!checked) {
      setSelectedPreviewPackageIds((current) => current.filter((id) => !candidates.has(id)));
      if (candidateIncludesUnassigned) setSelectedPreviewUnassigned(false);
      return;
    }
    const requested = [...new Set([...selectedPreviewPackageIds, ...candidates])];
    const includeUnassigned = selectedPreviewUnassigned || candidateIncludesUnassigned;
    const requestedCount = requested.length + Number(includeUnassigned);
    if (requestedCount > DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT) {
      setMessageTone('warning');
      setMessage(`单次最多选择 ${DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT} 个上传范围，请分批处理。`);
    }
    setSelectedPreviewUnassigned(includeUnassigned);
    setSelectedPreviewPackageIds(requested.slice(
      0,
      DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT - Number(includeUnassigned),
    ));
  }

  async function exportDelivery(scope: ExportScope, explicitTaskIds: number[] | null = null) {
    const selectedTaskIds = explicitTaskIds ?? selected;
    if (exportBusy || (scope === 'SELECTED' ? !selectedTaskIds.length : summary.pendingCount === 0)
      || (scope === 'CLIENT_BATCH' && !clientBatchCode)) return;
    const count = scope === 'SELECTED' ? selectedTaskIds.length : summary.pendingCount;
    setExporting(scope);
    setError('');
    setMessageTone('info');
    setMessage(scope === 'SELECTED'
      ? `正在为已选 ${count} 条内容创建交付批次。`
      : scope === 'CLIENT_BATCH'
        ? `正在为甲方批次“${clientBatchCode}”创建交付批次，本次包含其全部 ${count} 条待交付内容。`
        : `正在创建交付批次，本次仅包含全部 ${count} 条待交付内容。`);
    try {
      const response = await fetch('/api/control-plane/v1/delivery-pool/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope === 'SELECTED'
          ? { scope, taskIds: selectedTaskIds }
          : scope === 'CLIENT_BATCH'
            ? { scope, clientBatchCode }
            : { scope }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `交付池导出失败（${response.status}）`);
      }
      const prepared = normalizePreparedDeliveryExport(await response.json().catch(() => null));
      const anchor = document.createElement('a');
      anchor.href = `/api/control-plane/v1/delivery-pool/archive/${encodeURIComponent(prepared.downloadId)}`;
      anchor.download = prepared.fileName;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setMessage(`${prepared.batchCode ? `交付批次 ${prepared.batchCode}` : '交付包'}已创建，包含 ${prepared.taskCount} 条内容，下载已开始。以后可从交付历史重新下载。`);
      setMessageTone('success');
      setSelected([]);
      await Promise.all([load(), loadHistory()]);
      window.setTimeout(() => { void loadHistory(); }, 1200);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '交付池导出失败');
    } finally {
      setExporting(null);
    }
  }

  async function openBatchDetail(batch: DeliveryBatchSummary) {
    setBatchDetailLoading(true);
    setError('');
    try {
      setBatchDetail(normalizeDeliveryBatchDetail(await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-batches/${encodeURIComponent(batch.publicId)}`,
      )));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '交付批次详情读取失败');
    } finally {
      setBatchDetailLoading(false);
    }
  }

  async function exportXlsx() {
    if (exportBusy || xlsxExportCount === 0) return;
    if (!selected.length && summary.readyCount > DELIVERY_POOL_SELECTION_LIMIT) {
      setMessage('');
      setError(`Excel 一次最多导出 ${DELIVERY_POOL_SELECTION_LIMIT} 篇文章，请先勾选后分批导出。`);
      return;
    }
    const selectedTaskIds = [...selected];
    let input: ReturnType<typeof buildDeliveryPoolExportInput>;
    try {
      input = buildDeliveryPoolExportInput(selectedTaskIds, clientBatchCode);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : 'Excel 导出范围无效，请刷新后重试');
      return;
    }
    const count = input.scope === 'SELECTED' ? input.taskIds.length : summary.readyCount;
    setXlsxExporting(true);
    setError('');
    setMessageTone('info');
    setMessage(input.scope === 'SELECTED'
      ? `正在生成已选 ${count} 条可交付项的 Excel；图片原文件不重新编码、不二次压缩。`
      : input.scope === 'CLIENT_BATCH'
        ? `正在生成甲方批次“${input.clientBatchCode}”全部 ${count} 条 READY 交付项的 Excel；图片原文件不重新编码、不二次压缩，文本搜索不会缩小导出范围。`
        : `正在生成全部 ${count} 条 READY 交付项的 Excel；图片原文件不重新编码、不二次压缩，文本搜索不会缩小导出范围。`);
    try {
      const response = await fetch('/api/control-plane/v1/delivery-pool/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `Excel 导出失败（${response.status}）`);
      }
      const prepared = normalizePreparedDeliveryXlsxExport(await response.json().catch(() => null));
      const anchor = document.createElement('a');
      anchor.href = `/api/control-plane/v1/delivery-pool/xlsx/${encodeURIComponent(prepared.downloadId)}`;
      anchor.download = prepared.fileName;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setMessage(input.scope === 'SELECTED'
        ? `已选 ${prepared.taskCount} 条可交付项的 Excel 已准备，下载已开始。`
        : input.scope === 'CLIENT_BATCH'
          ? `甲方批次“${input.clientBatchCode}”的 ${prepared.taskCount} 条 READY 交付项 Excel 已准备，下载已开始。`
          : `全部 ${prepared.taskCount} 条 READY 交付项的 Excel 已准备，下载已开始。`);
      setMessageTone('success');
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : 'Excel 导出失败');
    } finally {
      setXlsxExporting(false);
    }
  }

  async function submitPreviewUpload({
    queryPackageIds,
    includeUnassigned,
    taskIds = [],
    limit,
    pendingMessage,
  }: {
    queryPackageIds: number[];
    includeUnassigned: boolean;
    taskIds?: number[];
    limit: number;
    pendingMessage: string;
  }) {
    setPreviewPublishing(true);
    setError('');
    setMessageTone('info');
    setMessage(pendingMessage);
    try {
      const result = normalizeDeliveryPreviewPublishResult(await apiRequest<unknown>(
        '/api/control-plane/v1/delivery-pool/previews',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'QUERY_PACKAGES',
            queryPackageIds,
            includeUnassigned,
            ...(taskIds.length ? { taskIds } : {}),
            limit,
          }),
        },
      ));
      setMessageTone(result.failedCount ? 'warning' : 'success');
      setMessage(`预览处理完成：新建 ${result.createdCount} 条，复用 ${result.reusedCount} 条${result.failedCount ? `，失败 ${result.failedCount} 条` : ''}。`);
      if (result.failedCount) {
        setError(result.failures.slice(0, 3).map((failure) => `任务 #${failure.taskId}：${failure.message}`).join('；'));
      }
      await load();
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '预览上传失败');
    } finally {
      setPreviewPublishing(false);
    }
  }

  async function publishPreviews() {
    if (exportBusy || selectedPreviewScopeCount === 0) return;
    if (selectedPreviewUnuploadedCount === 0) {
      setError('');
      setMessageTone('warning');
      setMessage('所选范围当前没有尚未上传的 READY 交付项，无需重复上传。');
      return;
    }
    const selectedNames = selectedPreviewPackages.map((facet) => `“${facet.name}${facet.deleted ? '（来源已删除）' : ''}”`);
    if (selectedPreviewUnassigned) selectedNames.unshift(`“${UNASSIGNED_PREVIEW_LABEL}”`);
    const namesPreview = selectedNames.length <= 3
      ? selectedNames.join('、')
      : `${selectedNames.slice(0, 3).join('、')}等 ${selectedNames.length} 个范围`;
    const uploadCount = Math.min(selectedPreviewUnuploadedCount, previewUploadLimit);
    if (!await confirm({
      title: previewUploadLimit === 1 ? '确认测试上传 1 条预览？' : '确认上传所选范围的预览？',
      description: `已勾选 ${selectedNames.length} 个上传范围：${namesPreview}。本次只会上传这些范围内尚未上传且版本仍有效的 READY 交付项，预计处理 ${uploadCount} 条${previewUploadLimit === 1 ? '；系统会按终审时间选择最新的一条' : ''}${selectedPreviewUnuploadedCount > previewUploadLimit ? `（另有 ${selectedPreviewUnuploadedCount - previewUploadLimit} 条受本次上限限制，将留待下次上传）` : ''}。页面文本搜索、列表筛选和任务行勾选不会改变本次范围。`,
      confirmLabel: previewUploadLimit === 1 ? '测试上传 1 条' : `确认上传 ${uploadCount} 条`,
    })) return;
    await submitPreviewUpload({
      queryPackageIds: selectedPreviewPackageIds,
      includeUnassigned: selectedPreviewUnassigned,
      limit: previewUploadLimit,
      pendingMessage: previewUploadLimit === 1
        ? '正在测试上传所选范围内最新的一条未上传内容。'
        : `正在上传所选 ${selectedNames.length} 个范围内最多 ${previewUploadLimit} 条尚未上传的交付项；系统会自动拆成安全的小批次。`,
    });
  }

  async function publishSinglePreview(entry: DeliveryEntry) {
    if (exportBusy || entry.preview !== null) return;
    const queryLabel = entry.query.trim() || '未记录 Query';
    const sourceLabel = entry.queryPackageName
      ? `词包“${entry.queryPackageName}”`
      : `“${UNASSIGNED_PREVIEW_LABEL}”`;
    if (!await confirm({
      title: `上传任务 #${entry.taskId}？`,
      description: `将从${sourceLabel}精确上传任务 #${entry.taskId}（${queryLabel}）。本次只处理这一条，不会上传同范围内的其他内容。`,
      confirmLabel: '上传这一条',
    })) return;
    await submitPreviewUpload({
      queryPackageIds: entry.queryPackageId === null ? [] : [entry.queryPackageId],
      includeUnassigned: entry.queryPackageId === null,
      taskIds: [entry.taskId],
      limit: 1,
      pendingMessage: `正在上传任务 #${entry.taskId}，本次只处理这一条。`,
    });
  }

  async function publishSelectedPreviews() {
    if (exportBusy || selectedPreviewEntryCount === 0) return;
    const taskIds = selectedPreviewEntries.map((entry) => entry.taskId);
    const queryPackageIds = [...new Set(selectedPreviewEntries.flatMap(
      (entry) => entry.queryPackageId === null ? [] : [entry.queryPackageId],
    ))];
    const includeUnassigned = selectedPreviewEntries.some(
      (entry) => entry.queryPackageId === null,
    );
    const taskPreview = taskIds.length <= 8
      ? taskIds.map((taskId) => `#${taskId}`).join('、')
      : `${taskIds.slice(0, 8).map((taskId) => `#${taskId}`).join('、')}等 ${taskIds.length} 条`;
    const alreadyUploadedCount = selected.length - selectedPreviewEntryCount;
    if (!await confirm({
      title: `上传已指定的 ${selectedPreviewEntryCount} 条内容？`,
      description: `本次将精确上传任务 ${taskPreview}，不会自动补充同词包内的其他内容${alreadyUploadedCount > 0 ? `；另有 ${alreadyUploadedCount} 条已选内容已有预览，不会重复上传` : ''}。提交时会再次校验所属词包、READY 状态和交付版本。`,
      confirmLabel: `上传这 ${selectedPreviewEntryCount} 条`,
    })) return;
    await submitPreviewUpload({
      queryPackageIds,
      includeUnassigned,
      taskIds,
      limit: taskIds.length,
      pendingMessage: `正在精确上传已指定的 ${taskIds.length} 条内容，不会处理同词包内的其他条目。`,
    });
  }

  const clientBatchSelectValue = clientBatchCode
    ? `client-batch:${clientBatchCode}`
    : ALL_CLIENT_BATCHES;
  const unselectedExportLabel = clientBatchCode
    ? `甲方批次“${clientBatchCode}”全部 ${summary.readyCount} 条`
    : `全部 ${summary.readyCount} 条`;

  return <div className={styles.stack}>
    <section className={`panel ${styles.workspace}`} aria-labelledby="delivery-pool-title">
      <header className={styles.workspaceHeader}>
        <div>
          <span className={styles.eyebrow}>DELIVERY CONTROL</span>
          <h2 id="delivery-pool-title">交付管理</h2>
          <p>核对内容、生成交付包与发布预览分区处理；测试任务已由服务端隔离。</p>
        </div>
        <Button unstyled className="button small" type="button" disabled={refreshing || loadingMore || exportBusy} onClick={() => {
          const hadSelection = selected.length > 0 || selectedPreviewScopeCount > 0;
          setSelected([]);
          setSelectedPreviewPackageIds([]);
          setSelectedPreviewUnassigned(false);
          if (hadSelection) setMessage('交付池已刷新，原选择已清空，请重新确认。');
          if (hadSelection) setMessageTone('info');
          void Promise.all([load(), loadHistory()]);
        }}>
          <RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />刷新数据
        </Button>
      </header>

      <div className={styles.progressGrid} aria-label="当前交付进度">
        <article><span>READY 总数</span><strong>{summary.readyCount}</strong><small>通过全部门禁</small></article>
        <article className={styles.pendingCard}><span>待交付</span><strong>{summary.pendingCount}</strong><small>可创建新批次</small></article>
        <article className={styles.packedCard}><span>已打包</span><strong>{summary.packedCount}</strong><small>可追溯下载</small></article>
        <article className={styles.updatedCard}><span>版本更新</span><strong>{summary.updatedCount}</strong><small>需要重新交付</small></article>
      </div>

      <nav className={styles.workspaceTabs} aria-label="交付池工作区" role="tablist">
        <Button unstyled id="delivery-content-tab" type="button" role="tab" aria-selected={activeView === 'CONTENT'} aria-controls="delivery-content-panel" data-active={activeView === 'CONTENT'} onClick={() => setActiveView('CONTENT')}>
          <ListChecks size={16} /><span>交付内容<small>{summary.pendingCount} 条待处理</small></span>
        </Button>
        <Button unstyled id="delivery-preview-tab" type="button" role="tab" aria-selected={activeView === 'PREVIEW'} aria-controls="delivery-preview-panel" data-active={activeView === 'PREVIEW'} onClick={() => setActiveView('PREVIEW')}>
          <Images size={16} /><span>预览发布<small>{queryPackages.length + Number(Boolean(previewUnassigned))} 个范围</small></span>
        </Button>
        <Button unstyled id="delivery-history-tab" type="button" role="tab" aria-selected={activeView === 'HISTORY'} aria-controls="delivery-history-panel" data-active={activeView === 'HISTORY'} onClick={() => setActiveView('HISTORY')}>
          <History size={16} /><span>交付历史<small>{deliveryBatchTotal} 个批次</small></span>
        </Button>
      </nav>

      <ToastFeedback id="delivery-pool-error" message={error} tone="error" />
      <ToastFeedback id="delivery-pool-feedback" message={message} tone={messageTone} />

      {activeView === 'CONTENT' && <div className={styles.workspacePane} id="delivery-content-panel" role="tabpanel" aria-labelledby="delivery-content-tab">
        <div className={styles.filterPanel}>
          <div className={styles.searchField}>
            <label htmlFor="delivery-pool-search">搜索交付内容</label>
            <div className={styles.searchControl}>
              <Search className={styles.searchIcon} size={16} aria-hidden="true" />
              <Textarea ref={searchInputRef} id="delivery-pool-search" className={styles.search}
                value={search} rows={2} maxLength={20_000} aria-describedby="delivery-pool-search-help"
                placeholder={'每行一条：Query、甲方批次、词包或任务号'}
                onChange={(event) => setSearch(event.target.value)} />
              {search && <Button unstyled className={styles.clearSearch} type="button" aria-label="清除全部搜索条件" onClick={() => {
                setSearch('');
                searchInputRef.current?.focus();
              }}><X size={15} aria-hidden="true" /></Button>}
            </div>
            <span id="delivery-pool-search-help">每行一条，在已加载条目的 Query、甲方批次、词包名称或任务号中匹配任意一条；自动忽略空行和重复项。</span>
          </div>
          <div className={styles.packageFilter}>
            <label htmlFor="delivery-pool-client-batch">甲方批次</label>
            <Select value={clientBatchSelectValue} onValueChange={(value) => {
              setClientBatchCode(value === ALL_CLIENT_BATCHES ? '' : value.slice('client-batch:'.length));
            }}>
              <SelectTrigger id="delivery-pool-client-batch" aria-describedby="delivery-pool-client-batch-help"><SelectValue placeholder="全部甲方批次" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CLIENT_BATCHES}>全部甲方批次</SelectItem>
                {clientBatches.map((facet) => <SelectItem key={facet.code} value={`client-batch:${facet.code}`}>
                  {facet.code}（{facet.queryPackageCount} 个词包 · 待 {facet.pendingCount} / 已打包 {facet.packedCount}）
                </SelectItem>)}
              </SelectContent>
            </Select>
            <small id="delivery-pool-client-batch-help">筛选与无勾选导出都会覆盖该批次下全部词包。</small>
          </div>
          <div className={styles.packageFilter}>
            <label htmlFor="delivery-pool-packing-filter">交付状态</label>
            <Select value={packingFilter} onValueChange={(value) => setPackingFilter(value as PackingFilter)}>
              <SelectTrigger id="delivery-pool-packing-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PENDING">待交付（默认）</SelectItem>
                <SelectItem value="PACKED">已打包</SelectItem>
                <SelectItem value="ALL">全部状态</SelectItem>
              </SelectContent>
            </Select>
            <small>待交付包含首次交付与版本更新后重交。</small>
          </div>
        </div>

        <div className={styles.resultBar}>
          <div><strong>{visible.length}</strong><span>当前结果</span><small>已加载 {entries.length} / 共 {total} 条{searchTermCount ? ` · ${searchTermCount} 个搜索词` : ''}</small></div>
          <span className={`pill ${styles.searchStatus}`} role="status" aria-live="polite">
            {clientBatchCode ? `甲方批次 ${clientBatchCode}` : '全部甲方批次'} · {packingFilter === 'PENDING' ? '待交付' : packingFilter === 'PACKED' ? '已打包' : '全部状态'}
          </span>
        </div>

        {role === 'ADMIN' && <div className={styles.selectionBar}>
          <div>
            <strong>{selected.length ? `已选 ${selected.length} 条` : '未选择具体条目'}</strong>
            <span>{selected.length
              ? `${selectedPackableCount} 条可打包 · ${selectedPreviewEntryCount} 条尚未发布预览`
              : clientBatchCode
                ? `未勾选时处理该甲方批次全部 ${summary.pendingCount} 条待交付内容`
                : `未勾选时处理全部 ${summary.pendingCount} 条待交付内容`}</span>
          </div>
          <div className={styles.contextActions}>
            <Button unstyled className="button small" type="button" aria-busy={xlsxExporting}
              aria-label={selected.length ? `导出已选 ${selected.length} 篇文章与图片为 Excel` : `导出${unselectedExportLabel}文章与图片为 Excel`}
              title={!selected.length && summary.readyCount > DELIVERY_POOL_SELECTION_LIMIT ? `超过 ${DELIVERY_POOL_SELECTION_LIMIT} 篇时请先勾选后分批导出` : undefined}
              disabled={xlsxExportCount === 0 || exportBusy} onClick={() => { void exportXlsx(); }}>
              <FileSpreadsheet aria-hidden="true" size={14} />
              {xlsxExporting ? '正在生成 Excel…' : selected.length ? `导出 Excel（已选 ${selected.length}）` : `导出 Excel（全部 ${summary.readyCount}）`}
            </Button>
            <Button unstyled className="button small" type="button" disabled={summary.pendingCount === 0 || exportBusy}
              onClick={() => { void exportDelivery(filteredExportScope); }}>
              <Download size={14} />{exporting === filteredExportScope ? '交付批次创建中…' : `新建交付批次（待交付 ${summary.pendingCount}）`}
            </Button>
            <Button unstyled className="button small primary" type="button"
              disabled={!selected.length || selectedPackableCount !== selected.length || exportBusy}
              title={selected.length && selectedPackableCount !== selected.length ? '已选内容中包含已打包版本，请仅选择待交付内容' : undefined}
              onClick={() => { void exportDelivery('SELECTED'); }}>
              <PackageCheck size={14} />{exporting === 'SELECTED' ? '交付批次创建中…' : `已选新建批次（${selected.length}）`}
            </Button>
          </div>
        </div>}
        <p className={styles.scopeNote}>新建交付批次始终由服务端排除已经打包的相同版本；文本搜索只覆盖已加载条目。Excel 按原文件字节内嵌图片，只调整表格中的显示尺寸，不重新编码或二次压缩。</p>

        {loading
          ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取交付池…</div>
          : visible.length === 0
            ? <div className="empty-state">{entries.length ? '没有符合搜索条件的交付条目。'
              : summary.readyCount > 0 && packingFilter === 'PENDING' ? '当前范围没有待交付内容，可在“交付历史”重新下载原批次。'
                : summary.readyCount > 0 && packingFilter === 'PACKED' ? '当前范围还没有已打包内容。'
                  : clientBatchCode ? `甲方批次“${clientBatchCode}”当前没有 READY 交付条目。`
                    : '交付池当前为空；图片质检门禁放行后会在这里生成就绪条目。'}</div>
            : <div className={`${styles.deliveryTable} table-wrap mobile-cards`} role="region" aria-label="交付内容列表，可横向滚动" tabIndex={0}>
              <table>
                <thead><tr>
                  <th><Checkbox aria-label={`选择当前已加载的筛选结果（最多 ${DELIVERY_POOL_SELECTION_LIMIT} 条）`} checked={allChecked} disabled={exportBusy} onChange={(event) => changeSelection(selectionCandidates.map((entry) => entry.taskId), event.target.checked)} /></th>
                  <th>内容与来源</th><th>交付状态</th><th>冻结版本</th><th>操作</th>
                </tr></thead>
                <tbody>{visible.map((entry) => <tr key={entry.id}>
                  <td data-label="选择"><Checkbox aria-label={`选择任务 ${entry.taskId}`} checked={selected.includes(entry.taskId)} disabled={exportBusy || (!selected.includes(entry.taskId) && selected.length >= DELIVERY_POOL_SELECTION_LIMIT)} onChange={(event) => changeSelection([entry.taskId], event.target.checked)} /></td>
                  <td data-label="内容与来源"><div className={styles.contentCell}>
                    <div><strong>#{entry.taskId}</strong><span>{entry.query || '未记录 Query'}</span></div>
                    <small>{entry.clientBatchCode || '未归属甲方批次'} · {entry.queryPackageName || '未归属词包'}</small>
                  </div></td>
                  <td data-label="交付状态"><div className={styles.deliveryState}>
                    {entry.packingState === 'PACKED' && entry.deliveryBatch
                      ? <><span className="pill">已打包</span><small>{entry.deliveryBatch.code}</small></>
                      : entry.packingState === 'VERSION_UPDATED'
                        ? <><span className={`pill ${styles.updatedPill}`}>版本更新待重交</span><small>上次 {entry.previousDeliveryBatch?.code ?? '历史批次'}</small></>
                        : <span className={`pill ${styles.pendingPill}`}>首次待交付</span>}
                    <small>{entry.preview?.status === 'PUBLISHED' ? '预览已发布' : entry.preview?.status === 'REVOKED' ? '预览已撤销' : '预览未发布'}</small>
                  </div></td>
                  <td data-label="冻结版本"><div className={styles.version}>
                    <span>文案 #{entry.copyRevisionId} · 图片 {entry.imageRunId.slice(0, 8)}…</span>
                    <span>终审 {entry.approvedAt ? new Date(entry.approvedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}</span>
                  </div></td>
                  <td className="row-action" data-label="操作"><div className={styles.actions}>
                    <Button unstyled className="button small" type="button" onClick={() => setPreviewEntry(entry)}><Eye size={14} />预览图文</Button>
                    {entry.preview?.status === 'PUBLISHED' && entry.preview.url
                      ? <a className="button small" href={entry.preview.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开预览</a>
                      : entry.preview === null && <Button unstyled className="button small" type="button" disabled={exportBusy} onClick={() => { void publishSinglePreview(entry); }}><UploadCloud size={14} />上传这一条</Button>}
                    {entry.packingState === 'PACKED' && entry.deliveryBatch
                      ? <a className="button small primary" href={`/api/control-plane/v1/delivery-batches/${encodeURIComponent(entry.deliveryBatch.publicId)}/archive`} download onClick={() => window.setTimeout(() => { void loadHistory(); }, 1200)}><Download size={14} />重下原批次</a>
                      : <Button unstyled className="button small primary" type="button" disabled={exportBusy} onClick={() => { void exportDelivery('SELECTED', [entry.taskId]); }}><PackageCheck size={14} />创建单条批次</Button>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>}
        {hasMore && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMore || refreshing || exportBusy} onClick={() => { void load(nextOffset); }}>
          {loadingMore ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : clientBatchCode
            ? `加载更多（该甲方批次剩余约 ${Math.max(0, total - nextOffset)} 条）`
            : `加载更多（服务端剩余约 ${Math.max(0, total - nextOffset)} 条）`}
        </Button></div>}
        <div className={styles.summary}><strong>交付门禁</strong><span>测试任务隔离 + 图片质检放行 + 当前文案与图片版本匹配 + READY 记录，缺一不可。</span></div>
      </div>}

      {activeView === 'PREVIEW' && role === 'ADMIN' && <div className={styles.workspacePane} id="delivery-preview-panel" role="tabpanel" aria-labelledby="delivery-preview-tab">
        <section className={styles.previewScope} aria-labelledby="delivery-preview-package-title">
          <div className={styles.previewScopeHeader}>
            <div><span className={styles.eyebrow}>PREVIEW PUBLISHING</span><h3 id="delivery-preview-package-title">选择发布范围</h3>
              <p>整包发布按词包选择；精确发布则先到“交付内容”勾选任务。任务行勾选不会改变这里的整包范围。</p></div>
            <strong>{selectedPreviewScopeCount ? `已选 ${selectedPreviewScopeCount} 个范围 · ${selectedPreviewUnuploadedCount} 条未上传` : '尚未选择上传范围'}</strong>
          </div>
          <div className={styles.previewActionBar}>
            <div className={styles.previewUploadControl}>
              <label htmlFor="delivery-preview-upload-limit">整包上传上限</label>
              <Select value={String(previewUploadLimit)} onValueChange={(value) => setPreviewUploadLimit(Number(value))}>
                <SelectTrigger id="delivery-preview-upload-limit" aria-label="本次预览上传条数上限"><SelectValue /></SelectTrigger>
                <SelectContent>{DELIVERY_PREVIEW_UPLOAD_LIMITS.map((limit) => <SelectItem key={limit} value={String(limit)}>{limit === 1 ? '1 条（测试）' : `${limit} 条`}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button unstyled className="button small primary" type="button" aria-busy={previewPublishing}
              disabled={selectedPreviewScopeCount === 0 || selectedPreviewUnuploadedCount === 0 || exportBusy}
              onClick={() => { void publishPreviews(); }}>
              {previewPublishing ? <><LoaderCircle className="animate-spin" size={14} />正在上传预览…</>
                : <><UploadCloud size={14} />{selectedPreviewScopeCount === 0 ? '请先勾选上传范围'
                  : selectedPreviewUnuploadedCount === 0 ? '所选范围无需上传'
                    : `整包上传（${selectedPreviewScopeCount} 个范围 / 最多 ${previewUploadLimit} 条）`}</>}
            </Button>
            <Button unstyled className="button small" type="button" aria-busy={previewPublishing}
              aria-label={`上传已指定的 ${selectedPreviewEntryCount} 条尚未上传内容`}
              disabled={selectedPreviewEntryCount === 0 || exportBusy} onClick={() => { void publishSelectedPreviews(); }}
              title={selected.length > 0 && selectedPreviewEntryCount === 0 ? '已选内容均已有预览，无需重复上传' : undefined}>
              <UploadCloud size={14} />{previewPublishing ? '正在上传预览…' : selectedPreviewEntryCount ? `上传已选（${selectedPreviewEntryCount} 条）` : '上传已选'}
            </Button>
          </div>
          <div className={styles.previewPackageTools}>
            <Input id="delivery-preview-package-search" value={previewPackageSearch} placeholder="搜索词包或历史未归属内容" aria-label="搜索预览上传范围" onChange={(event) => setPreviewPackageSearch(event.target.value)} />
            <Button unstyled className="button small" type="button" disabled={visiblePreviewScopeCount === 0 || exportBusy}
              onClick={() => changePreviewScopeSelection(visiblePreviewPackages.map((facet) => facet.id), visiblePreviewUnassigned, !allVisiblePreviewScopesChecked)}>
              {allVisiblePreviewScopesChecked ? '取消当前结果' : '勾选当前结果'}
            </Button>
            <Button unstyled className="button small" type="button" disabled={selectedPreviewScopeCount === 0 || exportBusy} onClick={() => {
              setSelectedPreviewPackageIds([]);
              setSelectedPreviewUnassigned(false);
            }}>清空选择</Button>
          </div>
          <div className={styles.previewPackageList} role="group" aria-label="预览上传范围">
            {visiblePreviewScopeCount ? <>
              {visiblePreviewUnassigned && previewUnassigned && <label className={`${styles.previewPackageOption} ${styles.previewUnassignedOption}`}>
                <Checkbox checked={selectedPreviewUnassigned} disabled={exportBusy || (!selectedPreviewUnassigned && selectedPreviewScopeCount >= DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT)} onChange={(event) => changePreviewScopeSelection([], true, event.target.checked)} />
                <span><strong>{UNASSIGNED_PREVIEW_LABEL}</strong><small>READY {previewUnassigned.count} · 未上传 {previewUnassigned.unuploadedCount} · 已发布 {previewUnassigned.publishedCount}{previewUnassigned.revokedCount ? ` · 已撤销 ${previewUnassigned.revokedCount}` : ''}</small></span>
              </label>}
              {visiblePreviewPackages.map((facet) => <label key={facet.id} className={styles.previewPackageOption}>
                <Checkbox checked={selectedPreviewPackageIds.includes(facet.id)} disabled={exportBusy || (!selectedPreviewPackageIds.includes(facet.id) && selectedPreviewScopeCount >= DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT)} onChange={(event) => changePreviewScopeSelection([facet.id], false, event.target.checked)} />
                <span><strong>{facet.name}{facet.deleted ? '（来源已删除）' : ''}</strong><small>READY {facet.count} · 未上传 {facet.unuploadedCount} · 已发布 {facet.publishedCount}{facet.revokedCount ? ` · 已撤销 ${facet.revokedCount}` : ''}</small></span>
              </label>)}
            </> : <div className={styles.previewPackageEmpty}>没有匹配的可上传范围。</div>}
          </div>
        </section>
      </div>}

      {activeView === 'HISTORY' && <div className={styles.workspacePane} id="delivery-history-panel" role="tabpanel" aria-labelledby="delivery-history-tab">
        <section className={styles.history} aria-labelledby="delivery-history-title">
          <div className={styles.sectionHeader}><div><span className={styles.eyebrow}>IMMUTABLE ARCHIVE</span><h3 id="delivery-history-title">交付历史</h3><p>每个批次冻结成员和版本，可查看明细或重新下载原文件。</p></div><strong>{deliveryBatchTotal} 批</strong></div>
          <div className={styles.historyBody}>
            {historyLoading ? <div className={styles.historyEmpty}><LoaderCircle className="animate-spin" size={16} />正在读取交付历史…</div>
              : deliveryBatches.length === 0 ? <div className={styles.historyEmpty}>{clientBatchCode ? `甲方批次“${clientBatchCode}”还没有交付批次。` : '还没有交付批次；首次创建后会在这里永久保留成员和版本记录。'}</div>
                : <div className="table-wrap mobile-cards" role="region" aria-label="交付批次历史，可横向滚动" tabIndex={0}>
                  <table><thead><tr><th>批次</th><th>来源范围</th><th>数量</th><th>创建信息</th><th>交付状态</th><th>操作</th></tr></thead>
                    <tbody>{deliveryBatches.map((batch) => <tr key={batch.publicId}>
                      <td data-label="批次"><strong>{batch.code}</strong><small className={styles.blockMeta}>{byteLabel(batch.byteSize)}</small></td>
                      <td data-label="来源范围">{batch.queryPackageNames.length ? batch.queryPackageNames.slice(0, 3).join('、') : '历史未归属内容'}{batch.queryPackageNames.length > 3 ? `等 ${batch.queryPackageNames.length} 个词包` : ''}<small className={styles.blockMeta}>甲方批次 {batch.clientBatchCode ?? '未记录'}</small></td>
                      <td data-label="数量">{batch.taskCount} 条</td>
                      <td data-label="创建信息">{timeLabel(batch.createdAt)}<small className={styles.blockMeta}>{batch.batchKind === 'OPERATOR_DELIVERY' ? '作业员交付' : '管理员交付'} · {batch.createdByUsername}</small></td>
                      <td data-label="交付状态">{batch.status === 'DELIVERED' ? '已确认完成交付' : batch.downloadCount ? '已下载，待确认交付' : '已生成，尚未下载'}<small className={styles.blockMeta}>{batch.status === 'DELIVERED' ? `${timeLabel(batch.deliveredAt)} · ${batch.deliveredByUsername ?? '未知确认人'}` : batch.downloadCount ? `已下载 ${batch.downloadCount} 次 · ${timeLabel(batch.lastDownloadedAt)}` : '—'}</small></td>
                      <td className="row-action" data-label="操作"><div className={styles.actions}>
                        <Button unstyled className="button small" type="button" disabled={batchDetailLoading} onClick={() => { void openBatchDetail(batch); }}>查看明细</Button>
                        <a className="button small primary" href={`/api/control-plane/v1/delivery-batches/${encodeURIComponent(batch.publicId)}/archive`} download={batch.fileName} onClick={() => window.setTimeout(() => { void loadHistory(); }, 1200)}><Download size={14} />重新下载</a>
                      </div></td>
                    </tr>)}</tbody>
                  </table>
                </div>}
            {batchDetail && <section className={styles.batchDetail} aria-labelledby="delivery-batch-detail-title">
              <div className={styles.batchDetailHeader}><div><h3 id="delivery-batch-detail-title">{batchDetail.code} 明细</h3><p>{batchDetail.taskCount} 条 · 创建于 {timeLabel(batchDetail.createdAt)} · 文件校验值 {batchDetail.sha256.slice(0, 12)}…</p></div><Button unstyled className="button small" type="button" onClick={() => setBatchDetail(null)}>关闭明细</Button></div>
              <div className={styles.batchItemList}>{batchDetail.items.map((item) => <article key={item.id}><strong>{item.ordinal}. 任务 #{item.taskId}</strong><span>{item.query || '未记录 Query'}</span><small>甲方批次 {item.clientBatchCode ?? '未记录'} · {item.queryPackageName || '未归属词包'} · 文案 #{item.copyRevisionId} · 图片 {item.imageRunId.slice(0, 8)}…</small></article>)}</div>
            </section>}
          </div>
        </section>
      </div>}
      <DeliveryPreviewDialog entry={previewEntry} onClose={() => setPreviewEntry(null)} />
    </section>
  </div>;
}
