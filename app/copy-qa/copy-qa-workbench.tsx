'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { apiRequest } from '../components/api-client';
import { canCommitLatestRequest } from '../components/latest-request';
import { buildCopyQaBatchReturnPayload } from '../../src/copy-qa-batch-return.mjs';
import styles from './copy-qa.module.css';
import {
  canReleaseCopyQaFreezeRest,
  canStartCopyQaBatchReturn,
  copyRevisionView,
  normalizeCopyQaItem,
  normalizeCopyQaPage,
  normalizeCopyQaStatistics,
  type CopyQaItem,
  type CopyQaStatistics,
  type CopyQaStatus,
} from './types';

const apiPath = (path: string) => `/api/control-plane${path}`;
const COPY_QA_LIST_LIMIT = 200;
const RETURN_REASONS = [
  { code: 'FACT_ERROR', label: '事实或数据错误' },
  { code: 'QUERY_MISMATCH', label: '偏离 Query' },
  { code: 'STRUCTURE_ERROR', label: '结构不完整' },
  { code: 'EXPRESSION_ERROR', label: '表达或合规问题' },
];
const STATUS_LABELS: Record<CopyQaStatus, string> = {
  PENDING: '待抽检',
  PASSED: '抽检通过',
  RETURNED: '单条已打回',
  RELEASED: '已放行',
  BATCH_RETURNED: '整批已打回',
  BATCH_AFFECTED: '整批受影响',
};
const MANDATORY_RECHECK_STATUS_LABELS: Record<CopyQaStatus, string> = {
  PENDING: '待处理',
  PASSED: '已通过',
  RETURNED: '已打回',
  RELEASED: '已放行',
  BATCH_RETURNED: '整批已打回',
  BATCH_AFFECTED: '整批受影响',
};

function timeLabel(value?: string) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录';
}

function requestId() {
  return crypto.randomUUID();
}

export function CopyQaWorkbench({ role }: { role: 'ADMIN' | 'REVIEWER' }) {
  const confirm = useConfirmDialog();
  const [items, setItems] = useState<CopyQaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [packageSearchInput, setPackageSearchInput] = useState('');
  const [queryPackageName, setQueryPackageName] = useState('');
  const [status, setStatus] = useState<CopyQaStatus | 'ALL'>('PENDING');
  const [mode, setMode] = useState<'ALL' | 'BLIND' | 'VISIBLE'>('ALL');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<CopyQaItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [action, setAction] = useState('');
  const [returnItem, setReturnItem] = useState<CopyQaItem | null>(null);
  const [returnReasons, setReturnReasons] = useState<string[]>([]);
  const [returnNote, setReturnNote] = useState('');
  const [returnError, setReturnError] = useState('');
  const [returnCompleted, setReturnCompleted] = useState(false);
  const [releaseItem, setReleaseItem] = useState<CopyQaItem | null>(null);
  const [releaseNote, setReleaseNote] = useState('');
  const [releaseConfirmation, setReleaseConfirmation] = useState('');
  const [releaseError, setReleaseError] = useState('');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchReasons, setBatchReasons] = useState<string[]>([]);
  const [batchNote, setBatchNote] = useState('');
  const [batchConfirmation, setBatchConfirmation] = useState('');
  const [batchError, setBatchError] = useState('');
  const [batchPreview, setBatchPreview] = useState<Record<string, unknown> | null>(null);
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false);
  const [batchTriggerItem, setBatchTriggerItem] = useState<CopyQaItem | null>(null);
  const [statistics, setStatistics] = useState<CopyQaStatistics | null>(null);
  const [statisticsError, setStatisticsError] = useState('');
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const detailRequestController = useRef<AbortController | null>(null);
  const batchPreviewRequestId = useRef(0);
  const batchPreviewRequestController = useRef<AbortController | null>(null);

  const load = useCallback(async ({ silent = false, offset = 0 } = {}) => {
    const append = offset > 0;
    const currentRequestId = ++listRequestId.current;
    if (append) setLoadingMore(true);
    else {
      if (!silent) setRefreshing(true);
      if (!silent) setLoading(true);
    }
    try {
      const params = new URLSearchParams({
        status,
        limit: String(COPY_QA_LIST_LIMIT),
        offset: String(offset),
      });
      if (role === 'ADMIN' && queryPackageName) params.set('queryPackageName', queryPackageName);
      const [payload, statisticsPayload] = await Promise.all([
        apiRequest<unknown>(apiPath(`/v1/copy-qa/items?${params.toString()}`)),
        role === 'ADMIN' && !append
          ? apiRequest<unknown>(apiPath('/v1/copy-qa/statistics')).catch((caught) => caught instanceof Error ? caught : new Error('准确率统计读取失败'))
          : Promise.resolve(null),
      ]);
      if (currentRequestId !== listRequestId.current) return;
      const page = normalizeCopyQaPage(payload);
      const followingOffset = offset + page.returnedCount;
      setItems((current) => {
        if (!append) return page.items;
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setNextOffset(followingOffset);
      setTotal(page.total);
      setHasMore(page.total === null
        ? page.returnedCount === COPY_QA_LIST_LIMIT
        : followingOffset < page.total);
      if (!append) {
        if (statisticsPayload instanceof Error) {
          setStatistics(null);
          setStatisticsError(statisticsPayload.message);
        } else if (role === 'ADMIN') {
          const normalizedStatistics = normalizeCopyQaStatistics(statisticsPayload);
          setStatistics(normalizedStatistics);
          setStatisticsError(normalizedStatistics ? '' : '中心返回的准确率统计不完整');
        }
      }
      setError('');
    } catch (caught) {
      if (currentRequestId !== listRequestId.current) return;
      setError(caught instanceof Error ? caught.message : '文案质检队列读取失败');
    } finally {
      if (currentRequestId === listRequestId.current) {
        setLoading(false);
        setLoadingMore(false);
        if (!silent) setRefreshing(false);
      }
    }
  }, [queryPackageName, role, status]);

  useEffect(() => {
    setCheckedIds([]);
    void load();
  }, [load]);

  useEffect(() => () => {
    detailRequestId.current += 1;
    detailRequestController.current?.abort();
    batchPreviewRequestId.current += 1;
    batchPreviewRequestController.current?.abort();
  }, []);

  const visibleItems = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => (status === 'ALL' || item.status === status)
      && (role !== 'ADMIN' || mode === 'ALL' || (mode === 'BLIND' ? item.blindReview : !item.blindReview))
      && (!keyword || `${item.anonymousCode} ${item.query ?? ''} ${item.productionBatch.anonymousCode} ${item.blindReview ? '' : item.productionBatch.queryPackageName ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [items, mode, role, search, status]);

  const selectedItems = useMemo(() => items.filter((item) => checkedIds.includes(item.id)), [checkedIds, items]);
  const selectedFreezePublicId = selectedItems[0]?.freezePublicId ?? null;
  const batchEligible = (item: CopyQaItem) => item.status === 'PENDING' && canStartCopyQaBatchReturn(item);
  const blindCount = items.filter((item) => item.blindReview).length;
  const currentStatusTotal = total === null
    ? `${items.length.toLocaleString('zh-CN')}${hasMore ? '+' : ''}`
    : total.toLocaleString('zh-CN');

  async function openItem(id: string) {
    const currentRequestId = detailRequestId.current + 1;
    detailRequestId.current = currentRequestId;
    detailRequestController.current?.abort();
    const controller = new AbortController();
    detailRequestController.current = controller;
    setDetailLoading(true);
    setDetailError('');
    setDetail((current) => current?.id === id ? current : null);
    try {
      const payload = await apiRequest<unknown>(apiPath(`/v1/copy-qa/items/${encodeURIComponent(id)}`), { signal: controller.signal });
      if (!canCommitLatestRequest(detailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      const next = normalizeCopyQaItem(payload);
      if (!next) throw new Error('中心返回的抽检详情不完整');
      setDetail(next);
    } catch (caught) {
      if (!canCommitLatestRequest(detailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setDetailError(caught instanceof Error ? caught.message : '抽检详情读取失败');
    } finally {
      if (canCommitLatestRequest(detailRequestId.current, currentRequestId, controller.signal.aborted)) {
        detailRequestController.current = null;
        setDetailLoading(false);
      }
    }
  }

  function closeItemDetail() {
    detailRequestId.current += 1;
    detailRequestController.current?.abort();
    detailRequestController.current = null;
    setDetail(null);
    setDetailLoading(false);
    setDetailError('');
  }

  async function passItem(item: CopyQaItem) {
    if (!item.capabilities.canPass || action) return;
    const mandatoryRecheck = item.sampleKind === 'MANDATORY_RECHECK';
    const approved = await confirm({
      title: mandatoryRecheck ? '确认返工稿通过强制复检？' : '确认当前最终稿通过抽检？',
      description: mandatoryRecheck
        ? `${item.anonymousCode} 的返工稿已按最终 3 分记录；通过强制复检后才会进入待生图队列。`
        : `${item.anonymousCode} 将按当前内容指纹绑定的最终人工通过稿记录抽检结果。`,
      confirmLabel: mandatoryRecheck ? '确认通过强制复检' : '确认通过',
    });
    if (!approved) return;
    setAction('pass');
    setDetailError('');
    try {
      await apiRequest(apiPath(`/v1/copy-qa/items/${encodeURIComponent(item.id)}/pass`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevisionToken: item.approvedRevision.revisionToken, requestId: requestId() }),
      });
      setDetail(null);
      setMessage(mandatoryRecheck
        ? `${item.anonymousCode} 已通过强制复检并进入待生图队列。`
        : `${item.anonymousCode} 已通过抽检。`);
      await load({ silent: true });
    } catch (caught) {
      setDetailError(mandatoryRecheck
        ? `强制复检提交失败：${caught instanceof Error ? caught.message : '请稍后重试'}`
        : caught instanceof Error ? caught.message : '抽检通过失败');
    } finally {
      setAction('');
    }
  }

  function beginSingleReturn(item: CopyQaItem) {
    setDetail((current) => current?.id === item.id ? null : current);
    setReturnItem(item);
    setReturnReasons([]);
    setReturnNote('');
    setReturnError('');
    setReturnCompleted(false);
  }

  async function submitSingleReturn() {
    if (!returnItem || !returnItem.capabilities.canReturnSingle || action) return;
    if (returnReasons.length === 0 && !returnNote.trim()) {
      setReturnError('请选择至少一个错误原因，或填写具体说明。');
      return;
    }
    setAction('return-single');
    setReturnError('');
    try {
      await apiRequest(apiPath(`/v1/copy-qa/items/${encodeURIComponent(returnItem.id)}/return`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevisionToken: returnItem.approvedRevision.revisionToken,
          reasonCodes: returnReasons,
          note: returnNote.trim(),
          requestId: requestId(),
        }),
      });
      const returned = returnItem;
      const code = returned.anonymousCode;
      setDetail(null);
      setMessage(returned.sampleKind === 'MANDATORY_RECHECK'
        ? `${code} 未通过强制复检，已退回继续修改；实际修改标题、正文或标签后，新返工稿会按最终 3 分记录并再次进入强制复检，通过前不会进入待生图队列。`
        : `${code} 已单条打回；同批其他任务保持等待，可随后显式放行其余或发起整批打回。`);
      await load({ silent: true });
      setReturnItem({ ...returned, status: 'RETURNED' });
      setReturnCompleted(true);
    } catch (caught) {
      setReturnError(returnItem.sampleKind === 'MANDATORY_RECHECK'
        ? `强制复检打回失败：${caught instanceof Error ? caught.message : '请稍后重试'}`
        : caught instanceof Error ? caught.message : '单条打回失败');
    } finally {
      setAction('');
    }
  }

  function toggleReason(code: string, setter: Dispatch<SetStateAction<string[]>>) {
    setter((current) => current.includes(code) ? current.filter((item) => item !== code) : [...current, code]);
  }

  function beginReleaseRest(item: CopyQaItem) {
    if (!canReleaseCopyQaFreezeRest(item)) return;
    setReturnItem(null);
    setReturnCompleted(false);
    setDetail((current) => current?.id === item.id ? null : current);
    setReleaseItem(item);
    setReleaseNote('');
    setReleaseConfirmation('');
    setReleaseError('');
  }

  async function submitReleaseRest() {
    if (!releaseItem || !canReleaseCopyQaFreezeRest(releaseItem) || action) return;
    if (!releaseNote.trim() || releaseConfirmation !== releaseItem.anonymousCode) {
      setReleaseError('请填写放行说明，并完整输入当前匿名样本编号确认。');
      return;
    }
    setAction('release-rest');
    setReleaseError('');
    try {
      const result = await apiRequest<Record<string, unknown>>(apiPath(`/v1/copy-qa/freezes/${encodeURIComponent(releaseItem.freezePublicId)}/release-rest`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: requestId(), note: releaseNote.trim() }),
      });
      const releasedCount = Math.max(0, Number(result.releasedCount) || 0);
      setReleaseItem(null);
      setMessage(`已显式放行同批其余 ${releasedCount} 条任务；当前错误项保持返工。`);
      await load({ silent: true });
    } catch (caught) {
      setReleaseError(caught instanceof Error ? caught.message : '放行同批其余任务失败');
    } finally {
      setAction('');
    }
  }

  async function beginBatchReturn(
    explicitTrigger?: CopyQaItem,
    defaults: { reasonCodes?: string[]; note?: string } = {},
  ) {
    const trigger = explicitTrigger ?? (selectedItems.length === 1 ? selectedItems[0] : null);
    if (!trigger || !canStartCopyQaBatchReturn(trigger)) return;
    const currentRequestId = batchPreviewRequestId.current + 1;
    batchPreviewRequestId.current = currentRequestId;
    batchPreviewRequestController.current?.abort();
    const controller = new AbortController();
    batchPreviewRequestController.current = controller;
    setReturnItem(null);
    setReturnCompleted(false);
    setBatchTriggerItem(trigger);
    setBatchReasons(defaults.reasonCodes ?? []);
    setBatchNote(defaults.note ?? '');
    setBatchConfirmation('');
    setBatchError('');
    setBatchPreview(null);
    setBatchOpen(true);
    setBatchPreviewLoading(true);
    try {
      const preview = await apiRequest<Record<string, unknown>>(
        apiPath(`/v1/copy-qa/freezes/${encodeURIComponent(trigger.freezePublicId)}/batch-return-preview`),
        { signal: controller.signal },
      );
      if (!canCommitLatestRequest(batchPreviewRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setBatchPreview(preview);
    } catch (caught) {
      if (!canCommitLatestRequest(batchPreviewRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setBatchError(caught instanceof Error ? caught.message : '整批影响预检失败');
    } finally {
      if (canCommitLatestRequest(batchPreviewRequestId.current, currentRequestId, controller.signal.aborted)) {
        batchPreviewRequestController.current = null;
        setBatchPreviewLoading(false);
      }
    }
  }

  function closeBatchReturn() {
    batchPreviewRequestId.current += 1;
    batchPreviewRequestController.current?.abort();
    batchPreviewRequestController.current = null;
    setBatchOpen(false);
    setBatchTriggerItem(null);
    setBatchPreview(null);
    setBatchPreviewLoading(false);
    setBatchError('');
  }

  async function submitBatchReturn() {
    if (!batchTriggerItem || !canStartCopyQaBatchReturn(batchTriggerItem) || !batchPreview || action) return;
    if (!batchReasons.length || !batchNote.trim()) {
      setBatchError('整批打回必须选择原因并填写说明。');
      return;
    }
    let requestPayload;
    try {
      requestPayload = buildCopyQaBatchReturnPayload({
        freezePublicId: batchTriggerItem.freezePublicId,
        triggerSamplingItemId: batchTriggerItem.id,
        preview: batchPreview,
        reasonCodes: batchReasons,
        note: batchNote,
        requestId: requestId(),
      });
    } catch {
      setBatchError('服务端预检范围不完整，请重新打开预检后再操作。');
      return;
    }
    const { confirmedCount } = requestPayload;
    if (Number(batchConfirmation) !== confirmedCount) {
      setBatchError(`请输入预检受影响数量 ${confirmedCount} 完成二次确认。`);
      return;
    }
    setAction('return-batch');
    setBatchError('');
    try {
      await apiRequest(apiPath('/v1/copy-qa/batch-return'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      });
      const affected = confirmedCount;
      setBatchOpen(false);
      setBatchTriggerItem(null);
      setCheckedIds([]);
      setMessage(`已显式整批打回 ${affected} 条样本；操作原因和人员已写入审计。`);
      await load({ silent: true });
    } catch (caught) {
      setBatchError(caught instanceof Error ? caught.message : '整批打回失败');
    } finally {
      setAction('');
    }
  }

  const copy = detail ? copyRevisionView(detail.approvedRevision.content) : null;
  const previewAffectedCount = Number(batchPreview?.confirmedCount ?? 0);

  return <div className={styles.stack}>
    <section className={styles.summary} aria-label="抽检概况">
      <article><strong>{currentStatusTotal}</strong><span>当前结果总数{total === null && hasMore ? '（至少）' : ''}</span></article>
      <article><strong>{items.length.toLocaleString('zh-CN')}</strong><span>当前结果已加载</span></article>
      <article><strong>{visibleItems.length.toLocaleString('zh-CN')}</strong><span>已加载范围内筛选显示</span></article>
      <article><strong>{blindCount.toLocaleString('zh-CN')}</strong><span>已加载盲评样本</span></article>
    </section>

    {role === 'ADMIN' && <section className="panel" aria-labelledby="copy-qa-accuracy-title">
      <div className="panel-head"><div><h2 id="copy-qa-accuracy-title">文案审核正确率</h2><p className="subtle">只统计随机首检且已经得出结论的样本；待抽检和未抽中的任务不进入分母。强制复检与整批受影响数在下方单独列示。</p></div></div>
      {statisticsError && <div className="notice error" role="alert">{statisticsError}</div>}
      {!statistics && !statisticsError ? <div className="empty-state">正在读取正确率统计…</div>
        : statistics && statistics.random.length === 0 ? <div className="empty-state">还没有已决的随机首检样本，暂不能计算人员正确率。</div>
          : statistics && <div className="table-wrap"><table><thead><tr><th>最终审核账号</th><th>随机首检已决</th><th>通过</th><th>打回</th><th>正确率</th></tr></thead><tbody>{statistics.random.map((metric) => <tr key={metric.finalApproverAccountId}><td>账号 #{metric.finalApproverAccountId}</td><td>{metric.decided}</td><td>{metric.passed}</td><td>{metric.returned}</td><td><strong>{(metric.accuracyRate * 100).toFixed(1)}%</strong></td></tr>)}</tbody></table></div>}
      {statistics && <div className={styles.modeSummary}><span className="pill">强制复检：通过 {statistics.mandatory.passed}</span><span className="pill">强制复检：打回 {statistics.mandatory.returned}</span><span className="pill">强制复检：待处理 {statistics.mandatory.pending}</span><span className="pill">整批受影响 {statistics.batchAffectedCount}</span></div>}
    </section>}

    <section className="panel" aria-labelledby="copy-qa-queue-title">
      <div className={styles.toolbar}>
        <div><div><h2 id="copy-qa-queue-title">待质检队列</h2><p className="subtle">随机抽检与返工强制复检集中处理；默认单条处理错误，整批打回是单独的高风险管理操作。</p></div></div>
        <div>
          <Button unstyled className="button small" type="button" disabled={refreshing || loadingMore} onClick={() => { void load(); }}><RefreshCw className={refreshing ? 'animate-spin' : ''} size={14} />刷新</Button>
          {selectedItems.length === 1 && canStartCopyQaBatchReturn(selectedItems[0]) && <Button unstyled className="button small danger" type="button" disabled={Boolean(action)} onClick={() => { void beginBatchReturn(); }}><RotateCcw size={14} />以所选错误项发起整批打回</Button>}
        </div>
      </div>
      <div className={styles.toolbar}>
        <div>
          <SearchInput className={styles.search} value={search} onValueChange={setSearch} placeholder="搜索匿名编号、Query、词包或批次编号" />
          {role === 'ADMIN' && <form className={styles.packageSearch} onSubmit={(event) => {
            event.preventDefault();
            setQueryPackageName(packageSearchInput.replace(/\s+/gu, ' ').trim());
          }}>
            <SearchInput aria-label="按词包名称筛选全部抽检项" maxLength={200} value={packageSearchInput} onValueChange={setPackageSearchInput} placeholder="按词包名称跨页筛选" />
            <Button unstyled className="button small" type="submit">应用词包</Button>
            {queryPackageName && <Button unstyled className="button small" type="button" onClick={() => {
              setPackageSearchInput('');
              setQueryPackageName('');
            }}>清除词包</Button>}
          </form>}
          <label>结果<Select value={status} onValueChange={(value) => setStatus(value as typeof status)}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部结果</SelectItem>{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
          {role === 'ADMIN' && <label>评审模式<Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部模式</SelectItem><SelectItem value="BLIND">独立盲评</SelectItem><SelectItem value="VISIBLE">非盲评</SelectItem></SelectContent></Select></label>}
        </div>
        <span className="pill">{role === 'ADMIN' ? '管理员保留随机首检整批打回权限' : items.some(canStartCopyQaBatchReturn) ? '当前允许随机首检整批打回' : '当前仅可单条打回；需要扩大范围时请联系管理员整批处置'}</span>
      </div>
      <div className={styles.scopeNote}>结果状态{role === 'ADMIN' ? '和词包名称' : ''}由服务端跨全部结果筛选；{role === 'ADMIN' ? 'Query、匿名编号和评审模式筛选' : 'Query 和匿名编号搜索'}仅作用于当前已加载的 {items.length} 条。{role === 'REVIEWER' && '样本评审模式由管理员预先决定，审核员不可切换或更改。'}{hasMore ? '仍有更多结果可继续加载。' : '当前状态结果已全部加载。'}</div>
      {items.some((item) => item.blindReview) && <div className={`notice ${styles.blindNotice}`}><EyeOff size={17} aria-hidden="true" /><span>独立盲评样本仅显示匿名编号、最终通过稿和匿名批次编号；任务号、Query、词包自由名称、上游身份、原评分及原因均不可见。</span></div>}
      {message && <div className="notice success" role="status">{message}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <div className="empty-state" role="status"><LoaderCircle className="animate-spin" size={20} />正在读取文案质检队列…</div>
        : visibleItems.length === 0 ? <div className="empty-state">{items.length ? '没有符合当前筛选条件的质检项。' : '当前没有待处理的文案质检项。'}</div>
          : <div className={`table-wrap mobile-cards ${styles.queue}`}><table>
            <thead><tr><th>整批触发项</th><th>样本</th><th>内容 / 最终稿</th><th>批次 / 模式</th><th>进入时间</th><th>操作</th></tr></thead>
            <tbody>{visibleItems.map((item) => {
              const itemCopy = copyRevisionView(item.approvedRevision.content);
              const canCheck = batchEligible(item) && (!selectedFreezePublicId || selectedFreezePublicId === item.freezePublicId);
              return <tr key={item.id}>
                <td data-label="整批触发项">{item.sampleKind === 'MANDATORY_RECHECK'
                  ? <span className="subtle" aria-label="强制复检不可作为整批打回触发项">—</span>
                  : <Checkbox aria-label={`将 ${item.anonymousCode} 作为整批打回触发错误项`} checked={checkedIds.includes(item.id)} disabled={!canCheck} onChange={(event) => setCheckedIds(event.target.checked ? [item.id] : [])} />}</td>
                <td data-label="样本"><div className={styles.code}><strong>{item.anonymousCode}</strong><small>{item.sampleKind === 'MANDATORY_RECHECK'
                  ? `强制复检 · ${MANDATORY_RECHECK_STATUS_LABELS[item.status]}`
                  : `随机首检 · ${STATUS_LABELS[item.status]}`}</small></div></td>
                <td data-label="内容 / 最终稿" className={styles.query}>{item.query && <strong>{item.query}</strong>}<div className="subtle">{item.sampleKind === 'MANDATORY_RECHECK' ? '返工稿（已按最终 3 分记录）' : '最终人工通过稿'}{itemCopy.title ? ` · ${itemCopy.title}` : ''}</div></td>
                <td data-label="批次 / 模式"><div className={styles.code}><strong>{item.productionBatch.anonymousCode}</strong>{!item.blindReview && <small>词包：{item.productionBatch.queryPackageName ?? '未归属词包'}</small>}<small>{item.blindReview ? '独立盲评' : item.taskId ? `非盲评 · 任务 #${item.taskId}` : '非盲评'}</small></div></td>
                <td data-label="进入时间">{timeLabel(item.createdAt)}</td>
                <td className="row-action" data-label="操作"><div className={styles.actions}><Button unstyled className="button small" type="button" onClick={() => { void openItem(item.id); }}><Eye size={14} />查看</Button>{item.status === 'PENDING' && item.capabilities.canPass && <Button unstyled className="button small primary" type="button" disabled={Boolean(action)} onClick={() => { void passItem(item); }}><CheckCircle2 size={14} />{item.sampleKind === 'MANDATORY_RECHECK' ? '通过强制复检' : '通过'}</Button>}{item.status === 'PENDING' && item.capabilities.canReturnSingle && <Button unstyled className="button small danger" type="button" disabled={Boolean(action)} onClick={() => beginSingleReturn(item)}><RotateCcw size={14} />仅打回此条</Button>}{canReleaseCopyQaFreezeRest(item) && <Button unstyled className="button small primary" type="button" disabled={Boolean(action)} onClick={() => beginReleaseRest(item)}><CheckCircle2 size={14} />放行同批其余</Button>}{item.status === 'RETURNED' && canStartCopyQaBatchReturn(item) && <Button unstyled className="button small danger" type="button" disabled={Boolean(action)} onClick={() => { void beginBatchReturn(item); }}><ShieldAlert size={14} />升级整批打回</Button>}</div></td>
              </tr>;
            })}</tbody>
          </table></div>}
      {hasMore && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMore || refreshing} onClick={() => { void load({ silent: true, offset: nextOffset }); }}>{loadingMore ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : '加载更多抽检项'}</Button></div>}
    </section>

    <Dialog open={detail !== null || detailLoading} onOpenChange={(open) => { if (!open && !action) closeItemDetail(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><div><DialogTitle>{detail?.anonymousCode ?? '读取抽检详情'}</DialogTitle><DialogDescription>{detail
          ? detail.sampleKind === 'MANDATORY_RECHECK' ? '核对已按最终 3 分记录的返工稿' : '核对内容指纹绑定的最终人工通过稿'
          : '正在读取抽检详情…'}</DialogDescription></div>{detail && <span className="pill">{detail.blindReview ? <><EyeOff size={13} />独立盲评</> : <><Eye size={13} />非盲评</>}</span>}</div>
        {detailLoading && !detail && <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取详情…</div>}
        {detailError && !detail && <div className="notice error" role="alert">{detailError}</div>}
        {detail && copy && <>
          <div className={styles.metadata}>{detail.query && <div><small>Query</small><strong>{detail.query}</strong></div>}<div><small>匿名批次编号</small><strong>{detail.productionBatch.anonymousCode}</strong></div><div><small>内容指纹</small><strong>{detail.approvedRevision.contentSha256 ? `${detail.approvedRevision.contentSha256.slice(0, 12)}…` : '未提供'}</strong></div></div>
          {detail.blindReview && <div className="notice"><EyeOff size={15} aria-hidden="true" /> 当前为盲评，页面不会显示或保留任务身份、上游人员、原评分和原扣分原因。</div>}
          <article className={styles.copy} aria-label={detail.sampleKind === 'MANDATORY_RECHECK' ? '强制复检返工文案' : '最终人工通过文案'}><span className="pill">{detail.sampleKind === 'MANDATORY_RECHECK' ? '返工稿 · 已按最终 3 分记录' : '最终人工通过稿'}</span>{copy.title && <h3>{copy.title}</h3>}<p className={styles.copyBody}>{copy.body || '最终稿正文为空'}</p>{copy.tags.length > 0 && <div className={styles.tags}>{copy.tags.map((tag) => <span className="pill" key={tag}>#{tag}</span>)}</div>}</article>
          {!detail.blindReview && <section className={styles.source} aria-labelledby="copy-qa-source-title"><h3 id="copy-qa-source-title">管理员来源信息</h3><div className={styles.metadata}><div><small>词包名称</small><strong>{detail.productionBatch.queryPackageName ?? '未归属词包'}</strong></div><div><small>正式任务</small><strong>{detail.taskId ? `#${detail.taskId}` : '未记录'}</strong></div><div><small>最终审批账号</small><strong>{detail.finalApproverAccountId ? `账号 #${detail.finalApproverAccountId}` : '未记录'}</strong></div><div><small>生产批次</small><strong>{detail.productionBatchId ? `#${detail.productionBatchId}` : detail.productionBatch.anonymousCode}</strong></div></div></section>}
          {detailError && <div className="notice error" role="alert">{detailError}</div>}
          <div className={styles.footer}><span className="subtle">{detail.sampleKind === 'MANDATORY_RECHECK'
            ? '返工稿已按最终 3 分记录；只有通过强制复检后才会进入待生图队列。'
            : '抽检结论只绑定当前展示的最终修订版。'}</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={Boolean(action)}>关闭</Button></DialogClose>{detail.status === 'PENDING' && detail.capabilities.canReturnSingle && <Button unstyled className="button danger" type="button" disabled={Boolean(action)} onClick={() => beginSingleReturn(detail)}>仅打回此条</Button>}{canReleaseCopyQaFreezeRest(detail) && <Button unstyled className="button primary" type="button" disabled={Boolean(action)} onClick={() => beginReleaseRest(detail)}>放行同批其余</Button>}{detail.status === 'RETURNED' && canStartCopyQaBatchReturn(detail) && <Button unstyled className="button danger" type="button" disabled={Boolean(action)} onClick={() => { void beginBatchReturn(detail); }}>升级整批打回</Button>}{detail.status === 'PENDING' && detail.capabilities.canPass && <Button unstyled className="button primary" type="button" disabled={Boolean(action)} onClick={() => { void passItem(detail); }}>{action === 'pass' ? '提交中…' : detail.sampleKind === 'MANDATORY_RECHECK' ? '通过强制复检' : '通过最终稿'}</Button>}</div></div>
        </>}
      </DialogContent>
    </Dialog>

    <Dialog open={returnItem !== null} onOpenChange={(open) => { if (!open && action !== 'return-single') { setReturnItem(null); setReturnCompleted(false); } }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><div><DialogTitle>{returnItem?.sampleKind === 'MANDATORY_RECHECK'
          ? returnCompleted ? '强制复检未通过，已退回修改' : '打回强制复检返工稿'
          : returnCompleted ? '当前错误项已单条打回' : '只打回当前错误项'}</DialogTitle><DialogDescription>{returnItem?.sampleKind === 'MANDATORY_RECHECK'
          ? returnCompleted
            ? '当前返工稿未通过强制复检；实际修改标题、正文或标签后，新返工稿会按最终 3 分记录并再次进入强制复检，通过前不会进入待生图队列。'
            : `${returnItem.anonymousCode} 的返工稿将退回修改；强制复检不会放行同批其余或扩大为整批打回，通过复检前不会进入待生图队列。`
          : returnCompleted
            ? '同批其他任务仍在冻结等待。请明确选择放行其余，或以这个已确认的错误项升级整批打回。'
            : `${returnItem?.anonymousCode} 将退回修改；同批次其他任务保持等待。`}</DialogDescription></div><RotateCcw size={20} aria-hidden="true" /></div>
        {!returnCompleted ? <>
          <div className={styles.reasonGrid}>{RETURN_REASONS.map((reason) => <label key={reason.code}><Checkbox checked={returnReasons.includes(reason.code)} disabled={action === 'return-single'} onChange={() => toggleReason(reason.code, setReturnReasons)} />{reason.label}</label>)}</div>
          <div className="field"><label htmlFor="copy-qa-single-note">具体说明</label><Textarea id="copy-qa-single-note" value={returnNote} maxLength={500} rows={5} disabled={action === 'return-single'} placeholder="指出错误位置和修改要求，便于原作业人员处理" onChange={(event) => { setReturnNote(event.target.value); setReturnError(''); }} /></div>
          {returnError && <div className="notice error" role="alert">{returnError}</div>}
          <div className={styles.footer}><span className="subtle">{returnItem?.sampleKind === 'MANDATORY_RECHECK' ? '本次只处理当前强制复检返工稿。' : '默认最小影响范围：当前单条任务。'}</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={action === 'return-single'}>取消</Button></DialogClose><Button unstyled className="button danger" type="button" disabled={action === 'return-single'} onClick={() => { void submitSingleReturn(); }}>{action === 'return-single' ? '打回中…' : returnItem?.sampleKind === 'MANDATORY_RECHECK' ? '确认打回返工稿' : '确认仅打回此条'}</Button></div></div>
        </> : returnItem && <>
          <div className={styles.impact}><strong>{returnItem.sampleKind === 'MANDATORY_RECHECK' ? '强制复检项' : '错误项'}：{returnItem.anonymousCode}</strong><span>{returnItem.sampleKind === 'MANDATORY_RECHECK' ? '返工稿已退回继续修改，当前不会进入待生图队列。' : '单条打回已生效；关闭弹窗也不会自动放行或扩大范围。'}</span></div>
          {returnItem.sampleKind === 'MANDATORY_RECHECK'
            ? <>
              <div className="notice">实际修改标题、正文或标签后，新返工稿会按最终 3 分记录并再次进入强制复检；只有复检通过后才会进入待生图队列。</div>
              <div className={styles.footer}><span className="subtle">强制复检只处理当前返工项；此处不会提供整批打回或放行同批其余操作。</span><DialogClose asChild><Button unstyled className="button" type="button">完成</Button></DialogClose></div>
            </>
            : <>
              {!canStartCopyQaBatchReturn(returnItem) && <div className="notice">当前账号没有整批打回权限；可放行其余，需扩大范围时请联系管理员。</div>}
              <div className={styles.footer}><span className="subtle">同批其他任务保持等待，直到执行下列某个明确操作。</span><div><DialogClose asChild><Button unstyled className="button" type="button">稍后处理</Button></DialogClose>{canReleaseCopyQaFreezeRest(returnItem) && <Button unstyled className="button primary" type="button" onClick={() => beginReleaseRest(returnItem)}><CheckCircle2 size={14} />放行同批其余</Button>}{canStartCopyQaBatchReturn(returnItem) && <Button unstyled className="button danger" type="button" onClick={() => { void beginBatchReturn(returnItem, { reasonCodes: returnReasons, note: returnNote }); }}><ShieldAlert size={14} />升级整批打回</Button>}</div></div>
            </>}
        </>}
      </DialogContent>
    </Dialog>

    <Dialog open={releaseItem !== null} onOpenChange={(open) => { if (!open && action !== 'release-rest') setReleaseItem(null); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><div><DialogTitle>显式放行同批其余任务</DialogTitle><DialogDescription>当前错误项继续返工；这里只解除同一冻结批次中其余等待任务，不会把错误项恢复为通过。</DialogDescription></div><CheckCircle2 size={21} aria-hidden="true" /></div>
        {releaseItem && <>
          <div className={styles.impact}><strong>当前错误项：{releaseItem.anonymousCode}</strong><span>该操作对质检员和管理员始终可用，不受“整批打回”权限开关影响；服务端会按冻结快照执行并记录审计。</span></div>
          <div className="field"><label htmlFor="copy-qa-release-note">放行说明（必填）</label><Textarea id="copy-qa-release-note" value={releaseNote} maxLength={500} rows={4} disabled={action === 'release-rest'} placeholder="说明为何其余任务可以继续后续流程" onChange={(event) => { setReleaseNote(event.target.value); setReleaseError(''); }} /></div>
          <div className="field"><label htmlFor="copy-qa-release-confirmation">输入匿名样本编号“{releaseItem.anonymousCode}”确认</label><Input id="copy-qa-release-confirmation" value={releaseConfirmation} disabled={action === 'release-rest'} onChange={(event) => { setReleaseConfirmation(event.target.value); setReleaseError(''); }} /></div>
          {releaseError && <div className="notice error" role="alert">{releaseError}</div>}
          <div className={styles.footer}><span className="subtle">放行结果只作用于当前冻结批次中的其余等待任务。</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={action === 'release-rest'}>取消</Button></DialogClose><Button unstyled className="button primary" type="button" disabled={action === 'release-rest' || !releaseNote.trim() || releaseConfirmation !== releaseItem.anonymousCode} onClick={() => { void submitReleaseRest(); }}>{action === 'release-rest' ? '放行中…' : '确认放行同批其余'}</Button></div></div>
        </>}
      </DialogContent>
    </Dialog>

    <Dialog open={batchOpen} onOpenChange={(open) => { if (!open && action !== 'return-batch') closeBatchReturn(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><div><DialogTitle>整批打回 · 高风险操作</DialogTitle><DialogDescription>这是独立的显式管理操作，不会由单条抽检失败自动触发。</DialogDescription></div><ShieldAlert size={21} aria-hidden="true" /></div>
        <div className={styles.impact}><strong>预检影响：匿名批次 {batchTriggerItem?.productionBatch.anonymousCode}，触发错误项 {batchTriggerItem?.anonymousCode}</strong><span>{batchPreviewLoading ? '正在由服务端重新核对批次快照与影响范围…' : batchPreview ? `服务端预检完成，预计影响 ${previewAffectedCount} 条正式任务。提交时使用本次预检返回的完整范围。` : '服务端预检尚未完成，不能提交整批打回。'}</span></div>
        <div className={styles.reasonGrid}>{RETURN_REASONS.map((reason) => <label key={reason.code}><Checkbox checked={batchReasons.includes(reason.code)} disabled={action === 'return-batch'} onChange={() => toggleReason(reason.code, setBatchReasons)} />{reason.label}</label>)}</div>
        <div className="field"><label htmlFor="copy-qa-batch-note">整批打回说明（必填）</label><Textarea id="copy-qa-batch-note" value={batchNote} maxLength={500} rows={5} disabled={action === 'return-batch'} placeholder="说明为何需要扩大到整批，以及统一返工要求" onChange={(event) => { setBatchNote(event.target.value); setBatchError(''); }} /></div>
        <div className="field"><label htmlFor="copy-qa-batch-confirmation">输入预检受影响数量 {previewAffectedCount} 二次确认</label><Input id="copy-qa-batch-confirmation" type="number" min={0} value={batchConfirmation} disabled={action === 'return-batch'} onChange={(event) => { setBatchConfirmation(event.target.value); setBatchError(''); }} /></div>
        {batchError && <div className="notice error" role="alert">{batchError}</div>}
        <div className={styles.footer}><span className="subtle">关闭窗口不会提交任何变更。</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={action === 'return-batch'}>取消</Button></DialogClose><Button unstyled className="button danger" type="button" disabled={!batchPreview || batchPreviewLoading || action === 'return-batch' || Number(batchConfirmation) !== previewAffectedCount} onClick={() => { void submitBatchReturn(); }}>{action === 'return-batch' ? '整批打回中…' : `确认整批打回（影响 ${previewAffectedCount} 条）`}</Button></div></div>
      </DialogContent>
    </Dialog>
  </div>;
}
