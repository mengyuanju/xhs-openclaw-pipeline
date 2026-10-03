'use client';

import dynamic from 'next/dynamic';

export const TaskReviewDialog = dynamic(
  () => import('./task-review-dialog').then(module => module.TaskReviewDialog),
  { ssr: false, loading: () => <div className="workbench-review-loading" role="status">正在加载任务审核…</div> },
);
