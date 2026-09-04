'use client';

import { CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { apiRequest } from '../components/api-client';
import { resumeImageTask } from '../components/resume-image-task';
import { ImagePreview } from '../components/image-preview';

type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'DELIVERY_REVIEW_PENDING' | 'COMPLETED' | 'CANCELLED';

type Copy = { title: string; body: string; tags: string[] };
type ImagePlanItem = {
  kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
};
type ReviewDraft = { copy: Copy; imagePlan: ImagePlanItem[] };
type CopyRevision = {
  id: number;
  revision: number;
  content: {
    copy?: Copy;
    imagePlan?: ImagePlanItem[];
    reviewed?: { copy?: Copy; imagePlan?: ImagePlanItem[] };
    generation?: { research?: { sources?: Array<{ title?: string; url: string; siteName?: string }> } };
  };
  approvedAt: string | null;
};
type TaskDetail = {
  id: number;
  query: string;
  state: TaskState;
  copyExecutorNodeId: string;
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
      images?: Array<{
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

const STATE_LABELS: Record<TaskState, string> = {
  COPY_QUEUED: '待执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '等待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  DELIVERY_REVIEW_PENDING: '图文待审核',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};
const STAGE_LABELS: Record<string, string> = {
  STARTING_COPY: '准备生成文案',
  STARTING_IMAGE: '准备生成图片',
  SEARCHING_IMAGES: '联网搜索图片',
  SELECTING_IMAGES: '筛选并校验图片',
  UPLOADING_IMAGES: '上传图片到中心服务',
  UPLOADING: '上传图片到中心服务',
  QUERY_REVIEW: '选题审核',
  RESEARCH: '全网搜索与资料整理',
  ORIGINAL_GENERATION: '标题、正文与配图策划生成',
  ORIGINAL_REVIEW: '首稿质检',
  REVIEWED_GENERATION: '文案改写',
  REVIEWED_REVIEW: '改写稿质检',
  PREPARING: '生图准备',
  PLANNING: '画面规划',
  GENERATING: '图片生成',
  ALIGNING: '图片校验与对齐',
  QUALITY_CHECK: '图片质检',
  FINALIZING: '图片整理',
  COPY_QUEUED: '待执行',
  COPY_RUNNING: '文案生成中',
  COPY_REVIEW_PENDING: '待文案审核',
  COPY_FAILED: '文案生成失败',
  IMAGE_QUEUED: '等待生图',
  IMAGE_RUNNING: '生图中',
  IMAGE_FAILED: '生图失败',
  DELIVERY_REVIEW_PENDING: '图文待审核',
  COMPLETED: '已完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
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

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未开始';
}

function stageLabel(detail: TaskDetail) {
  return detail.currentStage
    ? STAGE_LABELS[detail.currentStage] ?? STATE_LABELS[detail.state]
    : STATE_LABELS[detail.state];
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
  };
}

export function TaskReviewDialog({
  taskId,
  nodeId,
  onOpenChange,
  onUpdated,
}: {
  taskId: number | null;
  nodeId: string;
  onOpenChange: (open: boolean) => void;
  onUpdated: (message: string) => void | Promise<void>;
}) {
  const confirm = useConfirmDialog();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const next = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${taskId}`));
      setDetail(next);
      setDraft(draftFromRevision(currentRevision(next)));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务详情读取失败');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      setDraft(null);
      setError('');
      return;
    }
    void load();
  }, [load, taskId]);

  const revision = currentRevision(detail);
  const editable = ['COPY_REVIEW_PENDING', 'IMAGE_FAILED'].includes(detail?.state ?? '')
    && Boolean(revision && draft);
  const sources = revision?.content.generation?.research?.sources ?? [];
  const currentImageRun = useMemo(() => detail?.imageRuns.find(
    (run) => run.id === detail.currentImageRunId,
  ) ?? null, [detail]);
  const resultImageByAssetId = useMemo(() => new Map(
    (currentImageRun?.result?.images ?? [])
      .filter((image) => Number.isSafeInteger(image.assetId))
      .map((image) => [image.assetId as number, image]),
  ), [currentImageRun]);
  const assets = useMemo(() => detail?.assets.filter(
    (asset) => asset.imageRunId === detail.currentImageRunId || resultImageByAssetId.has(asset.id),
  ).sort((left, right) => (resultImageByAssetId.get(left.id)?.pageIndex ?? left.id)
    - (resultImageByAssetId.get(right.id)?.pageIndex ?? right.id)) ?? [], [detail, resultImageByAssetId]);

  async function continueImages() {
    if (!detail || detail.state !== 'IMAGE_FAILED') return;
    if (!await confirm({
      title: '从失败步骤继续生图？',
      description: '沿用已审核文案和原配置，保留已完成的规划、图片及检查结果，由原执行机继续未完成步骤。本页未提交的修改不会用于此次续跑；剩余模型调用会产生费用。',
      confirmLabel: '继续生图',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await resumeImageTask(detail.id);
      await onUpdated('任务已等待原执行机从失败步骤继续。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '继续生图失败');
    } finally {
      setSubmitting(false);
    }
  }

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
    if (!detail || !revision || !draft || !editable) return;
    if (!await confirm({
      title: '提交当前修改并通过文案审核？',
      description: detail.state === 'IMAGE_FAILED'
        ? '系统会保存新的人工修订版本，并将生图失败的任务重新送入全局生图队列。'
        : '系统会保存一个新的人工修订版本，并立即将任务送入全局生图队列。',
      confirmLabel: '提交审核',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: revision.id, nodeId, edits: draft }),
      });
      await onUpdated('文案修改已保存并审核通过，任务已进入全局生图队列。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文案审核提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitDeliveryReview() {
    if (!detail || detail.state !== 'DELIVERY_REVIEW_PENDING') return;
    if (!await confirm({
      title: '提交图文审核？',
      description: '确认后任务将进入已完成状态，当前图文版本会继续保留。',
      confirmLabel: '提交审核',
    })) return;
    setSubmitting(true);
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-delivery`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      await onUpdated('图文审核已提交，任务已完成。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图文审核提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return <Dialog open={taskId !== null} onOpenChange={(open) => { if (!submitting) onOpenChange(open); }}>
    <DialogContent className="workbench-review-dialog">
      <header className="workbench-review-heading">
        <div>
          <span className="section-kicker">Task {detail ? `#${detail.id}` : ''}</span>
          <DialogTitle>任务详情与审核</DialogTitle>
          <DialogDescription>核对任务信息，直接修改文案和配图策划后提交审核。</DialogDescription>
        </div>
        <button className="button small" type="button" disabled={loading || submitting} onClick={() => { void load(); }}>
          <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />刷新
        </button>
      </header>

      {loading && !detail
        ? <div className="workbench-review-loading"><LoaderCircle className="animate-spin" size={22} />正在读取任务详情…</div>
        : detail && <form className="workbench-review-form" onSubmit={submitCopyReview}>
          <div className="workbench-review-scroll">
            <section className="workbench-review-section">
              <div className="workbench-review-section-title"><span>01</span><div><h3>当前任务概览</h3><p>确认 Query、状态和执行进度。</p></div></div>
              <dl className="workbench-review-facts">
                <div className="wide"><dt>Query 原文</dt><dd>{detail.query}</dd></div>
                <div><dt>当前状态</dt><dd><span className={`pill workbench-state-${detail.state.toLowerCase()}`}>{STATE_LABELS[detail.state]}</span></dd></div>
                <div><dt>文案执行机</dt><dd className="mono">{detail.copyExecutorNodeId}</dd></div>
                <div><dt>创建时间</dt><dd>{dateTime(detail.createdAt)}</dd></div>
                <div><dt>开始时间</dt><dd>{dateTime(detail.executionStartedAt)}</dd></div>
                <div><dt>当前阶段</dt><dd>{stageLabel(detail)}</dd></div>
                <div><dt>最后更新</dt><dd>{dateTime(detail.lastActivityAt)}</dd></div>
              </dl>
              {detail.progressMessage && <div className="workbench-review-progress">{detail.progressMessage}</div>}
              {detail.error && <div className="notice error" role="alert">{detail.error}</div>}
            </section>

            {draft && <>
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>02</span><div><h3>标题、正文与标签</h3><p>{editable ? '当前处于文案审核阶段，可直接修改后一起提交。' : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                <div className="workbench-copy-fields">
                  <div className="field full">
                    <label htmlFor="review-copy-title">标题 <small>{draft.copy.title.length}/25</small></label>
                    <input id="review-copy-title" className="input" value={draft.copy.title} maxLength={25} required readOnly={!editable} onChange={(event) => updateCopy('title', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-body">正文 <small>{[...draft.copy.body].length}/400–600</small></label>
                    <textarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={!editable} onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={!editable} onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div>
              </section>

            </>}

            {!draft && <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}

            {assets.length > 0 && <section className="workbench-review-section">
              <div className="workbench-review-section-title"><span>{draft ? '03' : '02'}</span><div><h3>当前生成图片</h3><p>核对当前图片运行生成的完整图集。</p></div></div>
              {currentImageRun?.result?.simulation?.enabled && <div className="notice warning">
                {currentImageRun.result.visualPlan?.warning?.message
                  ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}
              </div>}
              <div className="distributed-asset-grid workbench-review-assets">{assets.map((asset, index) => {
                const resultImage = resultImageByAssetId.get(asset.id);
                const alt = asset.originalName || `任务 ${detail.id} 第 ${index + 1} 张图片`;
                return <figure key={asset.id}>
                  <ImagePreview src={apiPath(asset.url)} alt={alt} />
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
            </section>}

            {draft && <>
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '04' : '03'}</span><div><h3>配图策划</h3><p>每一页独立呈现图片角色、画面文字与生成指令。</p></div></div>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => <article className="workbench-image-plan-card" key={index}>
                    <div className="workbench-image-plan-head"><b>第 {index + 1} 页</b><span>{IMAGE_KIND_LABELS[item.kind]}</span></div>
                    <div className="workbench-image-plan-fields">
                      <div className="field">
                        <label htmlFor={`review-plan-kind-${index}`}>页面类型</label>
                        <Select value={item.kind} disabled={!editable} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind })}>
                          <SelectTrigger id={`review-plan-kind-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={!editable} onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题</label>
                        <input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} required readOnly={!editable} onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small>每行一条，2–5 条</small></label>
                        <textarea id={`review-plan-bullets-${index}`} className="textarea" value={item.bullets.join('\n')} required readOnly={!editable} onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={!editable} onChange={(event) => updateImagePlan(index, { prompt: event.target.value })} />
                      </div>
                    </div>
                  </article>)}
                </div>
              </section>

              {sources.length > 0 && <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '05' : '04'}</span><div><h3>联网资料来源</h3><p>审核时可核对文案所依据的公开来源。</p></div></div>
                <div className="workbench-review-sources">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
                  <b>{source.title || source.siteName || `来源 ${index + 1}`}</b><small>{source.url}</small>
                </a>)}</div>
              </section>}
            </>}

          </div>

          <footer className="workbench-review-footer">
            <span>{editable ? `提交后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              <DialogClose asChild><button className="button" type="button" disabled={submitting}>关闭</button></DialogClose>
              {detail.state === 'IMAGE_FAILED' && <button className="button primary" type="button" disabled={submitting} onClick={() => { void continueImages(); }}>
                <RefreshCw size={15} />从失败步骤继续
              </button>}
              {editable && <button className="button primary" type="submit" disabled={submitting}>
                {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />提交审核</>}
              </button>}
              {detail.state === 'DELIVERY_REVIEW_PENDING' && <button className="button primary" type="button" disabled={submitting} onClick={() => { void submitDeliveryReview(); }}>
                <CheckCircle2 size={15} />提交图文审核
              </button>}
            </div>
          </footer>
        </form>}

      {error && <div className="notice error workbench-review-error" role="alert">{error}</div>}
    </DialogContent>
  </Dialog>;
}
