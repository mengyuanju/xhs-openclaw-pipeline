import { FileCheck2, FileText, Image as ImageIcon, UserRound } from 'lucide-react';

export type TaskState =
  | 'COPY_QUEUED' | 'COPY_RUNNING' | 'COPY_REVIEW_PENDING' | 'COPY_FAILED'
  | 'IMAGE_QUEUED' | 'IMAGE_RUNNING' | 'IMAGE_FAILED'
  | 'DELIVERY_REVIEW_PENDING' | 'COMPLETED' | 'CANCELLED';

export type ViewKey = 'PERSONAL' | 'COPY_REVIEW' | 'IMAGE_WORK' | 'DELIVERY_REVIEW' | 'COMPLETED' | 'ALL_COPY';

export const WORKBENCH_VIEWS: Array<{
  key: ViewKey;
  href: string;
  label: string;
  description: string;
  icon: typeof FileText;
  states: TaskState[];
  personalOnly?: boolean;
}> = [
  {
    key: 'PERSONAL',
    href: '/workbench/personal',
    label: '个人作业中心',
    description: '只显示当前账号创建的待文案执行、文案执行中和文案执行失败任务；失败任务可重试。',
    icon: UserRound,
    states: ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'],
    personalOnly: true,
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
    key: 'DELIVERY_REVIEW',
    href: '/workbench/delivery-review',
    label: '图文待审核',
    description: '显示图片生成完成、等待人工审核的图文任务。',
    icon: FileCheck2,
    states: ['DELIVERY_REVIEW_PENDING'],
  },
  {
    key: 'COMPLETED',
    href: '/workbench/completed',
    label: '已完成',
    description: '显示已完成图文审核的任务。',
    icon: FileCheck2,
    states: ['COMPLETED'],
  },
  {
    key: 'ALL_COPY',
    href: '/workbench/all-copy',
    label: '全部文案任务',
    description: '显示所有节点待执行、执行中和执行失败的文案任务，可进入详情重试。',
    icon: FileText,
    states: ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED'],
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
