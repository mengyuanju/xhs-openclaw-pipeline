'use client';

import { ArrowRight, ChevronLeft, ChevronRight, EyeOff, LoaderCircle, Maximize2, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiRequest } from '../components/api-client';
import { ImageCarouselNavigation } from '../components/image-carousel-navigation';
import { ImagePreview } from '../components/image-preview';
import { ImagePreviewBackgroundControl, type PreviewBackdrop } from '../components/image-preview-background-control';
import { createRequestId } from '../components/request-id';
import { copyRevisionView, type CopyQaItem } from '../copy-qa/types';
import type { ImageQaItem } from '../image-qa/types';
import { useHumanQualitySettings } from '../workbench/human-quality-settings';
import { WORK_LABELS, type WorkItem } from './types';
import styles from './work-mode.module.css';

const COPY_REASONS = [ ['FACT_ERROR', '事实或数据错误'], ['QUERY_MISMATCH', '偏离 Query'], ['STRUCTURE_ERROR', '结构不完整'], ['EXPRESSION_ERROR', '表达或合规问题'] ];
const apiPath = (path: string) => `/api/control-plane${path}`;

function QualityCopyPlan({ pages }: { pages: ReturnType<typeof copyRevisionView>['imagePlan'] }) {
  const [index, setIndex] = useState(0);
  const page = pages[index];
  return <section className={styles.qualityPlan} aria-label="待检图片文案规划">
    <h3>图片文案规划 <small>{pages.length} 页</small></h3>
    {page ? <>
      <nav className={styles.qualityPlanNav} aria-label="质检规划翻页">
        <Button variant="outline" size="sm" aria-label="上一页规划" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={15} /></Button>
        <span>第 {index + 1} / {pages.length} 页</span>
        <Button variant="outline" size="sm" aria-label="下一页规划" disabled={index === pages.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={15} /></Button>
      </nav>
      <article className={styles.qualityPlanPage}>
        <h4>{page.headline || '未填写页面标题'}</h4>
        {page.subtitle && <p>{page.subtitle}</p>}
        {page.bullets.length > 0 && <ul>{page.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}</ul>}
        {page.prompt && <Disclosure><DisclosureTrigger>画面生成指令</DisclosureTrigger><DisclosureContent><p>{page.prompt}</p></DisclosureContent></Disclosure>}
      </article>
    </> : <p className={styles.qualityHint}>当前版本没有图片文案规划。</p>}
  </section>;
}

export function WorkQualityEditor({ item, navigationGuardRef, onSkip, onCompleted }: {
  item: WorkItem; navigationGuardRef: RefObject<(() => Promise<boolean>) | null>;
  onSkip: () => void; onCompleted: (message: string) => void;
}) {
  const confirm = useConfirmDialog();
  const imageMode = item.kind === 'IMAGE_QA';
  const qa = item.qa!;
  const copyItem = imageMode ? null : qa as CopyQaItem;
  const imageItem = imageMode ? qa as ImageQaItem : null;
  const copy = copyItem ? copyRevisionView(copyItem.approvedRevision.content) : null;
  const { settings, loading: settingsLoading, error: settingsError, refresh } = useHumanQualitySettings();
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [target, setTarget] = useState('IMAGE');
  const [score, setScore] = useState('2');
  const [problemAssets, setProblemAssets] = useState<number[]>([]);
  const [copyFields, setCopyFields] = useState<string[]>([]);
  const [recommendation, setRecommendation] = useState('REWORK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>('white');
  const [mobilePane, setMobilePane] = useState<'content' | 'decision'>('content');
  const contentId = useId(), decisionId = useId();
  const decisionRef = useRef<HTMLElement | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assets = imageItem?.assets ?? [];
  const currentAsset = assets[selectedImage];
  const previewAsset = preview === null ? undefined : assets[preview];
  const pageNumber = (index: number) => assets[index]?.pageIndex ?? index + 1;
  const passBlocked = !qa.capabilities.canPass || Boolean(imageItem && (!assets.length || imageItem.blockers.pendingImageEdits > 0));
  const mutation = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const submitting = useRef(false);

  useEffect(() => { if (returning) decisionRef.current?.scrollTo({ top: 0 }); }, [returning]);

  useEffect(() => {
    navigationGuardRef.current = async () => {
      if (submitting.current) return false;
      if (note || reasons.length || problemAssets.length || copyFields.length) return confirm({ title: '离开当前质检作业？',
        description: '打回原因尚未提交，离开会丢失填写的内容。', confirmLabel: '放弃填写并离开', cancelLabel: '继续填写' });
      return true;
    };
    return () => { navigationGuardRef.current = null; };
  }, [navigationGuardRef, confirm, note, reasons, problemAssets, copyFields]);

  async function submit(returned: boolean) {
    if (submitting.current || (returned ? !qa.capabilities.canReturnSingle : passBlocked)) return;
    if (returned) {
      setMobilePane('decision');
      if (!note.trim() && reasons.length === 0) { setError('请填写具体问题或选择打回原因。'); return; }
      if (imageMode) {
        if (!settings || settingsLoading || settingsError) { setError('评分配置尚未读取成功，请先重试。'); return; }
        if (!note.trim()) { setError('图片返工必须填写明确的修改要求。'); return; }
        if (settings.imageReviewDisplay.showDeductionReasons && settings.imageReasons.length && !reasons.length) { setError('至少选择一项返工原因。'); return; }
        if (target !== 'COPY' && !problemAssets.length) { setError('请选择至少一张问题图片。'); return; }
        if (target !== 'IMAGE' && !copyFields.length) { setError('请选择需要返工的文案字段。'); return; }
      } else if (recommendation === 'DISCARD' && !note.trim()) { setError('建议废弃时请填写明确原因。'); return; }
    }
    const payload = copyItem ? {
      expectedRevisionToken: copyItem.approvedRevision.revisionToken,
      ...(returned ? { reasonCodes: reasons, note: note.trim(), recommendedDisposition: recommendation } : {}),
    } : returned ? { score: Number(score), reworkTarget: target, reasonCodes: reasons, note: note.trim(),
      problemAssetIds: target === 'COPY' ? [] : problemAssets, copyFields: target === 'IMAGE' ? [] : copyFields }
      : { score: 3, note: '' };
    const action = returned ? 'return' : 'pass';
    const fingerprint = JSON.stringify({ id: item.id, action, payload });
    if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, requestId: createRequestId() };
    submitting.current = true; setBusy(true); setError('');
    try {
      await apiRequest(apiPath(`/v1/${imageMode ? 'image' : 'copy'}-qa/items/${encodeURIComponent(item.id)}/${action}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: mutation.current.requestId }),
      });
      onCompleted(`${qa.anonymousCode} ${returned ? '已打回' : '已通过质检'}，已移出当前待办。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '提交失败，请重试；填写内容已保留。'); }
    finally { submitting.current = false; setBusy(false); }
  }

  const reasonOptions = imageMode ? settings?.imageReasons.map(r => [r.code, r.label]) ?? [] : COPY_REASONS;
  const toggle = <T,>(values: T[], value: T) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];

  function beginReturn() { setReturning(true); setMobilePane('decision'); setError(''); }
  function showImage(index: number) { setSelectedImage(index); setMobilePane('content'); }

  return <section className={styles.quality} data-quality-kind={imageMode ? 'image' : 'copy'} data-returning={returning} aria-label="当前质检内容">
    <header><div className={styles.qualityIdentity}><h2>{item.rework ? '返工强制复检' : WORK_LABELS[item.kind]}</h2><span>{qa.anonymousCode}</span>
      {qa.blindReview && <span className={styles.blind}><EyeOff size={14} />盲评模式</span>}</div>
      {imageItem && <div className={styles.qualityToolbar} role="group" aria-label="图片质检快捷操作">
        {currentAsset && <span>当前第 {pageNumber(selectedImage)} 页 · 共 {assets.length} 页</span>}
        <ImagePreviewBackgroundControl value={backdrop} onChange={setBackdrop} />
        {currentAsset && qa.capabilities.canReturnSingle && <Button variant="outline" size="sm" disabled={busy}
          aria-pressed={problemAssets.includes(currentAsset.id)} onClick={() => {
            const marked = problemAssets.includes(currentAsset.id);
            setProblemAssets(toggle(problemAssets, currentAsset.id));
            if (!marked) { if (target === 'COPY') setTarget('IMAGE'); beginReturn(); }
          }}>{problemAssets.includes(currentAsset.id) ? '取消当前页问题标记' : '标记当前页有问题'}</Button>}
      </div>}
      {!imageMode && <p className={styles.qualityHelp}>核对文案与逐页规划，发现问题后点击底部“打回”。</p>}
      {imageItem && !qa.blindReview && qa.query && <Disclosure className={styles.qualityQuery}>
        <DisclosureTrigger><strong>原始 Query</strong><span>{qa.query}</span></DisclosureTrigger>
        <DisclosureContent><p>{qa.query}</p></DisclosureContent>
      </Disclosure>}
      {imageItem && imageItem.blockers.pendingImageEdits > 0 && <p className={`notice warning ${styles.qualityHeaderNotice}`} role="status">图片仍有未完成的编辑，处理完成后才能通过质检。</p>}
    </header>
    <nav className={styles.qualityPaneSwitch} aria-label="切换质检内容">
      <Button unstyled aria-controls={contentId} aria-pressed={mobilePane === 'content'} onClick={() => setMobilePane('content')}>{imageMode ? '查看图片' : '查看文案'}</Button>
      <Button unstyled aria-controls={decisionId} aria-pressed={mobilePane === 'decision'} onClick={() => setMobilePane('decision')}>{imageMode ? '质检操作' : '规划与质检'}</Button>
    </nav>
    <div className={styles.qualityBody} data-mobile-pane={mobilePane}>
      <section id={contentId} className={styles.qualityContent} aria-label={imageMode ? '图片核对' : '文案核对'}>
        {copy && <article className={styles.qualityCopy}>
          {!qa.blindReview && qa.query && <div className={styles.source}><small>原始 Query</small><p>{qa.query}</p></div>}
          <span className={styles.qualityEyebrow}>待检文案</span><h3>{copy.title}</h3>
          <div className={styles.copyBody}>{copy.body}</div>
          {copy.tags.length > 0 && <p className={styles.tags}>{copy.tags.map(tag => `#${tag.replace(/^#/u, '')}`).join(' ')}</p>}
        </article>}
        {imageItem && <div className={styles.qualityGallery}>
          {currentAsset ? <>
            <ImageCarouselNavigation currentIndex={selectedImage} total={assets.length}
              onPrevious={() => showImage(Math.max(0, selectedImage - 1))} onNext={() => showImage(Math.min(assets.length - 1, selectedImage + 1))}>
              <Button unstyled className={`${styles.qualityImageStage} preview-background-${backdrop}`} aria-label={`放大查看第 ${pageNumber(selectedImage)} 页`}
                onClick={event => { previewTriggerRef.current = event.currentTarget; setPreview(selectedImage); }}>
                <img src={apiPath(currentAsset.url)} alt={`待检图片第 ${pageNumber(selectedImage)} 页`} decoding="async" />
                <span><Maximize2 size={13} />点击放大预览</span>
              </Button>
            </ImageCarouselNavigation>
            <nav className={styles.qualityThumbnails} aria-label="选择待检图片">
              {assets.map((asset, index) => <Button unstyled key={asset.id} aria-label={`选择待检图片第 ${pageNumber(index)} 页`}
                aria-pressed={index === selectedImage} data-problem={problemAssets.includes(asset.id)} onClick={() => showImage(index)}>
                <img src={apiPath(asset.url)} alt="" loading={index === 0 ? 'eager' : 'lazy'} /><span>第{pageNumber(index)}页{problemAssets.includes(asset.id) ? ' · 问题' : ''}</span>
              </Button>)}
            </nav>
          </> : <p className="notice warning">当前没有可预览的图片，暂不能通过质检。</p>}
        </div>}
      </section>
      <aside ref={decisionRef} id={decisionId} className={styles.qualityDecision} aria-label={imageMode ? '图片质检操作' : '文案质检操作'}>
        {returning && <section className={styles.returnForm} aria-label="填写返工要求"><h3>填写返工要求</h3>
        {imageMode && <><div className={styles.returnFields}>
          <label>原图评分<Select value={score} onValueChange={setScore} disabled={busy}><SelectTrigger aria-label="原图评分"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="2">2 分 · 返工</SelectItem><SelectItem value="1">1 分 · 返工</SelectItem></SelectContent></Select></label>
          <label>返工范围<Select value={target} onValueChange={setTarget} disabled={busy}><SelectTrigger aria-label="返工范围"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="IMAGE">图片</SelectItem><SelectItem value="COPY">文案</SelectItem><SelectItem value="BOTH">文案和图片</SelectItem></SelectContent></Select></label>
          </div>
          {target !== 'IMAGE' && <fieldset disabled={busy}><legend>需要修改的文案字段</legend>{[['TITLE', '标题'], ['BODY', '正文'], ['TAGS', '标签']].map(([v, label]) => <label key={v}><Checkbox checked={copyFields.includes(v)} onChange={() => setCopyFields(toggle(copyFields, v))} />{label}</label>)}</fieldset>}
          {target !== 'COPY' && <fieldset className={styles.qualityProblemPages} disabled={busy}><legend>问题图片 · 已选 {problemAssets.length} 页</legend>
            {assets.map((asset, index) => <div key={asset.id} data-selected={problemAssets.includes(asset.id)}>
              <label><Checkbox checked={problemAssets.includes(asset.id)} onChange={() => setProblemAssets(toggle(problemAssets, asset.id))} />第 {pageNumber(index)} 页有问题</label>
              <Button unstyled type="button" aria-label={`查看问题候选第 ${pageNumber(index)} 页`} onClick={() => showImage(index)}>查看</Button>
            </div>)}
          </fieldset>}
          {settingsError && <p role="alert">{settingsError}<Button unstyled className="button small" onClick={() => void refresh()}>重试配置</Button></p>}</>}
        {!imageMode && <label>处理建议<Select value={recommendation} onValueChange={setRecommendation} disabled={busy}><SelectTrigger aria-label="处理建议"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="REWORK">修改后复检</SelectItem><SelectItem value="DISCARD">建议负责人废弃</SelectItem></SelectContent></Select></label>}
        {(!imageMode || settings?.imageReviewDisplay.showDeductionReasons) && <fieldset className={styles.qualityReasonOptions} disabled={busy}><legend>问题原因</legend>{reasonOptions.map(([code, label]) => <label key={code}><Checkbox checked={reasons.includes(code)} onChange={() => setReasons(toggle(reasons, code))} />{label}</label>)}</fieldset>}
        <label>具体问题与修改要求<Textarea rows={imageMode ? 3 : 4} value={note} disabled={busy} onChange={e => setNote(e.target.value)} placeholder="请说明需要修改的位置和内容" /></label>
      </section>}
      {copy && <QualityCopyPlan pages={copy.imagePlan} />}
      </aside>
    </div>
    <footer className={styles.qualityFooter}>{error && <div className="notice error" role="alert">{error}</div>}
      <span>{item.rework ? '当前版本须通过强制复检' : '本次结论绑定当前待检版本'}</span><div>
        <Button unstyled className="button" disabled={busy} onClick={onSkip}>暂跳过</Button>
        {returning ? <><Button unstyled className="button" disabled={busy} onClick={() => { setReturning(false); setMobilePane('content'); setError(''); }}>返回核验</Button><Button unstyled className="button danger" disabled={busy || !qa.capabilities.canReturnSingle || imageMode && (settingsLoading || !!settingsError)} onClick={() => void submit(true)}><RotateCcw size={15} />打回并下一条</Button></>
          : <><Button unstyled className="button" disabled={busy || !qa.capabilities.canReturnSingle} onClick={beginReturn}>打回</Button><Button unstyled className="button primary" disabled={busy || passBlocked} onClick={() => void submit(false)}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <ArrowRight size={15} />}通过并下一条</Button></>}
      </div></footer>
    {previewAsset && preview !== null && <ImagePreview hideTrigger isOpen src={apiPath(previewAsset.url)} alt={`待检图片 · 第 ${pageNumber(preview)} 页`}
      restoreFocusRef={previewTriggerRef} position={preview + 1} total={assets.length} backdrop={backdrop} onBackdropChange={setBackdrop}
      preloads={assets.slice(Math.max(0, preview - 1), preview + 2).filter(asset => asset.id !== previewAsset.id).map(asset => apiPath(asset.url))}
      onPrevious={preview > 0 ? () => setPreview(preview - 1) : undefined} onNext={preview < assets.length - 1 ? () => setPreview(preview + 1) : undefined}
      onClose={() => { setSelectedImage(preview); setPreview(null); }} />}
  </section>;
}
