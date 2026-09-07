'use client';

import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

import { apiRequest } from '../components/api-client';
import { ModelCallTrace } from './model-call-trace';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { ImagePreview, ImagePreviewThumbnail } from '../components/image-preview';
import { ImagePreviewPreference } from '../components/image-preview-preference';
import { ImageSettingsEditor, defaultImageSettings, type ImageSettings, type PageLayout } from '../components/image-controls';
import { ImageHistoryCompare, type ImageArtifactInfo } from '../components/image-history-compare';

type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'MANUAL_ARCHIVE' | 'REVIEWED' | 'CANCELLED';

type Copy = { title: string; body: string; tags: string[] };
type ImagePlanItem = {
  kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
  layout?: PageLayout;
};
type ReviewDraft = { copy: Copy; imagePlan: ImagePlanItem[]; imageSettings: ImageSettings };
type CopyRevision = {
  id: number;
  revision: number;
  content: {
    copy?: Copy;
    imagePlan?: ImagePlanItem[];
    imageSettings?: ImageSettings;
    reviewed?: { copy?: Copy; imagePlan?: ImagePlanItem[] };
    generation?: { research?: { sources?: Array<{ title?: string; url: string; siteName?: string }> } };
  };
  approvedAt: string | null;
  approvalMode?: 'MANUAL' | 'ADMIN_BYPASS' | null;
};
type TaskDetail = {
  id: number;
  query: string;
  aiDisclosureEnabled: boolean;
  state: TaskState;
  imageReviewedAt: string | null;
  imageReviewedByUserId: string | null;
  copyExecutorNodeId: string | null;
  currentCopyRevisionId: number | null;
  currentImageRunId: string | null;
  currentExecutionId: string | null;
  currentStage: string | null;
  progressPercent: number;
  progressMessage: string;
  executionStartedAt: string | null;
  lastActivityAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  copyRevisions: CopyRevision[];
  imageRuns: Array<{
    id: string;
    result: {
      imageSettings?: ImageSettings;
      imagePlan?: ImagePlanItem[];
      processing?: { type: string };
      images?: Array<ImageArtifactInfo & {
        assetId?: number;
        pageIndex?: number;
        provider?: string;
        source?: {
          title?: string;
          pageUrl?: string;
          attribution?: string;
          license?: string;
        };
      }>;
      simulation?: { enabled?: boolean; provider?: string };
      visualPlan?: { warning?: { message?: string } };
    } | null;
  }>;
  assets: Array<{
    id: number;
    imageRunId: string;
    originalName: string | null;
    url: string;
  }>;
};

const IMAGE_KINDS: ImagePlanItem['kind'][] = ['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary'];
const IMAGE_KIND_LABELS: Record<ImagePlanItem['kind'], string> = {
  hero: '封面',
  steps: '步骤',
  checklist: '清单',
  comparison: '对比',
  detail: '细节',
  summary: '总结',
};

function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

function currentRevision(detail: TaskDetail | null) {
  if (!detail) return undefined;
  return detail.copyRevisions.find((item) => item.id === detail.currentCopyRevisionId)
    ?? detail.copyRevisions.at(-1);
}

function draftFromRevision(revision: CopyRevision | undefined): ReviewDraft | null {
  const copy = revision?.content.copy ?? revision?.content.reviewed?.copy;
  const imagePlan = revision?.content.imagePlan ?? revision?.content.reviewed?.imagePlan;
  if (!copy || !Array.isArray(imagePlan)) return null;
  return {
    copy: { title: copy.title, body: copy.body, tags: [...copy.tags] },
    imagePlan: imagePlan.map((item) => ({ ...item, bullets: [...item.bullets] })),
    imageSettings: revision?.content.imageSettings ?? { ...defaultImageSettings },
  };
}

export function TaskReviewDialog({
  taskId,
  nodeId,
  role,
  onOpenChange,
  onUpdated,
}: {
  taskId: number | null;
  nodeId: string;
  role: string;
  onOpenChange: (open: boolean) => void;
  onUpdated: (message: string) => void | Promise<void>;
}) {
  const confirm = useConfirmDialog();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [aiDisclosureEnabled, setAiDisclosureEnabled] = useState(false);
  const [activeAssetIndex, setActiveAssetIndex] = useState<number | null>(null);
  const [activePlanIndex, setActivePlanIndex] = useState(0);
  const [mobilePane, setMobilePane] = useState<'copy' | 'plan'>('copy');
  const [expandedPrompts, setExpandedPrompts] = useState<number[]>([]);
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [invalidField, setInvalidField] = useState<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const loadRequestRef = useRef(0);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++loadRequestRef.current;
    setActiveAssetIndex(null);
    setLoading(true);
    try {
      const next = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${taskId}`));
      if (requestId !== loadRequestRef.current) return;
      setDetail(next);
      setDraft(draftFromRevision(currentRevision(next)));
      // Every copy review starts with an opt-in; completed tasks show their saved setting.
      setAiDisclosureEnabled(next.state !== 'COPY_REVIEW_PENDING' && next.aiDisclosureEnabled === true);
      setError('');
    } catch (caught) {
      if (requestId === loadRequestRef.current) setError(caught instanceof Error ? caught.message : '任务详情读取失败');
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setDraft(null);
    setActivePlanIndex(0);
    setMobilePane('copy');
    setExpandedPrompts([]);
    setQueryExpanded(false);
    setInvalidField(null);
    if (!taskId) {
      setAiDisclosureEnabled(false);
      setActiveAssetIndex(null);
      setError('');
      return;
    }
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load, taskId]);

  const revision = currentRevision(detail);
  const savedDraft = draftFromRevision(revision);
  const imageConfigurationChanged = Boolean(draft && savedDraft && JSON.stringify(draft.imageSettings) !== JSON.stringify(savedDraft.imageSettings));
  const isAdmin = role === 'ADMIN';
  const editable = detail?.state === 'COPY_REVIEW_PENDING'
    && Boolean(revision && draft);
  const fieldsReadOnly = !editable || loading || submitting;
  const longQuery = Boolean(detail && (detail.query.length > 100 || detail.query.split('\n').length > 3));
  const canReviewImages = detail?.state === 'MANUAL_ARCHIVE'
    && ['ADMIN', 'REVIEWER'].includes(role) && Boolean(detail.currentImageRunId);
  const downloadable = detail && ['MANUAL_ARCHIVE', 'REVIEWED'].includes(detail.state);
  const canModifyImages = Boolean(detail && revision?.approvedAt && role !== 'REVIEWER'
    && ['MANUAL_ARCHIVE', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(detail.state) && !detail.currentExecutionId);
  const hasUnsavedChanges = editable
    ? JSON.stringify(draft) !== JSON.stringify(savedDraft) || aiDisclosureEnabled
    : imageConfigurationChanged;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!invalidField) return;
    invalidField.focus();
    invalidField.reportValidity();
    setInvalidField(null);
  }, [invalidField]);

  async function discardChanges(action: 'close' | 'refresh') {
    if (submitting || (action === 'refresh' && loading)) return;
    if (hasUnsavedChanges && !await confirm({
      title: action === 'close' ? '放弃修改并关闭？' : '放弃修改并刷新？',
      description: '当前文案、图片文案规划或图片配置有未提交修改，继续操作会丢失这些修改。',
      confirmLabel: action === 'close' ? '放弃修改并关闭' : '放弃修改并刷新',
      cancelLabel: '继续编辑',
    })) return;
    if (action === 'close') onOpenChange(false);
    else await load();
  }
  const sources = revision?.content.generation?.research?.sources ?? [];
  const assets = useMemo(() => detail?.assets.filter(
    (asset) => asset.imageRunId === detail.currentImageRunId
      && (!detail.imageRuns.find(run => run.id === detail.currentImageRunId)?.result?.images?.some(image => image.assetId)
        || detail.imageRuns.find(run => run.id === detail.currentImageRunId)?.result?.images?.some(image => image.assetId === asset.id)),
  ) ?? [], [detail]);
  const currentImageRun = useMemo(() => detail?.imageRuns.find(
    (run) => run.id === detail.currentImageRunId,
  ) ?? null, [detail]);
  const resultImageByAssetId = useMemo(() => new Map(
    (currentImageRun?.result?.images ?? [])
      .filter((image) => Number.isSafeInteger(image.assetId))
      .map((image) => [image.assetId as number, image]),
  ), [currentImageRun]);
  const activeAsset = activeAssetIndex === null ? undefined : assets[activeAssetIndex];
  const activeResultImage = activeAsset ? resultImageByAssetId.get(activeAsset.id) : undefined;

  useEffect(() => {
    if (activeAssetIndex !== null && activeAssetIndex >= assets.length) setActiveAssetIndex(null);
  }, [activeAssetIndex, assets.length]);

  useEffect(() => {
    if (draft && activePlanIndex >= draft.imagePlan.length) setActivePlanIndex(0);
  }, [activePlanIndex, draft]);

  function updateCopy(field: 'title' | 'body' | 'tags', value: string) {
    setDraft((current) => current ? {
      ...current,
      copy: {
        ...current.copy,
        [field]: field === 'tags'
          ? value.split(/[\s,，]+/u).map((tag) => tag.trim()).filter(Boolean)
          : value,
      },
    } : current);
  }

  function updateImagePlan(index: number, patch: Partial<ImagePlanItem>) {
    setDraft((current) => current ? {
      ...current,
      imagePlan: current.imagePlan.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...patch }
        : item),
    } : current);
  }

  async function submitCopyReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !revision || !draft || !editable || loading || submitting) return;
    // Validate every mounted page, then reveal the first invalid field before focusing it.
    const invalid = Array.from(event.currentTarget.elements).find((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      && element.willValidate && !element.validity.valid,
    ) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
    if (invalid) {
      const pane = invalid.closest<HTMLElement>('[data-review-pane]')?.dataset.reviewPane;
      setMobilePane(pane === 'plan' ? 'plan' : 'copy');
      const page = invalid.closest<HTMLElement>('[data-plan-index]')?.dataset.planIndex;
      if (page !== undefined) {
        const index = Number(page);
        setActivePlanIndex(index);
        if (invalid.id === `review-plan-prompt-${index}`) setExpandedPrompts(current => [...new Set([...current, index])]);
      }
      setInvalidField(invalid);
      return;
    }
    if (!await confirm({
      title: '提交当前修改并通过文案审核？',
      description: '系统会保存一个新的人工修订版本，并立即将任务送入全局生图队列。',
      confirmLabel: '提交审核',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await requireImageControls();
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revisionId: revision.id,
          nodeId,
          edits: draft,
          aiDisclosureEnabled,
        }),
      });
      await onUpdated('文案修改已保存并审核通过，任务已进入全局生图队列。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文案审核提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function requireImageControls() {
    try {
      const capability = await apiRequest<{ version: number }>(apiPath(`/v1/tasks/${detail!.id}/image-capabilities`));
      if (capability.version !== 1) throw new Error('unsupported');
    } catch { throw new Error('中心服务尚未支持图片配置，请更新中心与图片执行机后再提交。'); }
  }

  async function reviseImages(operation: 'REPROCESS' | 'REGENERATE') {
    if (!detail || !revision || !draft || !canModifyImages || submitting) return;
    if (operation === 'REPROCESS' && !isAdmin) return;
    if (operation === 'REGENERATE' && !await confirm({ title: '重新生成图片？', description: '保留已审核文案，按配置中的布局种类随机生成整套图片，会产生模型费用。旧版图片保留。', confirmLabel: '确认费用并生成' })) return;
    setSubmitting(true); setError('');
    try {
      await requireImageControls();
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/image-revisions`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: revision.id, imageRunId: detail.currentImageRunId, nodeId, operation,
          imageSettings: draft.imageSettings,
          ...(operation === 'REGENERATE' ? { layouts: draft.imagePlan.map(() => ({ mode: 'AUTO' })) } : {}),
          ...(operation === 'REGENERATE' ? { confirmation: 'LIVE_IMAGE_COST_ACCEPTED' } : {}) }),
      });
      await onUpdated(operation === 'REPROCESS' ? '格式与背景修改已进入图片队列，不调用模型。' : '已进入图片队列，将按配置随机选择布局。');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '图片修改提交失败'); }
    finally { setSubmitting(false); }
  }

  async function submitImageReview(decision: 'APPROVE' | 'RETRY' | 'DISCARD') {
    if (!detail || !canReviewImages || submitting || (decision === 'APPROVE' && imageConfigurationChanged)) return;
    const options = {
      APPROVE: { title: '确认图片审核通过？', description: '当前图文将标记为已审核，并移入已完成列表。', confirmLabel: '审核通过' },
      RETRY: { title: '重新生成这条任务的图片？', description: '保留已审核文案，使用最新配置重新生成整套图片；旧图片保留在历史记录中，生成会产生模型费用。', confirmLabel: '重试生图' },
      DISCARD: { title: '废弃这条图文任务？', description: '任务会移出业务列表，历史文案、执行记录和图片仍会保留。', confirmLabel: '确认废弃', tone: 'danger' as const },
    };
    if (!await confirm(options[decision])) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/review-images`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageRunId: detail.currentImageRunId, decision }),
      });
      await onUpdated(decision === 'APPROVE' ? '图片审核通过，任务已进入已完成列表。'
        : decision === 'RETRY' ? '任务已回到生图队列，等待重新生成图片。' : '任务已废弃。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片审核提交失败');
    } finally { setSubmitting(false); }
  }

  return <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) void discardChanges('close'); }}>
    <DialogContent className="workbench-review-dialog">
      <header className="workbench-review-heading">
        <div>
          <span className="section-kicker">Task {detail ? `#${detail.id}` : ''}</span>
          <DialogTitle>{detail?.state === 'REVIEWED' ? '已完成任务详情' : detail?.state === 'MANUAL_ARCHIVE' ? '人工归档详情' : '任务详情与审核'}</DialogTitle>
          <DialogDescription>{detail?.state === 'MANUAL_ARCHIVE'
            ? '核对文案与图片后，选择审核通过、重试生图或废弃。'
            : detail?.state === 'REVIEWED' ? '图文已审核通过，可查看详情并下载完整资源包。'
            : '核对任务信息，直接修改文案和配图策划后提交审核。'}</DialogDescription>
          {revision?.approvalMode === 'ADMIN_BYPASS' && <p role="status">管理员免审核 · 当前文案已自动放行生图</p>}
        </div>
        <div className="workbench-row-actions">
          {downloadable && <a className="button small primary" href={apiPath(`/v1/tasks/${detail.id}/archive`)} download>
            <Download size={14} />下载资源
          </a>}
          {detail && <label
            className="switch-field workbench-ai-disclosure-toggle"
            data-checked={aiDisclosureEnabled}
            title="开启后，生成图片会显示“AI生成”水印"
          >
            <Checkbox

              checked={aiDisclosureEnabled}
              disabled={!editable || loading || submitting}
              onChange={(event) => setAiDisclosureEnabled(event.target.checked)}
            />
            <span className="workbench-ai-disclosure-switch" aria-hidden="true" />
            <span className="workbench-ai-disclosure-label">AI生成水印</span>
            <strong>{aiDisclosureEnabled ? '已开启' : '已关闭'}</strong>
          </label>}
          <Button unstyled className="button small" type="button" disabled={loading || submitting} onClick={() => { void discardChanges('refresh'); }}>
            <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />刷新
          </Button>
        </div>
      </header>

      {loading && !detail
        ? <div className="workbench-review-loading"><LoaderCircle className="animate-spin" size={22} />正在读取任务详情…</div>
        : detail && <form className="workbench-review-form" data-comparing={editable} noValidate onSubmit={submitCopyReview}>
          {editable && <div className="workbench-review-pane-switch" aria-label="切换审核内容">
            <Button unstyled type="button" aria-pressed={mobilePane === 'copy'} aria-controls="review-copy-pane" onClick={() => setMobilePane('copy')}>文案</Button>
            <Button unstyled type="button" aria-pressed={mobilePane === 'plan'} aria-controls="review-plan-pane" onClick={() => setMobilePane('plan')}>图片文案规划</Button>
          </div>}
          <div className="workbench-review-scroll" data-mobile-pane={mobilePane}>
            <div id="review-copy-pane" className="workbench-review-pane" data-review-pane="copy">
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>01</span><div><h3>标题、正文与标签</h3><p>{editable ? '对照右侧图片文案规划修改，完成后一起提交。' : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                <div className="workbench-review-query">
                  <strong>Query 原文</strong>
                  <div id="review-query-text" className="workbench-review-query-text" data-expanded={queryExpanded || !longQuery}>{detail.query}</div>
                  {longQuery && <Button unstyled className="button small" type="button" aria-expanded={queryExpanded} aria-controls="review-query-text" onClick={() => setQueryExpanded(value => !value)}>{queryExpanded ? '收起原文' : '展开全文'}</Button>}
                </div>
                {isImageRetryExhausted(detail) && <div className="notice warning" role="status">{IMAGE_RETRY_EXHAUSTED_LABEL}</div>}
                {detail.error && <div className="notice error" role="alert">{detail.error}</div>}
                {draft ?
                <div className="workbench-copy-fields">
                  <div className="field full">
                    <label htmlFor="review-copy-title">标题 <small>{draft.copy.title.length}/25</small></label>
                    <Input id="review-copy-title" className="input" value={draft.copy.title} maxLength={25} required readOnly={fieldsReadOnly} onChange={(event) => updateCopy('title', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-body">正文 <small>{[...draft.copy.body].length}/400–600</small></label>
                    <Textarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={fieldsReadOnly} onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <Input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={fieldsReadOnly} onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div> : <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}
              </section>
              {sources.length > 0 && <Disclosure className="workbench-review-section workbench-review-source-disclosure">
                <DisclosureTrigger>联网资料来源 · {sources.length} 条</DisclosureTrigger>
                <DisclosureContent><div className="workbench-review-sources">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
                  <b>{source.title || source.siteName || `来源 ${index + 1}`}</b><small>{source.url}</small>
                </a>)}</div></DisclosureContent>
              </Disclosure>}
            {(assets.length > 0 || canReviewImages) && <section className="workbench-review-section">
              <div className="workbench-review-section-title"><span>02</span><div><h3>图片审核</h3><p>核对当前图片运行生成的完整图集。</p></div></div>
              <ImagePreviewPreference />
              {assets.length === 0 && <p className="notice warning">当前没有可预览的图片，请刷新核对，或选择重试生图、废弃。</p>}
              {currentImageRun?.result?.simulation?.enabled && <div className="notice warning">
                {currentImageRun.result.visualPlan?.warning?.message
                  ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}
              </div>}
              <div className="distributed-asset-grid workbench-review-assets">{assets.map((asset, index) => {
                const resultImage = resultImageByAssetId.get(asset.id);
                const alt = asset.originalName || `任务 ${detail.id} 第 ${index + 1} 张图片`;
                return <figure key={asset.id}>
                  <ImagePreviewThumbnail
                    src={apiPath(asset.url)}
                    alt={alt}
                    onClick={event => { previewTriggerRef.current = event.currentTarget; setActiveAssetIndex(index); }}
                  />
                  <figcaption>
                    <strong>第 {resultImage?.pageIndex ?? index + 1} 张</strong>
                    <span>{resultImage?.provider === 'deepseek-web-image-simulation'
                      ? '联网搜索模拟图'
                      : resultImage?.provider === 'deterministic-fallback-simulation'
                        ? '本地流程联调兜底图'
                        : asset.originalName || `图片 #${asset.id}`}</span>
                    {resultImage?.source?.pageUrl && <a href={resultImage.source.pageUrl} target="_blank" rel="noreferrer">
                      {resultImage.source.title || '查看图片来源'}
                    </a>}
                    {resultImage?.source?.attribution && <small>{resultImage.source.attribution}{resultImage.source.license ? ` · ${resultImage.source.license}` : ''}</small>}
                  </figcaption>
                </figure>;
              })}</div>
              {activeAsset && activeAssetIndex !== null && <ImagePreview
                hideTrigger
                isOpen
                restoreFocusRef={previewTriggerRef}
                src={apiPath(activeAsset.url)}
                alt={activeAsset.originalName || `任务 ${detail.id} 第 ${activeAssetIndex + 1} 张图片`}
                sourceSrc={activeResultImage?.sourceUrl ? apiPath(activeResultImage.sourceUrl) : undefined}
                deliverySrc={activeResultImage?.deliveryUrl ? apiPath(activeResultImage.deliveryUrl) : undefined}
                format={activeResultImage?.imageSettings?.format}
                transparency={activeResultImage?.transparency}
                position={activeAssetIndex + 1}
                total={assets.length}
                preloads={assets.slice(Math.max(0, activeAssetIndex - 1), activeAssetIndex + 2).filter(asset => asset.id !== activeAsset.id).map(asset => apiPath(asset.url))}
                onClose={() => setActiveAssetIndex(null)}
                onPrevious={activeAssetIndex > 0 ? () => setActiveAssetIndex(index => index === null ? null : index - 1) : undefined}
                onNext={activeAssetIndex < assets.length - 1 ? () => setActiveAssetIndex(index => index === null ? null : index + 1) : undefined}
              />}
              {currentImageRun?.result?.processing?.type === 'LOCAL' && <p className="notice warning">此版本已在本地转换格式或背景，未重新调用模型验收，请检查文字对比和透明边缘后审核。</p>}
              {imageConfigurationChanged && <p className="notice warning">下方配置尚未应用，当前预览仍是已有成品。请先提交转换或重新生图，或刷新恢复已保存的配置。</p>}
              {canReviewImages && <div className="workbench-row-actions">
                <Button unstyled className="button primary" type="button" disabled={submitting || loading || assets.length === 0 || imageConfigurationChanged} onClick={() => { void submitImageReview('APPROVE'); }}><CheckCircle2 size={15} />审核通过</Button>
                <Button unstyled className="button" type="button" disabled={submitting || loading} onClick={() => { void submitImageReview('RETRY'); }}><RotateCcw size={15} />重试生图</Button>
                <Button unstyled className="button danger" type="button" disabled={submitting || loading} onClick={() => { void submitImageReview('DISCARD'); }}><Trash2 size={15} />废弃</Button>
                {submitting && <span role="status">正在提交…</span>}
              </div>}
            </section>}

            <ImageHistoryCompare runs={detail.imageRuns} currentRunId={detail.currentImageRunId} assets={detail.assets}
              onRestore={isAdmin && canModifyImages && !submitting ? settings => setDraft(current => current ? { ...current, imageSettings: settings } : current) : undefined} />
            </div>

            {draft && <div id="review-plan-pane" className="workbench-review-pane" data-review-pane="plan">
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '03' : '02'}</span><div><h3>图片文案规划</h3><p>逐页核对画面文字，切换页面会保留当前修改。</p></div></div>
                <nav className="workbench-image-plan-nav" aria-label="图片规划页码">
                  {draft.imagePlan.map((item, index) => <Button unstyled type="button" key={index} aria-pressed={activePlanIndex === index} aria-controls={`review-plan-page-${index}`} onClick={() => setActivePlanIndex(index)}>
                    <span>第 {index + 1} 页 · {IMAGE_KIND_LABELS[item.kind]}</span><strong>{item.headline || '未填写页面标题'}</strong>
                  </Button>)}
                </nav>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => <article id={`review-plan-page-${index}`} className="workbench-image-plan-card" key={index} data-plan-index={index} hidden={activePlanIndex !== index}>
                    <div className="workbench-image-plan-head"><b>第 {index + 1} 页</b><span>{IMAGE_KIND_LABELS[item.kind]}</span></div>
                    <div className="workbench-image-plan-fields">
                      <div className="field">
                        <label htmlFor={`review-plan-kind-${index}`}>页面类型</label>
                        <Select value={item.kind} disabled={fieldsReadOnly} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind, layout: { mode: 'AUTO' } })}>
                          <SelectTrigger id={`review-plan-kind-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <Input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={fieldsReadOnly} onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题</label>
                        <Input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} required readOnly={fieldsReadOnly} onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small>每行一条，2–5 条</small></label>
                        <Textarea id={`review-plan-bullets-${index}`} className="textarea" value={item.bullets.join('\n')} required readOnly={fieldsReadOnly} onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <Disclosure className="field full" open={expandedPrompts.includes(index)} onOpenChange={open => setExpandedPrompts(current => open ? [...current, index] : current.filter(value => value !== index))}>
                        <DisclosureTrigger>画面生成指令</DisclosureTrigger>
                        <DisclosureContent>
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <Textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={fieldsReadOnly} onChange={(event) => updateImagePlan(index, { prompt: event.target.value })} />
                        </DisclosureContent>
                      </Disclosure>
                    </div>
                  </article>)}
                </div>
              </section>
              {isAdmin && <Disclosure className="workbench-review-section">
                <DisclosureTrigger>交付格式与背景</DisclosureTrigger>
                <DisclosureContent>
                  <ImageSettingsEditor value={draft.imageSettings} disabled={(!editable && !canModifyImages) || submitting} onChange={imageSettings => setDraft(current => current ? { ...current, imageSettings } : current)} />
                  {canModifyImages && <Button unstyled className="button" type="button" disabled={submitting || !assets.length} onClick={() => void reviseImages('REPROCESS')}>仅转换格式 / 背景（不调用模型）</Button>}
                </DisclosureContent>
              </Disclosure>}
              {canModifyImages && <div className="image-revision-actions"><Button unstyled className="button primary" type="button" disabled={submitting} onClick={() => void reviseImages('REGENERATE')}>重新生成图片</Button></div>}
              {role === 'ADMIN' && <ModelCallTrace key={detail.id} taskId={detail.id} />}
            </div>}
            {!draft && role === 'ADMIN' && <ModelCallTrace key={detail.id} taskId={detail.id} />}
          </div>

          <footer className="workbench-review-footer">
            <span><strong className="workbench-review-dirty" role="status">{hasUnsavedChanges ? '有未提交修改 · ' : ''}</strong>{editable ? `提交后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              <DialogClose asChild><Button unstyled className="button" type="button" disabled={submitting}>关闭</Button></DialogClose>
              {editable && <Button unstyled className="button primary" type="submit" disabled={submitting || loading}>
                {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />审核通过并开始生图</>}
              </Button>}
            </div>
          </footer>
        </form>}

      {error && <div className="notice error workbench-review-error" role="alert">{error}</div>}
    </DialogContent>
  </Dialog>;
}
