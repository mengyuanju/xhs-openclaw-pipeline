'use client';

import { type PreviewBackdrop } from "../components/image-preview-background-control";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTextInputDialog } from "@/components/ui/text-input-dialog";
import { ApiRequestError, apiRequest } from "../components/api-client";
import { createRequestId } from "../components/request-id";
import { resumeImageTask } from "../components/resume-image-task";
import { canResumeImageTask } from "../../src/control-plane/image-resume.mjs";
import { orderedImageFileName } from "../../src/image-file-name.mjs";
import { canRequeueImages, isImageRetryExhausted } from "../../src/control-plane/image-retry-status.mjs";
import { imageApprovalNoteForVersion } from "../components/image-approval-note.mjs";
import { IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH } from "../components/image-manual-modification-note";
import { type PendingImageEdit } from "../components/pending-image-edits-dialog";
import { useBackgroundTasks } from "../components/background-tasks";
import { isBackgroundTaskRunning, isPlanSourceCurrent } from "../components/background-task-store";
import { toast } from "sonner";
import { isPassingHumanScore, type HumanScore } from "./human-quality-rating";
import { DEFAULT_SETTINGS, useHumanQualitySettings } from "./human-quality-settings";
import { buildCopyReviewSubmission } from "../../src/copy-review-submission.mjs";
import { copyReworkChanges, findCopyReworkBaseline } from "../../src/copy-rework.mjs";
import { imagePlanBlankBulletLines, imagePlanBulletLengthWarnings, imagePlanPageDeletionBlockReason, planDisclosureIndicesAfterDeletion, planIndexAfterDeletion, removeImagePlanPage } from "../../src/image-plan-editing.mjs";
import { compareCopyReviewImagePlans } from "../../src/image-plan-review.mjs";
import { clearLocalCopyReviewDrafts, copyReviewDraftFingerprint, importLegacyCopyReviewDrafts, listLocalCopyReviewDrafts, LocalCopyReviewDraftConflictError, needsLegacyCopyReviewDraftImport, saveLocalCopyReviewDraft, type LocalCopyReviewDraftScope } from "./copy-review-draft-store";
import { type ImagePlanItem, type ReviewDraft, type ImagePlanBulletLengthWarning, type ImagePlanBlankBulletLine, type CopyReviewDraftContent, type CopyReviewDraftRecord, type LegacyCopyReviewDraftRecord, type TaskDetail, type ImagePlanRegenerationJob, PENDING_IMAGE_EDIT_STATUSES, apiPath, safeXiaohongshuUrl, currentRevision, draftFromRevision, imagePlanBulletOverflowDescription, imagePlanBlankLineDescription, initialAiDisclosure, revisionReworkRequirement, reworkReasonLabels, reworkProblemImages, isCopyReviewDraftContent, copyRatingsFromDetail, imageAssessmentFromDetail, ratingFeedbackComplete, type CopyEditArea, getCopyEditBlockMessage, getPlanEditBlockMessage, newReviewSessionId } from './task-review-model';

export function useTaskReviewController({
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
  } = useHumanQualitySettings(taskId, taskId !== null);
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
  const [imageManualModificationNote, setImageManualModificationNote] = useState('');
  const [previousImageManualModificationNote, setPreviousImageManualModificationNote] = useState<string | null>(null);
  const previousImageManualNoteRef = useRef<string | null>(null);
  const imageManualNoteDraftRef = useRef<{
    taskId: number; imageRunId: string | null; copyRevisionId: number | null; note: string;
  } | null>(null);
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
  const [restoredDraftId, setRestoredDraftId] = useState<string | null>(null);
  const [pendingImageEdits, setPendingImageEdits] = useState<PendingImageEdit[]>([]);
  const [pendingEditsOpen, setPendingEditsOpen] = useState(false);
  const continueImageReviewRef = useRef(false);
  const loadRequestRef = useRef(0);
  const activeDraftIdentityRef = useRef({ taskId, accountId: currentAccountId, username: currentUsername });
  activeDraftIdentityRef.current = { taskId, accountId: currentAccountId, username: currentUsername };
  const imagePlanGenerationRequestRef = useRef(0);
  const autoLoadPlanIdRef = useRef<string | null>(null);
  const appliedPlanIdRef = useRef<string | null>(null);
  const lastSavedDraftIdRef = useRef<string | null>(null);
  const reviewSessionRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const copyEditNoticeSequenceRef = useRef(0);
  const lastCopyEditNoticeRef = useRef<{ area: CopyEditArea; message: string; at: number } | null>(null);
  const copyEditPointerAtRef = useRef(0);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const imageSectionRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [planFocusTarget, setPlanFocusTarget] = useState<{ id: string; bulletIndex?: number } | null>(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++loadRequestRef.current;
    setActiveAssetIndex(null);
    setLoading(true);
    try {
      const next = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${taskId}?historyMode=current`));
      if (requestId !== loadRequestRef.current) return;
      const copyRatings = copyRatingsFromDetail(next);
      const imageAssessment = imageAssessmentFromDetail(next);
      const revisionDraft = draftFromRevision(currentRevision(next));
      const disclosureEnabled = initialAiDisclosure(next);
      const canLoadImageEdits = ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(next.state)
        && (role === 'ADMIN' || (next.assignedToUserId === currentUsername
          && next.assignedToAccountId === currentAccountId));
      const draftScope: LocalCopyReviewDraftScope | null = next.state === 'COPY_REVIEW_PENDING'
        && next.assignedToUserId !== null && next.currentCopyRevisionId && revisionDraft
        ? {
          accountId: currentAccountId,
          taskId,
          baseCopyRevisionId: next.currentCopyRevisionId,
          reviewerUsername: currentUsername,
        }
        : null;
      const [history, imageEdits] = await Promise.all([
        draftScope ? (async () => {
          if (await needsLegacyCopyReviewDraftImport(draftScope)) {
            const legacy = await apiRequest<{ baseCopyRevisionId: number | null; drafts: LegacyCopyReviewDraftRecord[] }>(
              apiPath(`/v1/tasks/${taskId}/copy-review-drafts`),
            );
            await importLegacyCopyReviewDrafts(draftScope,
              legacy.baseCopyRevisionId === draftScope.baseCopyRevisionId ? legacy.drafts : []);
          }
          return listLocalCopyReviewDrafts<CopyReviewDraftContent>(draftScope);
        })() : Promise.resolve({ baseCopyRevisionId: next.currentCopyRevisionId, drafts: [] }),
        canLoadImageEdits
          ? apiRequest<PendingImageEdit[]>(apiPath(`/v1/tasks/${taskId}/image-edits?pending=true`))
          : Promise.resolve([]),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const storedDrafts = history.baseCopyRevisionId === next.currentCopyRevisionId
        ? history.drafts : [];
      const validDrafts = storedDrafts.filter(item => isCopyReviewDraftContent(item.content));
      const latestDraft = validDrafts[0];
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
      const previousImageNote = imageManualNoteDraftRef.current;
      const sameImageNoteVersion = previousImageNote?.taskId === next.id
        && previousImageNote.imageRunId === next.currentImageRunId
        && previousImageNote.copyRevisionId === next.currentCopyRevisionId;
      if (previousImageNote?.taskId === next.id && !sameImageNoteVersion && previousImageNote.note.trim()
          && previousImageNote.note.trim() !== imageApprovalNoteForVersion(next.imageApprovalEvents,
            previousImageNote.imageRunId, previousImageNote.copyRevisionId)) {
        previousImageManualNoteRef.current = previousImageNote.note;
        setPreviousImageManualModificationNote(previousImageNote.note);
      }
      const imageNote = sameImageNoteVersion
        ? previousImageNote.note
        : imageApprovalNoteForVersion(next.imageApprovalEvents, next.currentImageRunId, next.currentCopyRevisionId) ?? '';
      imageManualNoteDraftRef.current = { taskId: next.id, imageRunId: next.currentImageRunId,
        copyRevisionId: next.currentCopyRevisionId, note: imageNote };
      setImageManualModificationNote(imageNote);
      setImageReworkCopyFields((imageAssessment?.reworkDetails?.copyFields ?? []).filter(
        (field): field is 'TITLE' | 'BODY' | 'TAGS' => ['TITLE', 'BODY', 'TAGS'].includes(field),
      ));
      reviewSessionRef.current = null;
      // Initial generated-copy review is opt-in. A returned copy revision keeps
      // the already-approved disclosure choice instead of silently resetting it.
      setAiDisclosureEnabled(restoredContent?.aiDisclosureEnabled ?? disclosureEnabled);
      setDraftHistory(validDrafts);
      lastSavedDraftIdRef.current = storedDrafts[0]?.id ?? null;
      setLastSavedDraftFingerprint(restoredContent ? copyReviewDraftFingerprint(restoredContent) : null);
      setLastDraftSavedAt(latestDraft?.createdAt ?? null);
      setRestoredDraftId(latestDraft?.id ?? null);
      setPendingImageEdits(imageEdits.filter(edit => PENDING_IMAGE_EDIT_STATUSES.has(edit.status)));
      setDraftSaveStatus(latestDraft ? 'saved' : 'idle');
      setDraftSaveError(storedDrafts.length !== validDrafts.length
        ? '发现格式不兼容的本机草稿，已跳过这些版本。其他有效草稿仍可恢复。' : '');
      setDraftSaveConflict(false);
      setDraftHydrated(true);
      setError('');
      return next;
    } catch (caught) {
      if (requestId === loadRequestRef.current) setError(caught instanceof Error ? caught.message : '任务详情读取失败');
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [currentAccountId, currentUsername, role, taskId]);

  useEffect(() => {
    lastSavedDraftIdRef.current = null;
    setDetail(null);
    setPendingEditsOpen(false);
    continueImageReviewRef.current = false;
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
    setImageManualModificationNote('');
    setPreviousImageManualModificationNote(null);
    previousImageManualNoteRef.current = null;
    imageManualNoteDraftRef.current = null;
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
    };
  }, [load, taskId]);

  const revision = currentRevision(detail);
  const savedDraft = draftFromRevision(revision);
  const copyContentChanged = Boolean(draft && savedDraft
    && JSON.stringify(draft.copy) !== JSON.stringify(savedDraft.copy));
  const imagePlanComparison = draft && savedDraft
    ? compareCopyReviewImagePlans(savedDraft.imagePlan, draft.imagePlan) : null;
  const imagePlanChanged = imagePlanComparison?.changed === true;
  const imageConfigurationChanged = Boolean(draft && savedDraft && JSON.stringify(draft.imageSettings) !== JSON.stringify(savedDraft.imageSettings));
  const draftChanged = copyContentChanged || imagePlanChanged || imageConfigurationChanged;
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
  const isImageRetryRework = Boolean(detail && isImageRetryExhausted(detail));
  // A later return starts rework even if full inspection came from a reset.
  const isCopyRework = Boolean(isImageRetryRework
    || detail?.copyQaReworkPending
    || (!['DISCARD_RESTORE', 'SECOND_ASSIGNMENT'].includes(detail?.mandatoryCopyQcOrigin ?? '')
      && (detail?.mandatoryCopyQc
        || ['QA_RETURN', 'FINAL_REWORK'].includes(revision?.revisionOrigin ?? '')
        || ['QA_RETURN', 'FINAL_REWORK'].includes(revision?.reworkOrigin ?? ''))));
  // Image exhaustion starts a new rework round from the current approved version.
  const reworkBaseline = isCopyRework && detail && revision
    ? (isImageRetryRework ? revision : findCopyReworkBaseline(detail.copyRevisions, revision.id)) : null;
  const isCopyOnlyFinalRework = (reworkBaseline?.revisionOrigin ?? revision?.reworkOrigin) === 'FINAL_REWORK'
    && (reworkBaseline?.reworkTarget ?? revision?.reworkTarget) === 'COPY';
  const savedCopyRatings = detail ? copyRatingsFromDetail(detail) : { current: undefined };
  const originalCopyRatingComplete = ratingFeedbackComplete(copyOriginalScore, copyOriginalReasons, copyOriginalNote);
  const copyFieldsEditable = editable && (isCopyRework || copyOriginalScore === 2 || copyOriginalScore === 2.5);
  const copyFieldsReadOnly = !copyFieldsEditable || loading || submitting || regeneratingImagePlan;
  const copyContentChangedFromMachine = revision?.copyContentChangedFromMachine === true;
  const hasEditedCopyVersion = copyContentChanged || copyContentChangedFromMachine;
  const copyReworkSatisfied = Boolean(isCopyRework && draft && savedDraft && copyReworkChanges(
    reworkBaseline?.content ?? savedDraft, draft,
  ).satisfied);
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
  const canDiscardImages = isImageReviewView && canHandleAssignedImages && Boolean(detail?.currentImageRunId);
  const canSubmitImageSelfReview = isImageReviewView
    && canHandleAssignedImages && Boolean(detail?.currentImageRunId);
  const canEditImageManualNote = isImageReviewView && canHandleAssignedImages;
  const savedImageManualModificationNote = detail
    ? imageApprovalNoteForVersion(detail.imageApprovalEvents, detail.currentImageRunId, detail.currentCopyRevisionId) : null;
  const imageManualNoteChanged = canEditImageManualNote
    && (imageManualModificationNote !== (savedImageManualModificationNote ?? '')
      || previousImageManualModificationNote !== null);
  // Scored pass/return decisions moved to the dedicated image-QA pool.
  const canReviewImages = false;
  const downloadable = isAdmin && detail?.state === 'REVIEWED' && detail.deliveryStatus === 'READY';
  const canResumeImages = canResumeImageTask(detail) && hasOwnerControl && role !== 'REVIEWER';
  const canRetryExhaustedImages = Boolean(detail && isImageRetryExhausted(detail)
    && canRequeueImages(detail) && revision?.approvedAt && hasOwnerControl
    && role !== 'REVIEWER' && !detail.currentExecutionId);
  const canModifyImages = Boolean(detail && revision?.approvedAt && hasOwnerControl && role !== 'REVIEWER'
    && (isAdmin
      ? ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(detail.state)
      : ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(detail.state))
    && !detail.currentExecutionId);
  const canEditApprovedImagePlan = canModifyImages;
  const planFieldsReadOnly = !(editable || canEditApprovedImagePlan)
    || loading || submitting || regeneratingImagePlan;
  const planKindDisabled = !(editable || canEditApprovedImagePlan) || loading || submitting || regeneratingImagePlan;
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
    : imagePlanChanged || imageConfigurationChanged || imageRatingChanged || imageManualNoteChanged;
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
    const loadRequestId = loadRequestRef.current;
    const appliedPlanId = appliedPlanIdRef.current;
    const scope: LocalCopyReviewDraftScope = {
      accountId: currentAccountId,
      taskId,
      baseCopyRevisionId: revision.id,
      reviewerUsername: currentUsername,
    };
    setDraftSaveStatus('saving');
    setDraftSaveError('');
    setDraftSaveConflict(false);
    try {
      const result = await saveLocalCopyReviewDraft(scope, {
        expectedLatestDraftId: lastSavedDraftIdRef.current,
        content,
      });
      if (loadRequestId !== loadRequestRef.current || taskId !== activeDraftIdentityRef.current.taskId
          || currentAccountId !== activeDraftIdentityRef.current.accountId
          || currentUsername !== activeDraftIdentityRef.current.username) return true;
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
      if (loadRequestId !== loadRequestRef.current || taskId !== activeDraftIdentityRef.current.taskId
          || currentAccountId !== activeDraftIdentityRef.current.accountId
          || currentUsername !== activeDraftIdentityRef.current.username) return false;
      const conflict = caught instanceof LocalCopyReviewDraftConflictError;
      setDraftSaveStatus('error');
      setDraftSaveConflict(conflict);
      setDraftSaveError(conflict
        ? '此浏览器的其他窗口已保存更新的草稿。请刷新任务，再从本机草稿历史选择要继续的版本。'
        : caught instanceof Error ? caught.message : '本机草稿保存失败，请重试');
      return false;
    }
  }, [backgroundStore, currentAccountId, currentUsername, draftSaveStatus, revision?.id, taskId]);

  const completedPlan = backgroundPlan?.status === 'SUCCEEDED' && !backgroundPlan.consumed
    ? backgroundPlan.payload as ImagePlanRegenerationJob | undefined : undefined;
  useEffect(() => {
    const job = detail?.imagePlanRegeneration;
    if (job && backgroundStore && !backgroundStore.getSnapshot().some(task => task.id === job.id)) {
      backgroundStore.track({ id:job.id,kind:'IMAGE_PLAN',taskId:detail.id,status:job.status,payload:job,
        ownerUsername:job.requestedByUsername,ownerAccountId:job.requestedByAccountId });
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
    if (!hasUnpersistedDraftChanges && !imageManualNoteChanged && draftSaveStatus !== 'saving') return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [draftSaveStatus, hasUnpersistedDraftChanges, imageManualNoteChanged]);

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
    if (!planFocusTarget) return;
    const target = document.getElementById(planFocusTarget.id);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus();
    if (target instanceof HTMLTextAreaElement && planFocusTarget.bulletIndex !== undefined) {
      const lines = target.value.split('\n');
      const start = lines.slice(0, planFocusTarget.bulletIndex).reduce((length, line) => length + line.length + 1, 0);
      target.setSelectionRange(start, start + (lines[planFocusTarget.bulletIndex]?.length ?? 0));
    }
    setPlanFocusTarget(null);
  }, [activePlanIndex, expandedPrompts, planFocusTarget]);

  useEffect(() => {
    if (!navigationGuardRef) return;
    navigationGuardRef.current = async () => {
      if (loading || submitting || submittingImagePlan || draftSaveStatus === 'saving') return false;
      if (imageManualNoteChanged) return confirm({ title: '离开当前图片作业？',
        description: '图片审核备注尚未提交，离开会丢失填写的内容。',
        confirmLabel: '放弃备注并离开', cancelLabel: '继续填写' });
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
    copyReviewDraftContent, currentDraftFingerprint, persistCopyReviewDraft, editable, draftChanged, imageManualNoteChanged, confirm]);

  async function discardChanges(action: 'close' | 'refresh') {
    if (submitting || submittingImagePlan || draftSaveStatus === 'saving' || (action === 'refresh' && (loading || regeneratingImagePlan))) return;
    if (imageManualNoteChanged && !await confirm({
      title: action === 'close' ? '图片审核备注未提交，仍要关闭？' : '图片审核备注未提交，仍要刷新？',
      description: '备注会随图片初审提交保存，继续操作会丢失当前填写的内容。',
      confirmLabel: action === 'close' ? '放弃并关闭' : '放弃并刷新', cancelLabel: '继续填写',
    })) return;
    if (hasUnpersistedDraftChanges && !await confirm({
      title: action === 'close' ? '未保存草稿，仍要关闭？' : '未保存草稿，仍要刷新？',
      description: '最近的修改还没有写入此浏览器的草稿数据库，继续操作会丢失这一小段内容。',
      confirmLabel: action === 'close' ? '放弃并关闭' : '放弃并刷新',
      cancelLabel: '继续编辑',
    })) return;
    if (action === 'close') {
      if (regeneratingImagePlan) toast.info('文案规划正在后台处理，可以关闭窗口。完成或失败后会在“后台任务”中提醒。');
      onOpenChange(false);
    }
    else {
      imageManualNoteDraftRef.current = null;
      previousImageManualNoteRef.current = null;
      setPreviousImageManualModificationNote(null);
      await load();
    }
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
  const research = revision?.content.generation?.research;
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
  const activeReworkRequirement = detail?.imageQaReturn ?? revisionReworkRequirement(revision);
  const activeReworkReasonLabels = reworkReasonLabels(activeReworkRequirement, imageReasonOptions);
  const activeReworkProblemImages = reworkProblemImages(detail, activeReworkRequirement);
  const showCopyScoreDescriptions = humanRatingSettings.copyReviewDisplay.showScoreDescriptions;
  // Visibility is fail-closed: never flash default reasons while task-specific settings are loading or unavailable.
  const showCopyDeductionReasons = humanQualitySettings?.copyReviewDisplay.showDeductionReasons === true;
  const showImageDeductionReasons = humanQualitySettings?.imageReviewDisplay.showDeductionReasons === true;
  const copyFeedbackRequirement = showCopyDeductionReasons ? '扣分原因或评分说明' : '评分说明';
  const copyActionBusyReason = loading ? '正在刷新任务，请稍候再操作。'
    : submitting ? '正在提交当前操作，请等待完成后再继续。'
    : submittingImagePlan ? '正在提交图片规划生成请求，请稍候再操作。'
    : draftSaveStatus === 'saving' ? '正在自动保存审核草稿，请等待保存完成后再操作。'
    : regeneratingImagePlan ? '图片规划正在生成，暂时无法保存、提交或废弃。可关闭窗口，完成后会收到提醒；重新打开任务核对规划后再继续。' : null;
  const copyRatingBlockReason = copyRatingComplete ? null
    : humanQualitySettingsLoading ? '正在加载评分设置，请稍候再完成机器原稿初评。'
    : humanQualitySettingsError ? '评分设置加载失败，请点击右上角“刷新”后再完成评分。'
    : copyOriginalScore === null ? '请先在“标题、正文与标签”中完成机器原稿初评，再保存或提交。'
    : `原稿低于 3 分，请补充${copyFeedbackRequirement}（至少一项），再保存或提交。`;
  const saveCopyBlockReason = copyActionBusyReason || copyRatingBlockReason
    || (isCopyRework && !draftChanged ? copyReworkSatisfied
      ? '当前返工修改已保存，无需重复保存。确认达标后可直接提交强制复检。'
      : '返工稿没有新的修改，无需重复保存。请先修改文案或图片规划；修改达标后也可直接提交强制复检。' : null);
  const approveCopyBlockReason = copyActionBusyReason || (canApproveCopy ? null : copyRatingBlockReason
    || (isCopyRework ? '请先按返工原因实际修改文案或图片规划，再提交强制复检；无需先单独保存。'
      : copyOriginalScore === 1 ? '原稿评为 1 分，无法审核通过。请使用“评分并废弃”处理任务。'
      : copyOriginalScore === 3 ? '3 分原稿需保持文案不变。请在“审核草稿”中恢复正式版本后再提交。'
      : '原稿为 2 分或 2.5 分，请先修改标题、正文或标签，确认达标后再提交。'));
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
    setError('');
  }

  function revealImagePlanLocation(location: { pageIndex?: number; field?: string; bulletIndex?: number }) {
    if (!draft?.imagePlan.length) return;
    const pageIndex = Math.min(Math.max(location.pageIndex ?? 0, 0), draft.imagePlan.length - 1);
    setMobilePane('plan');
    setActivePlanIndex(pageIndex);
    if (location.field === 'prompt') setExpandedPrompts(current => [...new Set([...current, pageIndex])]);
    const field = location.field === 'kind' || location.field === 'headline' || location.field === 'subtitle'
      || location.field === 'bullets' || location.field === 'prompt' ? location.field
      : location.field === 'layout' ? 'layout-trigger' : 'page';
    setPlanFocusTarget({
      id: `review-plan-${field}-${pageIndex}`,
      ...(field === 'bullets' ? { bulletIndex: location.bulletIndex } : {}),
    });
  }

  async function deleteImagePlanPage(index: number) {
    if (!draft || !editable || loading || submitting || regeneratingImagePlan) return;
    const page = draft.imagePlan[index];
    const blockedReason = imagePlanPageDeletionBlockReason(draft.imagePlan, index);
    if (!page || blockedReason) return;
    if (!await confirm({
      title: `删除第 ${index + 1} 页图片规划？`,
      description: `“${page.headline}”会从当前审核草稿中移除，后续页面将自动重新编号。点击“单独保存图片规划”后正式生效。`,
      confirmLabel: '删除本页',
      cancelLabel: '保留本页',
      tone: 'danger',
    })) return;
    const nextLength = draft.imagePlan.length - 1;
    setDraft(current => {
      if (!current || imagePlanPageDeletionBlockReason(current.imagePlan, index)) return current;
      return { ...current, imagePlan: removeImagePlanPage(current.imagePlan, index) };
    });
    setActivePlanIndex(current => planIndexAfterDeletion(current, index, nextLength));
    setExpandedPrompts(current => planDisclosureIndicesAfterDeletion(current, index));
    setInvalidField(null);
    setError('');
    setImagePlanGenerationNotice(`已从草稿删除第 ${index + 1} 页“${page.headline}”，当前剩余 ${nextLength} 页；单独保存图片规划后正式生效。`);
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
      backgroundStore.track({ id: job.id, kind: 'IMAGE_PLAN', taskId: detail.id, status: job.status, payload: job,
        ownerUsername: job.requestedByUsername, ownerAccountId: job.requestedByAccountId });
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
    } else if (!showCopyDeductionReasons && detail) {
      // With structured reasons hidden, a note is the only way to complete a
      // low score. Move the reviewer straight to that required field after it
      // mounts instead of leaving the footer action looking inexplicably
      // unavailable.
      window.requestAnimationFrame(() => {
        document.getElementById(`copy-original-${detail.id}-note`)?.focus();
      });
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

  function rejectImagePlanBulletOverflow(imagePlan: ImagePlanItem[]) {
    const warnings = imagePlanBulletLengthWarnings(imagePlan) as ImagePlanBulletLengthWarning[];
    if (warnings.length === 0) return false;
    setError(imagePlanBulletOverflowDescription(warnings));
    revealImagePlanLocation({
      pageIndex: warnings[0].pageIndex,
      field: 'bullets',
      bulletIndex: warnings[0].bulletIndex,
    });
    return true;
  }

  function rejectImagePlanBlankLines(imagePlan: ImagePlanItem[]) {
    const blankLines = imagePlanBlankBulletLines(imagePlan) as ImagePlanBlankBulletLine[];
    if (blankLines.length === 0) return false;
    setMobilePane('plan');
    setActivePlanIndex(blankLines[0].pageIndex);
    setError(imagePlanBlankLineDescription(blankLines));
    window.requestAnimationFrame(() => {
      document.getElementById(`review-plan-bullets-${blankLines[0].pageIndex}`)?.focus();
    });
    return true;
  }

  async function submitCopyDecision(decision: 'SAVE' | 'APPROVE' | 'DISCARD', form: HTMLFormElement) {
    if (!detail || !revision || !draft || !editable || loading || submitting
        || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    if (decision !== 'DISCARD' && rejectImagePlanBulletOverflow(draft.imagePlan)) return;
    if (decision !== 'DISCARD' && imagePlanComparison?.validationError) {
      setError(imagePlanComparison.validationError.message);
      revealImagePlanLocation(imagePlanComparison.validationError);
      return;
    }
    if (!isCopyRework && decision !== 'DISCARD' && imagePlanChanged) {
      setMobilePane('plan');
      setError(`图片文案规划有 ${imagePlanComparison?.differences.length ?? 1} 处未保存修改。请先单独保存图片规划，再提交只针对文案的评分或审核结果。`);
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
        ? '返工稿尚未实际修改文案或图片规划，不能提交强制复检。请按返工原因完成修改。'
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
    if (decision !== 'DISCARD' && draftChanged && rejectImagePlanBlankLines(draft.imagePlan)) return;
    const submittedScore = isCopyRework || decision === 'APPROVE' && hasEditedCopyVersion ? 3 : copyOriginalScore;
    if ((!embedded || decision === 'DISCARD') && !await confirm({
      title: decision === 'APPROVE'
        ? isImageRetryRework ? '确认生图失败修订并提交强制复检？'
          : detail.copyQaReworkPending ? '确认返工文案达标并重新审核？'
          : isCopyRework ? '确认返工文案达标并提交强制复检？' : '确认文案达标并进入后续流程？'
        : decision === 'DISCARD' ? '评分并废弃这条任务？' : '保存评分与当前修改？',
      description: decision === 'APPROVE'
        ? isCopyRework
          ? detail.copyQaReworkPending
            ? '抽检返工稿已实际修改，人工确认达标后会按普通规则重新进入待成批任务池；是否成为质检项由新批次决定。'
            : `${isImageRetryRework ? '生图失败修订' : revision.reworkOrigin === 'QA_RETURN' || detail.mandatoryCopyQcOrigin === 'QA_RETURN' ? '抽检返工' : '终审返工'}稿已实际修改文案或图片规划。本次将一起保存修改；人工确认达标后，系统将最终稿记录为 3 分并提交强制复检；复检通过后才会进入待生图队列。原稿评分和返工原因继续保留。`
          : hasEditedCopyVersion
          ? `机器原稿评分 ${copyOriginalScore} 分及其原因会原样保留；人工确认达标后，系统将当前最终修改稿记录为 3 分，并按任务策略进入文案抽检或待生图队列。`
          : `机器原稿评分为 ${submittedScore} 分。系统会保存审核结果，并按任务策略进入文案抽检或待生图队列。`
        : decision === 'DISCARD'
          ? '当前文案评分为 1 分。任务会被标记为已废弃，历史文案、执行记录与评分仍会保留。'
          : `机器原稿评分为 ${submittedScore} 分。系统会保存评分${draftChanged ? '和人工修订版本' : ''}，任务继续留在文案审核。`,
      confirmLabel: decision === 'APPROVE'
        ? isImageRetryRework ? '提交修订并复检' : detail.copyQaReworkPending ? '提交重新审核' : isCopyRework ? '提交强制复检' : '提交审核结果'
        : decision === 'DISCARD' ? '评分并废弃' : '保存待修改',
      ...(decision === 'DISCARD' ? { tone: 'danger' as const } : {}),
    })) return;
    setSubmitting(true);
    setError('');
    let submissionRecorded = false;
    try {
      if (draftChanged) await requireImageControls();
      const requestPayload = {
        ...buildCopyReviewSubmission({
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
        }),
      };
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      submissionRecorded = true;
      reviewSessionRef.current = null;
      await clearLocalCopyReviewDrafts({
        accountId: currentAccountId,
        taskId: detail.id,
        baseCopyRevisionId: revision.id,
        reviewerUsername: currentUsername,
      });
      await onUpdated(decision === 'APPROVE'
        ? isCopyRework
          ? `${isImageRetryRework ? '生图失败修订稿' : '返工稿'}已记录为最终 3 分并提交强制复检；复检通过后才会进入待生图队列。`
          : hasEditedCopyVersion
          ? '机器原稿评分已保留，最终修改稿已按 3 分提交；任务将按策略进入文案抽检或待生图队列。'
          : '文案审核结果已提交；任务将按策略进入文案抽检或待生图队列。'
        : decision === 'DISCARD' ? '文案评分已保存，任务已废弃。'
          : '文案评分与当前修改已保存，任务继续留在文案审核。', decision === 'SAVE' ? undefined : detail.id);
      if (decision === 'APPROVE' || decision === 'DISCARD') onOpenChange(false);
      else if (!await load()) throw new Error('未能刷新正式保存后的文案版本。请刷新任务。');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '文案评分提交失败';
      setError(submissionRecorded ? `文案已提交，但后续本机草稿处理或页面刷新失败：${message}` : message);
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
    let discardRecorded = false;
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
      discardRecorded = true;
      await clearLocalCopyReviewDrafts({
        accountId: currentAccountId,
        taskId: detail.id,
        baseCopyRevisionId: revision.id,
        reviewerUsername: currentUsername,
      });
      await onUpdated(`任务 #${detail.id} 已在保留质检记录的前提下废弃。`, detail.id);
      onOpenChange(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '废弃质检返工任务失败';
      setError(discardRecorded ? `任务已废弃，但本机草稿清理或页面刷新失败：${message}` : message);
    } finally {
      setSubmitting(false);
    }
  }

  async function saveImagePlan(form: HTMLFormElement) {
    if (!detail || !revision || !draft || !savedDraft || !editable || !imagePlanChanged
        || loading || submitting || regeneratingImagePlan || draftSaveStatus === 'saving') return;
    if (rejectImagePlanBulletOverflow(draft.imagePlan)) return;
    if (imagePlanComparison?.validationError) {
      setError(imagePlanComparison.validationError.message);
      revealImagePlanLocation(imagePlanComparison.validationError);
      return;
    }
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
    if (rejectImagePlanBlankLines(draft.imagePlan)) return;
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
    let planRecorded = false;
    try {
      const savedTask = await apiRequest<TaskDetail>(apiPath(`/v1/tasks/${detail.id}/approve-copy`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, reviewSessionId: reviewSessionId(requestPayload) }),
      });
      planRecorded = true;
      reviewSessionRef.current = null;
      if (!savedTask.currentCopyRevisionId || savedTask.currentCopyRevisionId === revision.id) {
        throw new Error('图片规划已保存，但未能确认新的文案版本。请刷新任务并检查草稿。');
      }
      const pendingContent: CopyReviewDraftContent = {
        version: 1,
        draft: pendingDraft,
        aiDisclosureEnabled: pendingRating.aiDisclosureEnabled,
        copyOriginalScore: pendingRating.score,
        copyOriginalReasons: [...pendingRating.reasons].sort(),
        copyOriginalNote: pendingRating.note,
      };
      let localTransferError: unknown = null;
      let newDraftSaved = false;
      try {
        await saveLocalCopyReviewDraft({
          accountId: currentAccountId,
          taskId: detail.id,
          baseCopyRevisionId: savedTask.currentCopyRevisionId,
          reviewerUsername: currentUsername,
        }, { expectedLatestDraftId: null, content: pendingContent });
        newDraftSaved = true;
        await clearLocalCopyReviewDrafts({
          accountId: currentAccountId,
          taskId: detail.id,
          baseCopyRevisionId: revision.id,
          reviewerUsername: currentUsername,
        });
      } catch (caught) {
        localTransferError = caught;
      }
      await onUpdated('图片文案规划已单独保存；文案评分与审核状态保持不变。');
      const reloadedTask = await load();
      if (!reloadedTask || reloadedTask.currentCopyRevisionId !== savedTask.currentCopyRevisionId) {
        throw new Error('未能读取新的文案版本。请刷新任务后继续编辑。');
      }
      setDraft(current => current ? {
        ...current,
        copy: pendingDraft.copy,
        imageSettings: pendingDraft.imageSettings,
      } : current);
      setCopyOriginalScore(pendingRating.score);
      setCopyOriginalReasons(pendingRating.reasons);
      setCopyOriginalNote(pendingRating.note);
      setAiDisclosureEnabled(pendingRating.aiDisclosureEnabled);
      if (localTransferError) {
        const message = localTransferError instanceof Error ? localTransferError.message : '本机草稿保存失败';
        setDraftSaveStatus('error');
        setDraftSaveConflict(localTransferError instanceof LocalCopyReviewDraftConflictError);
        setDraftSaveError(newDraftSaved
          ? `图片规划和新版本草稿已保存，但旧版本草稿清理失败：${message}`
          : `图片规划已保存，但未提交的修改未能写入新版本的本机草稿：${message}`);
      }
    } catch (caught) {
      const message = caught instanceof ApiRequestError && caught.code === 'IMAGE_PLAN_UNCHANGED'
        ? '图片规划内容与当前正式版本一致，无需重复保存。请刷新任务核对当前版本。'
        : caught instanceof Error ? caught.message : '图片文案规划保存失败';
      setError(planRecorded ? `图片规划已正式保存，但后续草稿同步或页面刷新失败：${message}` : message);
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

  async function retryExhaustedImages() {
    if (!detail || !canRetryExhaustedImages || submitting || loading || draftSaveStatus === 'saving') return;
    if (!await confirm({
      title: '从已审核文案重新生图？',
      description: `直接重试仍沿用当前已审核文案和图片规划，保留历史失败记录，清除旧恢复快照并重置本轮自动重试计数。若错误源于内容本身，重新生图仍可能失败。${draftChanged ? '当前未提交的草稿修改不会用于本次重试。' : ''}`,
      confirmLabel: '重试生图',
    })) return;
    setSubmitting(true); setError('');
    try {
      await apiRequest(apiPath(`/v1/tasks/${detail.id}/retry-image`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      await onUpdated(`任务 #${detail.id} 已重新进入待生图队列，本轮自动重试计数已重置。`);
      onOpenChange(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重新生成图片失败'); }
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
    if (decision === 'REWORK' && reworkTarget !== 'COPY' && imagePlanChanged
        && rejectImagePlanBlankLines(draft!.imagePlan)) return;
    if (decision === 'REWORK' && reworkTarget !== 'COPY' && imagePlanChanged
        && rejectImagePlanBulletOverflow(draft!.imagePlan)) return;
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

  async function submitImageSelfReview(reviewDetail = detail, fromResolution = false) {
    if (!reviewDetail || !canSubmitImageSelfReview || !reviewDetail.currentImageRunId || (submitting && !fromResolution)) return;
    if (previousImageManualNoteRef.current !== null) {
      continueImageReviewRef.current = false;
      setError('图片版本已更新，旧版未提交的备注已保留。请核对新图后选择沿用或放弃旧版备注，再提交初审。');
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
    const imageNoteDraft = imageManualNoteDraftRef.current;
    const manualModificationNote = (imageNoteDraft?.taskId === reviewDetail.id
      && imageNoteDraft.imageRunId === reviewDetail.currentImageRunId
      && imageNoteDraft.copyRevisionId === reviewDetail.currentCopyRevisionId
      ? imageNoteDraft.note
      : imageApprovalNoteForVersion(reviewDetail.imageApprovalEvents,
        reviewDetail.currentImageRunId, reviewDetail.currentCopyRevisionId) ?? '').trim();
    if ([...manualModificationNote].length > IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH) {
      setError(`图片审核备注不能超过 ${IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH} 字。`);
      return;
    }
    if (manualModificationNote && !Array.isArray(reviewDetail.imageApprovalEvents)) {
      setError('中心服务尚不支持保存图片审核备注，请更新中心服务后再提交。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const pending = await apiRequest<PendingImageEdit[]>(apiPath(`/v1/tasks/${reviewDetail.id}/image-edits?pending=true`));
      setPendingImageEdits(pending);
      if (pending.length > 0) {
        continueImageReviewRef.current = true;
        setPendingEditsOpen(true);
        return;
      }
      const requiresRecheck = reviewDetail.state === 'IMAGE_REWORK_PENDING' || reviewDetail.mandatoryImageQc === true;
      if (!await confirm({
        title: requiresRecheck ? '确认提交图片复检？' : '确认完成图片初审？',
        description: `${requiresRecheck
          ? '当前图集将直接进入强制图片复检。无需在系统内修改或采用新图；如需后续手工修改，可在图片审核备注中写明具体点位。'
          : '提交后将按管理员设置进入图片抽检；若未开启图片抽检则直接进入交付池。'}${manualModificationNote ? '本次图片审核备注将随当前图集保存，供质检和后续手工修改查看。' : '初审不需要评分或填写打回原因。'}`,
        confirmLabel: requiresRecheck ? '提交图片复检' : '提交图片抽检',
      })) return;
      const requestPayload = { imageRunId: reviewDetail.currentImageRunId, manualModificationNote };
      await apiRequest(apiPath(`/v1/tasks/${reviewDetail.id}/submit-image-self-review`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...requestPayload,
          reviewSessionId: reviewSessionId(requestPayload),
        }),
      });
      await onUpdated(requiresRecheck ? '图片已提交强制复检。'
        : '图片初审已完成；系统已按图片抽检策略进入质检等待或交付池。', reviewDetail.id);
      reviewSessionRef.current = null;
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'IMAGE_EDITS_PENDING') {
        continueImageReviewRef.current = true;
        setPendingEditsOpen(true);
      } else setError(caught instanceof Error ? caught.message : '图片初审提交失败');
    } finally {
      setSubmitting(false);
    }
  }


  return { selectedAsset, detail, previewBackdrop, setPreviewBackdrop, canModifyImages, assets, selectedAssetIndex, load, onUpdated, selectedAssetPage, selectedResultImage, selectedAssetAlt, draft, isCopyOnlyFinalRework, submitting, setDraft, reviseImages, embedded, taskId, discardChanges, copyEditNotice, ReviewTitle, role, ReviewDescription, taskHasAssignee, canReviewCopy, canHandleAssignedImages, isAdmin, downloadable, revision, aiDisclosureEnabled, editable, loading, regeneratingImagePlan, setAiDisclosureEnabled, imageWorkMode, isImageReviewView, submitCopyReview, mobilePane, setMobilePane, currentImageRun, imageSectionRef, isCopyRework, isImageRetryRework, activeReworkRequirement, activeReworkReasonLabels, activeReworkProblemImages, draftSaveStatus, hasUnpersistedDraftChanges, lastDraftSavedAt, copyReviewDraftContent, currentDraftFingerprint, persistCopyReviewDraft, restoreCurrentCopyRevision, draftSaveError, draftHistory, restoredDraftId, restoreDraftVersion, copyEditBlockMessage, copyEditPointerAtRef, revealCopyEditNotice, copyFieldsReadOnly, updateCopy, showCopyRating, humanQualitySettingsLoading, humanQualitySettingsError, currentCopyRatingLabel, copyOriginalScore, showCopyScoreDescriptions, humanQualitySettingsUnavailable, savedCopyRatings, copyContentChanged, updateCopyOriginalScore, setError, copyReasonOptions, copyOriginalReasons, copyOriginalNote, humanRatingSettings, showCopyDeductionReasons, toggleReason, setCopyOriginalReasons, setCopyOriginalNote, copyFeedbackRequirement, originalCopyRatingComplete, copyAssessments, canApproveCopy, copyReworkSatisfied, scoreDefinitions, research, xiaohongshuLinks, canReviewImages, setSelectedAssetIndex, previewTriggerRef, setActiveAssetIndex, resultImageByAssetId, canEditImageManualNote, previousImageManualModificationNote, imageManualNoteDraftRef, setImageManualModificationNote, previousImageManualNoteRef, setPreviousImageManualModificationNote, imageManualModificationNote, savedImageManualModificationNote, imageSetComplete, imageScore, savedImageAssessment, updateImageScore, imageReasonOptions, imageReasons, imageReviewNote, showImageDeductionReasons, toggleImageReason, setImageReviewNote, imageReworkTarget, imageReworkCopyFields, toggleReworkCopyField, imageProblemAssetIds, toggleProblemAsset, imageScoreDefinition, imageAssessments, imageConfigurationChanged, pendingImageEdits, continueImageReviewRef, setPendingEditsOpen, activeAsset, activeAssetIndex, activeResultImage, canEditApprovedImagePlan, regenerateImagePlan, imagePlanComparison, imagePlanChanged, imagePlanGenerationNotice, backgroundPlan, completedPlan, canLoadCompletedPlan, appliedPlanIdRef, confirm, loadCompletedPlan, activePlanIndex, setActivePlanIndex, planEditBlockMessage, deleteImagePlanPage, planKindDisabled, updateImagePlan, planFieldsReadOnly, expandedPrompts, setExpandedPrompts, error, revealImagePlanLocation, approveCopyBlockReason, hasUnsavedChanges, imageManualNoteChanged, submittingImagePlan, canRetryCopy, retryCopy, canRetryExhaustedImages, retryExhaustedImages, canResumeImages, resumeImages, canDiscardImages, setSubmitting, onOpenChange, canSubmitImageSelfReview, submitImageSelfReview, imageRatingComplete, submitImageReview, setImageReworkTarget, canApproveImages, copyActionBusyReason, saveImagePlan, canDiscardReturnedCopy, discardReturnedCopy, copyRatingBlockReason, copyRatingComplete, submitCopyDecision, saveCopyBlockReason, draftChanged, pendingEditsOpen, setPendingImageEdits };
}
