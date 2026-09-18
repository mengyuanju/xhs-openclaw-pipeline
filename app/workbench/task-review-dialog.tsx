'use client';

import { TaskPriorityControl, PrioritySummary, type PriorityTask } from './task-priority-control';
import { VisualPlanSummary } from '../components/visual-plan-summary';
import { ImageCarouselNavigation } from '../components/image-carousel-navigation';
import { ImagePreviewBackgroundControl, type PreviewBackdrop } from '../components/image-preview-background-control';

import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { CheckCircle2, ChevronLeft, ChevronRight, Download, History, LoaderCircle, RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type ReactNode, type RefObject } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTextInputDialog } from '@/components/ui/text-input-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { ToastFeedback } from '@/components/ui/sonner';

import { ApiRequestError, apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import { resumeImageTask } from '../components/resume-image-task';
import { canResumeImageTask } from '../../src/control-plane/image-resume.mjs';
import { orderedImageFileName } from '../../src/image-file-name.mjs';
import { TaskQualitySummary } from './task-quality-summary';
import { ModelCallTrace } from './model-call-trace';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { ImagePreview } from '../components/image-preview';
import { ImagePreviewPreference } from '../components/image-preview-preference';
import { ImageSettingsEditor, PageLayoutEditor, defaultImageSettings, type ImageSettings, type PageLayout } from '../components/image-controls';
import { ImageHistoryCompare, type ImageArtifactInfo } from '../components/image-history-compare';
import { CurrentImageEditor } from '../components/current-image-editor';
import { useBackgroundTasks } from '../components/background-tasks';
import { backgroundTaskMessage, isBackgroundTaskRunning, isPlanSourceCurrent } from '../components/background-task-store';
import { toast } from 'sonner';
import {
  COPY_MACHINE_DRAFT_SCORE_PRESENTATION,
  CopyMachineDraftScoreField,
  HumanAssessmentHistory,
  HumanRatingFeedback,
  HumanScoreBadge,
  HumanScoreField,
  isPassingHumanScore,
  type HumanQualityAssessment,
  type HumanScore,
} from './human-quality-rating';
import { DEFAULT_SETTINGS, useHumanQualitySettings } from './human-quality-settings';
import { buildCopyReviewSubmission } from '../../src/copy-review-submission.mjs';
import styles from './copy-review-drafts.module.css';

type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_QC_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'MANUAL_ARCHIVE' | 'IMAGE_QC_PENDING' | 'IMAGE_REWORK_PENDING' | 'REVIEWED' | 'CANCELLED';

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
type CopyReviewDraftContent = {
  version: 1;
  draft: ReviewDraft;
  aiDisclosureEnabled: boolean;
  copyOriginalScore: HumanScore | null;
  copyOriginalReasons: string[];
  copyOriginalNote: string;
};
type CopyReviewDraftRecord = {
  id: number;
  taskId: number;
  baseCopyRevisionId: number;
  reviewerAccountId: number;
  reviewerUsername: string;
  version: number;
  content: CopyReviewDraftContent;
  createdAt: string;
};
type CopyRevision = {
  id: number;
  executionId: string | null;
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
  copyContentChangedFromMachine?: boolean;
  copyReworkSatisfied?: boolean;
  revisionOrigin?: string | null;
  parentRevisionId?: number | null;
  reworkOrigin?: 'QA_RETURN' | 'FINAL_REWORK' | null;
  reworkTarget?: 'COPY' | 'IMAGE' | 'BOTH' | null;
  reworkReasonCodes?: string[];
  reworkNote?: string | null;
  reworkRecommendation?: 'REWORK' | 'DISCARD';
  reworkSamplingItemId?: string | null;
};
type TaskDetail = PriorityTask & {
  imagePlanRegeneration?: ImagePlanRegenerationJob | null;
  id: number;
  query: string;
  sourceQueryPackageName?: string | null;
  createdByUserId?: string | null;
  createdByAccountId?: number | null;
  xiaohongshuLinks: Array<{
    noteId: string;
    url: string;
    title: string | null;
    rank: number;
  }>;
  xiaohongshuSearchStatus?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | null;
  xiaohongshuSearchBlockedReason?: 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED' | null;
  assignedToUserId?: string | null;
  assignedToAccountId?: number | null;
  aiDisclosureEnabled: boolean;
  mandatoryCopyQc?: boolean;
  mandatoryCopyQcOrigin?: 'QA_RETURN' | 'FINAL_REWORK' | 'IMAGE_RETRY_REVIEW' | null;
  deliveryStatus?: 'READY' | null;
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
  humanQualityAssessments?: HumanQualityAssessment[];
  copyRevisions: CopyRevision[];
  imageRuns: Array<{
    id: string;
    result: {
      qc?: unknown;
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
      visualPlan?: { warning?: { message?: string }; value?: unknown };
    } | null;
  }>;
  assets: Array<{
    id: number;
    sha256: string;
    imageRunId: string;
    mediaType?: string;
    originalName: string | null;
    url: string;
  }>;
};
type ImageEditSummary = {
  id: string;
  status: string;
};
type ImagePlanRegenerationJob = {
  id: string;
  copyRevisionId: number;
  copy: Copy;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STALE';
  result: { imagePlan: ImagePlanItem[]; model: string | null } | null;
  error: string | null;
};

const PENDING_IMAGE_EDIT_STATUSES = new Set(['DRAFT', 'QUEUED', 'RUNNING', 'PREVIEW_READY']);

const IMAGE_KINDS: ImagePlanItem['kind'][] = ['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary'];
const IMAGE_KIND_LABELS: Record<ImagePlanItem['kind'], string> = {
  hero: '封面',
  steps: '步骤',
  checklist: '清单',
  comparison: '对比',
  detail: '细节',
  summary: '总结',
};

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = '0px';
  element.style.height = `${element.scrollHeight + 2}px`;
}

function AutosizeTextarea({
  className,
  onChange,
  resizeToken,
  value,
  ...props
}: ComponentProps<'textarea'> & { resizeToken?: unknown }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => resizeTextarea(ref.current), [resizeToken, value]);

  return <Textarea
    {...props}
    ref={ref}
    className={`workbench-autosize-textarea ${className ?? ''}`}
    value={value}
    onChange={(event) => {
      resizeTextarea(event.currentTarget);
      onChange?.(event);
    }}
  />;
}

function ReviewScrollTextarea({
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

function apiPath(path: string) {
  return `/api/control-plane${path}`;
}

function safeXiaohongshuUrl(value: unknown) {
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

function xiaohongshuEmptyMessage(detail: TaskDetail | null) {
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

function ReviewReferences({
  detail,
  sources,
  xiaohongshuLinks,
}: {
  detail: TaskDetail;
  sources: Array<{ title?: string; url: string; siteName?: string }>;
  xiaohongshuLinks: TaskDetail['xiaohongshuLinks'];
}) {
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
    {sources.length > 0 && <Disclosure className="workbench-review-section workbench-review-source-disclosure">
      <DisclosureTrigger>联网资料来源 · {sources.length} 条</DisclosureTrigger>
      <DisclosureContent><div className="workbench-review-sources">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
        <b>{source.title || source.siteName || `来源 ${index + 1}`}</b><small>{source.url}</small>
      </a>)}</div></DisclosureContent>
    </Disclosure>}
  </>;
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

function initialAiDisclosure(detail: TaskDetail) {
  const returnedRevision = currentRevision(detail)?.reworkOrigin != null;
  return (detail.state !== 'COPY_REVIEW_PENDING' || returnedRevision)
    && detail.aiDisclosureEnabled === true;
}

function copyReviewDraftFingerprint(content: CopyReviewDraftContent) {
  return JSON.stringify(content);
}

function latestAssessment(
  detail: TaskDetail,
  predicate: (assessment: HumanQualityAssessment) => boolean,
) {
  return [...(detail.humanQualityAssessments ?? [])].reverse().find(predicate);
}

function copyRatingsFromDetail(detail: TaskDetail) {
  const revision = currentRevision(detail);
  return {
    current: latestAssessment(detail, assessment => assessment.stage === 'COPY'
      && assessment.copyRevisionId === revision?.id),
  };
}

function imageAssessmentFromDetail(detail: TaskDetail) {
  return latestAssessment(detail, assessment => assessment.stage === 'IMAGE'
    && assessment.imageRunId === detail.currentImageRunId);
}

function ratingFeedbackComplete(score: HumanScore | null, reasons: string[], note: string) {
  return score !== null && (score === 3 || reasons.length > 0 || note.trim().length > 0);
}

type CopyEditArea = 'copy' | 'plan';

function getCopyEditBlockMessage({
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

function getPlanEditBlockMessage({
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

function newReviewSessionId() {
  return createRequestId();
}

function TaskReviewFrame({ embedded, open, onOpenChange, children }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  if (embedded) return <section className="workbench-review-dialog" data-embedded="true" aria-label="当前作业内容">{children}</section>;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workbench-review-dialog">{children}</DialogContent></Dialog>;
}

export function TaskReviewDialog({
  taskId,
  nodeId,
  role,
  currentUsername,
  currentAccountId,
  onOpenChange,
  onUpdated,
  embedded = false,
  navigationGuardRef,
  onDetailLoaded,
}: {
  taskId: number | null;
  nodeId: string;
  role: string;
  currentUsername: string;
  currentAccountId: number;
  onOpenChange: (open: boolean) => void;
  onUpdated: (message: string, completedTaskId?: number) => void | Promise<void>;
  embedded?: boolean;
  navigationGuardRef?: RefObject<(() => Promise<boolean>) | null>;
  onDetailLoaded?: (task: { id: number; state: string }) => void;
}) {
  const ReviewTitle = embedded ? 'h2' : DialogTitle;
  const ReviewDescription = embedded ? 'p' : DialogDescription;
  const detailLoadedRef = useRef(onDetailLoaded);
  detailLoadedRef.current = onDetailLoaded;
  const confirm = useConfirmDialog();
  const { tasks: backgroundTasks, store: backgroundStore } = useBackgroundTasks();
  const backgroundPlan = backgroundTasks.find(task => task.kind === 'IMAGE_PLAN' && task.taskId === taskId);
  const requestText = useTextInputDialog();
  const {
    settings: humanQualitySettings,
    loading: humanQualitySettingsLoading,
    error: humanQualitySettingsError,
  } = useHumanQualitySettings(taskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittingImagePlan, setSubmittingImagePlan] = useState(false);
  const regeneratingImagePlan = submittingImagePlan || Boolean(backgroundPlan && isBackgroundTaskRunning(backgroundPlan));
  const [imagePlanGenerationNotice, setImagePlanGenerationNotice] = useState('');
  const [aiDisclosureEnabled, setAiDisclosureEnabled] = useState(false);
  const [activeAssetIndex, setActiveAssetIndex] = useState<number | null>(null);
  const [selectedAssetIndex, setSelectedAssetIndex] = useState(0);
  const [previewBackdrop, setPreviewBackdrop] = useState<PreviewBackdrop>('white');
  const [activePlanIndex, setActivePlanIndex] = useState(0);
  const [mobilePane, setMobilePane] = useState<'copy' | 'plan'>('copy');
  const [expandedPrompts, setExpandedPrompts] = useState<number[]>([]);
  const [copyOriginalScore, setCopyOriginalScore] = useState<HumanScore | null>(null);
  const [copyOriginalReasons, setCopyOriginalReasons] = useState<string[]>([]);
  const [copyOriginalNote, setCopyOriginalNote] = useState('');
  const [imageScore, setImageScore] = useState<HumanScore | null>(null);
  const [imageReasons, setImageReasons] = useState<string[]>([]);
  const [imageProblemAssetIds, setImageProblemAssetIds] = useState<number[]>([]);
  const [imageReviewNote, setImageReviewNote] = useState('');
  const [imageReworkTarget, setImageReworkTarget] = useState<'COPY' | 'IMAGE' | 'BOTH'>('IMAGE');
  const [imageReworkCopyFields, setImageReworkCopyFields] = useState<Array<'TITLE' | 'BODY' | 'TAGS'>>([]);
  const [invalidField, setInvalidField] = useState<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const [copyEditNotice, setCopyEditNotice] = useState<{ area: CopyEditArea; message: string; sequence: number } | null>(null);
  const [draftHistory, setDraftHistory] = useState<CopyReviewDraftRecord[]>([]);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [draftSaveError, setDraftSaveError] = useState('');
  const [draftSaveConflict, setDraftSaveConflict] = useState(false);
  const [lastSavedDraftFingerprint, setLastSavedDraftFingerprint] = useState<string | null>(null);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null);
  const [restoredDraftId, setRestoredDraftId] = useState<number | null>(null);
  const [pendingImageEdits, setPendingImageEdits] = useState<ImageEditSummary[]>([]);
  const loadRequestRef = useRef(0);
  const imagePlanGenerationRequestRef = useRef(0);
  const autoLoadPlanIdRef = useRef<string | null>(null);
  const appliedPlanIdRef = useRef<string | null>(null);
  const draftSaveAbortRef = useRef<AbortController | null>(null);
  const lastSavedDraftIdRef = useRef<number | null>(null);
  const reviewSessionRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const copyEditNoticeSequenceRef = useRef(0);
  const lastCopyEditNoticeRef = useRef<{ area: CopyEditArea; message: string; at: number } | null>(null);
  const copyEditPointerAtRef = useRef(0);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const imageSectionRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++loadRequestRef.current;
    setActiveAssetIndex(null);
    setLoading(true);
    try {
      const next = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${taskId}`));
      if (requestId !== loadRequestRef.current) return;
      const copyRatings = copyRatingsFromDetail(next);
      const imageAssessment = imageAssessmentFromDetail(next);
      const revisionDraft = draftFromRevision(currentRevision(next));
      const disclosureEnabled = initialAiDisclosure(next);
      const canLoadImageEdits = ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(next.state)
        && (role === 'ADMIN' || (next.assignedToUserId === currentUsername
          && next.assignedToAccountId === currentAccountId));
      const [history, imageEdits] = await Promise.all([
        next.state === 'COPY_REVIEW_PENDING' && next.assignedToUserId !== null
            && next.currentCopyRevisionId && revisionDraft
          ? apiRequest<{ baseCopyRevisionId: number | null; drafts: CopyReviewDraftRecord[] }>(
            apiPath(`/v1/tasks/${taskId}/copy-review-drafts`),
          )
          : Promise.resolve({ baseCopyRevisionId: next.currentCopyRevisionId, drafts: [] }),
        canLoadImageEdits
          ? apiRequest<ImageEditSummary[]>(apiPath(`/v1/tasks/${taskId}/image-edits`))
          : Promise.resolve([]),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const latestDraft = history.baseCopyRevisionId === next.currentCopyRevisionId
        ? history.drafts[0] : undefined;
      const initialDraftContent: CopyReviewDraftContent | null = revisionDraft ? {
        version: 1,
        draft: revisionDraft,
        aiDisclosureEnabled: disclosureEnabled,
        copyOriginalScore: copyRatings.current?.score ?? null,
        copyOriginalReasons: [...(copyRatings.current?.reasonCodes ?? [])].sort(),
        copyOriginalNote: copyRatings.current?.note ?? '',
      } : null;
      const restoredContent = latestDraft?.content ?? initialDraftContent;
      setDetail(next);
      detailLoadedRef.current?.({ id: next.id, state: next.state });
      setDraft(restoredContent?.draft ?? revisionDraft);
      setCopyOriginalScore(restoredContent
        ? restoredContent.copyOriginalScore
        : copyRatings.current?.score ?? null);
      setCopyOriginalReasons(restoredContent?.copyOriginalReasons ?? copyRatings.current?.reasonCodes ?? []);
      setCopyOriginalNote(restoredContent?.copyOriginalNote ?? copyRatings.current?.note ?? '');
      setImageScore(imageAssessment?.score ?? null);
      setImageReasons(imageAssessment?.reasonCodes ?? []);
      setImageProblemAssetIds(imageAssessment?.problemAssetIds ?? []);
      setImageReviewNote(imageAssessment?.note ?? '');
      setImageReworkCopyFields((imageAssessment?.reworkDetails?.copyFields ?? []).filter(
        (field): field is 'TITLE' | 'BODY' | 'TAGS' => ['TITLE', 'BODY', 'TAGS'].includes(field),
      ));
      reviewSessionRef.current = null;
      // Initial generated-copy review is opt-in. A returned copy revision keeps
      // the already-approved disclosure choice instead of silently resetting it.
      setAiDisclosureEnabled(restoredContent?.aiDisclosureEnabled ?? disclosureEnabled);
      setDraftHistory(history.drafts);
      lastSavedDraftIdRef.current = latestDraft?.id ?? null;
      setLastSavedDraftFingerprint(restoredContent ? copyReviewDraftFingerprint(restoredContent) : null);
      setLastDraftSavedAt(latestDraft?.createdAt ?? null);
      setRestoredDraftId(latestDraft?.id ?? null);
      setPendingImageEdits(imageEdits.filter(edit => PENDING_IMAGE_EDIT_STATUSES.has(edit.status)));
      setDraftSaveStatus(latestDraft ? 'saved' : 'idle');
      setDraftSaveError('');
      setDraftSaveConflict(false);
      setDraftHydrated(true);
      setError('');
    } catch (caught) {
      if (requestId === loadRequestRef.current) setError(caught instanceof Error ? caught.message : '任务详情读取失败');
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [currentAccountId, currentUsername, role, taskId]);

  useEffect(() => {
    draftSaveAbortRef.current?.abort();
    draftSaveAbortRef.current = null;
    lastSavedDraftIdRef.current = null;
    setDetail(null);
    setDraft(null);
    setSelectedAssetIndex(0);
    setActivePlanIndex(0);
    setMobilePane('copy');
    setExpandedPrompts([]);
    setCopyOriginalScore(null);
    setCopyOriginalReasons([]);
    setCopyOriginalNote('');
    setImageScore(null);
    setImageReasons([]);
    setImageProblemAssetIds([]);
    setImageReviewNote('');
    setImageReworkTarget('IMAGE');
    setImageReworkCopyFields([]);
    setCopyEditNotice(null);
    setDraftHistory([]);
    setDraftHydrated(false);
    setDraftSaveStatus('idle');
    setDraftSaveError('');
    setDraftSaveConflict(false);
    setLastSavedDraftFingerprint(null);
    setLastDraftSavedAt(null);
    setRestoredDraftId(null);
    setPendingImageEdits([]);
    setSubmittingImagePlan(false);
    autoLoadPlanIdRef.current = null;
    appliedPlanIdRef.current = null;
    setImagePlanGenerationNotice('');
    imagePlanGenerationRequestRef.current += 1;
    lastCopyEditNoticeRef.current = null;
    reviewSessionRef.current = null;
    setInvalidField(null);
    if (!taskId) {
      setAiDisclosureEnabled(false);
      setActiveAssetIndex(null);
      setError('');
      return;
    }
    void load();
    return () => {
      loadRequestRef.current += 1;
      draftSaveAbortRef.current?.abort();
    };
  }, [load, taskId]);

  const revision = currentRevision(detail);
  const savedDraft = draftFromRevision(revision);
  const draftChanged = Boolean(draft && savedDraft && JSON.stringify(draft) !== JSON.stringify(savedDraft));
  const copyContentChanged = Boolean(draft && savedDraft
    && JSON.stringify(draft.copy) !== JSON.stringify(savedDraft.copy));
  const imagePlanChanged = Boolean(draft && savedDraft
    && JSON.stringify(draft.imagePlan) !== JSON.stringify(savedDraft.imagePlan));
  const imageConfigurationChanged = Boolean(draft && savedDraft && JSON.stringify(draft.imageSettings) !== JSON.stringify(savedDraft.imageSettings));
  const isAdmin = role === 'ADMIN';
  const taskHasAssignee = Boolean(detail
    && (!Object.hasOwn(detail, 'assignedToUserId') || detail.assignedToUserId !== null));
  const currentUserIsAssignee = Boolean(detail
    && detail.assignedToUserId === currentUsername
    && detail.assignedToAccountId === currentAccountId);
  const currentUserIsCreator = Boolean(detail
    && detail.createdByUserId === currentUsername
    && detail.createdByAccountId === currentAccountId);
  const canReviewCopy = isAdmin || role === 'REVIEWER' || currentUserIsAssignee;
  const hasOwnerControl = isAdmin || currentUserIsAssignee;
  const canRetryCopy = Boolean(detail
    && ['COPY_RUNNING', 'COPY_FAILED'].includes(detail.state)
    && (hasOwnerControl || detail.assignedToUserId === null && currentUserIsCreator));
  const editable = taskHasAssignee && canReviewCopy && detail?.state === 'COPY_REVIEW_PENDING'
    && Boolean(revision && draft);
  const isCopyRework = Boolean(detail?.mandatoryCopyQc
    || ['QA_RETURN', 'FINAL_REWORK'].includes(revision?.revisionOrigin ?? '')
    || ['QA_RETURN', 'FINAL_REWORK'].includes(revision?.reworkOrigin ?? ''));
  const isCopyOnlyFinalRework = revision?.reworkOrigin === 'FINAL_REWORK'
    && revision.reworkTarget === 'COPY';
  const savedCopyRatings = detail ? copyRatingsFromDetail(detail) : { current: undefined };
  const originalCopyRatingComplete = ratingFeedbackComplete(copyOriginalScore, copyOriginalReasons, copyOriginalNote);
  const copyFieldsEditable = editable && (isCopyRework || copyOriginalScore === 2 || copyOriginalScore === 2.5);
  const copyFieldsReadOnly = !copyFieldsEditable || loading || submitting || regeneratingImagePlan;
  const copyContentChangedFromMachine = revision?.copyContentChangedFromMachine === true;
  const hasEditedCopyVersion = copyContentChanged || copyContentChangedFromMachine;
  const copyReworkSatisfied = copyContentChanged || revision?.copyReworkSatisfied === true;
  const copyRatingComplete = isCopyRework || originalCopyRatingComplete;
  const canApproveCopy = isCopyRework ? copyReworkSatisfied : copyRatingComplete && (copyOriginalScore === 3 && !copyContentChanged
    || (copyOriginalScore === 2 || copyOriginalScore === 2.5) && hasEditedCopyVersion);
  const canDiscardReturnedCopy = Boolean(editable && hasOwnerControl
    && detail?.mandatoryCopyQc === true && detail.mandatoryCopyQcOrigin === 'QA_RETURN'
    && revision?.reworkOrigin === 'QA_RETURN' && revision.reworkSamplingItemId
    && (isAdmin || revision.reworkRecommendation === 'DISCARD'));
  const showCopyRating = detail?.state === 'COPY_REVIEW_PENDING' && !isCopyRework;
  const isImageReviewView = detail?.state === 'MANUAL_ARCHIVE' || detail?.state === 'IMAGE_REWORK_PENDING';
  const imageWorkMode = embedded && isImageReviewView;
  const canHandleAssignedImages = (isAdmin || role === 'USER') && currentUserIsAssignee;
  const canSubmitImageSelfReview = detail?.state === 'MANUAL_ARCHIVE'
    && canHandleAssignedImages && Boolean(detail.currentImageRunId);
  // Scored pass/return decisions moved to the dedicated image-QA pool.
  const canReviewImages = false;
  const downloadable = isAdmin && detail?.state === 'REVIEWED' && detail.deliveryStatus === 'READY';
  const canResumeImages = canResumeImageTask(detail) && hasOwnerControl && role !== 'REVIEWER';
  const canModifyImages = Boolean(detail && revision?.approvedAt && hasOwnerControl && role !== 'REVIEWER'
    && (isAdmin
      ? ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(detail.state)
      : ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(detail.state))
    && !detail.currentExecutionId);
  const canEditApprovedImagePlan = canModifyImages;
  const planFieldsReadOnly = !(editable || canEditApprovedImagePlan)
    || isCopyOnlyFinalRework || loading || submitting || regeneratingImagePlan;
  const planKindDisabled = !(editable || canEditApprovedImagePlan) || isCopyOnlyFinalRework || loading || submitting || regeneratingImagePlan;
  const currentCopyRatingLabel = '机器原稿初评（保留）';
  const standardCopyEditBlockMessage = getCopyEditBlockMessage({
    editable,
    assigned: taskHasAssignee,
    canControl: canReviewCopy,
    busy: loading || submitting || regeneratingImagePlan,
    score: copyOriginalScore,
    ratingComplete: originalCopyRatingComplete,
  });
  const copyEditBlockMessage = isCopyRework && editable && !loading && !submitting
    ? null
    : standardCopyEditBlockMessage;
  const planEditBlockMessage = getPlanEditBlockMessage({
    assigned: taskHasAssignee,
    canControl: canReviewCopy,
    editable,
    canEditApproved: canEditApprovedImagePlan,
    busy: loading || submitting || regeneratingImagePlan,
  });
  const savedImageAssessment = detail ? imageAssessmentFromDetail(detail) : undefined;
  const copyRatingChanged = editable && (copyOriginalScore !== (savedCopyRatings.current?.score ?? null)
    || JSON.stringify(copyOriginalReasons) !== JSON.stringify(savedCopyRatings.current?.reasonCodes ?? [])
    || copyOriginalNote !== (savedCopyRatings.current?.note ?? ''));
  const imageRatingChanged = canReviewImages && (imageScore !== (savedImageAssessment?.score ?? null)
    || JSON.stringify(imageReasons) !== JSON.stringify(savedImageAssessment?.reasonCodes ?? [])
    || JSON.stringify(imageProblemAssetIds) !== JSON.stringify(savedImageAssessment?.problemAssetIds ?? [])
    || imageReviewNote !== (savedImageAssessment?.note ?? ''));
  const hasUnsavedChanges = editable
    ? draftChanged || aiDisclosureEnabled || copyRatingChanged
    : imagePlanChanged || imageConfigurationChanged || imageRatingChanged;
  const copyReviewDraftContent = useMemo<CopyReviewDraftContent | null>(() => draft ? ({
    version: 1,
    draft,
    aiDisclosureEnabled,
    copyOriginalScore,
    copyOriginalReasons: [...copyOriginalReasons].sort(),
    copyOriginalNote,
  }) : null, [aiDisclosureEnabled, copyOriginalNote, copyOriginalReasons, copyOriginalScore, draft]);
  const currentDraftFingerprint = copyReviewDraftContent
    ? copyReviewDraftFingerprint(copyReviewDraftContent)
    : null;
  const hasUnpersistedDraftChanges = Boolean(editable && draftHydrated && currentDraftFingerprint
    && currentDraftFingerprint !== lastSavedDraftFingerprint);

  const persistCopyReviewDraft = useCallback(async (
    content: CopyReviewDraftContent,
    fingerprint: string,
  ) => {
    if (!taskId || !revision?.id || draftSaveStatus === 'saving') return false;
    const appliedPlanId = appliedPlanIdRef.current;
    const controller = new AbortController();
    draftSaveAbortRef.current?.abort();
    draftSaveAbortRef.current = controller;
    setDraftSaveStatus('saving');
    setDraftSaveError('');
    setDraftSaveConflict(false);
    try {
      const result = await apiRequest<{ created: boolean; draft: CopyReviewDraftRecord }>(
        apiPath(`/v1/tasks/${taskId}/copy-review-drafts`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseCopyRevisionId: revision.id,
            expectedLatestDraftId: lastSavedDraftIdRef.current,
            content,
          }),
          signal: controller.signal,
          keepalive: true,
        },
      );
      lastSavedDraftIdRef.current = result.draft.id;
      setDraftHistory(current => [
        result.draft,
        ...current.filter(item => item.id !== result.draft.id),
      ].slice(0, 20));
      setLastSavedDraftFingerprint(fingerprint);
      setLastDraftSavedAt(result.draft.createdAt);
      setRestoredDraftId(result.draft.id);
      setDraftSaveStatus('saved');
      if (appliedPlanId) {
        backgroundStore?.consumePlan(appliedPlanId);
        if (appliedPlanIdRef.current === appliedPlanId) appliedPlanIdRef.current = null;
      }
      return true;
    } catch (caught) {
      if (controller.signal.aborted) return;
      const conflict = caught instanceof ApiRequestError && caught.code === 'COPY_REVIEW_DRAFT_CONFLICT';
      setDraftSaveStatus('error');
      setDraftSaveConflict(conflict);
      setDraftSaveError(conflict
        ? '其他窗口已保存更新的草稿。请刷新任务，再从草稿历史选择要继续的版本。'
        : caught instanceof Error ? caught.message : '草稿保存失败，请重试');
      return false;
    } finally {
      if (draftSaveAbortRef.current === controller) draftSaveAbortRef.current = null;
    }
  }, [backgroundStore, draftSaveStatus, revision?.id, taskId]);

  const completedPlan = backgroundPlan?.status === 'SUCCEEDED' && !backgroundPlan.consumed
    ? backgroundPlan.payload as ImagePlanRegenerationJob | undefined : undefined;
  useEffect(() => {
    const job = detail?.imagePlanRegeneration;
    if (job && backgroundStore && !backgroundStore.getSnapshot().some(task => task.id === job.id)) {
      backgroundStore.track({ id:job.id,kind:'IMAGE_PLAN',taskId:detail.id,status:job.status,payload:job });
    }
  },[detail,backgroundStore]);
  const canLoadCompletedPlan = Boolean(editable && completedPlan?.result?.imagePlan?.length
    && isPlanSourceCurrent(completedPlan, revision?.id, draft?.copy));

  const loadCompletedPlan = useCallback(() => {
    if (!canLoadCompletedPlan || !completedPlan?.result || loading || submitting || draftSaveStatus === 'saving') return;
    const result = completedPlan.result;
    appliedPlanIdRef.current = completedPlan.id;
    autoLoadPlanIdRef.current = null;
    if (!hasUnpersistedDraftChanges && JSON.stringify(draft?.imagePlan) === JSON.stringify(result.imagePlan)) {
      backgroundStore?.consumePlan(completedPlan.id);
      appliedPlanIdRef.current = null;
    }
    setDraft(current => current ? { ...current, imagePlan: result.imagePlan } : current);
    setActivePlanIndex(0);
    setExpandedPrompts([]);
    setMobilePane('plan');
    setImagePlanGenerationNotice(`已根据当前文案重新生成 ${result.imagePlan.length} 页规划。请逐页核对后单独保存图片规划。`);
  }, [backgroundStore, canLoadCompletedPlan, completedPlan, draft?.imagePlan, draftSaveStatus, hasUnpersistedDraftChanges, loading, submitting]);

  useEffect(() => {
    if (completedPlan?.id === autoLoadPlanIdRef.current) loadCompletedPlan();
  }, [completedPlan, loadCompletedPlan]);

  useEffect(() => {
    setCopyEditNotice(null);
    lastCopyEditNoticeRef.current = null;
  }, [copyEditBlockMessage, planEditBlockMessage, taskId]);

  useEffect(() => {
    if (!hasUnpersistedDraftChanges && draftSaveStatus !== 'saving') return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [draftSaveStatus, hasUnpersistedDraftChanges]);

  useEffect(() => {
    if (!editable || !draftHydrated || !copyReviewDraftContent || !currentDraftFingerprint
        || !hasUnpersistedDraftChanges || submitting || submittingImagePlan || draftSaveStatus === 'saving'
        || draftSaveStatus === 'error' && draftSaveConflict) return;
    const timer = window.setTimeout(() => {
      void persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint);
    }, draftSaveStatus === 'error' ? 5_000 : 1_200);
    return () => window.clearTimeout(timer);
  }, [copyReviewDraftContent, currentDraftFingerprint, draftHydrated, draftSaveConflict, draftSaveStatus, editable,
    hasUnpersistedDraftChanges, persistCopyReviewDraft, submitting, submittingImagePlan]);

  useEffect(() => {
    if (!invalidField) return;
    invalidField.focus();
    invalidField.reportValidity();
    setInvalidField(null);
  }, [invalidField]);

  useEffect(() => {
    if (!navigationGuardRef) return;
    navigationGuardRef.current = async () => {
      if (loading || submitting || submittingImagePlan || draftSaveStatus === 'saving') return false;
      if (hasUnpersistedDraftChanges && copyReviewDraftContent && currentDraftFingerprint) {
        const saved = Boolean(await persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint));
        if (!saved) toast.error('草稿保存失败，已保留当前作业，请保存成功后再切换。');
        return saved;
      }
      if (!editable && draftChanged) return confirm({ title: '离开当前作业？',
        description: '图片规划或配置的修改尚未提交，离开会丢失这些修改。', confirmLabel: '放弃修改并离开', cancelLabel: '继续编辑' });
      return true;
    };
    return () => { navigationGuardRef.current = null; };
  }, [navigationGuardRef, loading, submitting, submittingImagePlan, draftSaveStatus, hasUnpersistedDraftChanges,
    copyReviewDraftContent, currentDraftFingerprint, persistCopyReviewDraft, editable, draftChanged, confirm]);

  async function discardChanges(action: 'close' | 'refresh') {
    if (submitting || submittingImagePlan || draftSaveStatus === 'saving' || (action === 'refresh' && (loading || regeneratingImagePlan))) return;
    if (hasUnpersistedDraftChanges && !await confirm({
      title: action === 'close' ? '未保存草稿，仍要关闭？' : '未保存草稿，仍要刷新？',
      description: '最近的修改还没有写入服务器，继续操作会丢失这一小段内容。',
      confirmLabel: action === 'close' ? '放弃并关闭' : '放弃并刷新',
      cancelLabel: '继续编辑',
    })) return;
    if (action === 'close') {
      if (regeneratingImagePlan) toast.info('文案规划正在后台处理，可以关闭窗口。完成或失败后会在“后台任务”中提醒。');
      onOpenChange(false);
    }
    else await load();
  }

  async function restoreDraftVersion(item: CopyReviewDraftRecord) {
    if (!editable || submitting || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    const fingerprint = copyReviewDraftFingerprint(item.content);
    if (fingerprint !== currentDraftFingerprint && hasUnpersistedDraftChanges && !await confirm({
      title: `恢复草稿 v${item.version}？`,
      description: '当前尚未自动保存的修改会被这个历史草稿替换。恢复后会自动另存为最新草稿。',
      confirmLabel: '恢复这个版本',
      cancelLabel: '继续编辑',
    })) return;
    setDraft(item.content.draft);
    setAiDisclosureEnabled(item.content.aiDisclosureEnabled);
    setCopyOriginalScore(item.content.copyOriginalScore);
    setCopyOriginalReasons(item.content.copyOriginalReasons);
    setCopyOriginalNote(item.content.copyOriginalNote);
    setRestoredDraftId(item.id);
    setDraftSaveStatus('idle');
    setDraftSaveError('');
    setDraftSaveConflict(false);
  }

  async function restoreCurrentCopyRevision() {
    if (!editable || !savedDraft || !detail || submitting || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    const currentRating = savedCopyRatings.current;
    const content: CopyReviewDraftContent = {
      version: 1,
      draft: savedDraft,
      aiDisclosureEnabled: initialAiDisclosure(detail),
      copyOriginalScore: currentRating?.score ?? null,
      copyOriginalReasons: [...(currentRating?.reasonCodes ?? [])].sort(),
      copyOriginalNote: currentRating?.note ?? '',
    };
    if (hasUnpersistedDraftChanges && !await confirm({
      title: '恢复当前正式版本？',
      description: '尚未自动保存的修改会被替换；恢复结果随后会作为一个新草稿保存。',
      confirmLabel: '恢复正式版本',
      cancelLabel: '继续编辑',
    })) return;
    setDraft(content.draft);
    setAiDisclosureEnabled(content.aiDisclosureEnabled);
    setCopyOriginalScore(content.copyOriginalScore);
    setCopyOriginalReasons(content.copyOriginalReasons);
    setCopyOriginalNote(content.copyOriginalNote);
    setRestoredDraftId(null);
    setDraftSaveStatus('idle');
    setDraftSaveError('');
    setDraftSaveConflict(false);
  }
  const sources = revision?.content.generation?.research?.sources ?? [];
  const xiaohongshuLinks = (detail?.xiaohongshuLinks ?? []).flatMap((link) => {
    const url = safeXiaohongshuUrl(link.url);
    return url ? [{ ...link, url }] : [];
  });
  const assets = useMemo(() => {
    if (!detail) return [];
    const members = detail.assets.filter(asset => asset.imageRunId === detail.currentImageRunId);
    const images = detail.imageRuns.find(run => run.id === detail.currentImageRunId)?.result?.images;
    return images?.some(image => image.assetId) ? images.flatMap(image => {
      const asset = members.find(item => item.id === (image.deliveryAssetId ?? image.assetId));
      return asset ? [asset] : [];
    }) : members;
  }, [detail]);
  const currentImageRun = useMemo(() => detail?.imageRuns.find(
    (run) => run.id === detail.currentImageRunId,
  ) ?? null, [detail]);
  const resultImageByAssetId = useMemo(() => new Map(
    (currentImageRun?.result?.images ?? [])
      .filter((image) => Number.isSafeInteger(image.assetId))
      .map((image) => [image.assetId as number, image]),
  ), [currentImageRun]);
  const expectedImageAssetIds = (currentImageRun?.result?.images ?? [])
    .map(image => image.assetId)
    .filter((assetId): assetId is number => Number.isSafeInteger(assetId));
  const imageSetComplete = assets.length > 0 && (expectedImageAssetIds.length === 0
    || expectedImageAssetIds.every(assetId => assets.some(asset => asset.id === assetId)));
  const imageRatingComplete = imageScore !== null;
  const humanQualitySettingsUnavailable = humanQualitySettingsLoading || Boolean(humanQualitySettingsError);
  const humanRatingSettings = humanQualitySettings ?? DEFAULT_SETTINGS;
  const scoreDefinitions = humanRatingSettings.scoreDefinitions;
  const copyReasonOptions = humanRatingSettings.copyReasons;
  const imageReasonOptions = humanRatingSettings.imageReasons;
  const showCopyScoreDescriptions = humanRatingSettings.copyReviewDisplay.showScoreDescriptions;
  // Visibility is fail-closed: never flash default reasons while task-specific settings are loading or unavailable.
  const showCopyDeductionReasons = humanQualitySettings?.copyReviewDisplay.showDeductionReasons === true;
  const showImageDeductionReasons = humanQualitySettings?.imageReviewDisplay.showDeductionReasons === true;
  const copyFeedbackRequirement = showCopyDeductionReasons ? '扣分原因或评分说明' : '评分说明';
  const imageScoreDefinition = scoreDefinitions.find(definition => definition.score === imageScore);
  const imageReworkReasonRequired = showImageDeductionReasons && imageReasonOptions.length > 0;
  const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore(imageScore)
    && !imagePlanChanged && !imageConfigurationChanged;
  const copyAssessments = (detail?.humanQualityAssessments ?? []).filter(assessment => assessment.stage === 'COPY');
  const imageAssessments = (detail?.humanQualityAssessments ?? []).filter(assessment => assessment.stage === 'IMAGE'
    && assessment.imageRunId === detail?.currentImageRunId);
  const activeAsset = activeAssetIndex === null ? undefined : assets[activeAssetIndex];
  const activeResultImage = activeAsset ? resultImageByAssetId.get(activeAsset.id) : undefined;
  const selectedAsset = assets[selectedAssetIndex];
  const selectedResultImage = selectedAsset ? resultImageByAssetId.get(selectedAsset.id) : undefined;
  const selectedAssetPage = selectedResultImage?.pageIndex ?? selectedAssetIndex + 1;
  const selectedAssetAlt = selectedAsset
    ? orderedImageFileName(selectedAsset.originalName, selectedAssetPage, selectedAsset.mediaType)
    : `任务 ${detail?.id ?? ''} 第 ${selectedAssetPage} 张图片`;

  useEffect(() => {
    if (activeAssetIndex !== null && activeAssetIndex >= assets.length) setActiveAssetIndex(null);
  }, [activeAssetIndex, assets.length]);

  useEffect(() => {
    if (selectedAssetIndex >= assets.length) setSelectedAssetIndex(0);
  }, [assets.length, selectedAssetIndex]);

  useEffect(() => {
    if (draft && activePlanIndex >= draft.imagePlan.length) setActivePlanIndex(0);
  }, [activePlanIndex, draft]);

  function revealCopyEditNotice(area: CopyEditArea) {
    const message = area === 'plan' ? planEditBlockMessage : copyEditBlockMessage;
    if (!message) return;
    const now = Date.now();
    const last = lastCopyEditNoticeRef.current;
    if (last && last.area === area && last.message === message && now - last.at < 250) return;
    lastCopyEditNoticeRef.current = { area, message, at: now };
    copyEditNoticeSequenceRef.current += 1;
    setCopyEditNotice({ area, message, sequence: copyEditNoticeSequenceRef.current });
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
    setImagePlanGenerationNotice('');
  }

  function updateImagePlan(index: number, patch: Partial<ImagePlanItem>) {
    setDraft((current) => current ? {
      ...current,
      imagePlan: current.imagePlan.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...patch }
        : item),
    } : current);
    setImagePlanGenerationNotice('');
  }

  async function regenerateImagePlan(form: HTMLFormElement | null) {
    if (!detail || !revision || !draft || !editable
        || !backgroundStore || loading || submitting || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    const invalid = form ? Array.from(form.elements).find((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && element.closest<HTMLElement>('[data-review-pane]')?.dataset.reviewPane === 'copy'
      && element.willValidate && !element.validity.valid,
    ) as HTMLInputElement | HTMLTextAreaElement | undefined : undefined;
    if (invalid) {
      setMobilePane('copy');
      setInvalidField(invalid);
      setError('请先把当前标题、正文和标签填写完整，再重新生成图片文案规划。');
      return;
    }
    const tags = draft.copy.tags;
    if (tags.length < 3 || tags.length > 8
        || tags.some(tag => !/^#[^#\s]+$/u.test(tag)) || new Set(tags).size !== tags.length) {
      setMobilePane('copy');
      setError('请先填写 3–8 个不重复的标签；每个标签需以 # 开头且不能包含空格。');
      return;
    }
    if (imagePlanChanged && !await confirm({
      title: '覆盖当前图片文案规划？',
      description: '当前逐页规划已有未提交修改。继续后会调用文本模型，并用基于当前文案生成的新规划覆盖这些修改；文案本身不会改变。',
      confirmLabel: '覆盖并重新生成',
    })) return;

    const generationSequence = imagePlanGenerationRequestRef.current + 1;
    imagePlanGenerationRequestRef.current = generationSequence;
    const copy = structuredClone(draft.copy);
    setSubmittingImagePlan(true);
    setImagePlanGenerationNotice('');
    setError('');
    try {
      // Persist the exact source copy before allowing the window to close.
      if (hasUnpersistedDraftChanges && copyReviewDraftContent && currentDraftFingerprint
          && !await persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint)) return;
      const queued = await apiRequest<{ created: boolean; job: ImagePlanRegenerationJob }>(
        apiPath(`/v1/tasks/${detail.id}/regenerate-image-plan`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: createRequestId(),
            copyRevisionId: revision.id,
            copy,
          }),
        },
      );
      const job = queued.job;
      backgroundStore.track({ id: job.id, kind: 'IMAGE_PLAN', taskId: detail.id, status: job.status, payload: job });
      toast.info('文案规划已提交，可以关闭窗口。完成或失败后会在“后台任务”中提醒。');
      if (imagePlanGenerationRequestRef.current !== generationSequence) return;
      autoLoadPlanIdRef.current = job.id;
    } catch (caught) {
      if (imagePlanGenerationRequestRef.current === generationSequence) {
        setError(caught instanceof Error ? caught.message : '图片文案规划重新生成失败');
      }
    } finally {
      if (imagePlanGenerationRequestRef.current === generationSequence) setSubmittingImagePlan(false);
    }
  }

  function updateCopyOriginalScore(score: HumanScore) {
    setCopyOriginalScore(score);
    if (score === 3) {
      setCopyOriginalReasons([]);
      setCopyOriginalNote('');
    }
  }

  function toggleReason(code: string, setReasons: (update: (current: string[]) => string[]) => void) {
    setReasons(current => current.includes(code)
      ? current.filter(reason => reason !== code)
      : [...current, code]);
  }

  function updateImageScore(score: HumanScore) {
    setImageScore(score);
  }

  function toggleImageReason(code: string) {
    setImageReasons(current => current.includes(code)
      ? current.filter(reason => reason !== code)
      : [...current, code]);
  }

  function toggleProblemAsset(assetId: number) {
    setImageProblemAssetIds(current => current.includes(assetId)
      ? current.filter(id => id !== assetId)
      : [...current, assetId]);
  }

  function toggleReworkCopyField(field: 'TITLE' | 'BODY' | 'TAGS') {
    setImageReworkCopyFields(current => current.includes(field)
      ? current.filter(value => value !== field)
      : [...current, field]);
  }

  function reviewSessionId(payload: object) {
    const fingerprint = JSON.stringify(payload);
    if (reviewSessionRef.current?.fingerprint === fingerprint) return reviewSessionRef.current.id;
    const id = newReviewSessionId();
    reviewSessionRef.current = { fingerprint, id };
    return id;
  }

  async function submitCopyDecision(decision: 'SAVE' | 'APPROVE' | 'DISCARD', form: HTMLFormElement) {
    if (!detail || !revision || !draft || !editable || loading || submitting
        || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    if (decision !== 'DISCARD' && imagePlanChanged) {
      setMobilePane('plan');
      setError('图片文案规划有未保存修改。请先单独保存图片规划，再提交只针对文案的评分或审核结果。');
      return;
    }
    if (!isCopyRework && decision === 'SAVE' && copyOriginalScore === 1) {
      setError('机器原稿评为 1 分时只能评分并废弃，不能保存为待修改。');
      return;
    }
    if (!copyRatingComplete) {
      setError(`请完成机器原稿初评；低于 3 分时，${copyFeedbackRequirement}至少填写一项。`);
      return;
    }
    if (decision === 'APPROVE' && !canApproveCopy) {
      setError(isCopyRework
        ? '返工稿尚未实际修改标题、正文或标签，不能提交强制复检。请按返工原因完成修改。'
        : copyOriginalScore === 2 || copyOriginalScore === 2.5
        ? '原稿为 2 分或 2.5 分时，请先修改标题、正文或标签；人工确认达标后，系统会将最终修改稿记录为 3 分。'
        : '当前原稿评分不能提交为达标，请按评分结果处理。');
      return;
    }
    if (decision === 'DISCARD' && copyOriginalScore !== 1) {
      setError('只有当前文案评为 1 分时才能从审核弹窗废弃任务。');
      return;
    }
    // Validate every mounted page, then reveal the first invalid field before focusing it.
    const invalid = decision === 'DISCARD' ? undefined : Array.from(form.elements).find((element) =>
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
    const submittedScore = isCopyRework || decision === 'APPROVE' && hasEditedCopyVersion ? 3 : copyOriginalScore;
    if ((!embedded || decision === 'DISCARD') && !await confirm({
      title: decision === 'APPROVE'
        ? isCopyRework ? '确认返工文案达标并提交强制复检？' : '确认文案达标并进入后续流程？'
        : decision === 'DISCARD' ? '评分并废弃这条任务？' : '保存评分与当前修改？',
      description: decision === 'APPROVE'
        ? isCopyRework
          ? `${revision.reworkOrigin === 'QA_RETURN' || detail.mandatoryCopyQcOrigin === 'QA_RETURN' ? '抽检返工' : '终审返工'}稿已实际修改标题、正文或标签。人工确认达标后，系统将最终稿记录为 3 分并提交强制复检；复检通过后才会进入待生图队列。原稿评分和返工原因继续保留。`
          : hasEditedCopyVersion
          ? `机器原稿评分 ${copyOriginalScore} 分及其原因会原样保留；人工确认达标后，系统将当前最终修改稿记录为 3 分，并按任务策略进入文案抽检或待生图队列。`
          : `机器原稿评分为 ${submittedScore} 分。系统会保存审核结果，并按任务策略进入文案抽检或待生图队列。`
        : decision === 'DISCARD'
          ? '当前文案评分为 1 分。任务会被标记为已废弃，历史文案、执行记录与评分仍会保留。'
          : `机器原稿评分为 ${submittedScore} 分。系统会保存评分${draftChanged ? '和人工修订版本' : ''}，任务继续留在文案审核。`,
      confirmLabel: decision === 'APPROVE'
        ? isCopyRework ? '提交强制复检' : '提交审核结果'
        : decision === 'DISCARD' ? '评分并废弃' : '保存待修改',
      ...(decision === 'DISCARD' ? { tone: 'danger' as const } : {}),
    })) return;
    setSubmitting(true);
    setError('');
    try {
      if (draftChanged) await requireImageControls();
      const requestPayload = buildCopyReviewSubmission({
        revisionId: revision.id,
        nodeId,
        decision,
        draft,
        draftChanged,
        copyContentChanged,
        copyContentChangedFromMachine,
        copyRework: isCopyRework,
        originalScore: copyOriginalScore,
        originalReasons: copyOriginalReasons,
        originalNote: copyOriginalNote,
        aiDisclosureEnabled,
      });
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      reviewSessionRef.current = null;
      await onUpdated(decision === 'APPROVE'
        ? isCopyRework
          ? '返工稿已记录为最终 3 分并提交强制复检；复检通过后才会进入待生图队列。'
          : hasEditedCopyVersion
          ? '机器原稿评分已保留，最终修改稿已按 3 分提交；任务将按策略进入文案抽检或待生图队列。'
          : '文案审核结果已提交；任务将按策略进入文案抽检或待生图队列。'
        : decision === 'DISCARD' ? '文案评分已保存，任务已废弃。'
          : '文案评分与当前修改已保存，任务继续留在文案审核。', decision === 'SAVE' ? undefined : detail.id);
      if (decision === 'APPROVE' || decision === 'DISCARD') onOpenChange(false);
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文案评分提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCopyReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitCopyDecision('APPROVE', event.currentTarget);
  }

  async function discardReturnedCopy() {
    if (!detail || !revision || !canDiscardReturnedCopy || submitting || loading || regeneratingImagePlan) return;
    const followsQaRecommendation = revision.reworkRecommendation === 'DISCARD';
    const note = await requestText({
      title: followsQaRecommendation ? '确认质检建议并废弃任务' : '废弃质检返工任务',
      description: followsQaRecommendation
        ? '质检人员建议废弃。请记录你的确认依据，原质检结论、文案版本和执行历史都会保留。'
        : '这是质检打回后的业务处置，不会把原质检结论改为通过。请说明继续返工不合适的原因。',
      label: '废弃说明（必填）',
      placeholder: followsQaRecommendation
        ? '例如：已核对质检问题，继续返工无法满足本次选题要求'
        : '例如：核心方向无法修正，继续返工成本过高',
      confirmLabel: '填写完成，继续确认',
      maxLength: 1_000,
      required: true,
    });
    if (!note) return;
    if (!await confirm({
      title: '确认废弃这条质检返工作业？',
      description: `${draftChanged ? '当前未提交的返工修改不会保存。' : ''}任务将标记为已废弃并退出返工与强制复检流程；历史文案、质检记录和执行记录仍会保留。`,
      confirmLabel: '确认废弃',
      tone: 'danger',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/discard-returned-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: createRequestId(),
          expectedCopyRevisionId: revision.id,
          sourceSamplingItemId: revision.reworkSamplingItemId,
          reasonCode: followsQaRecommendation ? 'QA_RECOMMENDATION' : 'UNRECOVERABLE_QUALITY',
          note,
        }),
      });
      await onUpdated(`任务 #${detail.id} 已在保留质检记录的前提下废弃。`, detail.id);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '废弃质检返工任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function saveImagePlan(form: HTMLFormElement) {
    if (!detail || !revision || !draft || !savedDraft || !editable || !imagePlanChanged
        || loading || submitting || regeneratingImagePlan) return;
    const invalid = Array.from(form.elements).find((element) =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      && element.closest<HTMLElement>('[data-review-pane]')?.dataset.reviewPane === 'plan'
      && element.willValidate && !element.validity.valid,
    ) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
    if (invalid) {
      setMobilePane('plan');
      const page = invalid.closest<HTMLElement>('[data-plan-index]')?.dataset.planIndex;
      if (page !== undefined) {
        const index = Number(page);
        setActivePlanIndex(index);
        if (invalid.id === `review-plan-prompt-${index}`) setExpandedPrompts(current => [...new Set([...current, index])]);
      }
      setInvalidField(invalid);
      return;
    }
    const pendingDraft = draft;
    const pendingRating = {
      score: copyOriginalScore,
      reasons: copyOriginalReasons,
      note: copyOriginalNote,
      aiDisclosureEnabled,
    };
    const requestPayload = {
      revisionId: revision.id,
      nodeId,
      decision: 'SAVE_PLAN',
      edits: {
        copy: savedDraft.copy,
        imagePlan: draft.imagePlan,
        imageSettings: savedDraft.imageSettings,
      },
    };
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      reviewSessionRef.current = null;
      await onUpdated('图片文案规划已单独保存；文案评分与审核状态保持不变。');
      await load();
      setDraft(current => current ? {
        ...current,
        copy: pendingDraft.copy,
        imageSettings: pendingDraft.imageSettings,
      } : current);
      setCopyOriginalScore(pendingRating.score);
      setCopyOriginalReasons(pendingRating.reasons);
      setCopyOriginalNote(pendingRating.note);
      setAiDisclosureEnabled(pendingRating.aiDisclosureEnabled);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片文案规划保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function requireImageControls({ imagePlanEdits = false } = {}) {
    try {
      const capability = await apiRequest<{ version: number; reviewImagePlanEdits?: boolean }>(apiPath(`/v1/tasks/${detail!.id}/image-capabilities`));
      if (capability.version !== 1 || imagePlanEdits && capability.reviewImagePlanEdits !== true) throw new Error('unsupported');
    } catch {
      throw new Error(imagePlanEdits
        ? '中心服务尚未支持审核后修正图片文案规划，请更新中心与网页端后再提交。'
        : '中心服务尚未支持图片配置，请更新中心与图片执行机后再提交。');
    }
  }

  async function reviseImages(operation: 'REPROCESS' | 'REGENERATE') {
    if (!detail || !revision || !draft || !canModifyImages || submitting) return;
    if (operation === 'REPROCESS' && !isAdmin) return;
    if (imagePlanChanged) {
      setError('图片文案规划已有修改。请先完成本轮图片评分，再使用底部“重试生图”保存新规划并重新生成。');
      return;
    }
    if (operation === 'REGENERATE' && !await confirm({
      title: '重新生成整套图片？',
      description: `保留已审核文案，按配置中的布局种类重新生成全部 ${draft.imagePlan.length} 张图片。会产生模型费用，旧版图片保留。`,
      confirmLabel: '确认费用并生成整套',
    })) return;
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
      await onUpdated(operation === 'REPROCESS' ? '格式与背景修改已进入图片队列，不调用模型。' : '已进入图片队列，将按配置随机选择布局。', detail.id);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '图片修改提交失败'); }
    finally { setSubmitting(false); }
  }

  async function resumeImages() {
    if (!detail || !canResumeImages || submitting || loading) return;
    if (!await confirm({ title: '从失败步骤继续生图？',
      description: '沿用原配置和已审核文案，复用已完成的规划、图片与检查点，只继续未完成步骤。原执行机离线时需等待其恢复；检查点缺失会明确报错。',
      confirmLabel: '继续未完成步骤' })) return;
    setSubmitting(true); setError('');
    try {
      await resumeImageTask(detail.id);
      await onUpdated('任务已等待原执行机从失败步骤继续。');
      onOpenChange(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '断点续跑提交失败'); }
    finally { setSubmitting(false); }
  }

  async function retryCopy() {
    if (!detail || !canRetryCopy || submitting || loading) return;
    if (!await confirm({
      title: '重新生成这条文案？',
      description: '任务会回到共享文案队列，使用最新提示词、知识库和生产配置，等待任一有空闲容量的执行机领取。正在进行的旧执行将作废。',
      confirmLabel: '重试',
    })) return;
    setSubmitting(true); setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/retry`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLatestConfig: true }),
      });
      await onUpdated(`任务 #${detail.id} 已回到共享文案队列，等待空闲执行机领取。`);
      onOpenChange(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重新生成文案失败'); }
    finally { setSubmitting(false); }
  }

  async function adminDirectApproveCopyQa() {
    if (!detail || role !== 'ADMIN' || detail.state !== 'COPY_QC_PENDING' || submitting || loading) return;
    const note = await requestText({
      title: '填写质检通过原因',
      description: '本次说明将写入质检记录，作为管理员单独通过当前文案的审计依据。',
      label: '通过原因（必填）',
      placeholder: '请说明当前文案符合质检要求的具体依据',
      confirmLabel: '填写完成，继续',
      maxLength: 1_000,
    });
    if (!note) return;
    if (!await confirm({
      title: '单独通过这条文案质检？',
      description: '本次通过当前已抽中的文案。仍须等待该人员批次的全部质检与强制复检完成；系统记录通过原因。',
      confirmLabel: '记录质检通过',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/admin-direct-copy-qa`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: createRequestId(),
          note,
          expectedCopyRevisionId: detail.currentCopyRevisionId,
        }),
      });
      await onUpdated(`任务 #${detail.id} 已记录文案质检通过，批次关卡全部完成后进入生图。`);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '单独通过文案质检失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitImageReview(decision: 'APPROVE' | 'REWORK' | 'DISCARD', reworkTarget?: 'COPY' | 'IMAGE' | 'BOTH') {
    if (!detail || !canReviewImages || submitting) return;
    if (decision === 'REWORK' && !reworkTarget) return;
    if (decision === 'REWORK') {
      if (imageReworkReasonRequired && imageReasons.length === 0) {
        setError('发起返工前请至少选择一项问题原因。');
        return;
      }
      if (!imageReviewNote.trim()) {
        setError('发起返工前请填写明确、可执行的修改要求。');
        return;
      }
      if (['COPY', 'BOTH'].includes(reworkTarget!) && imageReworkCopyFields.length === 0) {
        setError('文案返工请至少选择标题、正文或标签中的一项。');
        return;
      }
      if (['IMAGE', 'BOTH'].includes(reworkTarget!) && imageProblemAssetIds.length === 0) {
        setError('图片返工请至少选择一个问题页。');
        return;
      }
    }
    if (imagePlanChanged && (!revision || !draft)) {
      setError('当前图片文案规划版本不可用，请刷新后重试。');
      return;
    }
    if (!imageRatingComplete) {
      setError('请先完成整套图片人工评分。');
      return;
    }
    if (decision === 'APPROVE' && !canApproveImages) {
      setError(!imageSetComplete
        ? '当前图集不完整，不能审核通过；请刷新核对、重试生图或废弃。'
        : imagePlanChanged
          ? '图片文案规划尚未应用，不能审核通过；请使用重试生图保存新规划并重新生成。'
        : imageConfigurationChanged
          ? '图片配置尚未应用，不能审核通过。'
          : '当前图片评分未高于 2 分，可以重试或废弃，但不能审核通过。');
      return;
    }
    if (decision === 'REWORK' && reworkTarget !== 'COPY' && imageConfigurationChanged) {
      setError('交付格式或背景配置尚未应用。请先提交图片配置，或刷新恢复后再发起图片返工。');
      return;
    }
    const targetLabel = reworkTarget === 'COPY' ? '文案' : reworkTarget === 'IMAGE' ? '图片' : '文案和图片';
    const option = decision === 'APPROVE'
      ? { title: '确认图片质检通过？', description: `当前整套图片人工评分为 ${imageScore} 分。通过后任务进入交付池，才可下载完整资源。`, confirmLabel: '通过到交付池' }
      : decision === 'REWORK'
        ? { title: `确认发起${targetLabel}返工？`, description: `当前整套图片人工评分为 ${imageScore} 分。只退回${targetLabel}环节；历史版本、图片与评分记录全部保留。`, confirmLabel: `确认${targetLabel}返工` }
        : { title: '废弃这条图文任务？', description: `当前整套图片人工评分为 ${imageScore} 分。任务会移出业务列表，历史文案、执行记录、图片与评分仍会保留。`, confirmLabel: '确认废弃', tone: 'danger' as const };
    if (!await confirm(option)) return;
    setSubmitting(true);
    setError('');
    try {
      if (decision === 'REWORK' && reworkTarget !== 'COPY' && imagePlanChanged) await requireImageControls({ imagePlanEdits: true });
      const requestPayload = {
        imageRunId: detail.currentImageRunId,
        decision,
        ...(decision === 'REWORK' ? { reworkTarget } : {}),
        score: imageScore,
        reasons: decision === 'APPROVE' && imageScore === 3 ? [] : imageReasons,
        problemAssetIds: decision === 'APPROVE' && imageScore === 3 ? [] : imageProblemAssetIds,
        note: decision === 'APPROVE' && imageScore === 3 ? '' : imageReviewNote.trim(),
        ...(decision === 'REWORK' ? { copyFields: imageReworkCopyFields } : {}),
        ...(decision === 'REWORK' && reworkTarget !== 'COPY' && imagePlanChanged ? {
          revisionId: revision!.id,
          nodeId,
          imagePlan: draft!.imagePlan,
        } : {}),
      };
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/review-images`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      reviewSessionRef.current = null;
      await onUpdated(decision === 'APPROVE' ? '图片质检通过，任务已进入交付池。'
        : decision === 'REWORK' ? `${targetLabel}返工已发起；历史版本与评分继续保留。`
          : '任务已废弃。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片审核提交失败');
    } finally { setSubmitting(false); }
  }

  async function submitImageSelfReview() {
    if (!detail || !canSubmitImageSelfReview || !detail.currentImageRunId || submitting) return;
    if (pendingImageEdits.length > 0) {
      setError(`当前图片版本还有 ${pendingImageEdits.length} 个待处理的图片修改。请点击“修改图片”，在历史记录中逐项采用、拒绝或取消后再提交图片初审。`);
      return;
    }
    if (imagePlanChanged || imageConfigurationChanged) {
      setError('图片规划或交付配置还有未应用修改，请先重新生成或转换图片，再提交图片初审。');
      return;
    }
    if (!imageSetComplete) {
      setError('当前图集不完整，不能提交图片初审。');
      return;
    }
    if (!await confirm({
      title: '确认完成图片初审？',
      description: '提交后将按管理员设置进入图片抽检；若未开启图片抽检则直接进入交付池。初审不需要评分或填写打回原因。',
      confirmLabel: '提交图片抽检',
    })) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/submit-image-self-review`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageRunId: detail.currentImageRunId,
          reviewSessionId: createRequestId(),
        }),
      });
      await onUpdated('图片初审已完成；系统已按图片抽检策略进入质检等待或交付池。', detail.id);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片初审提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  const imageActions = selectedAsset && detail && <div className="workbench-image-review-title-actions">
    <ImagePreviewBackgroundControl value={previewBackdrop} onChange={setPreviewBackdrop} />
    {canModifyImages && ['MANUAL_ARCHIVE','IMAGE_REWORK_PENDING','REVIEWED'].includes(detail.state) && detail.currentImageRunId && detail.currentCopyRevisionId && <CurrentImageEditor
      key={`${detail.currentImageRunId}-${selectedAsset.id}`} taskId={detail.id} runId={detail.currentImageRunId}
      copyRevisionId={detail.currentCopyRevisionId} asset={selectedAsset} assets={assets} page={selectedAssetIndex + 1}
      runs={detail.imageRuns} onChanged={load} />}
  </div>;
  const imagePosition = selectedAsset && <div className="workbench-image-review-current">
    <div><strong>第 {selectedAssetPage} / {assets.length} 页</strong><span>{selectedResultImage?.provider === 'deepseek-web-image-simulation'
      ? '联网搜索模拟图'
      : selectedResultImage?.provider === 'deterministic-fallback-simulation'
        ? '本地流程联调兜底图'
        : selectedAssetAlt}</span></div>
    {selectedResultImage?.source?.pageUrl && <a href={selectedResultImage.source.pageUrl} target="_blank" rel="noreferrer">{selectedResultImage.source.title || '查看图片来源'}</a>}
  </div>;
  const imageSettingsPanel = draft && canModifyImages && <Disclosure className="workbench-review-section">
    <DisclosureTrigger>交付格式与背景</DisclosureTrigger>
    <DisclosureContent>
      <ImageSettingsEditor value={draft.imageSettings} disabled={isCopyOnlyFinalRework || submitting} onChange={imageSettings => setDraft(current => current ? { ...current, imageSettings } : current)} />
      <Button unstyled className="button" type="button" disabled={submitting || !assets.length} onClick={() => void reviseImages('REPROCESS')}>仅转换格式 / 背景（不调用模型）</Button>
    </DisclosureContent>
  </Disclosure>;
  const imageHistory = detail && <ImageHistoryCompare runs={detail.imageRuns} currentRunId={detail.currentImageRunId} assets={detail.assets}
    onRestore={canModifyImages && !submitting ? settings => setDraft(current => current ? { ...current, imageSettings: settings } : current) : undefined} />;

  return <TaskReviewFrame embedded={embedded} open={taskId !== null} onOpenChange={(open) => { if (!open) void discardChanges('close'); }}>
      <ToastFeedback id="task-review-copy-edit" message={copyEditNotice?.message ?? ''}
        revision={copyEditNotice?.sequence} tone="info" />
      <header className="workbench-review-heading">
        <div>
          <span className="section-kicker">Task {detail ? `#${detail.id}` : ''}</span>
          <ReviewTitle>{detail?.state === 'REVIEWED'
            ? role === 'USER' ? '已完成任务详情' : '交付池任务详情'
            : detail?.state === 'MANUAL_ARCHIVE' ? '图片初审详情'
            : detail?.state === 'IMAGE_REWORK_PENDING' ? '图片返修详情' : embedded ? '文案作业' : '任务详情与审核'}</ReviewTitle>
          <ReviewDescription>{detail?.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
            ? '机器文案已生成；请先在任务列表分配负责人，再开始人工评分与审核。'
            : detail?.state === 'COPY_REVIEW_PENDING' && !canReviewCopy
            ? '任务已分配给其他负责人；你可以查看生成结果，但不能评分、编辑或提交审核结果。'
            : detail?.state === 'MANUAL_ARCHIVE'
            ? canHandleAssignedImages
              ? '图片已经生成；请逐页核对并按需使用完整图片编辑功能，确认后提交图片初审。'
              : isAdmin
                ? '图片初审由任务负责人完成；如需代办，请先将任务改派给自己。'
                : '图片初审由任务负责人完成；审核员请在独立图片质检池处理抽中项。'
            : detail?.state === 'IMAGE_REWORK_PENDING'
              ? canHandleAssignedImages
                ? '图片已被质检打回；请按要求修改并采用新版本，再重新提交初审和强制复检。'
                : isAdmin
                  ? '图片正由任务负责人返修；如需代办，请先将任务改派给自己。'
                  : '图片正由任务负责人返修；新版本提交后将在图片质检池进行强制复检。'
            : detail?.state === 'REVIEWED' ? role === 'USER'
              ? '任务已经完成，可查看最终内容。'
              : downloadable
                ? '图片质检与交付门禁均已通过，可查看详情并下载完整资源包。'
                : '图片质检与交付门禁均已通过，可查看任务详情。'
            : detail?.state === 'COPY_QC_PENDING' && detail.currentStage === 'QC_MANDATORY_RECHECK'
              ? '返工稿已提交强制复检；复检通过后才会进入待生图队列。当前内容仅供查看。'
            : detail?.state === 'COPY_QC_PENDING'
              ? '当前最终稿正在等待文案质检；质检完成后才会进入待生图队列。当前内容仅供查看。'
            : detail?.state === 'COPY_FAILED'
              ? '文案生成失败；请核对失败阶段与调用记录，然后使用下方“重试文案”重新进入共享队列。'
            : detail?.state === 'COPY_RUNNING'
              ? '文案仍在执行；确认当前执行已经异常或需要作废时，可使用下方“重试文案”重新进入共享队列。'
            : '先给机器原稿评分；2 分或 2.5 分可修改正文，图片文案规划不受评分档位影响。'}</ReviewDescription>
          {revision?.approvalMode === 'ADMIN_BYPASS' && <p role="status">管理员免审核 · 当前文案已自动放行生图</p>}
        </div>
        <div className="workbench-row-actions">
          {detail && <PrioritySummary task={detail} />}
          {detail && role === 'ADMIN' && <TaskPriorityControl tasks={[detail]} onChanged={() => load()} />}
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
              disabled={!editable || isCopyOnlyFinalRework || loading || submitting || regeneratingImagePlan}
              onChange={(event) => setAiDisclosureEnabled(event.target.checked)}
            />
            <span className="workbench-ai-disclosure-switch" aria-hidden="true" />
            <span className="workbench-ai-disclosure-label">AI生成水印</span>
            <strong>{aiDisclosureEnabled ? '已开启' : '已关闭'}</strong>
          </label>}
          <Button unstyled className="button small" type="button" disabled={loading || submitting || regeneratingImagePlan} onClick={() => { void discardChanges('refresh'); }}>
            <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />刷新
          </Button>
        </div>
        {imageWorkMode && <div className="workbench-image-work-toolbar" role="group" aria-label="当前图片操作">{imagePosition}{imageActions}</div>}
      </header>

      {loading && !detail
        ? <div className="workbench-review-loading"><LoaderCircle className="animate-spin" size={22} />正在读取任务详情…</div>
        : detail && <form className="workbench-review-form" data-comparing={editable} data-image-review={isImageReviewView} data-work-layout={imageWorkMode ? 'image' : undefined} noValidate onSubmit={submitCopyReview}>
          {editable && <div className="workbench-review-pane-switch" aria-label="切换审核内容">
            <Button unstyled type="button" aria-pressed={mobilePane === 'copy'} aria-controls="review-copy-pane" onClick={() => setMobilePane('copy')}>文案</Button>
            <Button unstyled type="button" aria-pressed={mobilePane === 'plan'} aria-controls="review-plan-pane" onClick={() => setMobilePane('plan')}>图片文案规划</Button>
          </div>}
          <div className="workbench-review-scroll" data-mobile-pane={mobilePane}>
            <div id="review-copy-pane" className="workbench-review-pane" data-review-pane="copy">
              {!editable && !isImageReviewView && currentImageRun && <TaskQualitySummary result={currentImageRun.result}
                onShowImages={assets.length ? () => { imageSectionRef.current?.scrollIntoView({ block: 'start' }); imageSectionRef.current?.focus({ preventScroll: true }); } : undefined} />}
              {!imageWorkMode && <section className="workbench-review-section workbench-copy-review-section">
                <div className="workbench-review-section-title"><span>{isImageReviewView ? '02' : '01'}</span><div><h3>{isImageReviewView ? '已审文案对照' : '标题、正文与标签'}</h3><p>{editable
                  ? isCopyRework
                    ? '按返工原因修改标题、正文或标签；无需重新评分。实际修改后提交强制复检，复检通过后才会进入待生图队列。'
                    : '先评价机器原稿，再决定提交达标审核结果或修改。'
                  : isImageReviewView
                    ? '文案已完成前序审核，保留标题、正文与标签用于核对图片表达。'
                  : detail.currentStage === 'QC_MANDATORY_RECHECK'
                    ? '返工稿已提交强制复检；复检通过后才会进入待生图队列。'
                    : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                <div className="workbench-review-query" aria-label="原始需求">
                  <strong>原始需求</strong>
                  <div className="workbench-review-query-text">{detail.query}</div>
                  {role !== 'USER' && <span>词包：{detail.sourceQueryPackageName || '未归属词包'}</span>}
                </div>
                {detail.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
                  && <div className="notice warning" role="status">文案已生成，但任务尚未分配负责人。请先关闭窗口并完成分配，再进行评分或修改。</div>}
                {detail.state === 'COPY_REVIEW_PENDING' && taskHasAssignee && !canReviewCopy
                  && <div className="notice warning" role="status">当前任务由其他负责人处理；这里仅提供只读查看。</div>}
                {editable && isCopyRework && <div className="notice warning" role="status"><strong>{revision?.reworkOrigin === 'QA_RETURN' || detail.mandatoryCopyQcOrigin === 'QA_RETURN' ? '文案抽检返工' : '图片质检文案返工'}</strong>{revision?.reworkRecommendation === 'DISCARD' ? ' · 质检建议废弃' : ''}{revision?.reworkReasonCodes?.length ? ` · 原因：${revision.reworkReasonCodes.join('、')}` : ''}{revision?.reworkNote ? ` · 要求：${revision.reworkNote}` : ''}<br />{revision?.reworkRecommendation === 'DISCARD' ? '可以继续返工，也可以由当前任务负责人确认废弃；质检建议本身不会直接终止任务。' : '返工稿必须实际修改标题、正文或标签；仅保存不会提交复检。人工确认达标后，系统将最终稿记录为 3 分并提交强制复检；复检通过后才会进入待生图队列。'}</div>}
                {isImageRetryExhausted(detail) && <div className="notice warning" role="status">{IMAGE_RETRY_EXHAUSTED_LABEL}</div>}
                {detail.error && <div className="notice error" role="alert">{detail.error}</div>}
                {editable && <Disclosure className={styles.panel}>
                  <DisclosureTrigger className={styles.trigger}>
                    <span><History size={16} /><strong>审核草稿</strong></span>
                    <small>{draftSaveStatus === 'saving'
                      ? '正在保存…'
                      : draftSaveStatus === 'error'
                        ? '保存失败'
                        : hasUnpersistedDraftChanges
                          ? '等待自动保存'
                          : lastDraftSavedAt
                            ? `已保存 ${new Date(lastDraftSavedAt).toLocaleString('zh-CN', { hour12: false })}`
                            : '修改后自动保存到服务器'}</small>
                  </DisclosureTrigger>
                  <DisclosureContent className={styles.content}>
                    <div className={styles.actions}>
                      <div>
                        <strong>服务器草稿历史</strong>
                        <small>按当前文案版本和你的账号独立保存，服务或网页重启后仍可恢复。</small>
                      </div>
                      <Button unstyled className="button small" type="button"
                        disabled={regeneratingImagePlan || !hasUnpersistedDraftChanges || draftSaveStatus === 'saving' || !copyReviewDraftContent || !currentDraftFingerprint}
                        onClick={() => {
                          if (copyReviewDraftContent && currentDraftFingerprint) {
                            void persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint);
                          }
                        }}>
                        {draftSaveStatus === 'saving' ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />}
                        立即保存
                      </Button>
                      <Button unstyled className="button small" type="button"
                        disabled={regeneratingImagePlan || draftSaveStatus === 'saving'} onClick={() => { void restoreCurrentCopyRevision(); }}>
                        <RotateCcw size={14} />恢复正式版本
                      </Button>
                    </div>
                    {draftSaveError && <div className="notice error" role="alert">{draftSaveError}</div>}
                    {draftHistory.length > 0
                      ? <ol className={styles.history}>{draftHistory.map(item => <li key={item.id} data-current={item.id === restoredDraftId}>
                        <div>
                          <strong>草稿 v{item.version}</strong>
                          <span>{item.content.draft.copy.title || '未填写标题'}</span>
                          <small>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small>
                        </div>
                        <Button unstyled className="button small" type="button"
                          disabled={regeneratingImagePlan || draftSaveStatus === 'saving' || item.id === restoredDraftId && copyReviewDraftFingerprint(item.content) === currentDraftFingerprint}
                          onClick={() => { void restoreDraftVersion(item); }}>
                          {item.id === restoredDraftId && copyReviewDraftFingerprint(item.content) === currentDraftFingerprint ? '当前版本' : '恢复'}
                        </Button>
                      </li>)}</ol>
                      : <div className={styles.empty}>还没有历史草稿。开始修改后会自动生成第一个版本。</div>}
                  </DisclosureContent>
                </Disclosure>}
                {draft ?
                <div className="workbench-copy-fields" data-edit-blocked={Boolean(copyEditBlockMessage)}
                  onPointerDownCapture={() => { copyEditPointerAtRef.current = Date.now(); }}
                  onClickCapture={() => revealCopyEditNotice('copy')}
                  onFocusCapture={() => { if (Date.now() - copyEditPointerAtRef.current > 500) revealCopyEditNotice('copy'); }}>
                  <div className="field full">
                    <label htmlFor="review-copy-title">标题 <small>{draft.copy.title.length}/25</small></label>
                    <Input id="review-copy-title" className="input" value={draft.copy.title} maxLength={25} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('title', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-body">正文 <small>{[...draft.copy.body].length}/400–600</small></label>
                    <ReviewScrollTextarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={copyFieldsReadOnly}
                      resizeToken={mobilePane === 'copy'} onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <Input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div> : <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}
                {showCopyRating && <div className="human-rating-panel" aria-label="文案人工评分">
                  {!editable && <p className="human-rating-config-status" role="status">评分模块当前为只读。请确认任务已分配给当前账号，并刷新任务详情后再评分。</p>}
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <CopyMachineDraftScoreField
                    id={`copy-original-score-${detail.id}`}
                    legend={currentCopyRatingLabel}
                    value={copyOriginalScore}
                    showDescriptions={showCopyScoreDescriptions}
                    disabled={!editable || loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current) || copyContentChanged}
                    onChange={(score) => { updateCopyOriginalScore(score); setError(''); }}
                  />
                  {copyOriginalScore !== null && copyOriginalScore < 3 && <HumanRatingFeedback
                    id={`copy-original-${detail.id}`}
                    reasonOptions={copyReasonOptions}
                    reasons={copyOriginalReasons}
                    note={copyOriginalNote}
                    notePlaceholder={humanRatingSettings.noteGuidance.copyPlaceholder}
                    showReasonOptions={showCopyDeductionReasons}
                    disabled={!editable || loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current)}
                    onToggleReason={(code) => { toggleReason(code, setCopyOriginalReasons); setError(''); }}
                    onNoteChange={(note) => { setCopyOriginalNote(note); setError(''); }}
                  />}
                  {copyOriginalScore !== null && <p className="human-rating-guidance" role="status">
                    {copyOriginalScore === 1
                      ? `填写${copyFeedbackRequirement}后，只能评分并废弃任务。`
                      : copyOriginalScore === 2
                        ? `已解锁标题、正文与标签编辑；${originalCopyRatingComplete ? '修改完成后可提交审核结果' : `提交前请填写${copyFeedbackRequirement}`}。人工确认达标后，系统将最终修改稿记录为 3 分，原评分保持不变。`
                      : copyOriginalScore === 2.5
                        ? `请完成必要的小修；${originalCopyRatingComplete ? '修改完成后可提交审核结果' : `提交前请填写${copyFeedbackRequirement}`}。人工确认达标后，系统将最终修改稿记录为 3 分，原评分保持不变。`
                        : '原稿已达标，可直接提交审核结果；后续将按任务策略进入文案抽检或待生图队列。'}
                  </p>}
                </div>}
                {!editable && copyAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>当前文案人工评分</span>
                  <HumanScoreBadge score={copyAssessments.at(-1)!.score}
                    passingScores={copyAssessments.at(-1)!.ratingContext === 'ORIGINAL'
                      ? COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores : undefined} />
                </div>}
                {editable && canApproveCopy && <div className="workbench-final-score-card" role="status" aria-label="最终稿评分">
                  <div><span>最终稿评分</span><HumanScoreBadge score={3} passingScores={COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores} /></div>
                  <p>{copyOriginalScore === 3 && !copyContentChanged
                    ? '机器原稿已达标，本次审核结果为 3 分。'
                    : '提交达标后系统自动把最终修改稿记录为 3 分，并保留机器原稿评分与原因。'}</p>
                </div>}
                {editable && copyContentChanged && <div className="notice success" role="status">{isCopyRework
                  ? '返工稿无需再次评分；提交强制复检时，系统会将最终稿记录为 3 分。复检通过后才会进入待生图队列。'
                  : '最终修改稿无需再次评分；提交达标审核结果时，系统会将其记录为 3 分，机器原稿评分和原因继续保留。'}</div>}
                <HumanAssessmentHistory assessments={copyAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={copyReasonOptions}
                  originalScorePresentation={COPY_MACHINE_DRAFT_SCORE_PRESENTATION}
                  showScoreDescriptions={showCopyScoreDescriptions} showReasonOptions={showCopyDeductionReasons} />
              </section>}
              {!imageWorkMode && !editable && <ReviewReferences detail={detail} sources={sources} xiaohongshuLinks={xiaohongshuLinks} />}
            {!imageWorkMode && <VisualPlanSummary value={currentImageRun?.result?.visualPlan?.value} />}
            {!imageWorkMode && currentImageRun?.result?.visualPlan?.warning?.message && !currentImageRun?.result?.simulation?.enabled
              && <p className="notice warning">{currentImageRun.result.visualPlan.warning.message}</p>}
            {(assets.length > 0 || canReviewImages) && <section className="workbench-review-section workbench-image-review-section" data-image-primary={isImageReviewView} ref={imageSectionRef} tabIndex={-1} aria-label="当前图片审核">
              {!imageWorkMode && <div className="workbench-review-section-title workbench-image-review-section-title">
                <div className="workbench-image-review-title-main">
                  <span>{isImageReviewView ? '01' : '02'}</span>
                  <div><h3>{isImageReviewView ? detail.state === 'IMAGE_REWORK_PENDING' ? '图片返修' : '图片初审' : '图片审核'}</h3><p>{isImageReviewView
                    ? detail.state === 'IMAGE_REWORK_PENDING' ? '图片质检已打回；任务负责人可使用完整图片编辑能力，采用新版本后再完成初审。' : '由任务负责人逐页核对并修改；确认完成后提交图片抽检。'
                    : '核对当前图片运行生成的完整图集。'}</p></div>
                  {imageActions}
                </div>
              </div>}
              {!imageWorkMode && assets.length === 0 && <p className="notice warning">当前没有可预览的图片，请刷新核对，或选择重试生图、废弃。</p>}
              {!imageWorkMode && currentImageRun?.result?.simulation?.enabled && <div className="notice warning">
                {currentImageRun.result.visualPlan?.warning?.message
                  ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}
              </div>}
              <div className="workbench-image-review-gallery">
                {imageWorkMode && assets.length === 0 && <p className="notice warning">当前没有可预览的图片，请刷新核对，或选择重新生成图片。</p>}
                {selectedAsset && <>
                  <ImageCarouselNavigation
                    currentIndex={selectedAssetIndex}
                    total={assets.length}
                    onPrevious={() => setSelectedAssetIndex(index => Math.max(0, index - 1))}
                    onNext={() => setSelectedAssetIndex(index => Math.min(assets.length - 1, index + 1))}
                  >
                    <Button unstyled className={`workbench-image-review-stage preview-background-${previewBackdrop}`} type="button" aria-label={`放大查看第 ${selectedAssetPage} 页：${selectedAssetAlt}`}
                      onClick={event => { previewTriggerRef.current = event.currentTarget; setActiveAssetIndex(selectedAssetIndex); }}>
                      <img src={apiPath(selectedAsset.url)} alt={selectedAssetAlt} decoding="async" />
                      <span>完整图 · 点击放大</span>
                    </Button>
                  </ImageCarouselNavigation>
                  {!imageWorkMode && imagePosition}
                </>}
                {assets.length > 0 && <nav className="workbench-image-review-thumbnails" aria-label="选择审核图片">
                  {assets.map((asset, index) => {
                    const resultImage = resultImageByAssetId.get(asset.id);
                    const pageIndex = resultImage?.pageIndex ?? index + 1;
                    const alt = orderedImageFileName(asset.originalName, pageIndex, asset.mediaType);
                    return <Button unstyled className="workbench-image-review-thumbnail" type="button" key={asset.id}
                      data-selected={selectedAssetIndex === index} aria-pressed={selectedAssetIndex === index}
                      aria-label={`选择第 ${pageIndex} 页：${alt}`} onClick={() => setSelectedAssetIndex(index)}>
                      <img src={apiPath(asset.url)} alt="" loading={index === 0 ? 'eager' : 'lazy'} decoding="async" />
                      <span><strong>{String(pageIndex).padStart(2, '0')}</strong>{IMAGE_KIND_LABELS[draft?.imagePlan[index]?.kind ?? 'detail']}</span>
                    </Button>;
                  })}
                </nav>}
              </div>
              <aside className="workbench-image-review-decision" aria-label={imageWorkMode ? '图片操作与信息' : '图片终审结论'}>
                {imageWorkMode && <>
                  {detail.error && <p className="notice error" role="alert">{detail.error}</p>}
                  {isImageRetryExhausted(detail) && <p className="notice warning" role="status">{IMAGE_RETRY_EXHAUSTED_LABEL}</p>}
                  {currentImageRun?.result?.simulation?.enabled && <p className="notice warning">{currentImageRun.result.visualPlan?.warning?.message
                    ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}</p>}
                  {currentImageRun?.result?.visualPlan?.warning?.message && !currentImageRun.result.simulation?.enabled
                    && <p className="notice warning">{currentImageRun.result.visualPlan.warning.message}</p>}
                </>}
                {isImageReviewView && currentImageRun && <TaskQualitySummary compact result={currentImageRun.result} />}
                {canReviewImages && <div className="human-rating-panel human-image-rating" aria-label="整套图片人工评分">
                  {!imageSetComplete && <p className="notice warning" role="status">当前图集文件不完整，不能审核通过。请刷新核对，或评分后选择重试生图、废弃。</p>}
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <HumanScoreField
                    id={`image-score-${detail.id}-${detail.currentImageRunId}`}
                    legend="整套图片评分"
                    value={imageScore}
                    scoreDefinitions={scoreDefinitions}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                    onChange={(score) => { updateImageScore(score); setError(''); }}
                  />
                  {imageScore !== null && <div className="human-rating-followup">
                    <HumanRatingFeedback
                      id={`image-${detail.id}-${detail.currentImageRunId}`}
                      reasonOptions={imageReasonOptions}
                      reasons={imageReasons}
                      note={imageReviewNote}
                      notePlaceholder={humanRatingSettings.noteGuidance.imagePlaceholder}
                      showReasonOptions={showImageDeductionReasons}
                      feedbackRequired={false}
                      reasonRequirement="发起返工时至少选择一项"
                      noteLabel="评分说明 / 修改要求"
                      noteRequirement="发起返工时必填"
                      disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                      onToggleReason={(code) => { toggleImageReason(code); setError(''); }}
                      onNoteChange={(note) => { setImageReviewNote(note); setError(''); }}
                    />
                    {['COPY', 'BOTH'].includes(imageReworkTarget) && <fieldset>
                      <legend>文案返工字段 <span>发起文案返工时至少选择一项</span></legend>
                      <div className="human-rating-pages">
                        {([['TITLE', '标题'], ['BODY', '正文'], ['TAGS', '标签']] as const).map(([field, label]) => <label key={field} data-selected={imageReworkCopyFields.includes(field)}>
                          <Checkbox
                            checked={imageReworkCopyFields.includes(field)}
                            disabled={loading || submitting || Boolean(savedImageAssessment)}
                            onChange={() => toggleReworkCopyField(field)}
                          />
                          <span>{label}</span>
                        </label>)}
                      </div>
                    </fieldset>}
                    {assets.length > 0 && <fieldset>
                      <legend>问题页 <span>发起图片返工时至少选择一页</span></legend>
                      <div className="human-rating-pages">
                        {assets.map((asset, index) => {
                          const pageIndex = resultImageByAssetId.get(asset.id)?.pageIndex ?? index + 1;
                          return <label key={asset.id} data-selected={imageProblemAssetIds.includes(asset.id)}>
                            <Checkbox
                              checked={imageProblemAssetIds.includes(asset.id)}
                              disabled={loading || submitting || Boolean(savedImageAssessment)}
                              onChange={() => toggleProblemAsset(asset.id)}
                            />
                            <span>第 {pageIndex} 页</span>
                          </label>;
                        })}
                      </div>
                    </fieldset>}
                  </div>}
                  {imageScore !== null && <p className="human-rating-guidance" role="status">
                    {imageScoreDefinition && <><strong>{imageScoreDefinition.title}</strong> · {imageScoreDefinition.description}。 </>}
                    {isPassingHumanScore(imageScore)
                      ? '已达到放行标准，也可根据需要重试或废弃。'
                      : '未达到放行标准，请选择重试生图或废弃。'}
                  </p>}
                  <HumanAssessmentHistory assessments={imageAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={imageReasonOptions} showReasonOptions={showImageDeductionReasons} />
                </div>}
                {!canReviewImages && imageAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>{imageWorkMode && detail.state === 'IMAGE_REWORK_PENDING' ? '返工要求与评分记录' : '当前图集人工评分'}</span>
                  <HumanScoreBadge score={imageAssessments.at(-1)!.score} />
                  <HumanAssessmentHistory assessments={imageAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={imageReasonOptions} showReasonOptions={showImageDeductionReasons} />
                </div>}
                {!canReviewImages && imageAssessments.length === 0 && isImageReviewView && <p className="notice">{canHandleAssignedImages
                  ? detail.state === 'IMAGE_REWORK_PENDING' ? '请完成返修并采用新图片版本；系统随后回到图片初审，提交后固定进入强制图片复检。' : '请逐页核对图片。需要调整时可直接编辑或重新生成；确认无误后在底部提交图片抽检。'
                  : isAdmin ? '当前任务由其他负责人处理；如需代办，请先将任务改派给自己。' : '图片初审由任务负责人完成；审核员在独立图片质检池处理抽中项。'}</p>}
                {currentImageRun?.result?.processing?.type === 'LOCAL' && <p className="notice warning">此版本已在本地转换格式或背景，未重新调用模型验收，请检查文字对比和透明边缘后审核。</p>}
                {imageConfigurationChanged && <p className="notice warning">格式与背景配置尚未应用，当前预览仍是已有成品。请先提交转换或重新生图，或刷新恢复已保存的配置。</p>}
                {pendingImageEdits.length > 0 && <p className="notice warning" role="status"><strong>还有 {pendingImageEdits.length} 个待处理的图片修改。</strong> 请点击“修改图片”，在历史记录中逐项采用、拒绝或取消；全部处理后才能提交图片抽检。</p>}
                <div className="workbench-image-review-preference"><ImagePreviewPreference /></div>
                {imageWorkMode && <>{imageSettingsPanel}{imageHistory}</>}
              </aside>
              {activeAsset && activeAssetIndex !== null && <ImagePreview
                hideTrigger
                isOpen
                restoreFocusRef={previewTriggerRef}
                src={apiPath(activeAsset.url)}
                alt={orderedImageFileName(activeAsset.originalName, activeAssetIndex + 1, activeAsset.mediaType)}
                sourceSrc={activeResultImage?.sourceUrl ? apiPath(activeResultImage.sourceUrl) : undefined}
                deliverySrc={activeResultImage?.deliveryUrl ? apiPath(activeResultImage.deliveryUrl) : undefined}
                format={activeResultImage?.imageSettings?.format}
                transparency={activeResultImage?.transparency}
                position={activeAssetIndex + 1}
                total={assets.length}
                backdrop={previewBackdrop}
                onBackdropChange={setPreviewBackdrop}
                preloads={assets.slice(Math.max(0, activeAssetIndex - 1), activeAssetIndex + 2).filter(asset => asset.id !== activeAsset.id).map(asset => apiPath(asset.url))}
                onClose={() => { if (imageWorkMode) setSelectedAssetIndex(activeAssetIndex); setActiveAssetIndex(null); }}
                onPrevious={activeAssetIndex > 0 ? () => setActiveAssetIndex(index => index === null ? null : index - 1) : undefined}
                onNext={activeAssetIndex < assets.length - 1 ? () => setActiveAssetIndex(index => index === null ? null : index + 1) : undefined}
              />}
            </section>}

            {!imageWorkMode && imageHistory}
            </div>

            {draft && !imageWorkMode && <div id="review-plan-pane" className="workbench-review-pane" data-review-pane="plan">
              <section className="workbench-review-section workbench-image-plan-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '03' : '02'}</span><div><h3>图片文案规划</h3><p>{canEditApprovedImagePlan
                  ? '可修正逐页文字与画面指令；页面类型保持锁定，评分后重试会创建新的人工批准版本。'
                    : editable ? '逐页核对画面文字与排版；修改后单独保存，不受文案评分档位影响。'
                    : '当前状态仅供核对已审核的图片文案规划。'}</p></div>
                  {editable && <Button unstyled className="button small workbench-image-plan-regenerate" type="button"
                    disabled={loading || submitting || regeneratingImagePlan}
                    title="调用文本模型，根据当前文案重新生成全部逐页规划"
                    onClick={(event) => { void regenerateImagePlan(event.currentTarget.form); }}>
                    {regeneratingImagePlan
                      ? <><LoaderCircle className="animate-spin" size={14} />执行机生成中…</>
                      : <><RefreshCw size={14} />按当前文案重新生成规划</>}
                  </Button>}
                </div>
                {imagePlanGenerationNotice && <div className="notice success" role="status">{imagePlanGenerationNotice}</div>}
                {backgroundPlan && !backgroundPlan.consumed && <div className="notice" role="status">
                  {backgroundTaskMessage(backgroundPlan)}
                  {completedPlan && !canLoadCompletedPlan && ' 当前文案或版本与生成时不同，请按当前文案重新生成规划。'}
                  {canLoadCompletedPlan && appliedPlanIdRef.current !== completedPlan?.id && <Button unstyled className="button small" type="button"
                    disabled={loading || submitting || draftSaveStatus === 'saving'} onClick={() => { void (async () => {
                      if (imagePlanChanged && !await confirm({ title: '载入已完成的新规划？', description: '载入后会替换当前逐页规划；文案内容保持不变。', confirmLabel: '载入新规划' })) return;
                      loadCompletedPlan();
                    })(); }}>载入新规划</Button>}
                </div>}
                <nav className="workbench-image-plan-nav" aria-label="图片规划页码">
                  <Button unstyled className="workbench-image-plan-nav-button" type="button" aria-label="上一页" disabled={activePlanIndex === 0}
                    onClick={() => setActivePlanIndex(index => Math.max(0, index - 1))}><ChevronLeft size={16} /><span>上一页</span></Button>
                  <div className="workbench-image-plan-current" aria-live="polite">
                    <div><strong>第 {activePlanIndex + 1} / {draft.imagePlan.length} 页</strong><span>{IMAGE_KIND_LABELS[draft.imagePlan[activePlanIndex]?.kind] ?? '未设置类型'}</span></div>
                    <p>{draft.imagePlan[activePlanIndex]?.headline || '未填写页面标题'}</p>
                  </div>
                  <Button unstyled className="workbench-image-plan-nav-button" type="button" aria-label="下一页" disabled={activePlanIndex >= draft.imagePlan.length - 1}
                    onClick={() => setActivePlanIndex(index => Math.min(draft.imagePlan.length - 1, index + 1))}><span>下一页</span><ChevronRight size={16} /></Button>
                </nav>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => <article id={`review-plan-page-${index}`} className="workbench-image-plan-card" key={index} data-plan-index={index} hidden={activePlanIndex !== index}>
                    <div className="workbench-image-plan-fields" data-edit-blocked={Boolean(planEditBlockMessage)}
                      onPointerDownCapture={(event) => {
                        if (!(event.target as Element).closest('[data-edit-reminder-exempt]')) copyEditPointerAtRef.current = Date.now();
                      }}
                      onClickCapture={(event) => {
                        if (!(event.target as Element).closest('[data-edit-reminder-exempt]')) revealCopyEditNotice('plan');
                      }}
                      onFocusCapture={(event) => {
                        if (Date.now() - copyEditPointerAtRef.current > 500 && !(event.target as Element).closest('[data-edit-reminder-exempt]')) revealCopyEditNotice('plan');
                      }}>
                      <div className="field">
                        <label htmlFor={`review-plan-kind-${index}`}>页面类型 <small>{index === 0 ? '首图固定' : '影响页面版式'}</small></label>
                        <Select value={item.kind} disabled={planKindDisabled || index === 0} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind, layout: { mode: 'AUTO' } })}>
                          <SelectTrigger id={`review-plan-kind-${index}`} aria-describedby={`review-plan-kind-help-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.filter((kind) => index === 0 ? kind === 'hero' : kind !== 'hero').map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                        <small id={`review-plan-kind-help-${index}`} className="workbench-image-plan-kind-help">{index === 0
                          ? '首图必须为封面。'
                          : '用于匹配可用版式；切换后将自动重新匹配布局。'}</small>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <Input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题 <small>选填</small></label>
                        <Input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small>每行一条，2–5 条</small></label>
                        <AutosizeTextarea id={`review-plan-bullets-${index}`} className="textarea workbench-plan-bullets-editor" value={item.bullets.join('\n')} required readOnly={planFieldsReadOnly}
                          resizeToken={activePlanIndex === index} onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <Disclosure className="field full" open={expandedPrompts.includes(index)} onOpenChange={open => setExpandedPrompts(current => open ? [...current, index] : current.filter(value => value !== index))}>
                        <DisclosureTrigger data-edit-reminder-exempt>画面生成指令</DisclosureTrigger>
                        <DisclosureContent>
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <Textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { prompt: event.target.value })} />
                        </DisclosureContent>
                      </Disclosure>
                      <Disclosure className="field full workbench-page-layout-disclosure">
                        <DisclosureTrigger data-edit-reminder-exempt>
                          页面排版 <em>{item.layout?.mode === 'CUSTOM' ? '自定义' : '自动匹配'}</em>
                        </DisclosureTrigger>
                        <DisclosureContent>
                          <div className="field">
                            <label htmlFor={`review-plan-layout-mode-${index}`}>排版方式</label>
                            <Select value={item.layout?.mode === 'CUSTOM' ? 'CUSTOM' : 'AUTO'} disabled={planFieldsReadOnly}
                              onValueChange={(mode: 'AUTO' | 'CUSTOM') => updateImagePlan(index, { layout: { mode } })}>
                              <SelectTrigger id={`review-plan-layout-mode-${index}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="AUTO">自动匹配版式</SelectItem>
                                <SelectItem value="CUSTOM">自定义排版</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {item.layout?.mode === 'CUSTOM' && <PageLayoutEditor kind={item.kind} value={item.layout}
                            disabled={planFieldsReadOnly} onChange={(layout) => updateImagePlan(index, { layout })} />}
                        </DisclosureContent>
                      </Disclosure>
                    </div>
                  </article>)}
                </div>
              </section>
              {editable && <ReviewReferences detail={detail} sources={sources} xiaohongshuLinks={xiaohongshuLinks} />}
              {imageSettingsPanel}
              {role === 'ADMIN' && <ModelCallTrace key={detail.id} taskId={detail.id} />}
            </div>}
            {!draft && role === 'ADMIN' && <ModelCallTrace key={detail.id} taskId={detail.id} />}
          </div>

          <footer className="workbench-review-footer">
            {error && <div className="notice error workbench-review-footer-error" role="alert">{error}</div>}
            <span><strong className="workbench-review-dirty" role="status">{hasUnsavedChanges
              ? hasUnpersistedDraftChanges || draftSaveStatus === 'saving' ? '有未保存草稿 · ' : '草稿已保存，尚未提交 · '
              : ''}</strong>{imageWorkMode ? `当前图集 · ${assets.length} 页` : editable
              ? copyContentChanged ? `保存后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'} · 等待评分决定`
              : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              {embedded ? <Button unstyled className="button" type="button" disabled={submitting || submittingImagePlan || draftSaveStatus === 'saving'} onClick={() => onOpenChange(false)}>暂跳过</Button>
                : <DialogClose asChild><Button unstyled className="button" type="button" disabled={submitting || submittingImagePlan || draftSaveStatus === 'saving'}>{regeneratingImagePlan && !submittingImagePlan ? '关闭，后台继续处理' : '关闭'}</Button></DialogClose>}
              {embedded && editable && <Button unstyled className="button" type="button" disabled={submitting || loading || draftSaveStatus === 'saving' || !hasUnpersistedDraftChanges}
                onClick={() => { if (copyReviewDraftContent && currentDraftFingerprint) void persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint); }}><Save size={15} />保存草稿</Button>}
              {canModifyImages && <Button unstyled className="button primary" type="button" disabled={submitting} onClick={() => void reviseImages('REGENERATE')}><RotateCcw size={15} />重新生成图片</Button>}
              {canRetryCopy && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void retryCopy(); }}><RotateCcw size={15} />重试文案</Button>}
              {role === 'ADMIN' && detail.state === 'COPY_QC_PENDING'
                && <Button unstyled className="button primary" type="button" disabled={submitting || loading}
                  onClick={() => { void adminDirectApproveCopyQa(); }}>
                  <CheckCircle2 size={15} />{submitting ? '正在提交…' : '通过文案质检'}
                </Button>}
              {canResumeImages && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void resumeImages(); }}><RotateCcw size={15} />从失败步骤继续</Button>}
              {canSubmitImageSelfReview && <Button unstyled className="button primary" type="button"
                disabled={submitting || loading || !imageSetComplete || imagePlanChanged || imageConfigurationChanged || pendingImageEdits.length > 0}
                onClick={() => { void submitImageSelfReview(); }}><CheckCircle2 size={15} />
                {submitting ? '正在提交…' : embedded ? '提交并下一条' : '初审完成，提交图片抽检'}</Button>}
              {canReviewImages && <>
                <Button unstyled className="button danger" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('DISCARD'); }}><Trash2 size={15} />废弃</Button>
                <div className="workbench-image-rework-control">
                  <Select value={imageReworkTarget} disabled={submitting || loading} onValueChange={(value: 'COPY' | 'IMAGE' | 'BOTH') => setImageReworkTarget(value)}>
                    <SelectTrigger aria-label="返工范围"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IMAGE">仅图片返工</SelectItem>
                      <SelectItem value="COPY">仅文案返工</SelectItem>
                      <SelectItem value="BOTH">文案 + 图片返工</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('REWORK', imageReworkTarget); }}><RotateCcw size={15} />发起返工</Button>
                </div>
                <Button unstyled className="button primary" type="button" disabled={submitting || loading || !canApproveImages} onClick={() => { void submitImageReview('APPROVE'); }}><CheckCircle2 size={15} />{submitting ? '正在提交…' : '通过到交付池'}</Button>
              </>}
              {editable && <>
                {imagePlanChanged && <Button unstyled className="button" type="button" disabled={submitting || loading || regeneratingImagePlan}
                  onClick={(event) => { if (event.currentTarget.form) void saveImagePlan(event.currentTarget.form); }}>
                  <Save size={15} />{submitting ? '正在保存…' : '单独保存图片规划'}
                </Button>}
                {canDiscardReturnedCopy && <Button unstyled className="button danger" type="button"
                  disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving'} onClick={() => { void discardReturnedCopy(); }}>
                  <Trash2 size={15} />{revision?.reworkRecommendation === 'DISCARD' ? '确认质检建议并废弃' : '废弃返工任务'}
                </Button>}
                {!isCopyRework && copyOriginalScore === 1 && <Button unstyled className="button danger" type="button" disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !copyRatingComplete} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('DISCARD', event.currentTarget.form); }}><Trash2 size={15} />评分并废弃</Button>}
                {(isCopyRework || copyOriginalScore !== 1) && <Button unstyled className="button" type="button" disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !copyRatingComplete || isCopyRework && !draftChanged} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('SAVE', event.currentTarget.form); }}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : isCopyRework ? '保存返工稿，暂不提交复检' : '保存评分，暂不提交'}
                </Button>}
                <Button unstyled className="button primary" type="submit" disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !canApproveCopy}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />{embedded ? isCopyRework ? '提交复检并下一条' : '提交并下一条' : isCopyRework ? '提交强制复检' : '审核通过并进入后续流程'}</>}
                </Button>
              </>}
            </div>
          </footer>
        </form>}

      {error && !detail && <div className="notice error workbench-review-error" role="alert">{error}</div>}
  </TaskReviewFrame>;
}
