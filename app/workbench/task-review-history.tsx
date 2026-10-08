'use client';

import { LazyImageHistory } from './lazy-image-history';
import { ModelCallTrace } from './model-call-trace';
import { TaskHistory } from './task-history';
import type { ImageSettings } from '../components/image-controls';
import type { CopyRevision, ReviewResearch, TaskDetail } from './task-review-model';

export function TaskReviewImageHistory({ detail, onRestore }: {
  detail: TaskDetail; onRestore?: (settings: ImageSettings) => void;
}) {
  return <LazyImageHistory key={detail.id} taskId={detail.id} runs={detail.imageRuns}
    currentRunId={detail.currentImageRunId} assets={detail.assets} onRestore={onRestore} />;
}

export function TaskReviewModelHistory({ detail, research, revision }: {
  detail: TaskDetail; research?: ReviewResearch; revision?: CopyRevision;
}) {
  return <ModelCallTrace key={detail.id} taskId={detail.id} researchSnapshot={research}
    copyRevisionId={revision?.id} researchExecutionId={revision?.executionId} />;
}

export function TaskReviewHistory({ detail, admin }: { detail: TaskDetail; admin: boolean }) {
  return <TaskHistory key={`history-${detail.id}`} taskId={detail.id} admin={admin} />;
}
