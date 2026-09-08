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
  HumanAssessmentHistory,
  HumanRatingFeedback,
  HumanScoreBadge,
  HumanScoreField,
  isPassingHumanScore,
  type HumanQualityAssessment,
  type HumanScore,
} from './human-quality-rating';
import { useHumanQualitySettings } from './human-quality-settings';

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
};
type TaskDetail = {
  id: number;
  query: string;
  assignedToUserId?: string | null;
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
  busy,
  score,
  ratingComplete,
  machineOriginal,
}: {
  editable: boolean;
  assigned: boolean;
  busy: boolean;
  score: HumanScore | null;
  ratingComplete: boolean;
  machineOriginal: boolean;
}) {
  if (!assigned) return '请先分配负责人，再进行文案评分和编辑。';
  if (!editable) return '当前任务不在待文案审核阶段，文案内容仅供查看。';
  if (busy) return '审核内容正在处理，请稍候再编辑。';
  if (score === null) return machineOriginal
    ? '请先完成机器原稿评分并填写反馈后再编辑'
    : '请先完成当前修改稿评分并填写反馈后再编辑';
  if (score === 1) return ratingComplete
    ? '当前稿评为 1 分，不支持编辑；请保存评分或废弃任务。'
    : '当前稿评为 1 分，不支持编辑；请填写扣分原因或评分说明后保存评分或废弃任务。';
  if (score === 3) return '当前稿评为 3 分，已达到直接放行标准，无需修改。';
  if (!ratingComplete) return `当前稿已评为 ${score} 分；请先选择扣分原因或填写评分说明后再编辑。`;
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
  const [copyEditedScore, setCopyEditedScore] = useState<HumanScore | null>(null);
  const [copyEditedReasons, setCopyEditedReasons] = useState<string[]>([]);
  const [copyEditedNote, setCopyEditedNote] = useState('');
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
      setCopyEditedScore(null);
      setCopyEditedReasons([]);
      setCopyEditedNote('');
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
    setCopyEditedScore(null);
    setCopyEditedReasons([]);
    setCopyEditedNote('');
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
  const copyMaterialChanged = Boolean(draft && savedDraft && JSON.stringify({ copy: draft.copy, imagePlan: draft.imagePlan })
    !== JSON.stringify({ copy: savedDraft.copy, imagePlan: savedDraft.imagePlan }));
  const imageConfigurationChanged = Boolean(draft && savedDraft && JSON.stringify(draft.imageSettings) !== JSON.stringify(savedDraft.imageSettings));
  const isAdmin = role === 'ADMIN';
  const taskHasAssignee = Boolean(detail
    && (!Object.hasOwn(detail, 'assignedToUserId') || detail.assignedToUserId !== null));
  const editable = taskHasAssignee && detail?.state === 'COPY_REVIEW_PENDING'
    && Boolean(revision && draft);
  const originalCopyRatingComplete = ratingFeedbackComplete(copyOriginalScore, copyOriginalReasons, copyOriginalNote);
  const copyFieldsEditable = editable && originalCopyRatingComplete
    && (copyOriginalScore === 2 || copyOriginalScore === 2.5);
  const fieldsReadOnly = !copyFieldsEditable || loading || submitting;
  const effectiveCopyScore = copyMaterialChanged ? copyEditedScore : copyOriginalScore;
  const effectiveCopyReasons = copyMaterialChanged ? copyEditedReasons : copyOriginalReasons;
  const effectiveCopyNote = copyMaterialChanged ? copyEditedNote : copyOriginalNote;
  const copyRatingComplete = originalCopyRatingComplete
    && ratingFeedbackComplete(effectiveCopyScore, effectiveCopyReasons, effectiveCopyNote);
  const canApproveCopy = copyRatingComplete && isPassingHumanScore(effectiveCopyScore);
  const longQuery = Boolean(detail && (detail.query.length > 100 || detail.query.split('\n').length > 3));
  const canReviewImages = detail?.state === 'MANUAL_ARCHIVE'
    && ['ADMIN', 'REVIEWER'].includes(role) && Boolean(detail.currentImageRunId);
  const downloadable = detail && ['MANUAL_ARCHIVE', 'REVIEWED'].includes(detail.state);
  const canResumeImages = canResumeImageTask(detail) && role !== 'REVIEWER';
  const canModifyImages = Boolean(detail && revision?.approvedAt && role !== 'REVIEWER'
    && ['MANUAL_ARCHIVE', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(detail.state) && !detail.currentExecutionId);
  const savedCopyRatings = detail ? copyRatingsFromDetail(detail) : { current: undefined };
  const currentCopyRatingLabel = revision?.executionId === null ? '当前修改稿评分' : '机器原稿初评';
  const copyEditBlockMessage = getCopyEditBlockMessage({
    editable,
    assigned: taskHasAssignee,
    busy: loading || submitting,
    score: copyOriginalScore,
    ratingComplete: originalCopyRatingComplete,
    machineOriginal: revision?.executionId !== null,
  });
  const savedImageAssessment = detail ? imageAssessmentFromDetail(detail) : undefined;
  const copyRatingChanged = editable && (copyOriginalScore !== (savedCopyRatings.current?.score ?? null)
    || JSON.stringify(copyOriginalReasons) !== JSON.stringify(savedCopyRatings.current?.reasonCodes ?? [])
    || copyOriginalNote !== (savedCopyRatings.current?.note ?? '')
    || copyEditedScore !== null || copyEditedReasons.length > 0 || copyEditedNote.length > 0);
  const imageRatingChanged = canReviewImages && (imageScore !== (savedImageAssessment?.score ?? null)
    || JSON.stringify(imageReasons) !== JSON.stringify(savedImageAssessment?.reasonCodes ?? [])
    || JSON.stringify(imageProblemAssetIds) !== JSON.stringify(savedImageAssessment?.problemAssetIds ?? [])
    || imageReviewNote !== (savedImageAssessment?.note ?? ''));
  const hasUnsavedChanges = editable
    ? draftChanged || aiDisclosureEnabled || copyRatingChanged
    : imageConfigurationChanged || imageRatingChanged;

  useEffect(() => {
    setCopyEditNotice(null);
    lastCopyEditNoticeRef.current = null;
  }, [copyEditBlockMessage, taskId]);

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
  const imageRatingComplete = ratingFeedbackComplete(imageScore, imageReasons, imageReviewNote);
  const humanQualitySettingsUnavailable = humanQualitySettingsLoading || Boolean(humanQualitySettingsError);
  const copyReasonOptions = humanQualitySettings?.copyReasons ?? [];
  const imageReasonOptions = humanQualitySettings?.imageReasons ?? [];
  const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore(imageScore)
    && !imageConfigurationChanged;
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
    if (!copyEditBlockMessage) return;
    const now = Date.now();
    const last = lastCopyEditNoticeRef.current;
    if (last && last.area === area && last.message === copyEditBlockMessage && now - last.at < 250) return;
    lastCopyEditNoticeRef.current = { area, message: copyEditBlockMessage, at: now };
    copyEditNoticeSequenceRef.current += 1;
    setCopyEditNotice({ area, message: copyEditBlockMessage, sequence: copyEditNoticeSequenceRef.current });
  }

  function updateCopy(field: 'title' | 'body' | 'tags', value: string) {
    setCopyEditedScore(null);
    setCopyEditedReasons([]);
    setCopyEditedNote('');
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
    setCopyEditedScore(null);
    setCopyEditedReasons([]);
    setCopyEditedNote('');
    setDraft((current) => current ? {
      ...current,
      imagePlan: current.imagePlan.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...patch }
        : item),
    } : current);
  }

  function updateCopyOriginalScore(score: HumanScore) {
    setCopyOriginalScore(score);
    setCopyEditedScore(null);
    setCopyEditedReasons([]);
    setCopyEditedNote('');
    if (score === 3) {
      setCopyOriginalReasons([]);
      setCopyOriginalNote('');
    }
  }

  function updateCopyEditedScore(score: HumanScore) {
    setCopyEditedScore(score);
    if (score === 3) {
      setCopyEditedReasons([]);
      setCopyEditedNote('');
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
    if (!copyRatingComplete) {
      setError(!originalCopyRatingComplete
        ? '请完成机器原稿初评；低于 3 分时，扣分原因或评分说明至少填写一项。'
        : '请完成修改后自评；低于 3 分时，扣分原因或评分说明至少填写一项。');
      return;
    }
    if (decision === 'APPROVE' && !canApproveCopy) {
      setError('当前文案评分未高于 2 分，可以保存待修改，但不能放行生图。');
      return;
    }
    if (decision === 'DISCARD' && (effectiveCopyScore !== 1 || draftChanged)) {
      setError(draftChanged
        ? '请先保存当前修改及 1 分自评，再废弃任务，确保评分对应已保存版本。'
        : '只有当前文案评为 1 分时才能从审核弹窗废弃任务。');
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
    if (!await confirm({
      title: decision === 'APPROVE' ? '确认文案达标并开始生图？' : decision === 'DISCARD' ? '评分并废弃这条任务？' : '保存评分与当前修改？',
      description: decision === 'APPROVE'
        ? `当前人工评分为 ${effectiveCopyScore} 分。系统会保存评分${draftChanged ? '和人工修订版本' : ''}，并将任务送入全局生图队列。`
        : decision === 'DISCARD'
          ? '当前文案评分为 1 分。任务会被标记为已废弃，历史文案、执行记录与评分仍会保留。'
          : `当前人工评分为 ${effectiveCopyScore} 分。系统会保存评分${draftChanged ? '和人工修订版本' : ''}，任务继续留在文案审核。`,
      confirmLabel: decision === 'APPROVE' ? '确认放行' : decision === 'DISCARD' ? '评分并废弃' : '保存待修改',
      ...(decision === 'DISCARD' ? { tone: 'danger' as const } : {}),
    })) return;
    setSubmitting(true);
    setError('');
    try {
      if (draftChanged) await requireImageControls();
      const requestPayload = {
        revisionId: revision.id,
        nodeId,
        decision,
        score: effectiveCopyScore,
        reasons: effectiveCopyScore === 3 ? [] : effectiveCopyReasons,
        note: effectiveCopyScore === 3 ? '' : effectiveCopyNote.trim(),
        ...(decision !== 'DISCARD' && draftChanged ? {
          edits: draft,
          ...(revision.executionId ? {
            originalScore: copyOriginalScore,
            originalReasons: copyOriginalScore === 3 ? [] : copyOriginalReasons,
            originalNote: copyOriginalScore === 3 ? '' : copyOriginalNote.trim(),
          } : {}),
        } : {}),
        aiDisclosureEnabled,
      };
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      reviewSessionRef.current = null;
      await onUpdated(decision === 'APPROVE'
        ? '文案评分已保存并放行，任务已进入全局生图队列。'
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

  async function submitImageReview(decision: 'APPROVE' | 'RETRY' | 'DISCARD') {
    if (!detail || !canReviewImages || submitting) return;
    if (!imageRatingComplete) {
      setError(imageScore === null ? '请先完成整套图片人工评分。' : '评分低于 3 分时，扣分原因或评分说明至少填写一项。');
      return;
    }
    if (decision === 'APPROVE' && !canApproveImages) {
      setError(!imageSetComplete
        ? '当前图集不完整，不能审核通过；请刷新核对、重试生图或废弃。'
        : imageConfigurationChanged
          ? '图片配置尚未应用，不能审核通过。'
          : '当前图片评分未高于 2 分，可以重试或废弃，但不能审核通过。');
      return;
    }
    const options = {
      APPROVE: { title: '确认图片评分达标并通过？', description: `当前整套图片人工评分为 ${imageScore} 分。图文将移入已完成列表。`, confirmLabel: '确认通过' },
      RETRY: { title: '重新生成这条任务的图片？', description: `当前整套图片人工评分为 ${imageScore} 分。保留已审核文案并重新生成整套图片；旧图片与评分记录会保留，生成会产生模型费用。`, confirmLabel: '重试生图' },
      DISCARD: { title: '废弃这条图文任务？', description: `当前整套图片人工评分为 ${imageScore} 分。任务会移出业务列表，历史文案、执行记录、图片与评分仍会保留。`, confirmLabel: '确认废弃', tone: 'danger' as const },
    };
    if (!await confirm(options[decision])) return;
    setSubmitting(true);
    setError('');
    try {
      const requestPayload = {
        imageRunId: detail.currentImageRunId,
        decision,
        score: imageScore,
        reasons: imageScore === 3 ? [] : imageReasons,
        problemAssetIds: imageScore === 3 ? [] : imageProblemAssetIds,
        note: imageScore === 3 ? '' : imageReviewNote.trim(),
      };
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/review-images`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      reviewSessionRef.current = null;
      await onUpdated(decision === 'APPROVE' ? '图片审核通过，任务已进入已完成列表。'
        : decision === 'RETRY' ? '任务已回到生图队列，等待重新生成图片。' : '任务已废弃。');
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
          <DialogTitle>{detail?.state === 'REVIEWED' ? '已完成任务详情' : detail?.state === 'MANUAL_ARCHIVE' ? '人工归档详情' : '任务详情与审核'}</DialogTitle>
          <DialogDescription>{detail?.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
            ? '机器文案已生成；请先在任务列表分配负责人，再开始人工评分与审核。'
            : detail?.state === 'MANUAL_ARCHIVE'
            ? '核对完整图集并完成人工评分，再选择审核通过、重试生图或废弃。'
            : detail?.state === 'REVIEWED' ? '图文已审核通过，可查看详情并下载完整资源包。'
            : '先给机器原稿评分；2 分或 2.5 分可修改，修改后需要重新自评。'}</DialogDescription>
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
                <div className="workbench-review-section-title"><span>01</span><div><h3>标题、正文与标签</h3><p>{editable ? '先评价机器原稿，再决定直接放行或修改。' : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                {detail.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
                  && <div className="notice warning" role="status">文案已生成，但任务尚未分配负责人。请先关闭窗口并完成分配，再进行评分或修改。</div>}
                <div className="workbench-review-query">
                  <strong>Query 原文</strong>
                  <div id="review-query-text" className="workbench-review-query-text" data-expanded={queryExpanded || !longQuery}>{detail.query}</div>
                  {longQuery && <Button unstyled className="button small" type="button" aria-expanded={queryExpanded} aria-controls="review-query-text" onClick={() => setQueryExpanded(value => !value)}>{queryExpanded ? '收起原文' : '展开全文'}</Button>}
                </div>
                {editable && <div className="human-rating-panel" aria-label="文案人工评分">
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <HumanScoreField
                    id={`copy-original-score-${detail.id}`}
                    legend={currentCopyRatingLabel}
                    value={copyOriginalScore}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current) || copyMaterialChanged}
                    onChange={(score) => { updateCopyOriginalScore(score); setError(''); }}
                  />
                  {copyOriginalScore !== null && copyOriginalScore < 3 && <HumanRatingFeedback
                    id={`copy-original-${detail.id}`}
                    reasonOptions={copyReasonOptions}
                    reasons={copyOriginalReasons}
                    note={copyOriginalNote}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current) || copyMaterialChanged}
                    onToggleReason={(code) => { toggleReason(code, setCopyOriginalReasons); setError(''); }}
                    onNoteChange={(note) => { setCopyOriginalNote(note); setError(''); }}
                  />}
                  {copyOriginalScore !== null && <p className="human-rating-guidance" role="status">
                    {copyOriginalScore === 1
                      ? '1 分：当前稿不可用。填写原因或说明后，可保存评分或直接废弃任务。'
                      : copyOriginalScore === 2
                        ? `${originalCopyRatingComplete ? '已解锁编辑' : '填写扣分原因或说明后即可编辑'}。完成结构性修改后，请进行修改后自评。`
                        : copyOriginalScore === 2.5
                          ? `2.5 分已达到放行标准；${originalCopyRatingComplete ? '也可以小修' : '填写扣分原因或说明后可以小修'}，修改后需重新自评。`
                          : '3 分：原稿质量优良，可直接放行生图。'}
                  </p>}
                </div>}
                {!editable && copyAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>当前文案人工评分</span>
                  <HumanScoreBadge score={copyAssessments.at(-1)!.score} />
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
                    <Input id="review-copy-title" className="input" value={draft.copy.title} maxLength={25} required readOnly={fieldsReadOnly}
                      onChange={(event) => updateCopy('title', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-body">正文 <small>{[...draft.copy.body].length}/400–600</small></label>
                    <Textarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={fieldsReadOnly}
                      onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <Input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={fieldsReadOnly}
                      onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div> : <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}
                {editable && copyMaterialChanged && <div className="human-rating-panel" data-edited>
                  <HumanScoreField
                    id={`copy-edited-score-${detail.id}`}
                    legend="修改后自评"
                    value={copyEditedScore}
                    disabled={loading || submitting || humanQualitySettingsUnavailable}
                    onChange={(score) => { updateCopyEditedScore(score); setError(''); }}
                  />
                  {copyEditedScore !== null && copyEditedScore < 3 && <HumanRatingFeedback
                    id={`copy-edited-${detail.id}`}
                    reasonOptions={copyReasonOptions}
                    reasons={copyEditedReasons}
                    note={copyEditedNote}
                    disabled={loading || submitting || humanQualitySettingsUnavailable}
                    onToggleReason={(code) => { toggleReason(code, setCopyEditedReasons); setError(''); }}
                    onNoteChange={(note) => { setCopyEditedNote(note); setError(''); }}
                  />}
                  <p className="human-rating-guidance" role="status">文案再次修改时，本次自评会自动清空，确保分数对应当前内容。</p>
                </div>}
                <HumanAssessmentHistory assessments={copyAssessments} />
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
                  disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                  onChange={(score) => { updateImageScore(score); setError(''); }}
                />
                {imageScore !== null && imageScore < 3 && <div className="human-rating-followup">
                  <HumanRatingFeedback
                    id={`image-${detail.id}-${detail.currentImageRunId}`}
                    reasonOptions={imageReasonOptions}
                    reasons={imageReasons}
                    note={imageReviewNote}
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
                  {isPassingHumanScore(imageScore)
                    ? `${imageScore} 分已达到放行标准，也可根据需要重试或废弃。`
                    : `${imageScore} 分未达到放行标准，请选择重试生图或废弃。`}
                </p>}
                <HumanAssessmentHistory assessments={imageAssessments} />
              </div>}
              {!canReviewImages && imageAssessments.length > 0 && <div className="human-rating-readonly">
                <span>当前图集人工评分</span>
                <HumanScoreBadge score={imageAssessments.at(-1)!.score} />
                <HumanAssessmentHistory assessments={imageAssessments} />
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
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '03' : '02'}</span><div><h3>图片文案规划</h3><p>逐页核对画面文字，切换页面会保留当前修改。</p></div></div>
                <nav className="workbench-image-plan-nav" aria-label="图片规划页码">
                  {draft.imagePlan.map((item, index) => <Button unstyled type="button" key={index} aria-pressed={activePlanIndex === index} aria-controls={`review-plan-page-${index}`} onClick={() => setActivePlanIndex(index)}>
                    <span>第 {index + 1} 页 · {IMAGE_KIND_LABELS[item.kind]}</span><strong>{item.headline || '未填写页面标题'}</strong>
                  </Button>)}
                </nav>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => <article id={`review-plan-page-${index}`} className="workbench-image-plan-card" key={index} data-plan-index={index} hidden={activePlanIndex !== index}>
                    <div className="workbench-image-plan-head"><b>第 {index + 1} 页</b><span>{IMAGE_KIND_LABELS[item.kind]}</span></div>
                    <div className="workbench-image-plan-fields" data-edit-blocked={Boolean(copyEditBlockMessage)}
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
                        <Select value={item.kind} disabled={fieldsReadOnly} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind, layout: { mode: 'AUTO' } })}>
                          <SelectTrigger id={`review-plan-kind-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <Input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={fieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题</label>
                        <Input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} required readOnly={fieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small>每行一条，2–5 条</small></label>
                        <Textarea id={`review-plan-bullets-${index}`} className="textarea" value={item.bullets.join('\n')} required readOnly={fieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <Disclosure className="field full" open={expandedPrompts.includes(index)} onOpenChange={open => setExpandedPrompts(current => open ? [...current, index] : current.filter(value => value !== index))}>
                        <DisclosureTrigger data-edit-reminder-exempt>画面生成指令</DisclosureTrigger>
                        <DisclosureContent>
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <Textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={fieldsReadOnly}
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
              ? copyMaterialChanged ? `保存后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'} · 等待评分决定`
              : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              <DialogClose asChild><Button unstyled className="button" type="button" disabled={submitting}>关闭</Button></DialogClose>
              {canResumeImages && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void resumeImages(); }}><RotateCcw size={15} />从失败步骤继续</Button>}
              {canReviewImages && <>
                <Button unstyled className="button danger" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('DISCARD'); }}><Trash2 size={15} />废弃</Button>
                <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('RETRY'); }}><RotateCcw size={15} />重试生图</Button>
                <Button unstyled className="button primary" type="button" disabled={submitting || loading || !canApproveImages} onClick={() => { void submitImageReview('APPROVE'); }}><CheckCircle2 size={15} />{submitting ? '正在提交…' : '审核通过'}</Button>
              </>}
              {editable && <>
                {effectiveCopyScore === 1 && !draftChanged && <Button unstyled className="button danger" type="button" disabled={submitting || loading || !copyRatingComplete} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('DISCARD', event.currentTarget.form); }}><Trash2 size={15} />评分并废弃</Button>}
                <Button unstyled className="button" type="button" disabled={submitting || loading || !copyRatingComplete} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('SAVE', event.currentTarget.form); }}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : '保存评分，暂不放行'}
                </Button>
                <Button unstyled className="button primary" type="submit" disabled={submitting || loading || !canApproveCopy}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />审核通过并开始生图</>}
                </Button>
              </>}
            </div>
          </footer>
        </form>}

      {error && !detail && <div className="notice error workbench-review-error" role="alert">{error}</div>}
    </DialogContent>
  </Dialog>;
}
