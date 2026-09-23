'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, EyeOff, ImageOff, Images, ListChecks, LoaderCircle, Maximize2, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { apiRequest } from '../components/api-client';
import { ImageDiscardButton } from '../components/image-discard-button';
import { ImageCarouselNavigation } from '../components/image-carousel-navigation';
import { ImagePreview } from '../components/image-preview';
import { createRequestId } from '../components/request-id';
import { DEFAULT_SETTINGS, useHumanQualitySettings } from '../workbench/human-quality-settings';
import { orderedImageFileName } from '../../src/image-file-name.mjs';
import styles from '../copy-qa/copy-qa.module.css';
import qaStyles from './image-qa.module.css';
import { normalizeImageQaItem, type ImageQaAsset, type ImageQaItem } from './types';

const apiPath = (path: string) => `/api/control-plane${path}`;
const IMAGE_QA_LOAD_TOAST_ID = 'image-qa-load';
const IMAGE_QA_ACTION_TOAST_ID = 'image-qa-action';

type ImageQaStatus = 'PENDING' | 'PASSED' | 'RETURNED' | 'DISCARDED' | 'ADMIN_ESCALATED' | 'ALL';

const STATUS_OPTIONS: Array<{
  value: ImageQaStatus;
  label: string;
  emptyTitle: string;
  emptyDescription: string;
}> = [
  {
    value: 'PENDING',
    label: '待质检',
    emptyTitle: '当前没有待质检任务',
    emptyDescription: '新的随机抽检或返修强制复检进入队列后，会显示在这里。',
  },
  {
    value: 'PASSED',
    label: '已通过',
    emptyTitle: '当前没有已通过记录',
    emptyDescription: '质检通过的冻结版本会保留在这里，便于后续核对。',
  },
  {
    value: 'RETURNED',
    label: '已打回',
    emptyTitle: '当前没有已打回记录',
    emptyDescription: '需要返工的图片任务会保留问题页和修改要求。',
  },
  {
    value: 'ALL',
    label: '全部记录',
    emptyTitle: '图片质检池暂无记录',
    emptyDescription: '完成图片初审并命中抽检规则后，质检记录会出现在这里。',
  },
  { value: 'ADMIN_ESCALATED', label: '已提交管理员', emptyTitle: '当前没有提交管理员的记录', emptyDescription: '强制复检后提交管理员的任务保留处置记录。' },
  { value: 'DISCARDED', label: '已废弃', emptyTitle: '当前没有已废弃记录', emptyDescription: '废弃原因和历史图片会保留，便于后续核对。' },
];

const STATUS_LABELS: Record<ImageQaItem['status'], string> = {
  ADMIN_ESCALATED: '已提交管理员',
  PENDING: '待质检',
  PASSED: '已通过',
  RETURNED: '已打回',
  DISCARDED: '已废弃',
};

function displayAssetName(asset: ImageQaAsset, fallbackIndex: number) {
  return orderedImageFileName(asset.originalName, asset.pageIndex || fallbackIndex + 1, asset.mediaType);
}

export function ImageQaWorkbench({ role }: { role: 'ADMIN' | 'REVIEWER' }) {
  const { settings: loadedSettings, loading: settingsLoading, error: settingsError } = useHumanQualitySettings();
  const settings = loadedSettings ?? DEFAULT_SETTINGS;
  const [items, setItems] = useState<ImageQaItem[]>([]);
  const [status, setStatus] = useState<ImageQaStatus>('PENDING');
  const [personSearchInput, setPersonSearchInput] = useState('');
  const [personName, setPersonName] = useState('');
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<ImageQaItem | null>(null);
  const [returning, setReturning] = useState(false);
  const [score, setScore] = useState<'1' | '2'>('2');
  const [target, setTarget] = useState<'COPY' | 'IMAGE' | 'BOTH'>('IMAGE');
  const [reasons, setReasons] = useState<string[]>([]);
  const [problemAssetIds, setProblemAssetIds] = useState<number[]>([]);
  const [copyFields, setCopyFields] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [selectedAssetIndex, setSelectedAssetIndex] = useState(0);
  const [previewAssetIndex, setPreviewAssetIndex] = useState<number | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ status, limit: '200', offset: '0' });
      if (role === 'ADMIN' && personName) params.set('personName', personName);
      const payload = await apiRequest<unknown>(apiPath(`/v1/image-qa/items?${params.toString()}`));
      const rows = payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown[] }).items)
        ? (payload as { items: unknown[] }).items : [];
      if (sequence !== loadSequenceRef.current) return;
      toast.dismiss(IMAGE_QA_LOAD_TOAST_ID);
      setItems(rows.map((item) => normalizeImageQaItem(item, role))
        .filter((item): item is ImageQaItem => item !== null));
    } catch (caught) {
      if (sequence !== loadSequenceRef.current) return;
      toast.error(caught instanceof Error ? caught.message : '图片质检队列读取失败', {
        id: IMAGE_QA_LOAD_TOAST_ID,
        duration: Infinity,
      });
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [personName, role, status]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (detail && selectedAssetIndex >= detail.assets.length) setSelectedAssetIndex(0);
  }, [detail, selectedAssetIndex]);

  const mandatoryCount = useMemo(() => items.filter((item) => item.sampleKind === 'MANDATORY_RECHECK').length, [items]);
  const pageCount = useMemo(() => items.reduce((total, item) => total + item.assets.length, 0), [items]);
  const activeStatus = STATUS_OPTIONS.find((option) => option.value === status) ?? STATUS_OPTIONS[0];

  function openDetail(item: ImageQaItem, trigger?: HTMLButtonElement) {
    if (trigger) detailTriggerRef.current = trigger;
    setDetail(item);
    setReturning(false);
    setSelectedAssetIndex(0);
    setPreviewAssetIndex(null);
    setError('');
  }

  function openReturn(item: ImageQaItem, initialProblemAssetId?: number, trigger?: HTMLButtonElement) {
    if (trigger) detailTriggerRef.current = trigger;
    setDetail(item);
    const initialIndex = initialProblemAssetId === undefined
      ? 0
      : item.assets.findIndex((asset) => asset.id === initialProblemAssetId);
    setSelectedAssetIndex(Math.max(0, initialIndex));
    setPreviewAssetIndex(null);
    setReturning(true);
    setScore('2');
    setTarget('IMAGE');
    setReasons([]);
    setProblemAssetIds(initialProblemAssetId === undefined ? [] : [initialProblemAssetId]);
    setCopyFields([]);
    setNote('');
    setError('');
  }

  function closeDetail() {
    setDetail(null);
    setReturning(false);
    setPreviewAssetIndex(null);
    setError('');
  }

  async function pass(item: ImageQaItem) {
    setAction(item.id);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/image-qa/items/${encodeURIComponent(item.id)}/pass`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: createRequestId(), score: 3, note: '' }),
      });
      toast.success(`${item.anonymousCode} 已通过；本冻结批次全部通过后才会整体进入交付池。`, {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
      if (detail?.id === item.id) setDetail(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '图片质检通过失败', {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
    } finally {
      setAction('');
    }
  }

  async function submitReturn() {
    if (!detail) return;
    const reasonsRequired = settings.imageReviewDisplay.showDeductionReasons && settings.imageReasons.length > 0;
    if (reasonsRequired && reasons.length === 0) {
      setError('发起图片返工时至少选择一项返工原因。');
      return;
    }
    if (!note.trim()) {
      setError('发起图片返工时必须填写明确的修改要求。');
      return;
    }
    if (['IMAGE', 'BOTH'].includes(target) && problemAssetIds.length === 0) {
      setError('图片返工必须至少选择一张问题图片。');
      return;
    }
    if (['COPY', 'BOTH'].includes(target) && copyFields.length === 0) {
      setError('文案返工必须至少选择一个文案字段。');
      return;
    }
    setAction(detail.id);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/image-qa/items/${encodeURIComponent(detail.id)}/return`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: createRequestId(), score: Number(score), reworkTarget: target,
          reasonCodes: reasons, note: note.trim(), problemAssetIds, copyFields,
        }),
      });
      toast.success(`${detail.anonymousCode} 已打回；标注采用新图片后将自动进入 100% 强制复检。`, {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
      setReturning(false);
      setDetail(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '图片质检打回失败', {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
    } finally {
      setAction('');
    }
  }

  async function submitBatchReturn() {
    if (!detail || !detail.capabilities.canReturnBatch) return;
    const reasonsRequired = settings.imageReviewDisplay.showDeductionReasons && settings.imageReasons.length > 0;
    if (reasonsRequired && reasons.length === 0) {
      setError('整批打回图片时至少选择一项返工原因。');
      return;
    }
    if (!note.trim()) {
      setError('整批打回图片时必须填写适用于本批任务的明确修改要求。');
      return;
    }
    setAction(detail.id);
    setError('');
    try {
      const preview = await apiRequest<{ freezePublicId: string; confirmedCount: number; itemIds: string[] }>(
        apiPath(`/v1/image-qa/freezes/${encodeURIComponent(detail.freezePublicId)}/batch-return-preview`),
      );
      if (!window.confirm(`确认整批打回 ${preview.confirmedCount} 条图片任务？每条返修后都必须重新初审并接受 100% 强制复检。`)) return;
      await apiRequest(apiPath('/v1/image-qa/batch-return'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: createRequestId(), freezePublicId: preview.freezePublicId,
          confirmedCount: preview.confirmedCount, itemIds: preview.itemIds,
          reasonCodes: reasons, note: note.trim(),
        }),
      });
      toast.success(`图片抽检批次已整批打回 ${preview.confirmedCount} 条；每条新版本都会进入强制复检。`, {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
      setReturning(false);
      setDetail(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '图片整批打回失败', {
        id: IMAGE_QA_ACTION_TOAST_ID,
      });
    } finally {
      setAction('');
    }
  }

  const selectedAsset = detail?.assets[selectedAssetIndex] ?? null;
  const previewAsset = detail && previewAssetIndex !== null ? detail.assets[previewAssetIndex] : null;

  return <div className={`${styles.stack} ${qaStyles.workbench}`}>
    <section className={qaStyles.overview} aria-label="图片质检概况">
      <article className={qaStyles.primaryMetric}>
        <span className={qaStyles.metricIcon}><ListChecks size={18} aria-hidden="true" /></span>
        <div><strong>{items.length}</strong><span>当前筛选结果</span><small>{activeStatus.label}范围内的质检记录</small></div>
      </article>
      <article>
        <span className={qaStyles.metricIcon}><RotateCcw size={18} aria-hidden="true" /></span>
        <div><strong>{mandatoryCount}</strong><span>返修强制复检</span><small>必须逐页确认修复结果</small></div>
      </article>
      <article>
        <span className={qaStyles.metricIcon}><Images size={18} aria-hidden="true" /></span>
        <div><strong>{pageCount}</strong><span>最终成品页</span><small>仅统计当前冻结版本</small></div>
      </article>
      <article>
        <span className={qaStyles.metricIcon}><ShieldCheck size={18} aria-hidden="true" /></span>
        <div><strong>{role === 'ADMIN' ? '全部' : '我的'}</strong><span>可见任务范围</span><small>{role === 'ADMIN' ? '管理员保留完整来源信息' : '仅显示分配给我的样本'}</small></div>
      </article>
    </section>
    <section className={`panel ${qaStyles.queuePanel}`} aria-labelledby="image-qa-queue-title">
      <header className={qaStyles.queueHeader}>
        <div>
          <span className={qaStyles.eyebrow}>REVIEW QUEUE</span>
          <h2 id="image-qa-queue-title">质检队列</h2>
          <p>先逐页检查完整成品图，再通过或填写可执行的返工要求。</p>
        </div>
        <div className={qaStyles.queueHeaderActions}>
          <span className={qaStyles.resultCount} aria-live="polite">{loading ? '正在更新' : `${items.length} 条结果`}</span>
          <Button unstyled className="button" type="button" disabled={loading} onClick={() => { void load(); }}><RefreshCw className={loading ? 'animate-spin' : ''} size={15} />刷新队列</Button>
        </div>
      </header>
      <div className={qaStyles.filterBar}>
        <nav className={qaStyles.statusTabs} role="tablist" aria-label="图片质检处理状态">
          {STATUS_OPTIONS.map((option) => <Button unstyled id={`image-qa-${option.value.toLowerCase()}-tab`} key={option.value}
            type="button" role="tab" aria-selected={status === option.value} aria-controls="image-qa-results"
            data-active={status === option.value} onClick={() => setStatus(option.value)}>{option.label}</Button>)}
        </nav>
        <div className={qaStyles.filterActions}>
          {role === 'ADMIN' && <form className={qaStyles.personSearch} onSubmit={(event) => {
            event.preventDefault();
            setPersonName(personSearchInput.replace(/\s+/gu, ' ').trim());
          }}>
            <SearchInput aria-label="按人员姓名筛选全部图片质检项" maxLength={80} value={personSearchInput} onValueChange={setPersonSearchInput} placeholder="按图片提交人姓名或账号筛选" />
            <Button unstyled className="button small" type="submit">应用人员</Button>
            {personName && <Button unstyled className="button small" type="button" onClick={() => {
              setPersonSearchInput('');
              setPersonName('');
            }}>清除人员</Button>}
          </form>}
          <span className={qaStyles.scopeBadge}><ShieldCheck size={14} aria-hidden="true" />{role === 'ADMIN' ? '管理员完整视图' : '质检盲评视图'}</span>
        </div>
      </div>
      {role === 'REVIEWER' && <p className={`notice ${styles.blindNotice}`}><EyeOff size={16} />质检员不能处理自己提交的图片；管理员不受自检限制。盲评开启时只显示匿名样本和成品图。</p>}
      <div id="image-qa-results" role="tabpanel" aria-labelledby={`image-qa-${status.toLowerCase()}-tab`} className={qaStyles.queueContent}>
        {loading ? <div className={qaStyles.loadingState}><LoaderCircle className="animate-spin" size={22} /><strong>正在读取图片质检池</strong><span>正在同步最新冻结版本与质检状态…</span></div>
        : items.length === 0 ? <div className={qaStyles.emptyState}>
            <span className={qaStyles.emptyIcon}><ImageOff size={25} aria-hidden="true" /></span>
            <span className={qaStyles.eyebrow}>QUEUE CLEAR</span>
            <h3>{activeStatus.emptyTitle}</h3>
            <p>{activeStatus.emptyDescription}</p>
            <div className={qaStyles.emptyActions}>
              <Button unstyled className="button primary" type="button" onClick={() => { void load(); }}><RefreshCw size={15} />重新检查</Button>
              {status !== 'PENDING' && <Button unstyled className="button" type="button" onClick={() => setStatus('PENDING')}>查看待质检</Button>}
            </div>
            <small>标注的图片初审不会进入此队列。</small>
          </div>
          : <div className={`table-wrap mobile-cards ${qaStyles.queue}`} role="region" aria-label="图片质检队列，可横向滚动" tabIndex={0}><table><thead><tr><th>质检内容</th><th>类型</th><th>状态</th><th>成品页</th><th>来源</th><th>操作</th></tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td data-label="质检内容"><div className={qaStyles.sample}><span>{item.anonymousCode}</span><strong>{item.blindReview ? '匿名成品图集' : `${item.taskId ? `任务 #${item.taskId}` : '任务号未记录'}${item.query ? ` · ${item.query}` : ''}`}</strong></div></td>
              <td data-label="类型"><span className="pill">{item.sampleKind === 'MANDATORY_RECHECK' ? '强制复检' : '随机抽检'}</span></td>
              <td data-label="状态"><span className={qaStyles.statusBadge} data-status={item.status}>{STATUS_LABELS[item.status] ?? '未知状态'}</span></td>
              <td data-label="成品页"><span className={qaStyles.imageCount}><Images size={15} aria-hidden="true" /><strong>{item.assets.length}</strong> 页</span></td>
              <td data-label="来源"><span className={qaStyles.source}>{item.blindReview ? '匿名' : <>{item.productionBatch?.queryPackageName || '独立任务'}{item.submitter?.username ? <small>提交 @{item.submitter.username}</small> : null}</>}</span></td>
              <td data-label="操作"><div className={styles.actions}>
                <Button unstyled className="button small" type="button" onClick={(event) => openDetail(item, event.currentTarget)}>查看图片</Button>
                {item.capabilities.canReturnSingle && <Button unstyled className="button small" type="button" disabled={Boolean(action)} onClick={(event) => openReturn(item, undefined, event.currentTarget)}><RotateCcw size={14} />打回</Button>}
                {item.capabilities.canDiscard && <ImageDiscardButton target={{ samplingItemId: item.id }} disabled={Boolean(action)}
                  onBusyChange={busy => setAction(busy ? item.id : '')} onCompleted={load} />}
                {item.capabilities.canPass && <Button unstyled className="button small primary" type="button" disabled={Boolean(action)} onClick={() => { void pass(item); }}><CheckCircle2 size={14} />通过</Button>}
              </div></td>
            </tr>)}</tbody></table></div>}
      </div>
    </section>

    <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) closeDetail(); }}>
      {detail && <DialogContent className={qaStyles.detailDialog} onCloseAutoFocus={(event) => {
        event.preventDefault();
        detailTriggerRef.current?.focus();
      }}>
        <header className={qaStyles.detailHeader}>
          <div><div className={qaStyles.detailBadges}><span className="pill">{detail.sampleKind === 'MANDATORY_RECHECK' ? '返修强制复检' : '随机图片抽检'}</span><span className="pill">{detail.assets.length} 个成品页</span></div><DialogTitle>{detail.anonymousCode}</DialogTitle><DialogDescription>按页码顺序检查当前最终交付图；源图、历史图和已被替换的旧图不会计入。</DialogDescription></div>
        </header>

        <div className={qaStyles.detailBody}>
          {error && <div className={`notice error ${qaStyles.detailError}`} role="alert">{error}</div>}
          <div className={qaStyles.reviewLayout}>
        <div className={qaStyles.viewer}>
          {selectedAsset ? <>
            <ImageCarouselNavigation currentIndex={selectedAssetIndex} total={detail.assets.length}
              onPrevious={() => setSelectedAssetIndex((index) => Math.max(0, index - 1))}
              onNext={() => setSelectedAssetIndex((index) => Math.min(detail.assets.length - 1, index + 1))}>
              <Button unstyled className={qaStyles.stage} type="button"
                aria-label={`放大查看第 ${selectedAsset.pageIndex} 页：${displayAssetName(selectedAsset, selectedAssetIndex)}`}
                onClick={(event) => { previewTriggerRef.current = event.currentTarget; setPreviewAssetIndex(selectedAssetIndex); }}>
                <img src={apiPath(selectedAsset.url)} alt={`第 ${selectedAsset.pageIndex} 页质检图片`} decoding="async" />
                <span><Maximize2 size={14} aria-hidden="true" />点击放大检查</span>
              </Button>
            </ImageCarouselNavigation>
            <div className={qaStyles.currentImage}><strong>第 {String(selectedAsset.pageIndex).padStart(2, '0')} / {String(detail.assets.length).padStart(2, '0')} 页</strong><span>{displayAssetName(selectedAsset, selectedAssetIndex)}</span></div>
            <nav className={qaStyles.thumbnails} aria-label="选择质检图片">
              {detail.assets.map((asset, index) => <Button unstyled className={qaStyles.thumbnail} type="button" key={`${asset.pageIndex}-${asset.id}`}
                data-selected={selectedAssetIndex === index} aria-pressed={selectedAssetIndex === index}
                aria-label={`选择第 ${asset.pageIndex} 页：${displayAssetName(asset, index)}`} onClick={() => setSelectedAssetIndex(index)}>
                <img src={apiPath(asset.url)} alt="" loading={index === 0 ? 'eager' : 'lazy'} decoding="async" />
                <span><strong>{String(asset.pageIndex).padStart(2, '0')}</strong><small>{displayAssetName(asset, index)}</small></span>
              </Button>)}
            </nav>
          </> : <div className="empty-state">当前图集没有可质检的最终交付图片。</div>}
        </div>

        <aside className={qaStyles.inspector} aria-label="质检关键信息">
          <div><span>检查对象</span><strong>{detail.assets.length} 个最终成品页</strong></div>
          <div><span>质检类型</span><strong>{detail.sampleKind === 'MANDATORY_RECHECK' ? '返修后强制复检' : '普通图片抽检'}</strong></div>
          {!detail.blindReview && <div><span>正式任务</span><strong>{detail.taskId ? `#${detail.taskId}` : '未记录'}</strong></div>}
          {!detail.blindReview && <div><span>来源词包</span><strong>{detail.productionBatch?.queryPackageName || '独立任务'}</strong></div>}
          {!detail.blindReview && <div><span>图片提交人</span><strong>{detail.submitter?.username ? `@${detail.submitter.username}` : detail.submitter?.accountId ? `账号 #${detail.submitter.accountId}` : '未记录'}</strong></div>}
          {!detail.blindReview && <div><span>生产批次</span><strong>{detail.productionBatch?.id ? `#${detail.productionBatch.id}` : '未记录'}</strong></div>}
          {!detail.blindReview && <div><span>版本绑定</span><strong>{detail.copyRevisionId ? `文案 #${detail.copyRevisionId}` : '文案未记录'} · {detail.imageRunId ? `图片 ${detail.imageRunId}` : '图片未记录'}</strong></div>}
          {!detail.blindReview && detail.query && <div className={qaStyles.query}><span>原始 Query</span><p>{detail.query}</p></div>}
          {detail.blockers.pendingImageEdits > 0 && <p className="notice warning" role="status">该任务在提交初审前遗留了 {detail.blockers.pendingImageEdits} 个待处理的图片修改，当前版本不能质检通过。请打回图片，让任务负责人采用、拒绝或取消修改后重新提交初审。</p>}
          <p className={qaStyles.reviewHint}>通过代表整套当前版本可以交付；发现问题时请选中具体问题页并填写可执行的修改要求。</p>
          {detail.discardReason && <p className="notice warning">废弃原因：{detail.discardReason}</p>}
          {!returning && detail.status === 'PENDING' && <div className={qaStyles.detailActions}>
            {detail.capabilities.canReturnSingle && <Button unstyled className="button" disabled={Boolean(action)} onClick={() => openReturn(detail, selectedAsset?.id)}><RotateCcw size={15} />发起返工</Button>}
            {detail.capabilities.canDiscard && <ImageDiscardButton target={{ samplingItemId: detail.id }} disabled={Boolean(action)}
              onBusyChange={busy => setAction(busy ? detail.id : '')} onCompleted={async () => { closeDetail(); await load(); }} />}
            {detail.capabilities.canPass && <Button unstyled className="button primary" disabled={Boolean(action)} onClick={() => { void pass(detail); }}><CheckCircle2 size={15} />质检通过</Button>}
          </div>}
        </aside>
          </div>

          {returning && <div className={qaStyles.returnPanel}>
        <div><h3>填写返工要求</h3><p>明确选择问题页和修改范围，修复后的新版本将再次进入强制复检。</p></div>
        <div className="form-grid">
          <label className="field">返工评分<Select value={score} onValueChange={(value: '1' | '2') => setScore(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1">1 分</SelectItem><SelectItem value="2">2 分</SelectItem></SelectContent></Select></label>
          <label className="field">返工范围<Select value={target} onValueChange={(value: 'COPY' | 'IMAGE' | 'BOTH') => setTarget(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="IMAGE">仅图片</SelectItem><SelectItem value="COPY">仅文案</SelectItem><SelectItem value="BOTH">文案和图片</SelectItem></SelectContent></Select></label>
        </div>
        {settings.imageReviewDisplay.showDeductionReasons && <fieldset><legend>返工原因 {settings.imageReasons.length > 0 ? '（至少一项）' : '（管理员尚未配置选项，不强制）'}</legend><div className={styles.reasonGrid}>
          {settings.imageReasons.map((reason) => <label key={reason.code}><Checkbox checked={reasons.includes(reason.code)} onChange={() => setReasons((current) => current.includes(reason.code) ? current.filter((code) => code !== reason.code) : [...current, reason.code])} />{reason.label}</label>)}
        </div></fieldset>}
        {['IMAGE', 'BOTH'].includes(target) && <fieldset><legend>问题图片（至少一张）</legend><div className={styles.reasonGrid}>{detail.assets.map((asset, index) => <label key={asset.id}><Checkbox checked={problemAssetIds.includes(asset.id)} onChange={() => setProblemAssetIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id])} />第 {String(asset.pageIndex).padStart(2, '0')} 页 · {displayAssetName(asset, index)}</label>)}</div></fieldset>}
        {['COPY', 'BOTH'].includes(target) && <fieldset><legend>文案返工字段（至少一项）</legend><div className={styles.reasonGrid}>{[['TITLE','标题'],['BODY','正文'],['TAGS','标签'],['IMAGE_PLAN','图片规划']].map(([code,label]) => <label key={code}><Checkbox checked={copyFields.includes(code)} onChange={() => setCopyFields((current) => current.includes(code) ? current.filter((field) => field !== code) : [...current, code])} />{label}</label>)}</div></fieldset>}
        <label className="field">具体修改要求（必填）<Textarea value={note} maxLength={1000} placeholder={settings.noteGuidance.imagePlaceholder} onChange={(event) => setNote(event.target.value)} /></label>
        {settingsLoading && <p className="subtle">正在读取管理员配置的返工原因…</p>}
        {settingsError && <p className="notice error">返工原因配置读取失败，暂不能安全打回。</p>}
        <div className={styles.actions}><Button unstyled className="button" onClick={() => setReturning(false)}>取消</Button>
          {detail.capabilities.canReturnBatch && target === 'IMAGE' && <Button unstyled className="button" disabled={Boolean(action) || settingsLoading || Boolean(settingsError)} onClick={() => { void submitBatchReturn(); }}>整批打回</Button>}
          <Button unstyled className="button danger" disabled={Boolean(action) || settingsLoading || Boolean(settingsError)} onClick={() => { void submitReturn(); }}>{action ? '提交中…' : '确认单条打回'}</Button></div>
          </div>}
        </div>
        {previewAsset && previewAssetIndex !== null && <ImagePreview hideTrigger isOpen initialMode="fit" restoreFocusRef={previewTriggerRef}
          src={apiPath(previewAsset.url)} alt={`第 ${previewAsset.pageIndex} 页：${displayAssetName(previewAsset, previewAssetIndex)}`}
          position={previewAssetIndex + 1} total={detail.assets.length}
          preloads={detail.assets.slice(Math.max(0, previewAssetIndex - 1), previewAssetIndex + 2).filter((asset) => asset.id !== previewAsset.id).map((asset) => apiPath(asset.url))}
          onClose={() => setPreviewAssetIndex(null)}
          onPrevious={previewAssetIndex > 0 ? () => setPreviewAssetIndex((index) => index === null ? null : index - 1) : undefined}
          onNext={previewAssetIndex < detail.assets.length - 1 ? () => setPreviewAssetIndex((index) => index === null ? null : index + 1) : undefined} />}
      </DialogContent>}
    </Dialog>
  </div>;
}
