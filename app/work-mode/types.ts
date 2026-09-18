import type { CopyQaItem } from '../copy-qa/types';
import type { ImageQaItem } from '../image-qa/types';

export type WorkKind = 'COPY' | 'IMAGE' | 'COPY_QA' | 'IMAGE_QA';
export type WorkItem = {
  id: string; kind: WorkKind; label: string; source: string | null; rework: boolean;
  taskId?: number; state?: string; version?: number | string | null;
  qa?: CopyQaItem | ImageQaItem;
};
export type WorkPage = { kind: WorkKind; kinds: WorkKind[]; items: WorkItem[]; total: number | null; hasMore: boolean };
export const WORK_LABELS: Record<WorkKind, string> = { COPY: '文案作业', IMAGE: '图片作业', COPY_QA: '文案质检', IMAGE_QA: '图片质检' };
export function workItemKey(item: WorkItem) { return `${item.kind}:${item.id}`; }
export function isTaskPending(kind: WorkKind, state: string) {
  return kind === 'COPY' ? state === 'COPY_REVIEW_PENDING' : kind === 'IMAGE' && ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'].includes(state);
}
