'use client';
import { VisualPlanSummary } from '../components/visual-plan-summary';

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
import { TransientInfoBubble } from '@/components/ui/transient-info-bubble';

import { apiRequest } from '../components/api-client';
import { resumeImageTask } from '../components/resume-image-task';
import { canResumeImageTask } from '../../src/control-plane/image-resume.mjs';
import { TaskQualitySummary } from './task-quality-summary';
import { ModelCallTrace } from './model-call-trace';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../../src/control-plane/image-retry-status.mjs';
import { ImagePreview, ImagePreviewThumbnail } from '../components/image-preview';
import { ImagePreviewPreference } from '../components/image-preview-preference';
import { ImageSettingsEditor, defaultImageSettings, type ImageSettings, type PageLayout } from '../components/image-controls';
import { ImageHistoryCompare, type ImageArtifactInfo } from '../components/image-history-compare';
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

type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_QC_PENDING' | 'COPY_FAILED'
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
  reworkReasonCodes?: string[];
  reworkNote?: string | null;
};
type TaskDetail = {
  id: number;
  query: string;
  assignedToUserId?: string | null;
  assignedToAccountId?: number | null;
  aiDisclosureEnabled: boolean;
  mandatoryCopyQc?: boolean;
  mandatoryCopyQcOrigin?: 'QA_RETURN' | 'FINAL_REWORK' | null;
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
  if (score === 3) return '当前稿评为 3 分，已达到直接放行标准，无需修改。';
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
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function TaskReviewDialog({
  taskId,
  nodeId,
  role,
  currentUsername,
  currentAccountId,
  onOpenChange,
  onUpdated,
}: {
  taskId: number | null;
  nodeId: string;
  role: string;
  currentUsername: string;
  currentAccountId: number;
  onOpenChange: (open: boolean) => void;
  onUpdated: (message: string) => void | Promise<void>;
}) {
  const confirm = useConfirmDialog();
  const {
    settings: humanQualitySettings,
    loading: humanQualitySettingsLoading,
    error: humanQualitySettingsError,
  } = useHumanQualitySettings(taskId);
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
  const [copyOriginalScore, setCopyOriginalScore] = useState<HumanScore | null>(null);
  const [copyOriginalReasons, setCopyOriginalReasons] = useState<string[]>([]);
  const [copyOriginalNote, setCopyOriginalNote] = useState('');
  const [imageScore, setImageScore] = useState<HumanScore | null>(null);
  const [imageReasons, setImageReasons] = useState<string[]>([]);
  const [imageProblemAssetIds, setImageProblemAssetIds] = useState<number[]>([]);
  const [imageReviewNote, setImageReviewNote] = useState('');
  const [invalidField, setInvalidField] = useState<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const [copyEditNotice, setCopyEditNotice] = useState<{ area: CopyEditArea; message: string; sequence: number } | null>(null);
  const loadRequestRef = useRef(0);
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
      setDetail(next);
      setDraft(draftFromRevision(currentRevision(next)));
      setCopyOriginalScore(copyRatings.current?.score ?? null);
      setCopyOriginalReasons(copyRatings.current?.reasonCodes ?? []);
      setCopyOriginalNote(copyRatings.current?.note ?? '');
      setImageScore(imageAssessment?.score ?? null);
      setImageReasons(imageAssessment?.reasonCodes ?? []);
      setImageProblemAssetIds(imageAssessment?.problemAssetIds ?? []);
      setImageReviewNote(imageAssessment?.note ?? '');
      reviewSessionRef.current = null;
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
    setCopyOriginalScore(null);
    setCopyOriginalReasons([]);
    setCopyOriginalNote('');
    setImageScore(null);
    setImageReasons([]);
    setImageProblemAssetIds([]);
    setImageReviewNote('');
    setCopyEditNotice(null);
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
    return () => { loadRequestRef.current += 1; };
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
  const canReviewCopy = isAdmin || role === 'REVIEWER' || currentUserIsAssignee;
  const hasOwnerControl = isAdmin || currentUserIsAssignee;
  const editable = taskHasAssignee && canReviewCopy && detail?.state === 'COPY_REVIEW_PENDING'
    && Boolean(revision && draft);
  const isCopyRework = Boolean(detail?.mandatoryCopyQc
    || ['QA_RETURN', 'FINAL_REWORK'].includes(revision?.revisionOrigin ?? '')
    || revision?.reworkOrigin);
  const savedCopyRatings = detail ? copyRatingsFromDetail(detail) : { current: undefined };
  const originalCopyRatingComplete = ratingFeedbackComplete(copyOriginalScore, copyOriginalReasons, copyOriginalNote);
  const copyFieldsEditable = editable && (isCopyRework || copyOriginalScore === 2 || copyOriginalScore === 2.5);
  const copyFieldsReadOnly = !copyFieldsEditable || loading || submitting;
  const copyContentChangedFromMachine = revision?.copyContentChangedFromMachine === true;
  const hasEditedCopyVersion = copyContentChanged || copyContentChangedFromMachine;
  const copyReworkSatisfied = copyContentChanged || revision?.copyReworkSatisfied === true;
  const copyRatingComplete = isCopyRework || originalCopyRatingComplete;
  const canApproveCopy = isCopyRework ? copyReworkSatisfied : copyRatingComplete && (copyOriginalScore === 3 && !copyContentChanged
    || (copyOriginalScore === 2 || copyOriginalScore === 2.5) && hasEditedCopyVersion);
  const longQuery = Boolean(detail && (detail.query.length > 100 || detail.query.split('\n').length > 3));
  const canReviewImages = detail?.state === 'MANUAL_ARCHIVE'
    && (isAdmin || role === 'REVIEWER' && taskHasAssignee) && Boolean(detail.currentImageRunId);
  const downloadable = detail?.state === 'REVIEWED' && detail.deliveryStatus === 'READY'
    && role !== 'REVIEWER' && (isAdmin || currentUserIsAssignee);
  const canResumeImages = canResumeImageTask(detail) && hasOwnerControl && role !== 'REVIEWER';
  const canModifyImages = Boolean(detail && revision?.approvedAt && hasOwnerControl && role !== 'REVIEWER'
    && ['MANUAL_ARCHIVE', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(detail.state) && !detail.currentExecutionId);
  const canEditApprovedImagePlan = Boolean(isAdmin && canReviewImages && canModifyImages);
  const planFieldsReadOnly = !(editable || canEditApprovedImagePlan) || loading || submitting;
  const planKindDisabled = !editable || loading || submitting;
  const currentCopyRatingLabel = '机器原稿初评（保留）';
  const standardCopyEditBlockMessage = getCopyEditBlockMessage({
    editable,
    assigned: taskHasAssignee,
    canControl: canReviewCopy,
    busy: loading || submitting,
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
    busy: loading || submitting,
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

  useEffect(() => {
    setCopyEditNotice(null);
    lastCopyEditNoticeRef.current = null;
  }, [copyEditBlockMessage, planEditBlockMessage, taskId]);

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
  const showCopyDeductionReasons = humanRatingSettings.copyReviewDisplay.showDeductionReasons;
  const showImageDeductionReasons = humanRatingSettings.imageReviewDisplay.showDeductionReasons;
  const copyFeedbackRequirement = showCopyDeductionReasons ? '扣分原因或评分说明' : '评分说明';
  const imageScoreDefinition = scoreDefinitions.find(definition => definition.score === imageScore);
  const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore(imageScore)
    && !imagePlanChanged && !imageConfigurationChanged;
  const copyAssessments = (detail?.humanQualityAssessments ?? []).filter(assessment => assessment.stage === 'COPY');
  const imageAssessments = (detail?.humanQualityAssessments ?? []).filter(assessment => assessment.stage === 'IMAGE'
    && assessment.imageRunId === detail?.currentImageRunId);
  const activeAsset = activeAssetIndex === null ? undefined : assets[activeAssetIndex];
  const activeResultImage = activeAsset ? resultImageByAssetId.get(activeAsset.id) : undefined;

  useEffect(() => {
    if (activeAssetIndex !== null && activeAssetIndex >= assets.length) setActiveAssetIndex(null);
  }, [activeAssetIndex, assets.length]);

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
  }

  function updateImagePlan(index: number, patch: Partial<ImagePlanItem>) {
    setDraft((current) => current ? {
      ...current,
      imagePlan: current.imagePlan.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...patch }
        : item),
    } : current);
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
    if (score === 3) {
      setImageReasons([]);
      setImageProblemAssetIds([]);
      setImageReviewNote('');
    }
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

  function reviewSessionId(payload: object) {
    const fingerprint = JSON.stringify(payload);
    if (reviewSessionRef.current?.fingerprint === fingerprint) return reviewSessionRef.current.id;
    const id = newReviewSessionId();
    reviewSessionRef.current = { fingerprint, id };
    return id;
  }

  async function submitCopyDecision(decision: 'SAVE' | 'APPROVE' | 'DISCARD', form: HTMLFormElement) {
    if (!detail || !revision || !draft || !editable || loading || submitting) return;
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
        ? '返工稿正文尚未发生实际修改，不能提交通过；请按返工原因修改标题、正文或标签。'
        : copyOriginalScore === 2 || copyOriginalScore === 2.5
        ? '原稿为 2 分或 2.5 分时，请先修改标题、正文或标签；通过时系统会将最终修改稿记为 3 分。'
        : '当前原稿评分不能直接放行，请按评分结果处理。');
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
    if (!await confirm({
      title: decision === 'APPROVE' ? '确认文案达标并开始生图？' : decision === 'DISCARD' ? '评分并废弃这条任务？' : '保存评分与当前修改？',
      description: decision === 'APPROVE'
        ? isCopyRework
          ? `${revision.reworkOrigin === 'QA_RETURN' || detail.mandatoryCopyQcOrigin === 'QA_RETURN' ? '抽检返工' : '终审返工'}已完成实际正文修改；最终稿将自动记为 3 分，并强制进入复检。`
          : hasEditedCopyVersion
          ? `机器原稿评分 ${copyOriginalScore} 分及其原因会原样保留；当前最终修改稿将自动记为 3 分并送入全局生图队列。`
          : `机器原稿评分为 ${submittedScore} 分。系统会保存评分并将任务送入全局生图队列。`
        : decision === 'DISCARD'
          ? '当前文案评分为 1 分。任务会被标记为已废弃，历史文案、执行记录与评分仍会保留。'
          : `机器原稿评分为 ${submittedScore} 分。系统会保存评分${draftChanged ? '和人工修订版本' : ''}，任务继续留在文案审核。`,
      confirmLabel: decision === 'APPROVE' ? '确认放行' : decision === 'DISCARD' ? '评分并废弃' : '保存待修改',
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
          ? '返工稿已按最终 3 分通过，并进入强制复检。'
          : hasEditedCopyVersion
          ? '机器原稿评分已保留，最终修改稿已按 3 分放行并进入全局生图队列。'
          : '文案评分已保存并放行，任务已进入全局生图队列。'
        : decision === 'DISCARD' ? '文案评分已保存，任务已废弃。'
          : '文案评分与当前修改已保存，任务继续留在文案审核。');
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

  async function submitImageReview(decision: 'APPROVE' | 'REWORK' | 'DISCARD', reworkTarget?: 'COPY' | 'IMAGE' | 'BOTH') {
    if (!detail || !canReviewImages || submitting) return;
    if (decision === 'REWORK' && !reworkTarget) return;
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
      ? { title: '确认图文终审通过？', description: `当前整套图片人工评分为 ${imageScore} 分。通过后任务进入交付池，才可下载完整资源。`, confirmLabel: '通过到交付池' }
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
        reasons: imageScore === 3 ? [] : imageReasons,
        problemAssetIds: imageScore === 3 ? [] : imageProblemAssetIds,
        note: imageScore === 3 ? '' : imageReviewNote.trim(),
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
      await onUpdated(decision === 'APPROVE' ? '图文终审通过，任务已进入交付池。'
        : decision === 'REWORK' ? `${targetLabel}返工已发起；历史版本与评分继续保留。`
          : '任务已废弃。');
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片审核提交失败');
    } finally { setSubmitting(false); }
  }

  return <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) void discardChanges('close'); }}>
    <DialogContent className="workbench-review-dialog">
      <TransientInfoBubble message={copyEditNotice?.message ?? null}
        announcementKey={copyEditNotice?.sequence} onDismiss={() => setCopyEditNotice(null)} />
      <header className="workbench-review-heading">
        <div>
          <span className="section-kicker">Task {detail ? `#${detail.id}` : ''}</span>
          <DialogTitle>{detail?.state === 'REVIEWED' ? '交付池任务详情' : detail?.state === 'MANUAL_ARCHIVE' ? '图文终审详情' : '任务详情与审核'}</DialogTitle>
          <DialogDescription>{detail?.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
            ? '机器文案已生成；请先在任务列表分配负责人，再开始人工评分与审核。'
            : detail?.state === 'COPY_REVIEW_PENDING' && !canReviewCopy
            ? '任务已分配给其他负责人；你可以查看生成结果，但不能评分、编辑或放行。'
            : detail?.state === 'MANUAL_ARCHIVE'
            ? '核对完整图文并完成人工评分，再明确选择通过到交付池、文案返工、图片返工、文案和图片返工，或废弃。'
            : detail?.state === 'REVIEWED' ? '图文终审与交付门禁均已通过，可查看详情并下载完整资源包。'
            : '先给机器原稿评分；2 分或 2.5 分可修改正文，图片文案规划不受评分档位影响。'}</DialogDescription>
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
              {!editable && currentImageRun && <TaskQualitySummary result={currentImageRun.result}
                onShowImages={assets.length ? () => { imageSectionRef.current?.scrollIntoView({ block: 'start' }); imageSectionRef.current?.focus({ preventScroll: true }); } : undefined} />}
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>01</span><div><h3>标题、正文与标签</h3><p>{editable ? isCopyRework ? '按返工原因直接修改正文；无需重评机器初稿，实际修改后最终稿自动按 3 分提交强制复检。' : '先评价机器原稿，再决定直接放行或修改。' : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                {detail.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
                  && <div className="notice warning" role="status">文案已生成，但任务尚未分配负责人。请先关闭窗口并完成分配，再进行评分或修改。</div>}
                {detail.state === 'COPY_REVIEW_PENDING' && taskHasAssignee && !canReviewCopy
                  && <div className="notice warning" role="status">当前任务由其他负责人处理；这里仅提供只读查看。</div>}
                <div className="workbench-review-query">
                  <strong>Query 原文</strong>
                  <div id="review-query-text" className="workbench-review-query-text" data-expanded={queryExpanded || !longQuery}>{detail.query}</div>
                  {longQuery && <Button unstyled className="button small" type="button" aria-expanded={queryExpanded} aria-controls="review-query-text" onClick={() => setQueryExpanded(value => !value)}>{queryExpanded ? '收起原文' : '展开全文'}</Button>}
                </div>
                {editable && isCopyRework && <div className="notice warning" role="status"><strong>{revision?.reworkOrigin === 'QA_RETURN' || detail.mandatoryCopyQcOrigin === 'QA_RETURN' ? '文案抽检返工' : '图文终审文案返工'}</strong>{revision?.reworkReasonCodes?.length ? ` · 原因：${revision.reworkReasonCodes.join('、')}` : ''}{revision?.reworkNote ? ` · 要求：${revision.reworkNote}` : ''}<br />返工稿必须实际修改标题、正文或标签；保存后可继续编辑，通过时自动记为 3 分并强制复检。</div>}
                {editable && !isCopyRework && <div className="human-rating-panel" aria-label="文案人工评分">
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <CopyMachineDraftScoreField
                    id={`copy-original-score-${detail.id}`}
                    legend={currentCopyRatingLabel}
                    value={copyOriginalScore}
                    showDescriptions={showCopyScoreDescriptions}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current) || copyContentChanged}
                    onChange={(score) => { updateCopyOriginalScore(score); setError(''); }}
                  />
                  {copyOriginalScore !== null && copyOriginalScore < 3 && <HumanRatingFeedback
                    id={`copy-original-${detail.id}`}
                    reasonOptions={copyReasonOptions}
                    reasons={copyOriginalReasons}
                    note={copyOriginalNote}
                    notePlaceholder={humanRatingSettings.noteGuidance.copyPlaceholder}
                    showReasonOptions={showCopyDeductionReasons}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current)}
                    onToggleReason={(code) => { toggleReason(code, setCopyOriginalReasons); setError(''); }}
                    onNoteChange={(note) => { setCopyOriginalNote(note); setError(''); }}
                  />}
                  {copyOriginalScore !== null && <p className="human-rating-guidance" role="status">
                    {copyOriginalScore === 1
                      ? `填写${copyFeedbackRequirement}后，只能评分并废弃任务。`
                      : copyOriginalScore === 2
                        ? `已解锁标题、正文与标签编辑；${originalCopyRatingComplete ? '修改完成后可直接通过' : `提交前请填写${copyFeedbackRequirement}`}。通过时最终修改稿自动记为 3 分，原评分保持不变。`
                      : copyOriginalScore === 2.5
                          ? `请完成必要的小修；${originalCopyRatingComplete ? '修改完成后可直接通过' : `提交前请填写${copyFeedbackRequirement}`}。通过时最终修改稿自动记为 3 分，原评分保持不变。`
                          : '原稿可直接放行生图。'}
                  </p>}
                </div>}
                {!editable && copyAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>当前文案人工评分</span>
                  <HumanScoreBadge score={copyAssessments.at(-1)!.score}
                    passingScores={copyAssessments.at(-1)!.ratingContext === 'ORIGINAL'
                      ? COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores : undefined} />
                </div>}
                {isImageRetryExhausted(detail) && <div className="notice warning" role="status">{IMAGE_RETRY_EXHAUSTED_LABEL}</div>}
                {detail.error && <div className="notice error" role="alert">{detail.error}</div>}
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
                    <Textarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <Input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div> : <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}
                {editable && copyContentChanged && <div className="notice success" role="status">最终修改稿无需再次自评；点击通过时系统会自动记为 3 分，机器原稿评分和原因继续保留。</div>}
                <HumanAssessmentHistory assessments={copyAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={copyReasonOptions}
                  originalScorePresentation={COPY_MACHINE_DRAFT_SCORE_PRESENTATION}
                  showScoreDescriptions={showCopyScoreDescriptions} showReasonOptions={showCopyDeductionReasons} />
              </section>
              {sources.length > 0 && <Disclosure className="workbench-review-section workbench-review-source-disclosure">
                <DisclosureTrigger>联网资料来源 · {sources.length} 条</DisclosureTrigger>
                <DisclosureContent><div className="workbench-review-sources">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}>
                  <b>{source.title || source.siteName || `来源 ${index + 1}`}</b><small>{source.url}</small>
                </a>)}</div></DisclosureContent>
              </Disclosure>}
            <VisualPlanSummary value={currentImageRun?.result?.visualPlan?.value} />
            {currentImageRun?.result?.visualPlan?.warning?.message && !currentImageRun?.result?.simulation?.enabled
              && <p className="notice warning">{currentImageRun.result.visualPlan.warning.message}</p>}
            {(assets.length > 0 || canReviewImages) && <section className="workbench-review-section" ref={imageSectionRef} tabIndex={-1} aria-label="当前图片审核">
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
                {imageScore !== null && imageScore < 3 && <div className="human-rating-followup">
                  <HumanRatingFeedback
                    id={`image-${detail.id}-${detail.currentImageRunId}`}
                    reasonOptions={imageReasonOptions}
                    reasons={imageReasons}
                    note={imageReviewNote}
                    notePlaceholder={humanRatingSettings.noteGuidance.imagePlaceholder}
                    showReasonOptions={showImageDeductionReasons}
                    feedbackRequired={false}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                    onToggleReason={(code) => { toggleImageReason(code); setError(''); }}
                    onNoteChange={(note) => { setImageReviewNote(note); setError(''); }}
                  />
                  {assets.length > 0 && <fieldset>
                    <legend>问题页 <span>可多选，也可不选</span></legend>
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
                <span>当前图集人工评分</span>
                <HumanScoreBadge score={imageAssessments.at(-1)!.score} />
                <HumanAssessmentHistory assessments={imageAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={imageReasonOptions} showReasonOptions={showImageDeductionReasons} />
              </div>}
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
            </section>}

            <ImageHistoryCompare runs={detail.imageRuns} currentRunId={detail.currentImageRunId} assets={detail.assets}
              onRestore={isAdmin && canModifyImages && !submitting ? settings => setDraft(current => current ? { ...current, imageSettings: settings } : current) : undefined} />
            </div>

            {draft && <div id="review-plan-pane" className="workbench-review-pane" data-review-pane="plan">
              <section className="workbench-review-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '03' : '02'}</span><div><h3>图片文案规划</h3><p>{canEditApprovedImagePlan
                  ? '可修正逐页文字与画面指令；页面类型保持锁定，评分后重试会创建新的人工批准版本。'
                    : editable ? '逐页核对画面文字；规划编辑不受文案评分档位影响。'
                    : '当前状态仅供核对已审核的图片文案规划。'}</p></div></div>
                <nav className="workbench-image-plan-nav" aria-label="图片规划页码">
                  {draft.imagePlan.map((item, index) => <Button unstyled type="button" key={index} aria-pressed={activePlanIndex === index} aria-controls={`review-plan-page-${index}`} onClick={() => setActivePlanIndex(index)}>
                    <span>第 {index + 1} 页 · {IMAGE_KIND_LABELS[item.kind]}</span><strong>{item.headline || '未填写页面标题'}</strong>
                  </Button>)}
                </nav>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => <article id={`review-plan-page-${index}`} className="workbench-image-plan-card" key={index} data-plan-index={index} hidden={activePlanIndex !== index}>
                    <div className="workbench-image-plan-head"><b>第 {index + 1} 页</b><span>{IMAGE_KIND_LABELS[item.kind]}</span></div>
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
                        <label htmlFor={`review-plan-kind-${index}`}>页面类型</label>
                        <Select value={item.kind} disabled={planKindDisabled} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind, layout: { mode: 'AUTO' } })}>
                          <SelectTrigger id={`review-plan-kind-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <Input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题</label>
                        <Input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small>每行一条，2–5 条</small></label>
                        <Textarea id={`review-plan-bullets-${index}`} className="textarea" value={item.bullets.join('\n')} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <Disclosure className="field full" open={expandedPrompts.includes(index)} onOpenChange={open => setExpandedPrompts(current => open ? [...current, index] : current.filter(value => value !== index))}>
                        <DisclosureTrigger data-edit-reminder-exempt>画面生成指令</DisclosureTrigger>
                        <DisclosureContent>
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <Textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { prompt: event.target.value })} />
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
            {error && <div className="notice error workbench-review-footer-error" role="alert">{error}</div>}
            <span><strong className="workbench-review-dirty" role="status">{hasUnsavedChanges ? '有未提交内容 · ' : ''}</strong>{editable
              ? copyContentChanged ? `保存后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'} · 等待评分决定`
              : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              <DialogClose asChild><Button unstyled className="button" type="button" disabled={submitting}>关闭</Button></DialogClose>
              {canResumeImages && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void resumeImages(); }}><RotateCcw size={15} />从失败步骤继续</Button>}
              {canReviewImages && <>
                <Button unstyled className="button danger" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('DISCARD'); }}><Trash2 size={15} />废弃</Button>
                <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('REWORK', 'COPY'); }}><RotateCcw size={15} />文案返工</Button>
                <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('REWORK', 'IMAGE'); }}><RotateCcw size={15} />图片返工</Button>
                <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('REWORK', 'BOTH'); }}><RotateCcw size={15} />文案 + 图片返工</Button>
                <Button unstyled className="button primary" type="button" disabled={submitting || loading || !canApproveImages} onClick={() => { void submitImageReview('APPROVE'); }}><CheckCircle2 size={15} />{submitting ? '正在提交…' : '通过到交付池'}</Button>
              </>}
              {editable && <>
                {!isCopyRework && copyOriginalScore === 1 && <Button unstyled className="button danger" type="button" disabled={submitting || loading || !copyRatingComplete} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('DISCARD', event.currentTarget.form); }}><Trash2 size={15} />评分并废弃</Button>}
                {(isCopyRework || copyOriginalScore !== 1) && <Button unstyled className="button" type="button" disabled={submitting || loading || !copyRatingComplete || isCopyRework && !draftChanged} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('SAVE', event.currentTarget.form); }}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : isCopyRework ? '保存返工稿，暂不提交复检' : '保存评分，暂不放行'}
                </Button>}
                <Button unstyled className="button primary" type="submit" disabled={submitting || loading || !canApproveCopy}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />{isCopyRework ? '提交返工稿并强制复检' : '审核通过并开始生图'}</>}
                </Button>
              </>}
            </div>
          </footer>
        </form>}

      {error && !detail && <div className="notice error workbench-review-error" role="alert">{error}</div>}
    </DialogContent>
  </Dialog>;
}
