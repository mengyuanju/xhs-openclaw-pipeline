export const DELIVERY_POOL_LIST_LIMIT = 200;
export const DELIVERY_POOL_SELECTION_LIMIT = 200;
export const DELIVERY_PREVIEW_UPLOAD_LIMITS = [1, 10, 25, 50, 100, 200] as const;
export const DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT = 200;

export type DeliveryPreviewLink = {
  id: string;
  noteId: string;
  url: string | null;
  contentHash: string;
  status: 'PUBLISHED' | 'REVOKED';
  publishedAt: string;
  revokedAt: string | null;
};

export type DeliveryEntry = {
  id: number;
  taskId: number;
  query: string;
  queryPackageId: number | null;
  queryPackageName: string | null;
  copyRevisionId: number;
  imageRunId: string;
  status: 'READY';
  approvedAt: string;
  preview: DeliveryPreviewLink | null;
};

export type DeliveryQueryPackageFacet = {
  id: number;
  name: string;
  count: number;
  unuploadedCount: number;
  publishedCount: number;
  revokedCount: number;
};

export type DeliveryUnassignedFacet = {
  count: number;
  unuploadedCount: number;
  publishedCount: number;
  revokedCount: number;
};

export type DeliveryPoolPage = {
  items: DeliveryEntry[];
  total: number;
  facets: {
    queryPackages: DeliveryQueryPackageFacet[];
    unassigned: DeliveryUnassignedFacet | null;
  };
};

export type PreparedDeliveryExport = {
  downloadId: string;
  fileName: string;
  taskCount: number;
  expiresAt: string;
};

export type DeliveryPoolExportInput =
  | { scope: 'ALL_READY' }
  | { scope: 'QUERY_PACKAGE'; queryPackageName: string }
  | { scope: 'SELECTED'; taskIds: number[] };

export type DeliveryPreviewPublishResult = {
  scope: 'QUERY_PACKAGES';
  limit: number;
  requestedCount: number;
  publishedCount: number;
  createdCount: number;
  reusedCount: number;
  failedCount: number;
  items: Array<{
    taskId: number;
    deliveryEntryId: number;
    noteId: string;
    previewUrl: string;
    reused: boolean;
  }>;
  failures: Array<{ taskId: number; code: string; message: string }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeQueryPackageName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/gu, ' ').trim();
  return name && [...name].length <= 200 ? name : null;
}

function normalizeEntry(value: unknown): DeliveryEntry | null {
  const item = record(value);
  if (!item) return null;
  const id = Number(item.id);
  const taskId = Number(item.taskId);
  const copyRevisionId = Number(item.copyRevisionId);
  const rawQueryPackageId = item.queryPackageId;
  const queryPackageId = rawQueryPackageId === null || rawQueryPackageId === undefined
    ? null
    : Number(rawQueryPackageId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(taskId) || taskId < 1
    || !Number.isSafeInteger(copyRevisionId) || copyRevisionId < 1 || item.status !== 'READY'
    || (queryPackageId !== null && (!Number.isSafeInteger(queryPackageId) || queryPackageId < 1))
    || typeof item.imageRunId !== 'string' || !item.imageRunId.trim()) return null;
  return {
    id,
    taskId,
    copyRevisionId,
    imageRunId: item.imageRunId,
    status: 'READY',
    query: typeof item.query === 'string' ? item.query : '',
    queryPackageId,
    queryPackageName: normalizeQueryPackageName(item.queryPackageName),
    approvedAt: typeof item.approvedAt === 'string' ? item.approvedAt : '',
    preview: normalizePreviewLink(item.preview),
  };
}

function normalizePreviewLink(value: unknown): DeliveryPreviewLink | null {
  const item = record(value);
  if (!item) return null;
  const id = typeof item.id === 'string' ? item.id.toLowerCase() : '';
  const noteId = typeof item.noteId === 'string' ? item.noteId.toLowerCase() : '';
  const url = typeof item.url === 'string' ? item.url : null;
  const contentHash = typeof item.contentHash === 'string' ? item.contentHash.toLowerCase() : '';
  const status = item.status;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
    || !/^[0-9a-f]{32}$/u.test(noteId)
    || (url !== null && !/^https?:\/\//u.test(url)) || !/^[0-9a-f]{64}$/u.test(contentHash)
    || !['PUBLISHED', 'REVOKED'].includes(String(status))) return null;
  return {
    id,
    noteId,
    url,
    contentHash,
    status: status as 'PUBLISHED' | 'REVOKED',
    publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : '',
    revokedAt: typeof item.revokedAt === 'string' ? item.revokedAt : null,
  };
}

export function normalizeDeliveryPreviewPublishResult(value: unknown): DeliveryPreviewPublishResult {
  const payload = record(value);
  const scope = payload?.scope;
  const limit = Number(payload?.limit);
  const requestedCount = Number(payload?.requestedCount);
  const publishedCount = Number(payload?.publishedCount);
  const createdCount = Number(payload?.createdCount);
  const reusedCount = Number(payload?.reusedCount);
  const failedCount = Number(payload?.failedCount);
  const counts = [limit, requestedCount, publishedCount, createdCount, reusedCount, failedCount];
  if (scope !== 'QUERY_PACKAGES'
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || limit < 1 || limit > DELIVERY_POOL_SELECTION_LIMIT
    || requestedCount !== publishedCount + failedCount
    || publishedCount !== createdCount + reusedCount) {
    throw new TypeError('预览上传结果无效，请刷新后核对');
  }
  const items = Array.isArray(payload?.items) ? payload.items.map((value) => {
    const item = record(value);
    const taskId = Number(item?.taskId);
    const deliveryEntryId = Number(item?.deliveryEntryId);
    const noteId = typeof item?.noteId === 'string' ? item.noteId.toLowerCase() : '';
    const previewUrl = typeof item?.previewUrl === 'string' ? item.previewUrl : '';
    if (!Number.isSafeInteger(taskId) || taskId < 1
      || !Number.isSafeInteger(deliveryEntryId) || deliveryEntryId < 1
      || !/^[0-9a-f]{32}$/u.test(noteId) || !/^https?:\/\//u.test(previewUrl)) {
      throw new TypeError('预览上传结果无效，请刷新后核对');
    }
    return { taskId, deliveryEntryId, noteId, previewUrl, reused: item?.reused === true };
  }) : [];
  const failures = Array.isArray(payload?.failures) ? payload.failures.map((value) => {
    const item = record(value);
    const taskId = Number(item?.taskId);
    if (!Number.isSafeInteger(taskId) || taskId < 1
      || typeof item?.code !== 'string' || typeof item?.message !== 'string') {
      throw new TypeError('预览上传结果无效，请刷新后核对');
    }
    return { taskId, code: item.code, message: item.message };
  }) : [];
  if (items.length !== publishedCount || failures.length !== failedCount) {
    throw new TypeError('预览上传结果无效，请刷新后核对');
  }
  return {
    scope: scope as DeliveryPreviewPublishResult['scope'],
    limit,
    requestedCount,
    publishedCount,
    createdCount,
    reusedCount,
    failedCount,
    items,
    failures,
  };
}

export function normalizeDeliveryPoolPage(value: unknown): DeliveryPoolPage {
  const payload = record(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(payload?.items) ? payload.items : [];
  const items = rows.map(normalizeEntry).filter((item): item is DeliveryEntry => item !== null);
  const rawTotal = Number(payload?.total);
  const total = Number.isSafeInteger(rawTotal) && rawTotal >= items.length ? rawTotal : items.length;
  const facetEnvelope = record(payload?.facets);
  const rawQueryPackages = Array.isArray(facetEnvelope?.queryPackages)
    ? facetEnvelope.queryPackages
    : [];
  const queryPackageMap = new Map<number, DeliveryQueryPackageFacet>();
  for (const value of rawQueryPackages.slice(0, 1_000)) {
    const facet = record(value);
    const id = Number(facet?.id);
    const name = normalizeQueryPackageName(facet?.name);
    const count = Number(facet?.count);
    const unuploadedCount = Number(facet?.unuploadedCount);
    const publishedCount = Number(facet?.publishedCount);
    const revokedCount = Number(facet?.revokedCount);
    if (!Number.isSafeInteger(id) || id < 1 || !name
      || [count, unuploadedCount, publishedCount, revokedCount]
        .some((candidate) => !Number.isSafeInteger(candidate) || candidate < 0)
      || unuploadedCount + publishedCount + revokedCount > count
      || queryPackageMap.has(id)) continue;
    queryPackageMap.set(id, {
      id,
      name,
      count,
      unuploadedCount,
      publishedCount,
      revokedCount,
    });
  }
  const queryPackages = [...queryPackageMap.values()];
  const rawUnassigned = record(facetEnvelope?.unassigned);
  const unassignedCounts = rawUnassigned
    ? [
        Number(rawUnassigned.count),
        Number(rawUnassigned.unuploadedCount),
        Number(rawUnassigned.publishedCount),
        Number(rawUnassigned.revokedCount),
      ]
    : [];
  const unassigned = rawUnassigned
    && unassignedCounts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && unassignedCounts[0] > 0
    && unassignedCounts[1] + unassignedCounts[2] + unassignedCounts[3] <= unassignedCounts[0]
    ? {
        count: unassignedCounts[0],
        unuploadedCount: unassignedCounts[1],
        publishedCount: unassignedCounts[2],
        revokedCount: unassignedCounts[3],
      }
    : null;
  return { items, total, facets: { queryPackages, unassigned } };
}

export function updateTaskSelection(
  current: number[],
  candidates: number[],
  checked: boolean,
  limit = DELIVERY_POOL_SELECTION_LIMIT,
): number[] {
  const candidateIds = new Set(candidates.filter((id) => Number.isSafeInteger(id) && id > 0));
  if (!checked) return current.filter((id) => !candidateIds.has(id));
  return [...new Set([...current, ...candidateIds])].slice(0, limit);
}

export function mergeDeliveryPoolEntries(
  current: DeliveryEntry[],
  next: DeliveryEntry[],
): DeliveryEntry[] {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of next) entries.set(entry.id, entry);
  return [...entries.values()];
}

export function parseDeliveryPoolSearchTerms(value: string): string[] {
  const terms = value
    .split(/\r\n?|\n/u)
    .map((term) => term.trim().toLocaleLowerCase('zh-CN'))
    .filter(Boolean);
  return [...new Set(terms)];
}

export function filterDeliveryPoolEntries(
  entries: DeliveryEntry[],
  search: string,
): DeliveryEntry[] {
  const terms = parseDeliveryPoolSearchTerms(search);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const candidate = `${entry.taskId} ${entry.query} ${entry.queryPackageName ?? '未归属词包'}`.toLocaleLowerCase('zh-CN');
    return terms.some((term) => candidate.includes(term));
  });
}

export function buildDeliveryPoolExportInput(
  selectedTaskIds: number[],
  queryPackageName = '',
): DeliveryPoolExportInput {
  if (!Array.isArray(selectedTaskIds)) throw new TypeError('交付池导出范围无效，请刷新后重试');
  if (typeof queryPackageName !== 'string') {
    throw new TypeError('交付池导出范围无效，请刷新后重试');
  }
  const normalizedPackageName = queryPackageName.replace(/\s+/gu, ' ').trim();
  if (selectedTaskIds.length === 0) {
    if ([...normalizedPackageName].length > 200) {
      throw new TypeError('交付池导出范围无效，请刷新后重试');
    }
    return normalizedPackageName
      ? { scope: 'QUERY_PACKAGE', queryPackageName: normalizedPackageName }
      : { scope: 'ALL_READY' };
  }
  const taskIds = [...new Set(selectedTaskIds)];
  if (taskIds.length > DELIVERY_POOL_SELECTION_LIMIT
    || taskIds.some((taskId) => !Number.isSafeInteger(taskId) || taskId < 1)) {
    throw new TypeError('交付池导出范围无效，请刷新后重试');
  }
  return { scope: 'SELECTED', taskIds };
}

function normalizePreparedDeliveryDownload(
  value: unknown,
  expectedExtension: '.zip' | '.xlsx',
): PreparedDeliveryExport {
  const envelope = record(value);
  const item = record(envelope?.data) ?? envelope;
  const downloadId = typeof item?.downloadId === 'string' ? item.downloadId.trim() : '';
  const fileName = typeof item?.fileName === 'string' ? item.fileName.trim() : '';
  const taskCount = Number(item?.taskCount);
  const expiresAt = typeof item?.expiresAt === 'string' ? item.expiresAt : '';
  const fileStem = fileName.slice(0, -expectedExtension.length).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(downloadId)
    || !fileName.endsWith(expectedExtension) || !fileStem || fileName.length > 180
    || /[\\/\u0000-\u001f\u007f]/u.test(fileName)
    || !Number.isSafeInteger(taskCount) || taskCount < 1
    || !Number.isFinite(Date.parse(expiresAt))) {
    throw new TypeError('交付池下载凭证无效，请重新导出');
  }
  return { downloadId, fileName, taskCount, expiresAt };
}

export function normalizePreparedDeliveryExport(value: unknown): PreparedDeliveryExport {
  return normalizePreparedDeliveryDownload(value, '.zip');
}

export function normalizePreparedDeliveryXlsxExport(value: unknown): PreparedDeliveryExport {
  return normalizePreparedDeliveryDownload(value, '.xlsx');
}
