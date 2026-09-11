'use client';

import { Button } from '@/components/ui/button';
import { FeedbackMessage } from '@/components/ui/feedback-message';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Download, ExternalLink, FileSpreadsheet, LoaderCircle, RefreshCw, Search, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
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
  normalizePreparedDeliveryExport,
  normalizePreparedDeliveryXlsxExport,
  normalizeDeliveryPreviewPublishResult,
  parseDeliveryPoolSearchTerms,
  updateTaskSelection,
  type DeliveryEntry,
  type DeliveryQueryPackageFacet,
  type DeliveryUnassignedFacet,
} from './types';

type ExportScope = 'ALL_READY' | 'QUERY_PACKAGE' | 'SELECTED';
const ALL_QUERY_PACKAGES = '__ALL_QUERY_PACKAGES__';
const UNASSIGNED_PREVIEW_LABEL = '历史未归属内容';

export function DeliveryPoolWorkbench({ role }: { role: 'ADMIN' }) {
  const confirm = useConfirmDialog();
  const [entries, setEntries] = useState<DeliveryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [queryPackageName, setQueryPackageName] = useState('');
  const [queryPackages, setQueryPackages] = useState<DeliveryQueryPackageFacet[]>([]);
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
      if (queryPackageName) query.set('queryPackageName', queryPackageName);
      const page = normalizeDeliveryPoolPage(await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-pool?${query}`,
      ));
      if (currentRequestId !== listRequestId.current) return;
      const followingOffset = offset + page.items.length;
      setEntries((current) => append ? mergeDeliveryPoolEntries(current, page.items) : page.items);
      setTotal(page.total);
      setQueryPackages(page.facets.queryPackages);
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
  }, [queryPackageName]);
  useEffect(() => {
    setEntries([]);
    setTotal(0);
    setNextOffset(0);
    setHasMore(false);
    setSelected([]);
    setLoading(true);
    void load();
  }, [load]);
  useEffect(() => () => { listRequestId.current += 1; }, []);

  const searchTermCount = useMemo(() => parseDeliveryPoolSearchTerms(search).length, [search]);
  const visible = useMemo(() => filterDeliveryPoolEntries(entries, search), [entries, search]);
  const selectionCandidates = visible.slice(0, DELIVERY_POOL_SELECTION_LIMIT);
  const allChecked = selectionCandidates.length > 0
    && selectionCandidates.every((entry) => selected.includes(entry.taskId));
  const previewSearchTerm = previewPackageSearch.trim().toLocaleLowerCase('zh-CN');
  const visiblePreviewPackages = useMemo(() => previewSearchTerm
    ? queryPackages.filter((facet) => facet.name.toLocaleLowerCase('zh-CN').includes(previewSearchTerm))
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
  const xlsxExportCount = selected.length || total;
  const filteredExportScope: Exclude<ExportScope, 'SELECTED'> = queryPackageName
    ? 'QUERY_PACKAGE'
    : 'ALL_READY';

  function changeSelection(candidateIds: number[], checked: boolean) {
    const requestedCount = new Set([...selected, ...candidateIds]).size;
    const next = updateTaskSelection(selected, candidateIds, checked);
    setSelected(next);
    if (checked && requestedCount > DELIVERY_POOL_SELECTION_LIMIT) {
      setMessageTone('warning');
      setMessage(`单次批量下载最多选择 ${DELIVERY_POOL_SELECTION_LIMIT} 条；其余条目可分批下载，或使用“一键导出全部”。`);
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

  async function exportDelivery(scope: ExportScope) {
    if (exportBusy || (scope === 'SELECTED' ? !selected.length : total === 0)
      || (scope === 'QUERY_PACKAGE' && !queryPackageName)) return;
    const count = scope === 'SELECTED' ? selected.length : total;
    setExporting(scope);
    setError('');
    setMessageTone('info');
    setMessage(scope === 'SELECTED'
      ? `正在打包已选 ${count} 条可交付项。`
      : scope === 'QUERY_PACKAGE'
        ? `正在打包词包“${queryPackageName}”的全部 ${count} 条可交付项；文本搜索不会缩小导出范围。`
        : `正在打包全部 ${count} 条可交付项；文本搜索不会缩小导出范围。`);
    try {
      const response = await fetch('/api/control-plane/v1/delivery-pool/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope === 'SELECTED'
          ? { scope, taskIds: selected }
          : scope === 'QUERY_PACKAGE'
            ? { scope, queryPackageName }
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
      setMessage(scope === 'SELECTED'
        ? `已选 ${prepared.taskCount} 条可交付项已准备，下载已开始。`
        : scope === 'QUERY_PACKAGE'
          ? `词包“${queryPackageName}”的 ${prepared.taskCount} 条可交付项已准备，下载已开始。`
          : `全部 ${prepared.taskCount} 条可交付项已准备，下载已开始。`);
      setMessageTone('success');
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '交付池导出失败');
    } finally {
      setExporting(null);
    }
  }

  async function exportXlsx() {
    if (exportBusy || xlsxExportCount === 0) return;
    if (!selected.length && total > DELIVERY_POOL_SELECTION_LIMIT) {
      setMessage('');
      setError(`Excel 一次最多导出 ${DELIVERY_POOL_SELECTION_LIMIT} 篇文章，请先勾选后分批导出。`);
      return;
    }
    const selectedTaskIds = [...selected];
    let input: ReturnType<typeof buildDeliveryPoolExportInput>;
    try {
      input = buildDeliveryPoolExportInput(selectedTaskIds, queryPackageName);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : 'Excel 导出范围无效，请刷新后重试');
      return;
    }
    const count = input.scope === 'SELECTED' ? input.taskIds.length : total;
    setXlsxExporting(true);
    setError('');
    setMessageTone('info');
    setMessage(input.scope === 'SELECTED'
      ? `正在生成已选 ${count} 条可交付项的 Excel；图片原文件不重新编码、不二次压缩。`
      : input.scope === 'QUERY_PACKAGE'
        ? `正在生成词包“${input.queryPackageName}”全部 ${count} 条 READY 交付项的 Excel；图片原文件不重新编码、不二次压缩，文本搜索不会缩小导出范围。`
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
        : input.scope === 'QUERY_PACKAGE'
          ? `词包“${input.queryPackageName}”的 ${prepared.taskCount} 条 READY 交付项 Excel 已准备，下载已开始。`
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
    limit,
    testTaskId = null,
    pendingMessage,
  }: {
    queryPackageIds: number[];
    includeUnassigned: boolean;
    limit: number;
    testTaskId?: number | null;
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
            ...(testTaskId === null ? {} : { testTaskId }),
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
    const selectedNames = selectedPreviewPackages.map((facet) => `“${facet.name}”`);
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
      title: `测试上传任务 #${entry.taskId}？`,
      description: `将从${sourceLabel}精确上传任务 #${entry.taskId}（${queryLabel}）。本次只处理这一条，不会上传同范围内的其他内容。`,
      confirmLabel: '测试上传这一条',
    })) return;
    await submitPreviewUpload({
      queryPackageIds: entry.queryPackageId === null ? [] : [entry.queryPackageId],
      includeUnassigned: entry.queryPackageId === null,
      testTaskId: entry.taskId,
      limit: 1,
      pendingMessage: `正在测试上传任务 #${entry.taskId}，本次只处理这一条。`,
    });
  }

  const packageSelectValue = queryPackageName
    ? `package:${queryPackageName}`
    : ALL_QUERY_PACKAGES;
  const unselectedExportLabel = queryPackageName
    ? `词包“${queryPackageName}”全部 ${total} 条`
    : `全部 ${total} 条`;

  return <div className={styles.stack}>
    <section className="panel" aria-labelledby="delivery-pool-title">
      <div className={styles.toolbar}>
        <div>
          <div>
            <h2 id="delivery-pool-title">READY 交付条目</h2>
            <p className="subtle">每条交付记录同时绑定所属词包、当前文案修订版和图片运行版本；版本失效会自动退出交付池。</p>
          </div>
        </div>
        <div>
          <Button unstyled className="button small" type="button" disabled={refreshing || loadingMore || exportBusy} onClick={() => {
            const hadSelection = selected.length > 0 || selectedPreviewScopeCount > 0;
            setSelected([]);
            setSelectedPreviewPackageIds([]);
            setSelectedPreviewUnassigned(false);
            if (hadSelection) setMessage('交付池已刷新，原选择已清空，请重新确认。');
            if (hadSelection) setMessageTone('info');
            void load();
          }}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />刷新
          </Button>
          {role === 'ADMIN' && <>
            <div className={styles.previewUploadControl}>
              <label htmlFor="delivery-preview-upload-limit">本次预览上限</label>
              <Select value={String(previewUploadLimit)} onValueChange={(value) => setPreviewUploadLimit(Number(value))}>
                <SelectTrigger id="delivery-preview-upload-limit" aria-label="本次预览上传条数上限">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIVERY_PREVIEW_UPLOAD_LIMITS.map((limit) => <SelectItem key={limit} value={String(limit)}>
                    {limit === 1 ? '1 条（测试）' : `${limit} 条`}
                  </SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button
              unstyled
              className="button small primary"
              type="button"
              aria-busy={previewPublishing}
              disabled={selectedPreviewScopeCount === 0
                || selectedPreviewUnuploadedCount === 0 || exportBusy}
              onClick={() => { void publishPreviews(); }}
            >
              {previewPublishing
                ? <><LoaderCircle className="animate-spin" size={14} />正在上传预览…</>
                : <><UploadCloud size={14} />{selectedPreviewScopeCount === 0
                  ? '请先勾选上传范围'
                  : selectedPreviewUnuploadedCount === 0
                    ? '所选范围无需上传'
                    : `上传预览（${selectedPreviewScopeCount} 个范围 / 最多 ${previewUploadLimit} 条）`}</>}
            </Button>
            <Button
              unstyled
              className="button small"
              type="button"
              aria-busy={xlsxExporting}
              aria-label={selected.length
                ? `导出已选 ${selected.length} 篇文章与图片为 Excel`
                : `导出${unselectedExportLabel} READY 文章与图片为 Excel`}
              title={!selected.length && total > DELIVERY_POOL_SELECTION_LIMIT
                ? `超过 ${DELIVERY_POOL_SELECTION_LIMIT} 篇时请先勾选后分批导出`
                : undefined}
              disabled={xlsxExportCount === 0 || exportBusy}
              onClick={() => { void exportXlsx(); }}
            >
              <FileSpreadsheet aria-hidden="true" size={14} />
              {xlsxExporting
                ? '正在生成 Excel…'
                : selected.length
                  ? `导出 Excel（已选 ${selected.length}）`
                  : queryPackageName
                    ? `导出 Excel（词包 ${total}）`
                    : `导出 Excel（全部 ${total}）`}
            </Button>
            <Button
              unstyled
              className="button small"
              type="button"
              disabled={total === 0 || exportBusy}
              onClick={() => { void exportDelivery(filteredExportScope); }}
            >
              <Download size={14} />
              {exporting === filteredExportScope
                ? queryPackageName ? '词包打包中…' : '全部打包中…'
                : queryPackageName ? `一键导出词包 ${total}` : `一键导出全部 ${total}`}
            </Button>
            <Button unstyled className="button small primary" type="button" disabled={!selected.length || exportBusy} onClick={() => { void exportDelivery('SELECTED'); }}>
              <Download size={14} />
              {exporting === 'SELECTED' ? '已选打包中…' : `批量下载（已选 ${selected.length}）`}
            </Button>
          </>}
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.searchField}>
          <label htmlFor="delivery-pool-search">搜索 Query、词包名称或正式任务号</label>
          <div className={styles.searchControl}>
            <Search className={styles.searchIcon} size={16} aria-hidden="true" />
            <Textarea
              ref={searchInputRef}
              id="delivery-pool-search"
              className={styles.search}
              value={search}
              rows={3}
              maxLength={20_000}
              aria-describedby="delivery-pool-search-help"
              placeholder={'每行一条，例如：\n租房桌面收纳\n九月收纳词包\n1024'}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && <Button unstyled className={styles.clearSearch} type="button" aria-label="清除全部搜索条件" onClick={() => {
              setSearch('');
              searchInputRef.current?.focus();
            }}>
              <X size={15} aria-hidden="true" />
            </Button>}
          </div>
          <span id="delivery-pool-search-help">每行一条，在已加载条目的 Query、词包名称或任务号中匹配任意一条；自动忽略空行和重复项。</span>
        </div>
        <div className={styles.packageFilter}>
          <label htmlFor="delivery-pool-query-package">按词包分类</label>
          <Select value={packageSelectValue} onValueChange={(value) => {
            setQueryPackageName(value === ALL_QUERY_PACKAGES ? '' : value.slice('package:'.length));
          }}>
            <SelectTrigger id="delivery-pool-query-package" aria-describedby="delivery-pool-package-help">
              <SelectValue placeholder="全部词包" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_QUERY_PACKAGES}>全部词包</SelectItem>
              {queryPackages.map((facet) => <SelectItem key={facet.name} value={`package:${facet.name}`}>
                {facet.name}（{facet.count}）
              </SelectItem>)}
            </SelectContent>
          </Select>
          <small id="delivery-pool-package-help">选择后，列表和无勾选导出均只包含该词包。</small>
        </div>
        <span className={`pill ${styles.searchStatus}`} role="status" aria-live="polite">
          只读 READY · {queryPackageName ? `词包“${queryPackageName}” · ` : ''}{searchTermCount ? `${searchTermCount} 条搜索条件 · ` : ''}当前筛选 {visible.length} · 已加载 {entries.length} / 共 {total} 条
        </span>
      </div>
      <div className={styles.scopeNote}>
        词包筛选由服务端覆盖该词包全部 READY 条目，并会限制无勾选时的 Excel 和一键 ZIP 导出；文本搜索只覆盖已加载条目，不会进一步缩小导出范围。
      </div>
      {role === 'ADMIN' && <section className={styles.previewScope} aria-labelledby="delivery-preview-package-title">
        <div className={styles.previewScopeHeader}>
          <div>
            <h3 id="delivery-preview-package-title">选择要上传预览的范围</h3>
            <p>按词包明确勾选；早期未绑定词包的内容会作为独立范围显示。列表筛选、文本搜索和任务行选择均不会改变上传范围。</p>
          </div>
          <strong>{selectedPreviewScopeCount
            ? `已选 ${selectedPreviewScopeCount} 个范围 · ${selectedPreviewUnuploadedCount} 条未上传`
            : '尚未选择上传范围'}</strong>
        </div>
        <div className={styles.previewPackageTools}>
          <Input
            id="delivery-preview-package-search"
            value={previewPackageSearch}
            placeholder="搜索词包或历史未归属内容"
            aria-label="搜索预览上传范围"
            onChange={(event) => setPreviewPackageSearch(event.target.value)}
          />
          <Button
            unstyled
            className="button small"
            type="button"
            disabled={visiblePreviewScopeCount === 0 || exportBusy}
            onClick={() => changePreviewScopeSelection(
              visiblePreviewPackages.map((facet) => facet.id),
              visiblePreviewUnassigned,
              !allVisiblePreviewScopesChecked,
            )}
          >
            {allVisiblePreviewScopesChecked ? '取消当前结果' : '勾选当前结果'}
          </Button>
          <Button unstyled className="button small" type="button" disabled={selectedPreviewScopeCount === 0 || exportBusy} onClick={() => {
            setSelectedPreviewPackageIds([]);
            setSelectedPreviewUnassigned(false);
          }}>清空选择</Button>
        </div>
        <div className={styles.previewPackageList} role="group" aria-label="预览上传范围">
          {visiblePreviewScopeCount
            ? <>
              {visiblePreviewUnassigned && previewUnassigned && <label className={`${styles.previewPackageOption} ${styles.previewUnassignedOption}`}>
                <Checkbox
                  checked={selectedPreviewUnassigned}
                  disabled={exportBusy || (!selectedPreviewUnassigned
                    && selectedPreviewScopeCount >= DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT)}
                  onChange={(event) => changePreviewScopeSelection([], true, event.target.checked)}
                />
                <span><strong>{UNASSIGNED_PREVIEW_LABEL}</strong><small>早期未绑定词包的交付项 · READY {previewUnassigned.count} · 未上传 {previewUnassigned.unuploadedCount} · 已发布 {previewUnassigned.publishedCount}{previewUnassigned.revokedCount ? ` · 已撤销 ${previewUnassigned.revokedCount}` : ''}</small></span>
              </label>}
              {visiblePreviewPackages.map((facet) => <label key={facet.id} className={styles.previewPackageOption}>
                <Checkbox
                  checked={selectedPreviewPackageIds.includes(facet.id)}
                  disabled={exportBusy || (!selectedPreviewPackageIds.includes(facet.id)
                    && selectedPreviewScopeCount >= DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT)}
                  onChange={(event) => changePreviewScopeSelection([facet.id], false, event.target.checked)}
                />
                <span><strong>{facet.name}</strong><small>READY {facet.count} · 未上传 {facet.unuploadedCount} · 已发布 {facet.publishedCount}{facet.revokedCount ? ` · 已撤销 ${facet.revokedCount}` : ''}</small></span>
              </label>)}
            </>
            : <div className={styles.previewPackageEmpty}>没有匹配的可上传范围。</div>}
        </div>
      </section>}
      {role === 'ADMIN' && <div className={styles.selectionStatus}>
        <span>{selected.length
          ? `已选择 ${selected.length} / ${DELIVERY_POOL_SELECTION_LIMIT} 条；Excel 与批量下载均优先处理已选条目。`
          : queryPackageName
            ? `尚未选择条目；Excel 与一键 ZIP 将按词包“${queryPackageName}”导出。单次勾选最多 ${DELIVERY_POOL_SELECTION_LIMIT} 条。`
            : `尚未选择条目；Excel 与一键 ZIP 将导出后台全部 READY。单次勾选最多 ${DELIVERY_POOL_SELECTION_LIMIT} 条。`}</span>
        <span>Excel 按原文件字节内嵌图片，只调整表格中的显示尺寸，不重新编码或二次压缩（支持 PNG、JPEG、GIF），文件可能较大。</span>
      </div>}
      <div className={styles.summary}>
        <strong>交付门禁</strong>
        <span>图文终审通过 + 当前文案版本匹配 + 当前图片版本匹配 + READY 交付记录，四项缺一不可。</span>
      </div>
      {error && <FeedbackMessage tone="error" onDismiss={() => setError('')}>{error}</FeedbackMessage>}
      {message && <FeedbackMessage tone={messageTone} onDismiss={() => setMessage('')}>{message}</FeedbackMessage>}
      {loading
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取交付池…</div>
        : visible.length === 0
          ? <div className="empty-state">{entries.length
            ? '没有符合搜索条件的交付条目。'
            : queryPackageName
              ? `词包“${queryPackageName}”当前没有 READY 交付条目。`
              : '交付池当前为空；图文终审通过后会在这里生成就绪条目。'}</div>
          : <div className="table-wrap mobile-cards">
            <table>
              <thead>
                <tr>
                  {role === 'ADMIN' && <th><Checkbox aria-label={`选择当前已加载的筛选结果（最多 ${DELIVERY_POOL_SELECTION_LIMIT} 条）`} checked={allChecked} disabled={exportBusy} onChange={(event) => changeSelection(selectionCandidates.map((entry) => entry.taskId), event.target.checked)} /></th>}
                  <th>正式任务</th><th>Query</th><th>词包</th><th>版本绑定</th><th>预览</th><th>终审时间</th><th>操作</th>
                </tr>
              </thead>
              <tbody>{visible.map((entry) => <tr key={entry.id}>
                {role === 'ADMIN' && <td data-label="选择"><Checkbox aria-label={`选择任务 ${entry.taskId}`} checked={selected.includes(entry.taskId)} disabled={exportBusy || (!selected.includes(entry.taskId) && selected.length >= DELIVERY_POOL_SELECTION_LIMIT)} onChange={(event) => changeSelection([entry.taskId], event.target.checked)} /></td>}
                <td data-label="正式任务">#{entry.taskId}</td>
                <td className={styles.query} data-label="Query">{entry.query || '未记录'}</td>
                <td className={styles.packageName} data-label="词包">{entry.queryPackageName || '未归属词包'}</td>
                <td data-label="版本绑定"><div className={styles.version}><span>文案 #{entry.copyRevisionId}</span><span>图片 {entry.imageRunId.slice(0, 8)}…</span></div></td>
                <td data-label="预览">{entry.preview?.status === 'PUBLISHED' && entry.preview.url
                  ? <a className="button small" href={entry.preview.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开预览</a>
                  : entry.preview?.status === 'PUBLISHED'
                    ? <span className="subtle">已上传，预览域名未配置</span>
                  : entry.preview?.status === 'REVOKED'
                    ? <span className="pill">已撤销</span>
                    : <span className="subtle">未上传</span>}</td>
                <td data-label="终审时间">{entry.approvedAt ? new Date(entry.approvedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}</td>
                <td className="row-action" data-label="操作"><div className={styles.actions}>
                  {entry.preview === null && <Button
                    unstyled
                    className="button small"
                    type="button"
                    disabled={exportBusy}
                    onClick={() => { void publishSinglePreview(entry); }}
                  ><UploadCloud size={14} />测试上传</Button>}
                  <a className="button small primary" href={`/api/control-plane/v1/tasks/${entry.taskId}/archive`} download><Download size={14} />下载资源</a>
                </div></td>
              </tr>)}</tbody>
            </table>
          </div>}
      {hasMore && <div className={styles.loadMore}>
        <Button unstyled className="button small" type="button" disabled={loadingMore || refreshing || exportBusy} onClick={() => { void load(nextOffset); }}>
          {loadingMore
            ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</>
            : queryPackageName
              ? `加载更多（该词包剩余约 ${Math.max(0, total - nextOffset)} 条）`
              : `加载更多（服务端剩余约 ${Math.max(0, total - nextOffset)} 条）`}
        </Button>
      </div>}
    </section>
  </div>;
}
