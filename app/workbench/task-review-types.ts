import { type PriorityTask } from "./task-priority-control";
import { type SecondaryAssignmentFeedback } from "./secondary-assignment-feedback";
import { type ResearchSnapshot } from "./model-call-trace";
import { type ImageApprovalEvent } from "../components/image-approval-note.mjs";
import { type ImageSettings, type PageLayout } from "../components/image-controls";
import { type ImageArtifactInfo } from "../components/image-history-compare";
import { type HumanQualityAssessment, type HumanScore } from "./human-quality-rating";
import { type LocalCopyReviewDraftRecord } from "./copy-review-draft-store";

export type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_QC_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'MANUAL_ARCHIVE' | 'IMAGE_QC_PENDING' | 'IMAGE_REWORK_PENDING' | 'REVIEWED' | 'CANCELLED' | 'PENDING_SECOND_ASSIGNMENT';

export type Copy = { title: string; body: string; tags: string[] };

export type ImagePlanItem = {
  kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
  layout?: PageLayout;
};

export type ReviewDraft = { copy: Copy; imagePlan: ImagePlanItem[]; imageSettings: ImageSettings };

export type ImagePlanBulletLengthWarning = {
  pageIndex: number;
  bulletIndex: number;
  length: number;
  recommendedMax: number;
};

export type ImagePlanBlankBulletLine = {
  pageIndex: number;
  bulletIndex: number;
};

export type ImagePlanDifference = {
  pageIndex: number;
  field: 'pages' | 'kind' | 'headline' | 'subtitle' | 'bullets' | 'prompt' | 'layout';
  bulletIndex?: number;
  layoutField?: string;
};

export type CopyReviewDraftContent = {
  version: 1;
  draft: ReviewDraft;
  aiDisclosureEnabled: boolean;
  copyOriginalScore: HumanScore | null;
  copyOriginalReasons: string[];
  copyOriginalNote: string;
};

export type CopyReviewDraftRecord = LocalCopyReviewDraftRecord<CopyReviewDraftContent>;

export type LegacyCopyReviewDraftRecord = {
  id: number;
  taskId: number;
  baseCopyRevisionId: number;
  reviewerAccountId: number;
  reviewerUsername: string;
  version: number;
  content: CopyReviewDraftContent;
  createdAt: string;
};

export type ReworkReasonSnapshot = { code: string; group?: string; label: string };

export type ReworkCopyField = 'TITLE' | 'BODY' | 'TAGS' | 'IMAGE_PLAN';

export type ReworkRequirement = {
  source: 'COPY_QA' | 'IMAGE_QA';
  target: 'COPY' | 'IMAGE' | 'BOTH';
  reasonCodes: string[];
  reasonSnapshots: ReworkReasonSnapshot[];
  copyFields: ReworkCopyField[];
  problemAssetIds: number[];
  note: string | null;
  sourceImageRunId: string | null;
  returnedAt?: string | null;
};

export type CopyRevision = {
  id: number;
  executionId: string | null;
  revision: number;
  content: {
    copy?: Copy;
    imagePlan?: ImagePlanItem[];
    imageSettings?: ImageSettings;
    reviewed?: { copy?: Copy; imagePlan?: ImagePlanItem[] };
    generation?: { research?: ResearchSnapshot };
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
  reworkReasonSnapshots?: ReworkReasonSnapshot[];
  reworkCopyFields?: ReworkCopyField[];
  reworkProblemAssetIds?: number[];
  reworkNote?: string | null;
  reworkRecommendation?: 'REWORK' | 'DISCARD';
  reworkSamplingItemId?: string | null;
};

export type TaskDetail = PriorityTask & {
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
  imageDiscardEvents?: { note: string; actorUsername: string; createdAt: string }[];
  imageApprovalEvents?: ImageApprovalEvent[];
  copyDiscardEvents?: { source: 'COPY_QA' | 'COPY_QA_RETURN'; reasonCode: string; note: string; actorUsername: string; createdAt: string }[];
  imageQaReturn?: ReworkRequirement | null;
  secondaryAssignmentFeedback?: SecondaryAssignmentFeedback | null;
  xiaohongshuSearchBlockedReason?: 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED' | null;
  assignedToUserId?: string | null;
  assignedToAccountId?: number | null;
  aiDisclosureEnabled: boolean;
  mandatoryCopyQc?: boolean;
  copyQaAutoPassed?: boolean;
  copyQaReworkPending?: boolean;
  mandatoryCopyQcOrigin?: 'QA_RETURN' | 'FINAL_REWORK' | 'IMAGE_RETRY_REVIEW' | 'DISCARD_RESTORE' | 'SECOND_ASSIGNMENT' | null;
  mandatoryImageQc?: boolean;
  mandatoryImageQcOrigin?: 'QA_RETURN' | 'BATCH_RETURN' | 'DISCARD_RESTORE' | 'SECOND_ASSIGNMENT' | null;
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
  imageRetryFailures?: Array<{
    attempt: number;
    stage: string | null;
    error: string;
    startedAt: string | null;
  }>;
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

export type ImagePlanRegenerationJob = {
  id: string;
  requestedByUsername: string;
  requestedByAccountId: number;
  copyRevisionId: number;
  copy: Copy;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STALE';
  result: { imagePlan: ImagePlanItem[]; model: string | null } | null;
  error: string | null;
};

export type ReviewResearch = NonNullable<NonNullable<CopyRevision['content']['generation']>['research']>;

export type CopyEditArea = 'copy' | 'plan';
