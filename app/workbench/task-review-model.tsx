'use client';

import { Textarea } from "@/components/ui/input";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "@/components/ui/disclosure";
import { createRequestId } from "../components/request-id";
import { safeDoubaoSearchDiagnostic } from "./research-attempt-diagnostic.mjs";
import { IMAGE_RETRY_EXHAUSTED_LABEL, imageFailureDisplayReason, isImageRetryExhausted } from "../../src/control-plane/image-retry-status.mjs";
import { defaultImageSettings } from "../components/image-controls";
import { type HumanQualityAssessment, type HumanScore } from "./human-quality-rating";
import { copyQaReasonLabels } from "../../src/copy-qa-reasons.mjs";
import type { ImagePlanItem, ReviewDraft, ImagePlanBulletLengthWarning, ImagePlanBlankBulletLine, ImagePlanDifference, CopyReviewDraftContent, ReworkCopyField, ReworkRequirement, CopyRevision, TaskDetail, ReviewResearch } from './task-review-types';
export type { TaskState, Copy, ImagePlanItem, ReviewDraft, ImagePlanBulletLengthWarning, ImagePlanBlankBulletLine, ImagePlanDifference, CopyReviewDraftContent, CopyReviewDraftRecord, LegacyCopyReviewDraftRecord, ReworkReasonSnapshot, ReworkCopyField, ReworkRequirement, CopyRevision, TaskDetail, ImagePlanRegenerationJob, ReviewResearch, CopyEditArea } from './task-review-types';

export function imagePlanDifferenceLabel(difference: ImagePlanDifference) {
  if (difference.field === 'pages') return `第 ${difference.pageIndex + 1} 页与正式版本的页数或位置不同`;
  const page = `第 ${difference.pageIndex + 1} 页`;
  if (difference.field === 'bullets') {
    return `${page}画面要点${difference.bulletIndex === undefined ? '行数' : `第 ${difference.bulletIndex + 1} 行`}与正式版本不同`;
  }
  const field = {
    kind: '页面类型', headline: '页面标题', subtitle: '页面副标题',
    prompt: '画面生成指令', layout: '页面排版',
  }[difference.field];
  const layoutField = difference.layoutField ? ({
    mode: '排版方式', template: '排版模板', titlePosition: '标题位置',
    subjectPosition: '主体位置', textPosition: '文字区域', alignment: '文字对齐',
    imageShare: '主体占比', spacing: '留白', direction: '补充布局要求',
  } as Record<string, string>)[difference.layoutField] ?? difference.layoutField : null;
  return `${page}${field}${layoutField ? `（${layoutField}）` : ''}与正式版本不同`;
}

export const PENDING_IMAGE_EDIT_STATUSES = new Set(['DRAFT', 'QUEUED', 'RUNNING', 'PREVIEW_READY']);

export const IMAGE_KINDS: ImagePlanItem['kind'][] = ['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary'];

export const IMAGE_KIND_LABELS: Record<ImagePlanItem['kind'], string> = {
  hero: '封面',
  steps: '步骤',
  checklist: '清单',
  comparison: '对比',
  detail: '细节',
  summary: '总结',
};

export function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  const width = element.getBoundingClientRect().width;
  if (width <= 0) return;
  const document = element.ownerDocument;
  const style = document.defaultView!.getComputedStyle(element);
  const mirror = document.createElement('textarea');
  // Measure outside the layout so the focused editor never collapses or moves its caret.
  for (const property of [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-transform',
    'white-space', 'word-break', 'overflow-wrap', 'tab-size', 'direction',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  ]) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${width}px`, height: '0px', minHeight: '0px',
    maxHeight: 'none', overflow: 'hidden', resize: 'none',
  });
  mirror.tabIndex = -1;
  mirror.setAttribute('aria-hidden', 'true');
  mirror.wrap = element.wrap;
  mirror.value = element.value;
  document.body.append(mirror);
  const borderHeight = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const paddingHeight = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const height = Math.ceil(mirror.scrollHeight + (style.boxSizing === 'border-box' ? borderHeight : -paddingHeight));
  mirror.remove();
  const nextHeight = `${height}px`;
  if (element.style.height !== nextHeight) element.style.height = nextHeight;
}

export function AutosizeTextarea({
  className,
  onChange,
  resizeToken,
  value,
  ...props
}: ComponentProps<'textarea'> & { resizeToken?: unknown }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => resizeTextarea(ref.current), [className, resizeToken, value]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let previousWidth = element.getBoundingClientRect().width;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (Math.abs(width - previousWidth) > .5) {
        previousWidth = width;
        cancelAnimationFrame(frame);
        if (width > 0) frame = requestAnimationFrame(() => resizeTextarea(element));
      }
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <Textarea
    {...props}
    ref={ref}
    className={`workbench-autosize-textarea ${className ?? ''}`}
    value={value}
    onChange={onChange}
  />;
}

export function ReviewScrollTextarea({
  className,
  onScroll,
  resizeToken,
  value,
  ...props
}: ComponentProps<'textarea'> & { resizeToken?: unknown }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [scrollbar, setScrollbar] = useState({ visible: false, size: 100, top: 0 });
  const syncScrollbar = useCallback((element: HTMLTextAreaElement) => {
    const visible = element.scrollHeight > element.clientHeight + 1;
    const size = visible ? Math.max(14, element.clientHeight / element.scrollHeight * 100) : 100;
    const progress = visible && element.scrollHeight > element.clientHeight
      ? element.scrollTop / (element.scrollHeight - element.clientHeight)
      : 0;
    setScrollbar({ visible, size, top: progress * (100 - size) });
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() => syncScrollbar(element));
    const handleResize = () => syncScrollbar(element);
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, [resizeToken, syncScrollbar, value]);

  return <div className="workbench-scroll-textarea" data-scrollable={scrollbar.visible}>
    <Textarea
      {...props}
      ref={ref}
      className={className}
      value={value}
      onScroll={(event) => {
        syncScrollbar(event.currentTarget);
        onScroll?.(event);
      }}
    />
    <span className="workbench-scroll-textarea-track" aria-hidden="true">
      <span style={{ height: `${scrollbar.size}%`, top: `${scrollbar.top}%` }} />
    </span>
  </div>;
}

export function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

export function safeXiaohongshuUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password
      || (hostname !== 'xiaohongshu.com' && !hostname.endsWith('.xiaohongshu.com'))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function xiaohongshuEmptyMessage(detail: TaskDetail | null) {
  if (detail?.xiaohongshuSearchStatus === 'PENDING') return '该 Query 已通过审核，正在等待小红书搜索执行机处理。';
  if (detail?.xiaohongshuSearchStatus === 'RUNNING') return '正在电脑版小红书搜索该 Query，请稍后刷新任务详情。';
  if (detail?.xiaohongshuSearchStatus === 'BLOCKED') {
    return detail.xiaohongshuSearchBlockedReason === 'CAPTCHA_REQUIRED'
      ? '小红书要求人工完成安全验证，处理并恢复搜索执行机后会继续。'
      : '小红书登录状态已失效，重新登录并恢复搜索执行机后会继续。';
  }
  if (detail?.xiaohongshuSearchStatus === 'FAILED') return '该 Query 搜索失败，需要检查搜索执行机后再处理。';
  if (detail?.xiaohongshuSearchStatus === 'CANCELLED') return '该 Query 的小红书搜索已取消。';
  if (detail?.xiaohongshuSearchStatus === 'SUCCEEDED') return '搜索已完成，但没有找到可展示的小红书文章链接。';
  return '当前 Query 尚未建立小红书搜索记录。';
}

export function researchProviderLabel(value: string | null | undefined) {
  if (typeof value !== 'string') return '未记录';
  const provider = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider)) return '未记录';
  return ({ doubao: '豆包', deepseek: 'DeepSeek', codex: 'Codex' } as Record<string, string>)[provider] ?? provider;
}

export function researchResultLabel(research?: ReviewResearch) {
  if (research?.provider) return `最终采用：${researchProviderLabel(research.provider)}`;
  if ((research?.sources?.length ?? 0) > 0) return '历史任务未记录服务';
  return research ? '搜索未取得可用来源' : '暂无搜索记录';
}

export function ReviewReferences({
  detail,
  research,
  xiaohongshuLinks,
  isAdmin,
}: {
  detail: TaskDetail;
  research?: ReviewResearch;
  xiaohongshuLinks: TaskDetail['xiaohongshuLinks'];
  isAdmin: boolean;
}) {
  const sources = research?.sources ?? [];
  return <>
    <Disclosure className="workbench-review-section workbench-review-reference-disclosure" aria-labelledby="review-xiaohongshu-links-title">
      <h3 id="review-xiaohongshu-links-title" className="sr-only">Query 对应小红书文章</h3>
      <DisclosureTrigger>
        <span className="workbench-review-reference-badge">参考</span>
        <span className="workbench-review-reference-title"><strong>Query 对应小红书文章</strong><small>仅供审核核对，不属于联网资料来源</small></span>
        <em>{xiaohongshuLinks.length > 0 ? `${xiaohongshuLinks.length} 条` : '暂无记录'}</em>
      </DisclosureTrigger>
      <DisclosureContent>
        <p className="workbench-review-reference-help">按当前 Query 搜索，并按点赞量从高到低保留管理员设定的数量。</p>
        {xiaohongshuLinks.length > 0
          ? <div className="workbench-review-sources" aria-label="Query 对应小红书文章链接">{xiaohongshuLinks.map((link, index) => {
            const rank = Number.isSafeInteger(link.rank) && link.rank > 0 ? link.rank : index + 1;
            const title = typeof link.title === 'string' ? link.title.trim() : '';
            return <a href={link.url} target="_blank" rel="noopener noreferrer" key={`${link.noteId}-${rank}-${index}`}>
              <b>{title || `小红书文章 ${rank}`}</b>
              <small>点赞量排序第 {rank} 条 · {link.url}</small>
            </a>;
          })}</div>
          : <div className="workbench-review-empty">{xiaohongshuEmptyMessage(detail)}</div>}
      </DisclosureContent>
    </Disclosure>
    <Disclosure className="workbench-review-section workbench-review-source-disclosure">
      <DisclosureTrigger>联网资料来源 · {sources.length} 条 · {researchResultLabel(research)}</DisclosureTrigger>
      <DisclosureContent>
        {research?.attempts && research.attempts.length > 0 && <p className="workbench-review-reference-help">
          服务尝试：{research.attempts.map((attempt, index) => {
            const diagnostic = isAdmin && attempt.status === 'FAILED'
              && typeof attempt.provider === 'string' && attempt.provider.toLowerCase() === 'doubao'
              ? safeDoubaoSearchDiagnostic(attempt.error) : null;
            return `${index + 1}. ${researchProviderLabel(attempt.provider)}（${attempt.status === 'COMPLETED' ? '已返回来源' : '失败'}${diagnostic ? `：${diagnostic}` : ''}）`;
          }).join(' → ')}
        </p>}
        {sources.length > 0 ? <div className="workbench-review-sources">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
          <b>{source.title || source.siteName || `来源 ${index + 1}`}</b>
          <small>搜索服务：{researchProviderLabel(source.provider ?? research?.provider)} · {source.url}</small>
        </a>)}</div> : <p className="workbench-review-reference-help">{research ? '这次搜索没有可用的资料来源。' : '当前任务没有可查看的联网搜索记录。'}</p>}
      </DisclosureContent>
    </Disclosure>
  </>;
}

export function currentRevision(detail: TaskDetail | null) {
  if (!detail) return undefined;
  return detail.copyRevisions.find((item) => item.id === detail.currentCopyRevisionId)
    ?? detail.copyRevisions.at(-1);
}

export function draftFromRevision(revision: CopyRevision | undefined): ReviewDraft | null {
  const copy = revision?.content.copy ?? revision?.content.reviewed?.copy;
  const imagePlan = revision?.content.imagePlan ?? revision?.content.reviewed?.imagePlan;
  if (!copy || !Array.isArray(imagePlan)) return null;
  return {
    copy: { title: copy.title, body: copy.body, tags: [...copy.tags] },
    imagePlan: imagePlan.map((item) => ({ ...item, bullets: [...item.bullets] })),
    imageSettings: revision?.content.imageSettings ?? { ...defaultImageSettings },
  };
}

export function imagePlanBulletOverflowDescription(warnings: ImagePlanBulletLengthWarning[]) {
  const examples = warnings.slice(0, 3).map(warning =>
    `第 ${warning.pageIndex + 1} 页画面要点第 ${warning.bulletIndex + 1} 行为 ${warning.length} 字（不能超过 ${warning.recommendedMax} 字）`,
  ).join('；');
  const remainder = warnings.length > 3 ? `；另有 ${warnings.length - 3} 条超出字数限制` : '';
  return `图片规划文字超出字数限制：${examples}${remainder}。超限可能导致图片排版拥挤、字号过小或文字截断。请缩短超限内容后再操作，当前规划不能保存或提交。`;
}

export function imagePlanBlankLineDescription(blankLines: ImagePlanBlankBulletLine[]) {
  const first = blankLines[0];
  const remainder = blankLines.length > 1 ? `，另有 ${blankLines.length - 1} 个空行` : '';
  return `第 ${first.pageIndex + 1} 页画面要点的第 ${first.bulletIndex + 1} 行是无效空行${remainder}。请删除空行后再保存。`;
}

export function initialAiDisclosure(detail: TaskDetail) {
  const returnedRevision = currentRevision(detail)?.reworkOrigin != null;
  return (detail.state !== 'COPY_REVIEW_PENDING' || returnedRevision)
    && detail.aiDisclosureEnabled === true;
}

export function TaskFailureNotice({ detail }: { detail: TaskDetail }) {
  if (!isImageRetryExhausted(detail)) {
    return detail.error ? <div className="notice error" role="alert">{detail.error}</div> : null;
  }
  const failures = detail.imageRetryFailures ?? [];
  return <div className="notice error workbench-image-failure-notice" role="alert">
    <strong>{IMAGE_RETRY_EXHAUSTED_LABEL}</strong>
    {failures.length > 0
      ? <ol aria-label="生图失败详情">{failures.map((failure) => <li key={`${failure.attempt}-${failure.startedAt ?? ''}`}>
        <b>第 {failure.attempt} 次{failure.attempt === 1 ? '（首个根因）' : ''}</b>
        <span>{imageFailureDisplayReason(failure.error)}</span>
      </li>)}</ol>
      : <p>{imageFailureDisplayReason(detail.error)}</p>}
  </div>;
}

export const REWORK_TARGET_LABELS: Record<ReworkRequirement['target'], string> = {
  COPY: '文案',
  IMAGE: '图片',
  BOTH: '文案和图片',
};

export const REWORK_COPY_FIELD_LABELS: Record<ReworkCopyField, string> = {
  TITLE: '标题',
  BODY: '正文',
  TAGS: '标签',
  IMAGE_PLAN: '图片文案规划',
};

export function revisionReworkRequirement(revision: CopyRevision | null | undefined): ReworkRequirement | null {
  if (!revision?.reworkOrigin) return null;
  const snapshotCopyFields = revision.reworkReasonSnapshots?.flatMap((snapshot): ReworkCopyField[] => {
    if (snapshot.group === 'TITLE') return ['TITLE'];
    if (snapshot.group === 'BODY') return ['BODY'];
    if (snapshot.group === 'PLAN') return ['IMAGE_PLAN'];
    return [];
  }) ?? [];
  return {
    source: revision.reworkOrigin === 'FINAL_REWORK' ? 'IMAGE_QA' : 'COPY_QA',
    target: revision.reworkTarget ?? 'COPY',
    reasonCodes: revision.reworkReasonCodes ?? [],
    reasonSnapshots: revision.reworkReasonSnapshots ?? [],
    copyFields: revision.reworkCopyFields?.length
      ? revision.reworkCopyFields
      : [...new Set(snapshotCopyFields)],
    problemAssetIds: revision.reworkProblemAssetIds ?? [],
    note: revision.reworkNote ?? null,
    sourceImageRunId: null,
  };
}

export function reworkReasonLabels(
  requirement: ReworkRequirement | null,
  imageReasonOptions: Array<{ code: string; label: string }>,
) {
  if (!requirement) return [];
  if (requirement.source === 'COPY_QA') {
    return copyQaReasonLabels(requirement.reasonCodes, requirement.reasonSnapshots);
  }
  const snapshotByCode = new Map(requirement.reasonSnapshots.map(snapshot => [snapshot.code, snapshot.label]));
  const currentByCode = new Map(imageReasonOptions.map(reason => [reason.code, reason.label]));
  return requirement.reasonCodes.map(code => snapshotByCode.get(code) ?? currentByCode.get(code) ?? code);
}

export function reworkProblemImages(detail: TaskDetail | null, requirement: ReworkRequirement | null) {
  if (!detail || !requirement?.problemAssetIds.length) return [];
  const sourceRun = detail.imageRuns.find(run => run.id === requirement.sourceImageRunId);
  const pageByAssetId = new Map<number, number>();
  for (const [index, image] of (sourceRun?.result?.images ?? []).entries()) {
    const assetId = image.deliveryAssetId ?? image.assetId;
    if (Number.isSafeInteger(assetId)) pageByAssetId.set(assetId as number, image.pageIndex ?? index + 1);
  }
  const sourceAssets = detail.assets.filter(asset => asset.imageRunId === requirement.sourceImageRunId);
  return requirement.problemAssetIds.flatMap((assetId) => {
    const asset = detail.assets.find(candidate => candidate.id === assetId);
    if (!asset) return [];
    const fallbackIndex = sourceAssets.findIndex(candidate => candidate.id === assetId);
    return [{ asset, page: pageByAssetId.get(assetId) ?? (fallbackIndex >= 0 ? fallbackIndex + 1 : null) }];
  });
}

export function ReworkRequirementNotice({
  title,
  requirement,
  reasonLabels,
  problemImages,
  guidance,
}: {
  title: string;
  requirement: ReworkRequirement;
  reasonLabels: string[];
  problemImages: ReturnType<typeof reworkProblemImages>;
  guidance: ReactNode;
}) {
  const copyFieldLabels = requirement.copyFields.map(field => REWORK_COPY_FIELD_LABELS[field]);
  return <div className="notice warning workbench-rework-requirements" role="status">
    <strong>{title}</strong>
    <dl>
      <div><dt>返工范围</dt><dd>{REWORK_TARGET_LABELS[requirement.target]}</dd></div>
      {copyFieldLabels.length > 0 && <div><dt>文案位置</dt><dd>{copyFieldLabels.join('、')}</dd></div>}
      {reasonLabels.length > 0 && <div><dt>问题标签</dt><dd>{reasonLabels.join('、')}</dd></div>}
      {problemImages.length > 0 && <div><dt>问题图片</dt><dd>{problemImages.map(image => image.page === null ? `素材 #${image.asset.id}` : `第 ${image.page} 页`).join('、')}</dd></div>}
      {requirement.note && <div><dt>具体要求</dt><dd>{requirement.note}</dd></div>}
    </dl>
    {problemImages.length > 0 && <div className="workbench-rework-problem-images" aria-label="质检标记的问题图片">
      {problemImages.map(({ asset, page }) => <a key={asset.id} href={apiPath(asset.url)} target="_blank" rel="noreferrer">
        <img src={apiPath(asset.url)} alt={page === null ? '质检标记的问题图片' : `质检标记的问题图片第 ${page} 页`} loading="lazy" decoding="async" />
        <span>{page === null ? `素材 #${asset.id}` : `第 ${page} 页`}</span>
      </a>)}
    </div>}
    <p>{guidance}</p>
  </div>;
}

export function isCopyReviewDraftContent(value: unknown): value is CopyReviewDraftContent {
  if (!value || typeof value !== 'object') return false;
  const content = value as Partial<CopyReviewDraftContent>;
  const draft = content.draft;
  const copy = draft?.copy;
  const settings = draft?.imageSettings;
  return content.version === 1
    && typeof content.aiDisclosureEnabled === 'boolean'
    && (content.copyOriginalScore === null || [1, 2, 2.5, 3].includes(content.copyOriginalScore as number))
    && Array.isArray(content.copyOriginalReasons)
    && content.copyOriginalReasons.every(reason => typeof reason === 'string')
    && typeof content.copyOriginalNote === 'string'
    && typeof copy?.title === 'string'
    && typeof copy.body === 'string'
    && Array.isArray(copy.tags)
    && copy.tags.every(tag => typeof tag === 'string')
    && Array.isArray(draft?.imagePlan)
    && draft.imagePlan.every(page => page && typeof page === 'object'
      && typeof page.kind === 'string' && typeof page.headline === 'string'
      && typeof page.subtitle === 'string' && typeof page.prompt === 'string'
      && Array.isArray(page.bullets) && page.bullets.every(bullet => typeof bullet === 'string'))
    && typeof settings?.version === 'number'
    && typeof settings.format === 'string'
    && typeof settings.quality === 'number'
    && typeof settings.background === 'string'
    && typeof settings.backgroundColor === 'string';
}

export function latestAssessment(
  detail: TaskDetail,
  predicate: (assessment: HumanQualityAssessment) => boolean,
) {
  return [...(detail.humanQualityAssessments ?? [])].reverse().find(predicate);
}

export function copyRatingsFromDetail(detail: TaskDetail) {
  const revision = currentRevision(detail);
  return {
    current: latestAssessment(detail, assessment => assessment.stage === 'COPY'
      && assessment.copyRevisionId === revision?.id),
  };
}

export function imageAssessmentFromDetail(detail: TaskDetail) {
  return latestAssessment(detail, assessment => assessment.stage === 'IMAGE'
    && assessment.imageRunId === detail.currentImageRunId);
}

export function ratingFeedbackComplete(score: HumanScore | null, reasons: string[], note: string) {
  return score !== null && (score === 3 || reasons.length > 0 || note.trim().length > 0);
}

export function getCopyEditBlockMessage({
  editable,
  assigned,
  canControl,
  busy,
  score,
  ratingComplete,
}: {
  editable: boolean;
  assigned: boolean;
  canControl: boolean;
  busy: boolean;
  score: HumanScore | null;
  ratingComplete: boolean;
}) {
  if (!assigned) return '请先分配负责人，再进行文案评分和编辑。';
  if (!canControl) return '当前任务已分配给其他负责人，你可以查看，但不能评分或编辑。';
  if (!editable) return '当前任务不在待文案审核阶段，文案内容仅供查看。';
  if (busy) return '审核内容正在处理，请稍候再编辑。';
  if (score === null) return '请先完成机器原稿评分；2 分或 2.5 分可编辑文案内容。';
  if (score === 1) return ratingComplete
    ? '当前稿评为 1 分，不支持编辑；只能评分并废弃任务。'
    : '当前稿评为 1 分，不支持编辑；请补充评分反馈后评分并废弃任务。';
  if (score === 3) return '当前稿评为 3 分，已达到直接提交标准，无需修改。';
  return null;
}

export function getPlanEditBlockMessage({
  assigned,
  canControl,
  editable,
  canEditApproved,
  busy,
}: {
  assigned: boolean;
  canControl: boolean;
  editable: boolean;
  canEditApproved: boolean;
  busy: boolean;
}) {
  if (!assigned) return '请先分配负责人，再修改图片文案规划。';
  if (!canControl) return '当前任务已分配给其他负责人，你可以查看，但不能修改图片文案规划。';
  if (!editable && !canEditApproved) return '当前任务状态不支持修改图片文案规划。';
  if (busy) return '审核内容正在处理，请稍候再编辑。';
  return null;
}

export function newReviewSessionId() {
  return createRequestId();
}

export function TaskReviewFrame({ embedded, open, onOpenChange, children }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  if (embedded) return <section className="workbench-review-dialog" data-embedded="true" aria-label="当前作业内容">{children}</section>;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workbench-review-dialog">{children}</DialogContent></Dialog>;
}
