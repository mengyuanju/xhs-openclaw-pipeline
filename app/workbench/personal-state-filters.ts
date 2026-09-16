import { STATE_GROUPS } from '../../src/web-statistics/summary.mjs';
import type { Summary } from '../workbench-statistics/types';
import type { TaskState } from './views';

export type PersonalPrimaryStateFilter =
  | 'ALL'
  | 'personalReview'
  | 'personalProduction'
  | 'failed'
  | 'completed';

type PrimaryFilter = {
  value: PersonalPrimaryStateFilter;
  label: string;
  description: string;
};

export const PERSONAL_PRIMARY_FILTERS: readonly PrimaryFilter[] = [
  { value: 'ALL', label: '全部相关', description: '我创建或负责的全部作业' },
  { value: 'personalReview', label: '待人工处理', description: '等待文案或图片审核、返修' },
  { value: 'personalProduction', label: '生产中', description: '机器排队或执行中的作业' },
  { value: 'failed', label: '执行失败', description: '文案或图片生成失败' },
  { value: 'completed', label: '已完成', description: '已通过审核并进入交付' },
];

export const PERSONAL_DETAIL_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'COPY_QUEUED', label: '待文案执行' },
  { value: 'COPY_RUNNING', label: '文案生成中' },
  { value: 'COPY_REVIEW_PENDING', label: '待文案审核' },
  { value: 'COPY_QC_PENDING', label: '待文案质检' },
  { value: 'COPY_FAILED', label: '文案生成失败' },
  { value: 'IMAGE_QUEUED', label: '待生图' },
  { value: 'IMAGE_RUNNING', label: '生图中' },
  { value: 'IMAGE_FAILED', label: '生图失败' },
  { value: 'MANUAL_ARCHIVE', label: '待图片初审' },
  { value: 'IMAGE_QC_PENDING', label: '待图片质检' },
  { value: 'IMAGE_REWORK_PENDING', label: '图片质检打回' },
  { value: 'REVIEWED', label: '已进入交付池' },
  { value: 'CANCELLED', label: '已废弃' },
  { value: 'copyQaReturned', label: '文案质检打回' },
];

export const PERSONAL_LEGACY_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'queued', label: '组合：全部排队中' },
  { value: 'running', label: '组合：全部生成中' },
  { value: 'copyReview', label: '组合：全部文案审核' },
  { value: 'imageReview', label: '组合：全部图片审核' },
  { value: 'cancelled', label: '组合：全部已废弃' },
];

const PRIMARY_VALUES = new Set(PERSONAL_PRIMARY_FILTERS.map((filter) => filter.value));
const DETAIL_VALUES = new Set(PERSONAL_DETAIL_FILTERS.map((filter) => filter.value));
const LEGACY_VALUES = new Set(PERSONAL_LEGACY_FILTERS.map((filter) => filter.value));
const ALL_STATES = [...new Set(Object.values(STATE_GROUPS).flat())] as TaskState[];

export const PERSONAL_STATE_FILTER_VALUES = new Set<string>([
  ...PRIMARY_VALUES,
  ...DETAIL_VALUES,
  ...LEGACY_VALUES,
]);

export function isPersonalStateFilter(value: string): boolean {
  return PERSONAL_STATE_FILTER_VALUES.has(value);
}

export function isPersonalPrimaryStateFilter(value: string): value is PersonalPrimaryStateFilter {
  return PRIMARY_VALUES.has(value as PersonalPrimaryStateFilter);
}

export function isPersonalAdvancedStateFilter(value: string): boolean {
  return DETAIL_VALUES.has(value) || LEGACY_VALUES.has(value);
}

export function personalStateFilterStates(filter: string): TaskState[] {
  if (filter === 'personalReview') {
    return [...STATE_GROUPS.copyReview, ...STATE_GROUPS.imageReview] as TaskState[];
  }
  if (filter === 'personalProduction') {
    return [...STATE_GROUPS.queued, ...STATE_GROUPS.running] as TaskState[];
  }
  if (Object.hasOwn(STATE_GROUPS, filter)) {
    return [...STATE_GROUPS[filter as keyof typeof STATE_GROUPS]] as TaskState[];
  }
  if (DETAIL_VALUES.has(filter) && filter !== 'copyQaReturned') return [filter as TaskState];
  if (filter === 'copyQaReturned') return [...STATE_GROUPS.copyReview] as TaskState[];
  return ALL_STATES;
}

export function personalStateFilterCount(
  filter: PersonalPrimaryStateFilter,
  summary: Summary | null | undefined,
): number | null {
  if (!summary) return null;
  if (filter === 'ALL') return summary.total;
  if (filter === 'personalReview') return summary.states.copyReview + summary.states.imageReview;
  if (filter === 'personalProduction') return summary.states.queued + summary.states.running;
  return summary.states[filter];
}
