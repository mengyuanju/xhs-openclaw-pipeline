'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../components/api-client';
import styles from './delivery-pool.module.css';
import {
  DELIVERY_POOL_LIST_LIMIT,
  DELIVERY_POOL_SELECTION_LIMIT,
  mergeDeliveryPoolEntries,
  normalizeDeliveryPoolPage,
  normalizePreparedDeliveryExport,
  updateTaskSelection,
  type DeliveryEntry,
} from './types';

type ExportScope = 'ALL_READY' | 'SELECTED';

export function DeliveryPoolWorkbench({ role }: { role: 'ADMIN' | 'USER' }) {
  const [entries, setEntries] = useState<DeliveryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (offset = 0) => {
    const append = offset > 0;
    if (append) setLoadingMore(true);
    else setRefreshing(true);
    try {
      const page = normalizeDeliveryPoolPage(await apiRequest<unknown>(
        `/api/control-plane/v1/delivery-pool?limit=${DELIVERY_POOL_LIST_LIMIT}&offset=${offset}&includeTotal=true`,
      ));
      const followingOffset = offset + page.items.length;
      setEntries((current) => append ? mergeDeliveryPoolEntries(current, page.items) : page.items);
      setTotal(page.total);
      setNextOffset(followingOffset);
      setHasMore(page.items.length > 0 && followingOffset < page.total);
      if (!append) {
        const availableTaskIds = new Set(page.items.map((entry) => entry.taskId));
        setSelected((current) => current.filter((taskId) => availableTaskIds.has(taskId)));
      }
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '交付池读取失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return entries.filter((entry) => !keyword || `${entry.taskId} ${entry.query}`.toLocaleLowerCase('zh-CN').includes(keyword));
  }, [entries, search]);
  const selectionCandidates = visible.slice(0, DELIVERY_POOL_SELECTION_LIMIT);
  const allChecked = selectionCandidates.length > 0
    && selectionCandidates.every((entry) => selected.includes(entry.taskId));

  function changeSelection(candidateIds: number[], checked: boolean) {
    const requestedCount = new Set([...selected, ...candidateIds]).size;
    const next = updateTaskSelection(selected, candidateIds, checked);
    setSelected(next);
    if (checked && requestedCount > DELIVERY_POOL_SELECTION_LIMIT) {
      setMessage(`单次批量下载最多选择 ${DELIVERY_POOL_SELECTION_LIMIT} 条；其余条目可分批下载，或使用“一键导出全部”。`);
    }
  }

  async function exportDelivery(scope: ExportScope) {
    if (exporting || (scope === 'SELECTED' && !selected.length) || (scope === 'ALL_READY' && total === 0)) return;
    const count = scope === 'ALL_READY' ? total : selected.length;
    setExporting(scope);
    setError('');
    setMessage(scope === 'ALL_READY'
      ? `正在打包全部 ${count} 条可交付项；当前搜索不会缩小导出范围。`
      : `正在打包已选 ${count} 条可交付项。`);
    try {
      const response = await fetch('/api/control-plane/v1/delivery-pool/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope === 'ALL_READY' ? { scope } : { scope, taskIds: selected }),
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
      setMessage(scope === 'ALL_READY'
        ? `全部 ${prepared.taskCount} 条可交付项已准备，下载已开始。`
        : `已选 ${prepared.taskCount} 条可交付项已准备，下载已开始。`);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '交付池导出失败');
    } finally {
      setExporting(null);
    }
  }

  return <div className={styles.stack}>
    <section className="panel" aria-labelledby="delivery-pool-title">
      <div className={styles.toolbar}><div><div><h2 id="delivery-pool-title">READY 交付条目</h2><p className="subtle">每条交付记录同时绑定当前文案修订版和图片运行版本；版本失效会自动退出交付池。</p></div></div><div><Button unstyled className="button small" type="button" disabled={refreshing || loadingMore || exporting !== null} onClick={() => { const hadSelection = selected.length > 0; setSelected([]); if (hadSelection) setMessage('交付池已刷新，原选择已清空，请重新确认。'); void load(); }}><RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />刷新</Button>{role === 'ADMIN' && <><Button unstyled className="button small" type="button" disabled={total === 0 || exporting !== null} onClick={() => { void exportDelivery('ALL_READY'); }}><Download size={14} />{exporting === 'ALL_READY' ? '全部打包中…' : `一键导出全部 ${total}`}</Button><Button unstyled className="button small primary" type="button" disabled={!selected.length || exporting !== null} onClick={() => { void exportDelivery('SELECTED'); }}><Download size={14} />{exporting === 'SELECTED' ? '已选打包中…' : `批量下载（已选 ${selected.length}）`}</Button></>}</div></div>
      <div className={styles.toolbar}><SearchInput className={styles.search} value={search} onValueChange={setSearch} placeholder="搜索 Query 或正式任务号" /><span className="pill">只读 READY · 当前筛选 {visible.length} · 已加载 {entries.length} / 共 {total} 条</span></div>
      <div className={styles.scopeNote}>当前搜索只覆盖已加载的交付条目；如果未找到目标，请先继续加载或刷新列表。“一键导出全部”仍覆盖后台全部 READY 条目。</div>
      {role === 'ADMIN' && <div className={styles.selectionStatus}><span>{selected.length ? `已选择 ${selected.length} / ${DELIVERY_POOL_SELECTION_LIMIT} 条，可批量下载。` : `尚未选择条目；单次最多选择 ${DELIVERY_POOL_SELECTION_LIMIT} 条。`}</span><span>批量下载只处理当前勾选；“一键导出全部”始终按后台全部 READY 条目打包，不受搜索或当前显示范围影响。</span></div>}
      <div className={styles.summary}><strong>交付门禁</strong><span>图文终审通过 + 当前文案版本匹配 + 当前图片版本匹配 + READY 交付记录，四项缺一不可。</span></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status" aria-live="polite">{message}</div>}
      {loading ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取交付池…</div>
        : visible.length === 0 ? <div className="empty-state">{entries.length ? '没有符合搜索条件的交付条目。' : '交付池当前为空；图文终审通过后会在这里生成就绪条目。'}</div>
          : <div className="table-wrap mobile-cards"><table><thead><tr>{role === 'ADMIN' && <th><Checkbox aria-label={`选择当前已加载的筛选结果（最多 ${DELIVERY_POOL_SELECTION_LIMIT} 条）`} checked={allChecked} onChange={(event) => changeSelection(selectionCandidates.map((entry) => entry.taskId), event.target.checked)} /></th>}<th>正式任务</th><th>Query</th><th>版本绑定</th><th>终审时间</th><th>操作</th></tr></thead><tbody>{visible.map((entry) => <tr key={entry.id}>{role === 'ADMIN' && <td data-label="选择"><Checkbox aria-label={`选择任务 ${entry.taskId}`} checked={selected.includes(entry.taskId)} disabled={!selected.includes(entry.taskId) && selected.length >= DELIVERY_POOL_SELECTION_LIMIT} onChange={(event) => changeSelection([entry.taskId], event.target.checked)} /></td>}<td data-label="正式任务">#{entry.taskId}</td><td className={styles.query} data-label="Query">{entry.query || '未记录'}</td><td data-label="版本绑定"><div className={styles.version}><span>文案 #{entry.copyRevisionId}</span><span>图片 {entry.imageRunId.slice(0, 8)}…</span></div></td><td data-label="终审时间">{entry.approvedAt ? new Date(entry.approvedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}</td><td className="row-action" data-label="操作"><div className={styles.actions}><a className="button small primary" href={`/api/control-plane/v1/tasks/${entry.taskId}/archive`} download><Download size={14} />下载资源</a></div></td></tr>)}</tbody></table></div>}
      {hasMore && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMore || refreshing || exporting !== null} onClick={() => { void load(nextOffset); }}>{loadingMore ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : `加载更多（服务端剩余约 ${Math.max(0, total - nextOffset)} 条）`}</Button></div>}
    </section>
  </div>;
}
