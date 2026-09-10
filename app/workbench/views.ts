import { FileCheck2, FileText, Image as ImageIcon, Inbox, ListChecks, UserRound } from 'lucide-react';

export type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_QC_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'MANUAL_ARCHIVE' | 'REVIEWED' | 'CANCELLED';

export type ViewKey = 'PERSONAL' | 'UNASSIGNED' | 'ALL_COPY' | 'COPY_REVIEW' | 'IMAGE_WORK' | 'MANUAL_ARCHIVE' | 'COMPLETED' | 'ALL_JOBS';
export type TaskSort = 'priority:desc' | 'createdAt:desc' | 'createdAt:asc' | 'id:desc' | 'id:asc';

export const TASK_SORT_OPTIONS: Array<{ value: TaskSort; label: string }> = [
  { value: 'priority:desc', label: '待处理优先' },
  { value: 'createdAt:desc', label: '创建时间：最新在前' },
  { value: 'createdAt:asc', label: '创建时间：最早在前' },
  { value: 'id:desc', label: 'Query ID：从大到小' },
  { value: 'id:asc', label: 'Query ID：从小到大' },
];

export function taskSortParams(sort: TaskSort) {
  const [sortBy, sortOrder] = sort.split(':') as ['priority' | 'createdAt' | 'id', 'asc' | 'desc'];
  return { sortBy, sortOrder };
}

export const TASK_STATE_PRIORITY: Record<TaskState, number> = {
  COPY_REVIEW_PENDING: 1,
  COPY_QC_PENDING: 2,
  MANUAL_ARCHIVE: 3,
  COPY_RUNNING: 4,
  IMAGE_RUNNING: 5,
  COPY_FAILED: 6,
  IMAGE_FAILED: 6,
  COPY_QUEUED: 7,
  IMAGE_QUEUED: 7,
  REVIEWED: 8,
  CANCELLED: 9,
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

export function compareTasks<T extends { id: number; state: TaskState; createdAt: string }>(
  left: T,
  right: T,
  sort: TaskSort,
) {
  if (sort === 'priority:desc') return compareTasksByStatePriority(left, right);
  const direction = sort.endsWith(':asc') ? 1 : -1;
  if (sort.startsWith('id:')) return direction * (left.id - right.id);
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const createdAtDifference = (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0)
    - (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0);
  return direction * (createdAtDifference || left.id - right.id);
}

export const WORKBENCH_VIEWS: Array<{
  key: ViewKey;
  href: string;
  label: string;
  description: string;
  icon: typeof FileText;
  states: TaskState[];
  personalOnly?: boolean;
  unassignedOnly?: boolean;
  adminOnly?: boolean;
}> = [
  {
    key: 'PERSONAL',
    href: '/workbench/personal',
    label: '个人作业中心',
    description: '显示当前账号提交或负责的 Query；机器阶段可跟踪进度，分配后按权限审核或处理。',
    icon: UserRound,
    states: [
      'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_QC_PENDING', 'COPY_FAILED',
      'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED',
    ],
    personalOnly: true,
  },
  {
    key: 'UNASSIGNED',
    href: '/workbench/unassigned',
    label: '待审核分配',
    description: '显示文案已经生成、正在等待分配审核负责人的 Query。机器生成阶段不需要负责人。',
    icon: Inbox,
    states: ['COPY_REVIEW_PENDING'],
    unassignedOnly: true,
    adminOnly: true,
  },
  {
    key: 'ALL_COPY',
    href: '/workbench/all-copy',
    label: '全部文案任务',
    description: '显示所有用户待执行、执行中和执行失败的文案任务，可进入详情重试。',
    icon: FileText,
    states: ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_QC_PENDING', 'COPY_FAILED'],
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
    label: '图文终审',
    description: '核对完整图文，可明确选择退回文案、退回图片、两者都退回，或终审通过。',
    icon: FileCheck2,
    states: ['MANUAL_ARCHIVE'],
  },
  {
    key: 'COMPLETED',
    href: '/workbench/completed',
    label: '交付池',
    description: '只显示图文终审通过且交付条目已就绪的任务，可查看详情和下载资源。',
    icon: FileCheck2,
    states: ['REVIEWED'],
    adminOnly: true,
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
  task: { state: TaskState; assignedToUserId?: string | null; assignedToAccountId?: number | null;
    createdByUserId?: string | null; createdByAccountId?: number | null },
  view: (typeof WORKBENCH_VIEWS)[number],
  userId: string,
  userAccountId?: number | null,
) {
  const assigneeUserId = Object.hasOwn(task, 'assignedToUserId')
    ? task.assignedToUserId
    : task.createdByUserId;
  const createdByCurrentAccount = task.createdByUserId === userId
    && (userAccountId === undefined || userAccountId === null
      || task.createdByAccountId === userAccountId);
  const assignedToCurrentAccount = assigneeUserId === userId
    && (userAccountId === undefined || userAccountId === null
      || task.assignedToAccountId === userAccountId);
  return view.states.includes(task.state)
    && (!view.personalOnly || assignedToCurrentAccount || createdByCurrentAccount)
    && (!view.unassignedOnly || assigneeUserId === null);
}
