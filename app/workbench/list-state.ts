import type { TaskSort } from './views';

export type TaskAttention = 'NONE' | 'ANOMALY' | 'STALE' | 'FAILED';

export type WorkbenchListState = {
  page: number;
  pageSize: 20 | 50 | 100;
  query: string;
  sort: TaskSort;
  deduplicateQuery: boolean;
  createdByUserId: string;
  createdByAccountId: number | null;
  createdByRole: string;
  state: string;
  attention: TaskAttention;
  taskId: number | null;
};

export const DEFAULT_WORKBENCH_LIST_STATE: WorkbenchListState = Object.freeze({
  page: 1,
  pageSize: 20,
  query: '',
  sort: 'priority:desc',
  deduplicateQuery: false,
  createdByUserId: '',
  createdByAccountId: null,
  createdByRole: 'ALL',
  state: 'ALL',
  attention: 'NONE',
  taskId: null,
});

const SORTS = new Set<TaskSort>(['priority:desc', 'createdAt:desc', 'createdAt:asc', 'id:desc', 'id:asc']);
const PAGE_SIZES = new Set([20, 50, 100]);
const CREATOR_ROLES = new Set(['ALL', 'ADMIN', 'REVIEWER', 'USER', 'UNKNOWN']);
const TASK_STATES = new Set([
  'ALL', 'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED', 'CANCELLED',
  'queued', 'running', 'copyReview', 'imageReview', 'failed', 'completed', 'cancelled',
]);
const ATTENTION = new Set<TaskAttention>(['NONE', 'ANOMALY', 'STALE', 'FAILED']);

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function parseWorkbenchListState(
  search: Record<string, string | string[] | undefined>,
  { allowAdminFilters = false }: { allowAdminFilters?: boolean } = {},
): WorkbenchListState {
  const pageSize = positiveInteger(one(search.pageSize), DEFAULT_WORKBENCH_LIST_STATE.pageSize);
  const sort = one(search.sort);
  const role = one(search.createdByRole);
  const state = one(search.state);
  const attention = one(search.attention) as TaskAttention | undefined;
  const creator = one(search.createdByUserId)?.trim() ?? '';
  const creatorAccountId = positiveInteger(one(search.createdByAccountId), 0);
  const validCreator = allowAdminFilters && /^[a-zA-Z0-9._:-]{1,100}$/u.test(creator) && creatorAccountId > 0;
  const query = one(search.query)?.trim() ?? '';
  const taskId = positiveInteger(one(search.taskId), 0);
  return {
    page: positiveInteger(one(search.page), 1),
    pageSize: PAGE_SIZES.has(pageSize) ? pageSize as WorkbenchListState['pageSize'] : 20,
    query: [...query].slice(0, 500).join(''),
    sort: sort && SORTS.has(sort as TaskSort) ? sort as TaskSort : 'priority:desc',
    deduplicateQuery: ['1', 'true'].includes(one(search.deduplicateQuery) ?? ''),
    createdByUserId: validCreator ? creator : '',
    createdByAccountId: validCreator ? creatorAccountId : null,
    createdByRole: allowAdminFilters && role && CREATOR_ROLES.has(role) ? role : 'ALL',
    state: state && TASK_STATES.has(state) ? state : 'ALL',
    attention: allowAdminFilters && attention && ATTENTION.has(attention) ? attention : 'NONE',
    taskId: taskId || null,
  };
}

export function workbenchListSearch(state: WorkbenchListState, { includeAdminFilters = false } = {}) {
  const search = new URLSearchParams();
  if (state.page > 1) search.set('page', String(state.page));
  if (state.pageSize !== 20) search.set('pageSize', String(state.pageSize));
  if (state.query) search.set('query', state.query);
  if (state.sort !== 'priority:desc') search.set('sort', state.sort);
  if (state.deduplicateQuery) search.set('deduplicateQuery', '1');
  if (state.state !== 'ALL') search.set('state', state.state);
  if (includeAdminFilters) {
    if (state.createdByUserId && state.createdByAccountId) {
      search.set('createdByUserId', state.createdByUserId);
      search.set('createdByAccountId', String(state.createdByAccountId));
    }
    if (state.createdByRole !== 'ALL') search.set('createdByRole', state.createdByRole);
    if (state.attention !== 'NONE') search.set('attention', state.attention);
  }
  if (state.taskId) search.set('taskId', String(state.taskId));
  return search;
}
