import { FileCheck2, FileText, Image as ImageIcon, ListChecks, UserRound } from 'lucide-react';

export type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'MANUAL_ARCHIVE' | 'REVIEWED' | 'CANCELLED';

export type ViewKey = 'PERSONAL' | 'ALL_COPY' | 'COPY_REVIEW' | 'IMAGE_WORK' | 'MANUAL_ARCHIVE' | 'COMPLETED' | 'ALL_JOBS';

export const TASK_STATE_PRIORITY: Record<TaskState, number> = {
  COPY_REVIEW_PENDING: 1,
  MANUAL_ARCHIVE: 2,
  COPY_RUNNING: 3,
  IMAGE_RUNNING: 4,
  COPY_FAILED: 5,
  IMAGE_FAILED: 5,
  COPY_QUEUED: 6,
  IMAGE_QUEUED: 6,
  REVIEWED: 7,
  CANCELLED: 8,
};

export function compareTasksByStatePriority<T extends { id: number; state: TaskState; createdAt: string }>(left: T, right: T) {
  const priorityDifference = TASK_STATE_PRIORITY[left.state] - TASK_STATE_PRIORITY[right.state];
  if (priorityDifference) return priorityDifference;
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const createdAtDifference = (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0)
    - (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0);
  return createdAtDifference || right.id - left.id;
}

export const WORKBENCH_VIEWS: Array<{
  key: ViewKey;
  href: string;
  label: string;
  description: string;
  icon: typeof FileText;
  states: TaskState[];
  personalOnly?: boolean;
  adminOnly?: boolean;
}> = [
  {
    key: 'PERSONAL',
    href: '/workbench/personal',
    label: '个人作业中心',
    description: '显示当前账号创建的全部 Query 任务，可跟踪进度、审核、重试或废弃。',
    icon: UserRound,
    states: [
      'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
      'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED',
    ],
    personalOnly: true,
  },
  {
    key: 'ALL_COPY',
    href: '/workbench/all-copy',
    label: '全部文案任务',
    description: '显示所有用户待执行、执行中和执行失败的文案任务，可进入详情重试。',
    icon: FileText,
    states: ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'],
  },
  {
    key: 'COPY_REVIEW',
    href: '/workbench/copy-review',
    label: '待文案审核',
    description: '显示待人工审核的文案；生图连续3次失败的任务会回到此处，等待重新审核。',
    icon: FileCheck2,
    states: ['COPY_REVIEW_PENDING'],
  },
  {
    key: 'IMAGE_WORK',
    href: '/workbench/images',
    label: '生图中',
    description: '显示所有执行节点待生图和正在生图的任务。',
    icon: ImageIcon,
    states: ['IMAGE_QUEUED', 'IMAGE_RUNNING'],
  },
  {
    key: 'MANUAL_ARCHIVE',
    href: '/workbench/manual-archive',
    label: '人工归档',
    description: '审核生成的图文，由审核员选择审核通过、重试生图或废弃。',
    icon: FileCheck2,
    states: ['MANUAL_ARCHIVE'],
  },
  {
    key: 'COMPLETED',
    href: '/workbench/completed',
    label: '已完成',
    description: '显示图片已审核通过的图文任务，可查看详情和下载资源。',
    icon: FileCheck2,
    states: ['REVIEWED'],
  },
  {
    key: 'ALL_JOBS',
    href: '/workbench/all',
    label: '全部作业',
    description: '查看所有账号和执行节点的任务，包含生图失败、已废弃与历史任务。角色按创建者当前角色筛选。',
    icon: ListChecks,
    states: Object.keys(TASK_STATE_PRIORITY) as TaskState[],
    adminOnly: true,
  },
];

export function matchesWorkbenchView(
  task: { state: TaskState; createdByUserId?: string | null },
  view: (typeof WORKBENCH_VIEWS)[number],
  userId: string,
) {
  return view.states.includes(task.state)
    && (!view.personalOnly || task.createdByUserId === userId);
}
