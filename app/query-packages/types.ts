export type QueryPackageDecision = 'PENDING' | 'SELECTED' | 'REJECTED';
export type QueryPackageValidationStatus = 'READY' | 'INVALID' | 'DUPLICATE' | 'TASK_CREATED';

export const QUERY_PACKAGE_ITEM_PAGE_SIZE = 100;
export const QUERY_PACKAGE_SELECTION_LIMIT = 5_000;
export const QUERY_PACKAGE_IMPORT_LIMIT = 10_000;

export type QueryPackageCounts = {
  total: number;
  pending: number;
  selected: number;
  rejected: number;
  produced: number;
};

export type QueryPackageSummary = {
  id: number;
  name: string;
  status: string;
  assignedToUserId: string | null;
  assignedToAccountId: number | null;
  assignedToDisplayName: string | null;
  assignedToRole: 'REVIEWER' | 'USER' | null;
  assigneeStatus: 'ACTIVE' | 'DISABLED' | null;
  assignedItemCount: number;
  assignedUserCount: number;
  version: number;
  counts: QueryPackageCounts;
  createdAt: string;
  updatedAt?: string;
};

export type QueryPackagePage = {
  items: QueryPackageSummary[];
  total: number | null;
  returnedCount: number;
};

export type QueryPackageItem = {
  id: number;
  rowNumber: number;
  externalId: string | null;
  query: string;
  input: Record<string, unknown>;
  requestedImageCount: number | 'auto';
  validationStatus: QueryPackageValidationStatus;
  screeningDecision: QueryPackageDecision;
  screeningReason: string | null;
  screeningAssignedToAccountId: number | null;
  screeningAssignedToUserId: string | null;
  taskId?: number | null;
  version: number;
};

export type QueryPackageDetail = QueryPackageSummary & {
  items: QueryPackageItem[];
  itemPage: {
    total: number;
    returnedCount: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type WorkflowQualitySettings = {
  version: number;
  queryPackage: { workerImportEnabled: boolean };
  copySampling: {
    enabled: boolean;
    rateBps: number;
    blindReviewEnabled: boolean;
    reviewerBatchReturnEnabled: boolean;
  };
};

export function normalizeWorkflowQualitySettings(value: unknown): WorkflowQualitySettings | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<WorkflowQualitySettings>;
  const version = Number(row.version);
  if (!row.queryPackage || !row.copySampling || !Number.isSafeInteger(version) || version < 1) return null;
  const rateBps = Number(row.copySampling.rateBps);
  return {
    version,
    queryPackage: { workerImportEnabled: row.queryPackage.workerImportEnabled === true },
    copySampling: {
      enabled: row.copySampling.enabled === true,
      rateBps: Number.isSafeInteger(rateBps) ? Math.min(10_000, Math.max(0, rateBps)) : 0,
      blindReviewEnabled: row.copySampling.blindReviewEnabled === true,
      reviewerBatchReturnEnabled: row.copySampling.reviewerBatchReturnEnabled === true,
    },
  };
}

export const EMPTY_PACKAGE_COUNTS: QueryPackageCounts = {
  total: 0,
  pending: 0,
  selected: 0,
  rejected: 0,
  produced: 0,
};

function finiteCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function normalizePackageSummary(value: unknown): QueryPackageSummary | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  const version = Number(row.version);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(version) || version < 1
    || typeof row.name !== 'string' || !row.name.trim()) return null;
  const counts = row.counts && typeof row.counts === 'object'
    ? row.counts as Record<string, unknown>
    : {};
  const assignedToAccountId = Number(row.assignedToAccountId);
  const assignedToRole = ['REVIEWER', 'USER'].includes(String(row.assignedToRole))
    ? row.assignedToRole as 'REVIEWER' | 'USER'
    : null;
  const assigneeStatus = ['ACTIVE', 'DISABLED'].includes(String(row.assigneeStatus))
    ? row.assigneeStatus as 'ACTIVE' | 'DISABLED'
    : null;
  return {
    id,
    name: row.name.trim(),
    status: typeof row.status === 'string' ? row.status : 'SCREENING',
    assignedToUserId: typeof row.assignedToUserId === 'string' && row.assignedToUserId.trim()
      ? row.assignedToUserId.trim()
      : null,
    assignedToAccountId: Number.isSafeInteger(assignedToAccountId) && assignedToAccountId > 0
      ? assignedToAccountId
      : null,
    assignedToDisplayName: typeof row.assignedToDisplayName === 'string' && row.assignedToDisplayName.trim()
      ? row.assignedToDisplayName.trim()
      : null,
    assignedToRole,
    assigneeStatus,
    assignedItemCount: finiteCount(row.assignedItemCount),
    assignedUserCount: finiteCount(row.assignedUserCount),
    version,
    counts: {
      total: finiteCount(counts.total),
      pending: finiteCount(counts.pending),
      selected: finiteCount(counts.selected),
      rejected: finiteCount(counts.rejected),
      produced: finiteCount(counts.produced),
    },
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
  };
}

export function normalizePackagePage(value: unknown): QueryPackagePage {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  const totalValue = payload?.total;
  const rawTotal = Number(totalValue);
  return {
    items: rows.map(normalizePackageSummary).filter((item): item is QueryPackageSummary => item !== null),
    total: totalValue !== null && totalValue !== undefined && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null,
    returnedCount: rows.length,
  };
}

export function normalizePackageList(value: unknown): QueryPackageSummary[] {
  return normalizePackagePage(value).items;
}

export function queryPackageItemPage<T>(items: T[], page: number, pageSize = QUERY_PACKAGE_ITEM_PAGE_SIZE) {
  const safeSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : QUERY_PACKAGE_ITEM_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(items.length / safeSize));
  const currentPage = Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const start = (currentPage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    pageCount,
    currentPage,
    start,
  };
}

export function updateQueryItemSelection(
  current: number[],
  candidates: Iterable<number>,
  checked: boolean,
  limit = QUERY_PACKAGE_SELECTION_LIMIT,
) {
  const candidateIds = new Set([...candidates].filter((id) => Number.isSafeInteger(id) && id > 0));
  if (!checked) return current.filter((id) => !candidateIds.has(id));
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : QUERY_PACKAGE_SELECTION_LIMIT;
  return [...new Set([...current, ...candidateIds])].slice(0, boundedLimit);
}

function normalizedStatusToken(value: unknown) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizePackageDecision(value: unknown): QueryPackageDecision {
  const token = normalizedStatusToken(value);
  if (['SELECT', 'SELECTED'].includes(token)) return 'SELECTED';
  if (['REJECT', 'REJECTED'].includes(token)) return 'REJECTED';
  return 'PENDING';
}

function normalizeValidationStatus(value: unknown): QueryPackageValidationStatus {
  const token = normalizedStatusToken(value);
  return ['INVALID', 'DUPLICATE', 'TASK_CREATED'].includes(token)
    ? token as QueryPackageValidationStatus
    : 'READY';
}

function normalizePackageItem(value: unknown): QueryPackageItem | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  const rowNumber = Number(row.rowNumber);
  const version = Number(row.version);
  const query = typeof row.query === 'string' ? row.query.trim() : '';
  const rawStatus = row.validationStatus ?? row.validation_status ?? row.status;
  const decision = normalizePackageDecision(
    row.screeningDecision ?? row.screening_decision ?? row.decision ?? rawStatus,
  );
  const validationStatus = normalizeValidationStatus(rawStatus);
  if (!Number.isSafeInteger(id) || id < 1 || !query || !Number.isSafeInteger(version) || version < 1) return null;
  const requestedImageCount = row.requestedImageCount === 'auto'
    ? 'auto'
    : [3, 4, 5].includes(Number(row.requestedImageCount)) ? Number(row.requestedImageCount) : 'auto';
  const taskId = Number(row.taskId);
  const screeningAssignedToAccountId = Number(row.screeningAssignedToAccountId);
  return {
    id,
    rowNumber: Number.isSafeInteger(rowNumber) && rowNumber > 0 ? rowNumber : id,
    externalId: typeof row.externalId === 'string' ? row.externalId : null,
    query,
    input: row.input && typeof row.input === 'object' && !Array.isArray(row.input)
      ? row.input as Record<string, unknown>
      : {},
    requestedImageCount: requestedImageCount as QueryPackageItem['requestedImageCount'],
    validationStatus: Number.isSafeInteger(taskId) && taskId > 0 ? 'TASK_CREATED' : validationStatus,
    screeningDecision: decision,
    screeningReason: typeof row.screeningReason === 'string' ? row.screeningReason : null,
    screeningAssignedToAccountId: Number.isSafeInteger(screeningAssignedToAccountId)
      && screeningAssignedToAccountId > 0 ? screeningAssignedToAccountId : null,
    screeningAssignedToUserId: typeof row.screeningAssignedToUserId === 'string'
      && row.screeningAssignedToUserId.trim() ? row.screeningAssignedToUserId.trim() : null,
    taskId: Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null,
    version,
  };
}

export type QueryPackageItemAssignmentSummary = {
  packageId: number;
  packageVersion: number;
  eligibleTotal: number;
  assignedTotal: number;
  unassignedTotal: number;
  assignees: Array<{
    accountId: number;
    username: string;
    displayName: string;
    role: 'REVIEWER' | 'USER' | null;
    status: 'ACTIVE' | 'DISABLED' | null;
    count: number;
  }>;
};

export function normalizeQueryPackageItemAssignmentSummary(
  value: unknown,
): QueryPackageItemAssignmentSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const packageId = Number(row.packageId);
  const packageVersion = Number(row.packageVersion);
  if (!Number.isSafeInteger(packageId) || packageId < 1
      || !Number.isSafeInteger(packageVersion) || packageVersion < 1
      || !Array.isArray(row.assignees)) return null;
  const assignees = row.assignees.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    const accountId = Number(candidate.accountId);
    const username = typeof candidate.username === 'string' ? candidate.username.trim() : '';
    if (!Number.isSafeInteger(accountId) || accountId < 1 || !username) return null;
    return {
      accountId,
      username,
      displayName: typeof candidate.displayName === 'string' && candidate.displayName.trim()
        ? candidate.displayName.trim() : username,
      role: ['REVIEWER', 'USER'].includes(String(candidate.role))
        ? candidate.role as 'REVIEWER' | 'USER' : null,
      status: ['ACTIVE', 'DISABLED'].includes(String(candidate.status))
        ? candidate.status as 'ACTIVE' | 'DISABLED' : null,
      count: finiteCount(candidate.count),
    };
  });
  if (assignees.some((entry) => entry === null)) return null;
  return {
    packageId,
    packageVersion,
    eligibleTotal: finiteCount(row.eligibleTotal),
    assignedTotal: finiteCount(row.assignedTotal),
    unassignedTotal: finiteCount(row.unassignedTotal),
    assignees: assignees as QueryPackageItemAssignmentSummary['assignees'],
  };
}

export type QueryPackageItemFilter = QueryPackageDecision | QueryPackageValidationStatus | 'ALL';

export function queryPackageItemMatchesFilter(item: QueryPackageItem, filter: QueryPackageItemFilter) {
  if (filter === 'ALL') return true;
  if (['PENDING', 'SELECTED', 'REJECTED'].includes(filter)) return item.screeningDecision === filter;
  return item.validationStatus === filter;
}

export function applyQueryPackageScreening(
  detail: QueryPackageDetail,
  summary: QueryPackageSummary,
  itemIds: Iterable<number>,
  decision: Exclude<QueryPackageDecision, 'PENDING'>,
  reason?: string,
): QueryPackageDetail {
  if (detail.id !== summary.id || detail.version > summary.version) return detail;
  const changedIds = new Set(itemIds);
  return {
    ...detail,
    ...summary,
    items: detail.items.map((item) => changedIds.has(item.id)
      ? {
          ...item,
          screeningDecision: decision,
          screeningReason: decision === 'REJECTED' ? reason?.trim() || null : null,
        }
      : item),
  };
}

export function normalizePackageDetail(value: unknown): QueryPackageDetail | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  const candidate = payload.queryPackage && typeof payload.queryPackage === 'object'
    ? { ...(payload.queryPackage as Record<string, unknown>), items: payload.items, itemPage: payload.itemPage }
    : payload;
  const summary = normalizePackageSummary(candidate);
  if (!summary) return null;
  const items = Array.isArray(candidate.items) ? candidate.items : [];
  const normalizedItems = items.map(normalizePackageItem).filter((item): item is QueryPackageItem => item !== null);
  const rawItemPage = candidate.itemPage && typeof candidate.itemPage === 'object'
    ? candidate.itemPage as Record<string, unknown>
    : null;
  const pageTotal = Number(rawItemPage?.total);
  const returnedCount = Number(rawItemPage?.returnedCount);
  return {
    ...summary,
    items: normalizedItems,
    itemPage: {
      total: Number.isSafeInteger(pageTotal) && pageTotal >= 0 ? pageTotal : normalizedItems.length,
      returnedCount: Number.isSafeInteger(returnedCount) && returnedCount >= 0
        ? returnedCount
        : normalizedItems.length,
      hasMore: rawItemPage?.hasMore === true,
      nextCursor: typeof rawItemPage?.nextCursor === 'string' && /^\d+:\d+$/u.test(rawItemPage.nextCursor)
        ? rawItemPage.nextCursor
        : null,
    },
  };
}

export function parseQueryPackageText(raw: string, maximum = QUERY_PACKAGE_IMPORT_LIMIT) {
  const seen = new Set<string>();
  const queries: string[] = [];
  let duplicates = 0;
  const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line) continue;
    const query = line.replace(/^"|"$/gu, '').replace(/""/gu, '"').trim();
    if (!query || /^(?:query|关键词|选题)$/iu.test(query)) continue;
    if ([...query].length > 500) return { queries: [], duplicates, error: '单条 Query 不能超过 500 个字符。' };
    const identity = query.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
    if (seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    queries.push(query);
    if (queries.length > maximum) return { queries: [], duplicates, error: `单个词包最多导入 ${maximum.toLocaleString('zh-CN')} 条 Query。` };
  }
  return {
    queries,
    duplicates,
    error: queries.length === 0 ? '请至少填写一条 Query。' : null,
  };
}
