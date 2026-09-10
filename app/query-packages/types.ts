export type QueryPackageDecision = 'PENDING' | 'SELECTED' | 'REJECTED';
export type QueryPackageValidationStatus = 'READY' | 'INVALID' | 'DUPLICATE' | 'TASK_CREATED';

export const QUERY_PACKAGE_ITEM_PAGE_SIZE = 100;
export const QUERY_PACKAGE_PRODUCTION_LIMIT = 5_000;

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
  assignedToDisplayName?: string | null;
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
  taskId?: number | null;
  version: number;
};

export type QueryPackageDetail = QueryPackageSummary & {
  items: QueryPackageItem[];
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
  return {
    id,
    name: row.name.trim(),
    status: typeof row.status === 'string' ? row.status : 'SCREENING',
    assignedToUserId: typeof row.assignedToUserId === 'string' ? row.assignedToUserId : null,
    assignedToDisplayName: typeof row.assignedToDisplayName === 'string' ? row.assignedToDisplayName : null,
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
  limit = QUERY_PACKAGE_PRODUCTION_LIMIT,
) {
  const candidateIds = new Set([...candidates].filter((id) => Number.isSafeInteger(id) && id > 0));
  if (!checked) return current.filter((id) => !candidateIds.has(id));
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : QUERY_PACKAGE_PRODUCTION_LIMIT;
  return [...new Set([...current, ...candidateIds])].slice(0, boundedLimit);
}

function normalizePackageItem(value: unknown): QueryPackageItem | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  const rowNumber = Number(row.rowNumber);
  const version = Number(row.version);
  const query = typeof row.query === 'string' ? row.query.trim() : '';
  const decision = ['SELECTED', 'REJECTED'].includes(String(row.screeningDecision))
    ? row.screeningDecision as QueryPackageDecision
    : 'PENDING';
  const rawValidation = row.validationStatus ?? row.status;
  const validationStatus = ['INVALID', 'DUPLICATE', 'TASK_CREATED'].includes(String(rawValidation))
    ? rawValidation as QueryPackageValidationStatus
    : 'READY';
  if (!Number.isSafeInteger(id) || id < 1 || !query || !Number.isSafeInteger(version) || version < 1) return null;
  const requestedImageCount = row.requestedImageCount === 'auto'
    ? 'auto'
    : [3, 4, 5].includes(Number(row.requestedImageCount)) ? Number(row.requestedImageCount) : 'auto';
  const taskId = Number(row.taskId);
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
    taskId: Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null,
    version,
  };
}

export function normalizePackageDetail(value: unknown): QueryPackageDetail | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  const candidate = payload.queryPackage && typeof payload.queryPackage === 'object'
    ? { ...(payload.queryPackage as Record<string, unknown>), items: payload.items }
    : payload;
  const summary = normalizePackageSummary(candidate);
  if (!summary) return null;
  const items = Array.isArray(candidate.items) ? candidate.items : [];
  return {
    ...summary,
    items: items.map(normalizePackageItem).filter((item): item is QueryPackageItem => item !== null),
  };
}

export function parseQueryPackageText(raw: string, maximum = 5_000) {
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
    if (queries.length > maximum) return { queries: [], duplicates, error: `单个词包最多导入 ${maximum} 条 Query。` };
  }
  return {
    queries,
    duplicates,
    error: queries.length === 0 ? '请至少填写一条 Query。' : null,
  };
}
