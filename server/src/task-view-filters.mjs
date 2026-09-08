import { TASK_STATES, normalizeCreatorUserId, normalizeTaskCreatorRole } from './domain.mjs';

export const TASK_ATTENTION_FILTERS = Object.freeze(['ANOMALY', 'STALE', 'FAILED']);
export const SAVED_TASK_VIEW_KEYS = Object.freeze([
  'PERSONAL', 'ALL_COPY', 'COPY_REVIEW', 'IMAGE_WORK', 'MANUAL_ARCHIVE', 'COMPLETED', 'ALL_JOBS',
]);

const SAVED_STATES = new Set([
  'ALL', ...TASK_STATES,
  'queued', 'running', 'copyReview', 'imageReview', 'failed', 'completed', 'cancelled',
]);
const SAVED_SORTS = new Set(['priority:desc', 'createdAt:desc', 'createdAt:asc', 'id:desc', 'id:asc']);
const PAGE_SIZES = new Set([20, 50, 100]);

export function normalizeTaskAttention(value) {
  if (value === undefined || value === null || value === '') return null;
  const attention = String(value).toUpperCase();
  if (!TASK_ATTENTION_FILTERS.includes(attention)) throw new TypeError('task attention filter is invalid');
  return attention;
}

export function normalizeTaskViewName(value) {
  const name = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 50) throw new RangeError('saved task view name must contain between 1 and 50 characters');
  return name;
}

export function normalizeSavedTaskView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('saved task view must be an object');
  const name = normalizeTaskViewName(value.name);
  const viewKey = String(value.viewKey ?? '');
  if (!SAVED_TASK_VIEW_KEYS.includes(viewKey)) throw new TypeError('saved task view page is invalid');
  const raw = value.filters;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('saved task view filters must be an object');
  const query = String(raw.query ?? '').trim();
  if ([...query].length > 500) throw new RangeError('saved task view query cannot exceed 500 characters');
  if (raw.deduplicateQuery !== undefined && typeof raw.deduplicateQuery !== 'boolean') {
    throw new TypeError('saved task view deduplicateQuery must be a boolean');
  }
  const createdByUserId = raw.createdByUserId ? normalizeCreatorUserId(raw.createdByUserId) : '';
  const createdByRole = raw.createdByRole === 'ALL' || raw.createdByRole === undefined || raw.createdByRole === null
    ? 'ALL' : normalizeTaskCreatorRole(raw.createdByRole);
  const state = String(raw.state ?? 'ALL');
  if (!SAVED_STATES.has(state)) throw new TypeError('saved task view state is invalid');
  const sort = String(raw.sort ?? 'priority:desc');
  if (!SAVED_SORTS.has(sort)) throw new TypeError('saved task view sort is invalid');
  const attention = raw.attention === 'NONE' || raw.attention === undefined
    ? 'NONE' : normalizeTaskAttention(raw.attention);
  const pageSize = Number(raw.pageSize ?? 20);
  if (!PAGE_SIZES.has(pageSize)) throw new TypeError('saved task view pageSize is invalid');
  return {
    name,
    viewKey,
    filters: {
      query,
      deduplicateQuery: raw.deduplicateQuery === true,
      createdByUserId,
      createdByRole,
      state,
      sort,
      attention,
      pageSize,
    },
  };
}
