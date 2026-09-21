import type { TaskSort } from './views';
import { normalizeTaskDateRange } from '../../src/control-plane/task-date-filter.mjs';

export type TaskAttention = 'NONE' | 'ANOMALY' | 'STALE' | 'FAILED';
export type PersonalTaskScope = 'ALL' | 'ASSIGNED' | 'CREATED';

export type WorkbenchListState = {
  page: number;
  pageSize: 20 | 50 | 100;
  query: string;
  queryPackageName: string;
  sort: TaskSort;
  deduplicateQuery: boolean;
  createdByUserId: string;
  createdByAccountId: number | null;
  assignedToUserId: string;
  assignedToAccountId: number | null;
  createdByRole: string;
  createdDateFrom: string;
  createdDateTo: string;
  personalScope: PersonalTaskScope;
  state: string;
  attention: TaskAttention;
  taskId: number | null;
};

export const DEFAULT_WORKBENCH_LIST_STATE: WorkbenchListState = Object.freeze({
  page: 1,
  pageSize: 20,
  query: '',
  queryPackageName: '',
  sort: 'priority:desc',
  deduplicateQuery: false,
  createdByUserId: '',
  createdByAccountId: null,
  assignedToUserId: '',
  assignedToAccountId: null,
  createdByRole: 'ALL',
  createdDateFrom: '',
  createdDateTo: '',
  personalScope: 'ALL',
  state: 'ALL',
  attention: 'NONE',
  taskId: null,
});

const SORTS = new Set<TaskSort>(['priority:desc', 'createdAt:desc', 'createdAt:asc', 'id:desc', 'id:asc']);
const PAGE_SIZES = new Set([20, 50, 100]);
const CREATOR_ROLES = new Set(['ALL', 'ADMIN', 'REVIEWER', 'USER', 'UNKNOWN']);
const TASK_STATES = new Set([
  'ALL', 'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_QC_PENDING', 'COPY_FAILED',
  'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'CANCELLED',
  'queued', 'running', 'copyReview', 'imageReview', 'failed', 'completed', 'cancelled',
  'copyQaReturned', 'personalReview', 'personalProduction',
]);
const ATTENTION = new Set<TaskAttention>(['NONE', 'ANOMALY', 'STALE', 'FAILED']);
const PERSONAL_SCOPES = new Set<PersonalTaskScope>(['ALL', 'ASSIGNED', 'CREATED']);

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
  const assignee = one(search.assignedToUserId)?.trim() ?? '';
  const assigneeAccountId = positiveInteger(one(search.assignedToAccountId), 0);
  const validAssignee = allowAdminFilters && /^[a-zA-Z0-9._:-]{1,100}$/u.test(assignee) && assigneeAccountId > 0;
  const personalScope = one(search.personalScope) as PersonalTaskScope | undefined;
  const query = one(search.query)?.trim() ?? '';
  const queryPackageName = one(search.queryPackageName)?.replace(/\s+/gu, ' ').trim() ?? '';
  const taskId = positiveInteger(one(search.taskId), 0);
  let createdDateFrom = '';
  let createdDateTo = '';
  if (allowAdminFilters) {
    try {
      const range = normalizeTaskDateRange(one(search.createdDateFrom), one(search.createdDateTo));
      createdDateFrom = range.createdDateFrom ?? '';
      createdDateTo = range.createdDateTo ?? '';
    } catch {
      // Invalid or reversed URL ranges are ignored rather than sent to the center.
    }
  }
  return {
    page: positiveInteger(one(search.page), 1),
    pageSize: PAGE_SIZES.has(pageSize) ? pageSize as WorkbenchListState['pageSize'] : 20,
    query: [...query].slice(0, 500).join(''),
    queryPackageName: [...queryPackageName].slice(0, 200).join(''),
    sort: sort && SORTS.has(sort as TaskSort) ? sort as TaskSort : 'priority:desc',
    deduplicateQuery: ['1', 'true'].includes(one(search.deduplicateQuery) ?? ''),
    createdByUserId: validCreator ? creator : '',
    createdByAccountId: validCreator ? creatorAccountId : null,
    assignedToUserId: validAssignee ? assignee : '',
    assignedToAccountId: validAssignee ? assigneeAccountId : null,
    createdByRole: allowAdminFilters && role && CREATOR_ROLES.has(role) ? role : 'ALL',
    createdDateFrom,
    createdDateTo,
    personalScope: personalScope && PERSONAL_SCOPES.has(personalScope) ? personalScope : 'ALL',
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
  if (state.queryPackageName) search.set('queryPackageName', state.queryPackageName);
  if (state.sort !== 'priority:desc') search.set('sort', state.sort);
  if (state.deduplicateQuery) search.set('deduplicateQuery', '1');
  if (state.state !== 'ALL') search.set('state', state.state);
  if (state.personalScope !== 'ALL') search.set('personalScope', state.personalScope);
  if (includeAdminFilters) {
    if (state.createdByUserId && state.createdByAccountId) {
      search.set('createdByUserId', state.createdByUserId);
      search.set('createdByAccountId', String(state.createdByAccountId));
    }
    if (state.assignedToUserId && state.assignedToAccountId) {
      search.set('assignedToUserId', state.assignedToUserId);
      search.set('assignedToAccountId', String(state.assignedToAccountId));
    }
    if (state.createdByRole !== 'ALL') search.set('createdByRole', state.createdByRole);
    if (state.createdDateFrom) search.set('createdDateFrom', state.createdDateFrom);
    if (state.createdDateTo) search.set('createdDateTo', state.createdDateTo);
    if (state.attention !== 'NONE') search.set('attention', state.attention);
  }
  if (state.taskId) search.set('taskId', String(state.taskId));
  return search;
}
