'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, EyeOff, Images, LoaderCircle, Maximize2, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { ImageCarouselNavigation } from '../components/image-carousel-navigation';
import { ImagePreview } from '../components/image-preview';
import { createRequestId } from '../components/request-id';
import { DEFAULT_SETTINGS, useHumanQualitySettings } from '../workbench/human-quality-settings';
import { orderedImageFileName } from '../../src/image-file-name.mjs';
import styles from '../copy-qa/copy-qa.module.css';
import qaStyles from './image-qa.module.css';

type ImageAsset = { id: number; mediaType: string; sha256: string; originalName: string | null; pageIndex: number; url: string };
type ImageQaItem = {
  id: string;
  freezePublicId: string;
  anonymousCode: string;
  status: string;
  sampleKind: 'RANDOM' | 'MANDATORY_RECHECK';
  blindReview: boolean;
  assets: ImageAsset[];
  capabilities: { canPass: boolean; canReturnSingle: boolean; canReturnBatch: boolean };
  taskId?: number;
  query?: string;
  productionBatch?: { id: number; queryPackageName: string | null };
  submitter?: { accountId: number; username: string };
  createdAt?: string;
};

function normalizeItem(value: unknown): ImageQaItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.anonymousCode !== 'string' || !Array.isArray(row.assets)) return null;
  const capabilities = row.capabilities && typeof row.capabilities === 'object'
    ? row.capabilities as Record<string, unknown> : {};
  return {
    id: row.id,
    freezePublicId: String(row.freezePublicId ?? ''),
    anonymousCode: row.anonymousCode,
    status: String(row.status ?? 'PENDING'),
    sampleKind: row.sampleKind === 'MANDATORY_RECHECK' ? 'MANDATORY_RECHECK' : 'RANDOM',
    blindReview: row.blindReview === true,
    assets: row.assets.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return [];
      const asset = entry as Record<string, unknown>;
      const id = Number(asset.id);
      const pageIndex = Number(asset.pageIndex);
      return Number.isSafeInteger(id) && id > 0 && typeof asset.url === 'string' ? [{
        id, mediaType: String(asset.mediaType ?? 'image/png'), sha256: String(asset.sha256 ?? ''),
        originalName: typeof asset.originalName === 'string' ? asset.originalName : null,
        pageIndex: Number.isSafeInteger(pageIndex) && pageIndex > 0 ? pageIndex : index + 1,
        url: asset.url,
      }] : [];
    }),
    capabilities: {
      canPass: capabilities.canPass === true,
      canReturnSingle: capabilities.canReturnSingle === true,
      canReturnBatch: capabilities.canReturnBatch === true,
    },
    ...(Number.isSafeInteger(Number(row.taskId)) ? { taskId: Number(row.taskId) } : {}),
    ...(typeof row.query === 'string' ? { query: row.query } : {}),
    ...(row.productionBatch && typeof row.productionBatch === 'object'
      ? { productionBatch: row.productionBatch as ImageQaItem['productionBatch'] } : {}),
    ...(row.submitter && typeof row.submitter === 'object'
      ? { submitter: row.submitter as ImageQaItem['submitter'] } : {}),
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
  };
}

const apiPath = (path: string) => `/api/control-plane${path}`;

function displayAssetName(asset: ImageAsset, fallbackIndex: number) {
  return orderedImageFileName(asset.originalName, asset.pageIndex || fallbackIndex + 1, asset.mediaType);
}

export function ImageQaWorkbench({ role }: { role: 'ADMIN' | 'REVIEWER' }) {
  const { settings: loadedSettings, loading: settingsLoading, error: settingsError } = useHumanQualitySettings();
  const settings = loadedSettings ?? DEFAULT_SETTINGS;
  const [items, setItems] = useState<ImageQaItem[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
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
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await apiRequest<unknown>(apiPath(`/v1/image-qa/items?status=${encodeURIComponent(status)}&limit=200&offset=0`));
      const rows = payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown[] }).items)
        ? (payload as { items: unknown[] }).items : [];
      setItems(rows.map(normalizeItem).filter((item): item is ImageQaItem => item !== null));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片质检队列读取失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (detail && selectedAssetIndex >= detail.assets.length) setSelectedAssetIndex(0);
  }, [detail, selectedAssetIndex]);

  const pendingCount = useMemo(() => items.filter((item) => item.status === 'PENDING').length, [items]);

  function openDetail(item: ImageQaItem) {
    setDetail(item);
    setReturning(false);
    setSelectedAssetIndex(0);
    setPreviewAssetIndex(null);
  }

  function openReturn(item: ImageQaItem, initialProblemAssetId?: number) {
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

  async function pass(item: ImageQaItem) {
    setAction(item.id);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/image-qa/items/${encodeURIComponent(item.id)}/pass`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: createRequestId(), score: 3, note: '' }),
      });
      setMessage(`${item.anonymousCode} 已通过；本冻结批次全部通过后才会整体进入交付池。`);
      if (detail?.id === item.id) setDetail(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片质检通过失败');
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
      setMessage(`${detail.anonymousCode} 已打回；作业员采用新图片后将自动进入 100% 强制复检。`);
      setReturning(false);
      setDetail(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片质检打回失败');
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
      setMessage(`图片抽检批次已整批打回 ${preview.confirmedCount} 条；每条新版本都会进入强制复检。`);
      setReturning(false);
      setDetail(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片整批打回失败');
    } finally {
      setAction('');
    }
  }

  const selectedAsset = detail?.assets[selectedAssetIndex] ?? null;
  const previewAsset = detail && previewAssetIndex !== null ? detail.assets[previewAssetIndex] : null;

  return <div className={styles.stack}>
    <section className={styles.summary} aria-label="图片质检概况">
      <article className={qaStyles.primaryMetric}><strong>{pendingCount}</strong><span>当前结果待处理</span><small className={qaStyles.metricHint}>优先逐套检查完整成品图</small></article>
      <article><strong>{items.filter((item) => item.sampleKind === 'MANDATORY_RECHECK').length}</strong><span>返修强制复检</span><small className={qaStyles.metricHint}>必须逐页确认修复结果</small></article>
      <article><strong>{items.filter((item) => item.blindReview).length}</strong><span>盲评样本</span><small className={qaStyles.metricHint}>隐藏任务与提交人信息</small></article>
      <article><strong>{role === 'ADMIN' ? '全部' : '已分配'}</strong><span>当前可见范围</span><small className={qaStyles.metricHint}>{role === 'ADMIN' ? '管理员可处理所有样本' : '仅展示分配给我的样本'}</small></article>
    </section>
    <section className="panel">
      <div className={styles.toolbar}>
        <div>
          <label>处理状态<Select value={status} onValueChange={setStatus}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="PENDING">待质检</SelectItem><SelectItem value="PASSED">已通过</SelectItem>
            <SelectItem value="RETURNED">已打回</SelectItem><SelectItem value="ALL">全部</SelectItem>
          </SelectContent></Select></label>
        </div>
        <Button unstyled className="button" type="button" disabled={loading} onClick={() => { void load(); }}><RefreshCw size={15} />刷新</Button>
      </div>
      {role === 'REVIEWER' && <p className={`notice ${styles.blindNotice}`}><EyeOff size={16} />质检员不能处理自己提交的图片；管理员不受自检限制。盲评开启时只显示匿名样本和成品图。</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}
      {loading ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在读取图片质检池…</div>
        : items.length === 0 ? <div className="empty-state">当前筛选下没有图片质检项。</div>
          : <div className={`table-wrap mobile-cards ${styles.queue} ${qaStyles.queue}`}><table><thead><tr><th>质检内容</th><th>类型</th><th>成品页</th><th>来源</th><th>操作</th></tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td data-label="质检内容"><div className={qaStyles.sample}><span>{item.anonymousCode}</span><strong>{item.blindReview ? '匿名成品图集' : item.query || `任务 #${item.taskId}`}</strong></div></td>
              <td data-label="类型"><span className="pill">{item.sampleKind === 'MANDATORY_RECHECK' ? '强制复检' : '随机抽检'}</span></td>
              <td data-label="成品页"><span className={qaStyles.imageCount}><Images size={15} aria-hidden="true" /><strong>{item.assets.length}</strong> 页</span></td>
              <td data-label="来源"><span className={qaStyles.source}>{item.blindReview ? '匿名' : item.productionBatch?.queryPackageName || '独立任务'}</span></td>
              <td data-label="操作"><div className={styles.actions}>
                <Button unstyled className="button small" type="button" onClick={() => openDetail(item)}>查看图片</Button>
                {item.capabilities.canReturnSingle && <Button unstyled className="button small" type="button" disabled={Boolean(action)} onClick={() => openReturn(item)}><RotateCcw size={14} />打回</Button>}
                {item.capabilities.canPass && <Button unstyled className="button small primary" type="button" disabled={Boolean(action)} onClick={() => { void pass(item); }}><CheckCircle2 size={14} />通过</Button>}
              </div></td>
            </tr>)}</tbody></table></div>}
    </section>

    {detail && <section className={`panel ${qaStyles.detail}`} aria-label="图片质检详情">
      <header className={qaStyles.detailHeader}>
        <div><div className={qaStyles.detailBadges}><span className="pill">{detail.sampleKind === 'MANDATORY_RECHECK' ? '返修强制复检' : '随机图片抽检'}</span><span className="pill">{detail.assets.length} 个成品页</span></div><h2>{detail.anonymousCode}</h2><p>按页码顺序检查当前最终交付图；源图、历史图和已被替换的旧图不会计入。</p></div>
        <Button unstyled className="button" type="button" onClick={() => { setDetail(null); setReturning(false); setPreviewAssetIndex(null); }}>关闭详情</Button>
      </header>

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
          {!detail.blindReview && <div><span>来源词包</span><strong>{detail.productionBatch?.queryPackageName || '独立任务'}</strong></div>}
          {!detail.blindReview && detail.query && <div className={qaStyles.query}><span>原始 Query</span><p>{detail.query}</p></div>}
          <p className={qaStyles.reviewHint}>通过代表整套当前版本可以交付；发现问题时请选中具体问题页并填写可执行的修改要求。</p>
          {!returning && detail.status === 'PENDING' && <div className={qaStyles.detailActions}>
            {detail.capabilities.canReturnSingle && <Button unstyled className="button" onClick={() => openReturn(detail, selectedAsset?.id)}><RotateCcw size={15} />发起返工</Button>}
            {detail.capabilities.canPass && <Button unstyled className="button primary" onClick={() => { void pass(detail); }}><CheckCircle2 size={15} />质检通过</Button>}
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
      {previewAsset && previewAssetIndex !== null && <ImagePreview hideTrigger isOpen restoreFocusRef={previewTriggerRef}
        src={apiPath(previewAsset.url)} alt={`第 ${previewAsset.pageIndex} 页：${displayAssetName(previewAsset, previewAssetIndex)}`}
        position={previewAssetIndex + 1} total={detail.assets.length}
        preloads={detail.assets.slice(Math.max(0, previewAssetIndex - 1), previewAssetIndex + 2).filter((asset) => asset.id !== previewAsset.id).map((asset) => apiPath(asset.url))}
        onClose={() => setPreviewAssetIndex(null)}
        onPrevious={previewAssetIndex > 0 ? () => setPreviewAssetIndex((index) => index === null ? null : index - 1) : undefined}
        onNext={previewAssetIndex < detail.assets.length - 1 ? () => setPreviewAssetIndex((index) => index === null ? null : index + 1) : undefined} />}
    </section>}
  </div>;
}
