'use client';

import { Button } from '@/components/ui/button';
import { ToastFeedback } from '@/components/ui/sonner';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { canCommitLatestRequest } from '../components/latest-request';
import { createRequestId } from '../components/request-id';
import { buildCopyQaBatchReturnPayload } from '../../src/copy-qa-batch-return.mjs';
import { CopyQaReasonPicker } from './copy-qa-reason-picker';
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
type CopyQaKindFilter = 'ALL' | 'RANDOM' | 'MANDATORY_RECHECK';
const STATUS_LABELS: Record<CopyQaStatus, string> = {
  PENDING: '待抽检',
  PASSED: '抽检通过',
  RETURNED: '单条已打回',
  RELEASED: '已放行',
  BATCH_RETURNED: '整批已打回',
  BATCH_AFFECTED: '整批受影响',
  SUPERSEDED: '旧版已失效',
};
const MANDATORY_RECHECK_STATUS_LABELS: Record<CopyQaStatus, string> = {
  PENDING: '待处理',
  PASSED: '已通过',
  RETURNED: '已打回',
  RELEASED: '已放行',
  BATCH_RETURNED: '整批已打回',
  BATCH_AFFECTED: '整批受影响',
  SUPERSEDED: '旧版已失效',
};
const IMAGE_KIND_LABELS: Record<string, string> = {
  hero: '封面',
  steps: '步骤',
  checklist: '清单',
  comparison: '对比',
  detail: '细节',
  summary: '总结',
};

function timeLabel(value?: string) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录';
}

export function CopyQaWorkbench({ role }: { role: 'ADMIN' | 'REVIEWER' | 'USER' }) {
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
  const [personSearchInput, setPersonSearchInput] = useState('');
  const [personName, setPersonName] = useState('');
  const [status, setStatus] = useState<CopyQaStatus | 'ALL' | 'ADMIN_DIRECT_PASSED'>('PENDING');
  const [sampleKind, setSampleKind] = useState<CopyQaKindFilter>('ALL');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<CopyQaItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [action, setAction] = useState('');
  const [returnItem, setReturnItem] = useState<CopyQaItem | null>(null);
  const [returnReasons, setReturnReasons] = useState<string[]>([]);
  const [returnNote, setReturnNote] = useState('');
  const [returnRecommendation, setReturnRecommendation] = useState<'REWORK' | 'DISCARD'>('REWORK');
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
      if (role === 'ADMIN' && personName) params.set('personName', personName);
      const [payload, statisticsPayload] = await Promise.all([
        apiRequest<unknown>(apiPath(`/v1/copy-qa/items?${params.toString()}`)),
        role === 'ADMIN' && !append
          ? apiRequest<unknown>(apiPath('/v1/copy-qa/statistics')).catch((caught) => caught instanceof Error ? caught : new Error('准确率统计读取失败'))
          : Promise.resolve(null),
      ]);
      if (currentRequestId !== listRequestId.current) return;
      const page = normalizeCopyQaPage(payload, { role });
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
  }, [personName, queryPackageName, role, status]);

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
    return items.filter((item) => (sampleKind === 'ALL' || item.sampleKind === sampleKind)
      && (status === 'ALL'
      || (status === 'ADMIN_DIRECT_PASSED'
        ? !item.blindReview && item.reviewMethod === 'ADMIN_DIRECT'
        : item.status === status))
      && (!keyword || `${item.anonymousCode} ${item.query ?? ''} ${item.productionBatch.anonymousCode} ${item.blindReview ? '' : item.productionBatch.queryPackageName ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [items, sampleKind, search, status]);

  const selectedItems = useMemo(() => items.filter((item) => checkedIds.includes(item.id)), [checkedIds, items]);
  const selectedFreezePublicId = selectedItems[0]?.freezePublicId ?? null;
  const batchEligible = (item: CopyQaItem) => item.status === 'PENDING' && canStartCopyQaBatchReturn(item);
  const blindCount = items.filter((item) => item.blindReview).length;
  const randomCount = items.filter((item) => item.sampleKind === 'RANDOM').length;
  const mandatoryCount = items.length - randomCount;
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
      const next = normalizeCopyQaItem(payload, { role });
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
        body: JSON.stringify({ expectedRevisionToken: item.approvedRevision.revisionToken, requestId: createRequestId() }),
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
    setReturnRecommendation('REWORK');
    setReturnError('');
    setReturnCompleted(false);
  }

  async function submitSingleReturn() {
    if (!returnItem || !returnItem.capabilities.canReturnSingle || action) return;
    if (returnReasons.length === 0 && !returnNote.trim()) {
      setReturnError('请选择至少一个错误原因，或填写具体说明。');
      return;
    }
    if (returnRecommendation === 'DISCARD' && !returnNote.trim()) {
      setReturnError('建议废弃时必须填写明确原因，供任务负责人确认。');
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
          recommendedDisposition: returnRecommendation,
          requestId: createRequestId(),
        }),
      });
      const returned = returnItem;
      const code = returned.anonymousCode;
      setDetail(null);
      setMessage(returned.sampleKind === 'MANDATORY_RECHECK'
        ? returnRecommendation === 'DISCARD'
          ? `${code} 未通过强制复检，并已向任务负责人建议废弃。`
          : `${code} 未通过强制复检，已退回继续修改；实际修改文案或图片规划后，新返工稿会按最终 3 分记录并再次进入强制复检，通过前不会进入待生图队列。`
        : returnRecommendation === 'DISCARD'
          ? `${code} 已单条打回并建议废弃；同批其他任务仍需显式放行或整批处置。`
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
        body: JSON.stringify({ requestId: createRequestId(), note: releaseNote.trim() }),
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
        requestId: createRequestId(),
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
    <Tabs className={`panel ${styles.workbenchTabs}`} defaultValue="queue" aria-label="质检数据与标注">
      <div className={styles.workbenchHeader}>
        <TabsList className={styles.tabList} aria-label="质检看板内容">
          <TabsTrigger value="queue">质检队列<span className={styles.tabCount}>{currentStatusTotal}</span></TabsTrigger>
          <TabsTrigger value="overview">数据概览</TabsTrigger>
          {role === 'ADMIN' && <TabsTrigger value="workers">标注</TabsTrigger>}
          <TabsTrigger value="guide">规则说明</TabsTrigger>
        </TabsList>
        <div className={styles.accessSummary} data-role={role === 'ADMIN' ? 'admin' : 'reviewer'}>
          <strong>{role === 'ADMIN' ? '管理员视图' : '质检视图'}</strong>
          <span>{role === 'ADMIN' ? '完整信息 · 跨页词包/人员筛选 · 人员统计' : '按样本策略脱敏 · 仅显示已授权操作'}</span>
        </div>
      </div>

      <TabsContent className={`${styles.tabViewport} ${styles.queueView}`} value="queue">
      <section className={styles.queuePanel} aria-labelledby="copy-qa-queue-title">
      <div className={styles.toolbar}>
        <div><div><h2 id="copy-qa-queue-title">待质检队列</h2><p className="subtle">一次抽检与返工强制复检集中处理；类型和状态已分列显示。</p></div></div>
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
          {role === 'ADMIN' && <form className={styles.packageSearch} onSubmit={(event) => {
            event.preventDefault();
            setPersonName(personSearchInput.replace(/\s+/gu, ' ').trim());
          }}>
            <SearchInput aria-label="按人员姓名筛选全部文案质检项" maxLength={80} value={personSearchInput} onValueChange={setPersonSearchInput} placeholder="按审核人姓名或账号筛选" />
            <Button unstyled className="button small" type="submit">应用人员</Button>
            {personName && <Button unstyled className="button small" type="button" onClick={() => {
              setPersonSearchInput('');
              setPersonName('');
            }}>清除人员</Button>}
          </form>}
          <label>类型<Select value={sampleKind} onValueChange={(value) => { setSampleKind(value as CopyQaKindFilter); setCheckedIds([]); }}><SelectTrigger className={styles.kindSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部类型</SelectItem><SelectItem value="RANDOM">一次抽检</SelectItem><SelectItem value="MANDATORY_RECHECK">强制复检</SelectItem></SelectContent></Select></label>
          <label>结果<Select value={status} onValueChange={(value) => setStatus(value as typeof status)}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部结果</SelectItem>{role === 'ADMIN' && <SelectItem value="ADMIN_DIRECT_PASSED">管理员单独通过</SelectItem>}{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
        </div>
        <span className="pill">{role === 'ADMIN' ? '管理员可对一次抽检发起整批打回' : items.some(canStartCopyQaBatchReturn) ? '当前可对一次抽检发起整批打回' : '当前仅可单条打回；需要扩大范围时请联系管理员整批处置'}</span>
      </div>
      <div className={styles.scopeNote}><strong>队列顺序：</strong>按标注逐轮交错，每人先显示 1 条再进入下一轮；同一人员内部仍按任务优先级和入队时间排序。结果状态{role === 'ADMIN' ? '、词包名称和人员姓名' : ''}由服务端跨全部结果筛选；Query 和匿名编号搜索仅作用于当前已加载的 {items.length} 条。{role === 'ADMIN' && '管理员固定使用完整信息视图，任务、Query、词包和来源信息不会因样本盲评策略而隐藏，也可处理自己最终审核的文案。'}{role === 'REVIEWER' && '样本评审模式由管理员预先决定，质检不可切换或更改。'}{hasMore ? '仍有更多结果可继续加载。' : '当前状态结果已全部加载。'}</div>
      {items.some((item) => item.blindReview) && <div className={`notice ${styles.blindNotice}`}><EyeOff size={17} aria-hidden="true" /><span>独立盲评样本仅显示匿名编号、最终通过稿和匿名批次编号；任务号、Query、词包自由名称、上游身份、原评分及原因均不可见。</span></div>}
      <ToastFeedback id="copy-qa-feedback" message={message} />
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <div className="empty-state" role="status"><LoaderCircle className="animate-spin" size={20} />正在读取文案质检队列…</div>
        : visibleItems.length === 0 ? <div className="empty-state">{items.length ? '没有符合当前筛选条件的质检项。' : '当前没有待处理的文案质检项。'}</div>
          : <div className={`table-wrap mobile-cards ${styles.queue}`} role="region" aria-label="待质检队列，可横向滚动" tabIndex={0}><table>
            <thead><tr><th>质检类型 / 状态</th><th>样本 / 批次</th><th>内容 / 最终稿</th><th>进入时间</th><th>操作</th></tr></thead>
            <tbody>{visibleItems.map((item) => {
              const itemCopy = copyRevisionView(item.approvedRevision.content);
              const canCheck = batchEligible(item) && (!selectedFreezePublicId || selectedFreezePublicId === item.freezePublicId);
              return <tr key={item.id}>
                <td data-label="质检类型 / 状态"><div className={styles.kindCell}><span className={styles.kindBadge} data-kind={item.sampleKind === 'MANDATORY_RECHECK' ? 'mandatory' : 'random'}>{item.sampleKind === 'MANDATORY_RECHECK' ? '强制复检' : '一次抽检'}</span><strong>{item.sampleKind === 'MANDATORY_RECHECK'
                  ? MANDATORY_RECHECK_STATUS_LABELS[item.status]
                  : !item.blindReview && item.reviewMethod === 'ADMIN_DIRECT'
                    ? `管理员单独通过 · ${item.status === 'SUPERSEDED' ? '旧版已失效' : '已通过'}`
                    : STATUS_LABELS[item.status]}</strong></div></td>
                <td data-label="样本 / 批次"><div className={styles.sampleCell}>{item.sampleKind === 'RANDOM' && <Checkbox aria-label={`将 ${item.anonymousCode} 作为整批打回触发错误项`} checked={checkedIds.includes(item.id)} disabled={!canCheck} onChange={(event) => setCheckedIds(event.target.checked ? [item.id] : [])} />}<div className={styles.code}><strong>{item.anonymousCode}</strong><small>批次 {item.productionBatch.anonymousCode}</small>{!item.blindReview && <small>词包：{item.productionBatch.queryPackageName ?? '未归属词包'}{item.taskId ? ` · 任务 #${item.taskId}` : ''}{item.finalApproverUsername ? ` · 审核 @${item.finalApproverUsername}` : ''}</small>}<small>{item.blindReview ? '独立盲评' : '完整信息'}</small></div></div></td>
                <td data-label="内容 / 最终稿" className={styles.query}>{item.query && <strong>{item.query}</strong>}<div className="subtle">{item.sampleKind === 'MANDATORY_RECHECK' ? '返工稿（已按最终 3 分记录）' : '最终人工通过稿'}{itemCopy.title ? ` · ${itemCopy.title}` : ''}</div></td>
                <td data-label="进入时间"><div className={styles.timeCell}><span>{timeLabel(item.createdAt)}</span><small>{item.prioritySummary ?? '跟随系统优先级'}</small></div></td>
                <td className="row-action" data-label="操作"><div className={styles.actions}><Button unstyled className={`button small ${styles.actionView}`} type="button" onClick={() => { void openItem(item.id); }}><Eye size={14} />查看</Button>{item.status === 'PENDING' && item.capabilities.canPass && <Button unstyled className={`button small primary ${styles.actionPrimary}`} type="button" disabled={Boolean(action)} onClick={() => { void passItem(item); }}><CheckCircle2 size={14} />{item.sampleKind === 'MANDATORY_RECHECK' ? '通过强制复检' : '通过抽检'}</Button>}{item.status === 'PENDING' && item.capabilities.canReturnSingle && <Button unstyled className={`button small danger ${styles.actionReturn}`} type="button" disabled={Boolean(action)} onClick={() => beginSingleReturn(item)}><RotateCcw size={14} />仅打回此条</Button>}{role === 'ADMIN' && canReleaseCopyQaFreezeRest(item) && <Button unstyled className={`button small primary ${styles.actionPrimary}`} type="button" disabled={Boolean(action)} onClick={() => beginReleaseRest(item)}><CheckCircle2 size={14} />放行同批其余</Button>}{item.status === 'RETURNED' && canStartCopyQaBatchReturn(item) && <Button unstyled className={`button small danger ${styles.actionReturn}`} type="button" disabled={Boolean(action)} onClick={() => { void beginBatchReturn(item); }}><ShieldAlert size={14} />升级整批打回</Button>}</div></td>
              </tr>;
            })}</tbody>
          </table></div>}
      {hasMore && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMore || refreshing} onClick={() => { void load({ silent: true, offset: nextOffset }); }}>{loadingMore ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : '加载更多抽检项'}</Button></div>}
      </section>
      </TabsContent>

      <TabsContent className={styles.tabViewport} value="overview">
        <section className={styles.viewContent} aria-labelledby="copy-qa-overview-title">
          <div className={styles.viewHeader}><div><h2 id="copy-qa-overview-title">数据概览</h2><p>快速判断当前积压、抽检构成和强制复检结果。</p></div><span className="pill">{role === 'ADMIN' ? '全局统计' : '当前授权范围'}</span></div>
          <section className={styles.summary} aria-label="质检数据概览">
            <article><strong>{currentStatusTotal}</strong><span>当前状态总数{total === null && hasMore ? '（至少）' : ''}</span><small>服务端结果</small></article>
            <article><strong>{visibleItems.length.toLocaleString('zh-CN')}</strong><span>当前显示</span><small>搜索与类型筛选后</small></article>
            <article data-kind="random"><strong>{randomCount.toLocaleString('zh-CN')}</strong><span>一次抽检</span><small>已加载范围</small></article>
            <article data-kind="mandatory"><strong>{mandatoryCount.toLocaleString('zh-CN')}</strong><span>强制复检</span><small>已加载范围</small></article>
            {role === 'ADMIN'
              ? <article><strong>{statistics?.random.length.toLocaleString('zh-CN') ?? '—'}</strong><span>标注</span><small>已有抽检结论</small></article>
              : <article><strong>{blindCount.toLocaleString('zh-CN')}</strong><span>盲评样本</span><small>已加载范围</small></article>}
          </section>
          {role === 'ADMIN' && <section className={styles.outcomeSection} aria-labelledby="copy-qa-outcome-title">
            <div className={styles.tabSectionHeader}><h3 id="copy-qa-outcome-title">强制复检数据</h3><p>强制复检和整批影响单独统计。</p></div>
            {statisticsError && <div className="notice error" role="alert">{statisticsError}</div>}
            {!statistics && !statisticsError ? <div className={styles.compactEmpty}>正在读取质检统计…</div>
              : statistics && <div className={styles.outcomeGrid}>
                <article><span>强制通过</span><strong>{statistics.mandatory.passed}</strong></article>
                <article><span>强制打回</span><strong>{statistics.mandatory.returned}</strong></article>
                <article><span>强制待处理</span><strong>{statistics.mandatory.pending}</strong></article>
                <article><span>整批受影响</span><strong>{statistics.batchAffectedCount}</strong></article>
              </div>}
          </section>}
          {role !== 'ADMIN' && <div className={styles.permissionNote}><strong>质检权限范围</strong><span>此处只汇总当前账号可见的队列数据；标注统计、词包跨页筛选和管理员单独通过记录仅管理员可见。</span></div>}
        </section>
      </TabsContent>

      {role === 'ADMIN' && <TabsContent className={styles.tabViewport} value="workers">
        <section className={styles.viewContent} aria-labelledby="copy-qa-accuracy-title">
          <div className={styles.viewHeader}><div><h2 id="copy-qa-accuracy-title">标注抽检数据</h2><p>仅统计已有结论的一次抽检；强制复检单独计入数据概览。</p></div><span className="pill">仅管理员可见</span></div>
          {statisticsError && <div className="notice error" role="alert">{statisticsError}</div>}
          {!statistics && !statisticsError ? <div className={styles.compactEmpty}>正在读取标注数据…</div>
            : statistics && statistics.random.length === 0 ? <div className={styles.compactEmpty}>还没有已决的一次抽检样本。</div>
              : statistics && <div className={styles.workerList} role="region" aria-label="文案质检标注数据，可滚动查看" tabIndex={0}>{statistics.random.map((metric) => <article key={metric.finalApproverAccountId}>
                <header><div><strong>{metric.finalApproverDisplayName ?? metric.finalApproverUsername ?? `账号 #${metric.finalApproverAccountId}`}</strong>{metric.finalApproverDisplayName && metric.finalApproverUsername && <small>@{metric.finalApproverUsername}</small>}</div><b>{(metric.accuracyRate * 100).toFixed(1)}%</b></header>
                <dl><div><dt>已决</dt><dd>{metric.decided}</dd></div><div><dt>通过</dt><dd>{metric.passed}</dd></div><div><dt>打回</dt><dd>{metric.returned}</dd></div></dl>
              </article>)}</div>}
        </section>
      </TabsContent>}

      <TabsContent className={styles.tabViewport} value="guide">
        <section className={`${styles.viewContent} ${styles.guidePanel}`} aria-labelledby="copy-qa-guide-title">
          <div className={styles.viewHeader}><div><h2 id="copy-qa-guide-title">质检类型与状态变化</h2><p>两种质检分开计数、分开流转。</p></div><span className="pill">不会到次数自动放行</span></div>
          <div className={styles.flowList}>
            <article data-kind="random">
              <header><strong>一次抽检</strong><span>当前版本只判定 1 次</span></header>
              <p><b>通过</b> 同轮项目均解决后，任务进入“待生图”。</p>
              <p><b>打回</b> 当前项变为“已打回”，任务进入“待修改”，修改后转为强制复检。</p>
            </article>
            <article data-kind="mandatory">
              <header><strong>强制复检</strong><span>返工版本 100% 必检</span></header>
              <p><b>通过</b> 解除强制门禁；上游批次也已解决时进入“待生图”。</p>
              <p><b>打回</b> 当前项保留为“已打回”，实际修改后生成新的“待强制复检”。</p>
            </article>
          </div>
          <div className={styles.attemptRule}><strong>最多质检几次？</strong><p>一次抽检对每个入选版本最多 1 次；强制复检当前不设总次数上限，会按“打回 → 修改 → 新强制复检”循环，直到通过。文案版本被替换时，旧的待检项会变为“旧版已失效”。</p></div>
          <div className={styles.permissionMatrix}>
            <div><strong>质检账号</strong><span>处理授权范围内的样本；盲评时隐藏任务、人员、词包和原评分信息，批次操作仅在条目明确授权时显示。</span></div>
            <div><strong>管理员</strong><span>始终使用完整信息视图，并额外查看人员统计、跨页词包筛选和管理员单独通过记录。</span></div>
          </div>
        </section>
      </TabsContent>
    </Tabs>

    <Dialog open={detail !== null || detailLoading} onOpenChange={(open) => { if (!open && !action) closeItemDetail(); }}>
      <DialogContent className={`${styles.dialog} ${styles.detailDialog}`}>
        <header className={styles.detailHeader}>
          <div className={styles.dialogHeader}><div><DialogTitle>{detail?.anonymousCode ?? '读取抽检详情'}</DialogTitle><DialogDescription>{detail
            ? detail.sampleKind === 'MANDATORY_RECHECK' ? '核对已按最终 3 分记录的返工稿' : '核对内容指纹绑定的最终人工通过稿'
            : '正在读取抽检详情…'}</DialogDescription></div>{detail && <div className={styles.actions}><span className="pill">{detail.blindReview ? <><EyeOff size={13} />独立盲评</> : <><Eye size={13} />非盲评</>}</span>{!detail.blindReview && detail.reviewMethod === 'ADMIN_DIRECT' && <span className="pill"><CheckCircle2 size={13} />管理员单独通过</span>}</div>}</div>
          {detail && copy && <div className={styles.metadata}>{detail.query && <div><small>Query</small><strong>{detail.query}</strong></div>}<div><small>匿名批次编号</small><strong>{detail.productionBatch.anonymousCode}</strong></div><div><small>内容指纹</small><strong>{detail.approvedRevision.contentSha256 ? `${detail.approvedRevision.contentSha256.slice(0, 12)}…` : '未提供'}</strong></div></div>}
        </header>
        <div className={styles.detailBody}>
          {detailLoading && !detail && <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取详情…</div>}
          {detailError && !detail && <div className="notice error" role="alert">{detailError}</div>}
          {detail && copy && <>
            {detail.blindReview && <div className="notice"><EyeOff size={15} aria-hidden="true" /> 当前为盲评，页面不会显示或保留任务身份、上游人员、原评分和原扣分原因。</div>}
            <div className={styles.comparison} aria-label="最终文案与图片文案规划对照">
              <article className={styles.copy} aria-label={detail.sampleKind === 'MANDATORY_RECHECK' ? '强制复检返工文案' : '最终人工通过文案'}><span className="pill">{detail.sampleKind === 'MANDATORY_RECHECK' ? '返工稿 · 已按最终 3 分记录' : '最终人工通过稿'}</span>{copy.title && <h3>{copy.title}</h3>}<p className={styles.copyBody}>{copy.body || '最终稿正文为空'}</p>{copy.tags.length > 0 && <div className={styles.tags}>{copy.tags.map((tag) => <span className="pill" key={tag}>#{tag}</span>)}</div>}</article>
              <section className={styles.plan} aria-labelledby="copy-qa-plan-title">
                <div className={styles.planHeader}><div><h3 id="copy-qa-plan-title">图片文案规划</h3><p>逐页核对最终稿中的画面文字与生成要求。</p></div><span className="pill">{copy.imagePlan.length} 页</span></div>
                {copy.imagePlan.length > 0
                  ? <div className={styles.planGrid}>{copy.imagePlan.map((page, index) => <article className={styles.planCard} key={`${index}-${page.kind}`}>
                    <header><span className={styles.planIndex}>{String(index + 1).padStart(2, '0')}</span><div><small>第 {index + 1} 页 · {IMAGE_KIND_LABELS[page.kind] ?? (page.kind || '未设置类型')}</small><h4>{page.headline || '未填写页面标题'}</h4></div></header>
                    <div className={styles.planField}><small>页面副标题</small><p>{page.subtitle || '未填写'}</p></div>
                    <div className={styles.planField}><small>画面要点</small>{page.bullets.length > 0 ? <ul>{page.bullets.map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul> : <p>未填写</p>}</div>
                    <div className={`${styles.planField} ${styles.planPrompt}`}><small>画面生成指令</small><p>{page.prompt || '未填写'}</p></div>
                  </article>)}</div>
                  : <div className={styles.planEmpty}>当前最终稿未记录图片文案规划。</div>}
              </section>
            </div>
            {!detail.blindReview && <section className={styles.source} aria-labelledby="copy-qa-source-title"><h3 id="copy-qa-source-title">管理员来源信息</h3><div className={styles.metadata}><div><small>词包名称</small><strong>{detail.productionBatch.queryPackageName ?? '未归属词包'}</strong></div><div><small>正式任务</small><strong>{detail.taskId ? `#${detail.taskId}` : '未记录'}</strong></div><div><small>任务创建人</small><strong>{detail.createdByUserId ? `@${detail.createdByUserId}` : '未记录'}</strong></div><div><small>任务负责人</small><strong>{detail.assignedToUserId ? `@${detail.assignedToUserId}` : '未分配'}</strong></div><div><small>最终审批账号</small><strong>{detail.finalApproverUsername ? `@${detail.finalApproverUsername}` : detail.finalApproverAccountId ? `账号 #${detail.finalApproverAccountId}` : '未记录'}</strong></div><div><small>质检处理</small><strong>{detail.reviewMethod === 'ADMIN_DIRECT' ? '管理员单独通过' : '质检队列处理'}</strong></div><div><small>生产批次</small><strong>{detail.productionBatchId ? `#${detail.productionBatchId}` : detail.productionBatch.anonymousCode}</strong></div><div><small>文案版本</small><strong>{detail.approvedRevision.id ? `#${detail.approvedRevision.id}` : '未记录'}</strong></div></div></section>}
            {detailError && <div className="notice error" role="alert">{detailError}</div>}
          </>}
        </div>
        {detail && copy && <footer className={`${styles.footer} ${styles.detailFooter}`}><span className="subtle">{detail.sampleKind === 'MANDATORY_RECHECK'
            ? '返工稿已按最终 3 分记录；只有通过强制复检后才会进入待生图队列。'
            : '抽检结论只绑定当前展示的最终修订版。'}</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={Boolean(action)}>关闭</Button></DialogClose>{detail.status === 'PENDING' && detail.capabilities.canReturnSingle && <Button unstyled className="button danger" type="button" disabled={Boolean(action)} onClick={() => beginSingleReturn(detail)}>仅打回此条</Button>}{role === 'ADMIN' && canReleaseCopyQaFreezeRest(detail) && <Button unstyled className="button primary" type="button" disabled={Boolean(action)} onClick={() => beginReleaseRest(detail)}>放行同批其余</Button>}{detail.status === 'RETURNED' && canStartCopyQaBatchReturn(detail) && <Button unstyled className="button danger" type="button" disabled={Boolean(action)} onClick={() => { void beginBatchReturn(detail); }}>升级整批打回</Button>}{detail.status === 'PENDING' && detail.capabilities.canPass && <Button unstyled className="button primary" type="button" disabled={Boolean(action)} onClick={() => { void passItem(detail); }}>{action === 'pass' ? '提交中…' : detail.sampleKind === 'MANDATORY_RECHECK' ? '通过强制复检' : '通过最终稿'}</Button>}</div></footer>}
      </DialogContent>
    </Dialog>

    <Dialog open={returnItem !== null} onOpenChange={(open) => { if (!open && action !== 'return-single') { setReturnItem(null); setReturnCompleted(false); } }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><div><DialogTitle>{returnItem?.sampleKind === 'MANDATORY_RECHECK'
          ? returnCompleted ? '强制复检未通过，已退回修改' : '打回强制复检返工稿'
          : returnCompleted ? '当前错误项已单条打回' : '只打回当前错误项'}</DialogTitle><DialogDescription>{returnItem?.sampleKind === 'MANDATORY_RECHECK'
          ? returnCompleted
            ? '当前返工稿未通过强制复检；实际修改文案或图片规划后，新返工稿会按最终 3 分记录并再次进入强制复检，通过前不会进入待生图队列。'
            : `${returnItem.anonymousCode} 的返工稿将退回修改；强制复检不会放行同批其余或扩大为整批打回，通过复检前不会进入待生图队列。`
          : returnCompleted
            ? '同批其他任务仍在冻结等待。请明确选择放行其余，或以这个已确认的错误项升级整批打回。'
            : `${returnItem?.anonymousCode} 将退回修改；同批次其他任务保持等待。`}</DialogDescription></div><RotateCcw size={20} aria-hidden="true" /></div>
        {!returnCompleted ? <>
          <div className="field"><label>处理建议</label><Select value={returnRecommendation}
            onValueChange={(value: 'REWORK' | 'DISCARD') => { setReturnRecommendation(value); setReturnError(''); }}>
            <SelectTrigger aria-label="质检打回后的处理建议"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="REWORK">要求返工修改</SelectItem>
              <SelectItem value="DISCARD">建议任务负责人废弃</SelectItem>
            </SelectContent>
          </Select>{returnRecommendation === 'DISCARD' && <small className="subtle">质检建议不会直接终止任务，当前任务负责人或管理员确认后才会废弃。</small>}</div>
          <CopyQaReasonPicker selected={returnReasons} onChange={(reasons) => { setReturnReasons(reasons); setReturnError(''); }} disabled={action === 'return-single'} />
          <div className="field"><label htmlFor="copy-qa-single-note">详细说明{returnRecommendation === 'DISCARD' ? '（建议废弃时必填）' : '（选填）'}</label><Textarea id="copy-qa-single-note" value={returnNote} maxLength={500} rows={4} disabled={action === 'return-single'} placeholder={returnRecommendation === 'DISCARD' ? '说明为什么继续返工不合适，供任务负责人确认' : '可选：补充具体句子、页码或修改要求'} onChange={(event) => { setReturnNote(event.target.value); setReturnError(''); }} /></div>
          {returnError && <div className="notice error" role="alert">{returnError}</div>}
          <div className={styles.footer}><span className="subtle">{returnItem?.sampleKind === 'MANDATORY_RECHECK' ? '本次只处理当前强制复检返工稿。' : '默认最小影响范围：当前单条任务。'}</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={action === 'return-single'}>取消</Button></DialogClose><Button unstyled className="button danger" type="button" disabled={action === 'return-single'} onClick={() => { void submitSingleReturn(); }}>{action === 'return-single' ? '打回中…' : `${returnItem?.sampleKind === 'MANDATORY_RECHECK' ? '确认打回返工稿' : '确认仅打回此条'}${returnReasons.length ? `（${returnReasons.length}项）` : ''}`}</Button></div></div>
        </> : returnItem && <>
          <div className={styles.impact}><strong>{returnItem.sampleKind === 'MANDATORY_RECHECK' ? '强制复检项' : '错误项'}：{returnItem.anonymousCode}</strong><span>{returnItem.sampleKind === 'MANDATORY_RECHECK' ? '返工稿已退回继续修改，当前不会进入待生图队列。' : '单条打回已生效；关闭弹窗也不会自动放行或扩大范围。'}</span></div>
          {returnItem.sampleKind === 'MANDATORY_RECHECK'
            ? <>
              <div className="notice">实际修改文案或图片规划后，新返工稿会按最终 3 分记录并再次进入强制复检；只有复检通过后才会进入待生图队列。</div>
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
        <CopyQaReasonPicker selected={batchReasons} onChange={(reasons) => { setBatchReasons(reasons); setBatchError(''); }} disabled={action === 'return-batch'} />
        <div className="field"><label htmlFor="copy-qa-batch-note">整批打回说明（必填）</label><Textarea id="copy-qa-batch-note" value={batchNote} maxLength={500} rows={5} disabled={action === 'return-batch'} placeholder="说明为何需要扩大到整批，以及统一返工要求" onChange={(event) => { setBatchNote(event.target.value); setBatchError(''); }} /></div>
        <div className="field"><label htmlFor="copy-qa-batch-confirmation">输入预检受影响数量 {previewAffectedCount} 二次确认</label><Input id="copy-qa-batch-confirmation" type="number" min={0} value={batchConfirmation} disabled={action === 'return-batch'} onChange={(event) => { setBatchConfirmation(event.target.value); setBatchError(''); }} /></div>
        {batchError && <div className="notice error" role="alert">{batchError}</div>}
        <div className={styles.footer}><span className="subtle">关闭窗口不会提交任何变更。</span><div><DialogClose asChild><Button unstyled className="button" type="button" disabled={action === 'return-batch'}>取消</Button></DialogClose><Button unstyled className="button danger" type="button" disabled={!batchPreview || batchPreviewLoading || action === 'return-batch' || Number(batchConfirmation) !== previewAffectedCount} onClick={() => { void submitBatchReturn(); }}>{action === 'return-batch' ? '整批打回中…' : `确认整批打回（影响 ${previewAffectedCount} 条）`}</Button></div></div>
      </DialogContent>
    </Dialog>
  </div>;
}
