export const DELIVERY_POOL_LIST_LIMIT = 200;
export const DELIVERY_POOL_SELECTION_LIMIT = 200;
export const DELIVERY_PREVIEW_UPLOAD_LIMITS = [1, 10, 25, 50, 100, 200] as const;
export const DELIVERY_PREVIEW_PACKAGE_SELECTION_LIMIT = 200;

export type DeliveryPreviewLink = {
  id: string;
  noteId: string;
  url: string | null;
  contentHash: string;
  status: 'PUBLISHED' | 'REVOKING' | 'REVOKE_FAILED' | 'REVOKED';
  publishedAt: string;
  revokedAt: string | null;
};

export type DeliveryEntry = {
  id: number;
  taskId: number;
  query: string;
  queryPackageId: number | null;
  queryPackageName: string | null;
  queryPackageDeleted: boolean;
  copyRevisionId: number;
  imageRunId: string;
  status: 'READY';
  approvedAt: string;
  preview: DeliveryPreviewLink | null;
  packingState: 'UNPACKED' | 'PACKED' | 'VERSION_UPDATED';
  deliveryBatch: DeliveryEntryBatch | null;
  previousDeliveryBatch: DeliveryEntryBatch | null;
};

export type DeliveryEntryBatch = {
  id: number;
  publicId: string;
  code: string;
  status?: 'GENERATED' | 'DOWNLOADED';
  createdAt: string;
  downloadedAt?: string | null;
};

export type DeliveryQueryPackageFacet = {
  id: number;
  name: string;
  deleted: boolean;
  count: number;
  unuploadedCount: number;
  publishedCount: number;
  revokedCount: number;
  pendingCount: number;
  packedCount: number;
  updatedCount: number;
};

export type DeliveryUnassignedFacet = {
  count: number;
  unuploadedCount: number;
  publishedCount: number;
  revokedCount: number;
  pendingCount: number;
  packedCount: number;
  updatedCount: number;
};

export type DeliveryPoolPage = {
  items: DeliveryEntry[];
  total: number;
  facets: {
    queryPackages: DeliveryQueryPackageFacet[];
    unassigned: DeliveryUnassignedFacet | null;
  };
  summary: DeliveryPoolSummary;
};

export type DeliveryPoolSummary = {
  readyCount: number;
  pendingCount: number;
  packedCount: number;
  updatedCount: number;
};

export type PreparedDeliveryExport = {
  downloadId: string;
  fileName: string;
  taskCount: number;
  expiresAt: string;
  batchId?: string;
  batchCode?: string;
};

export type DeliveryBatchSummary = {
  id: number;
  publicId: string;
  code: string;
  scope: 'ALL_READY' | 'QUERY_PACKAGE' | 'SELECTED';
  queryPackageName: string | null;
  queryPackageNames: string[];
  status: 'GENERATED' | 'DOWNLOADED';
  fileName: string;
  byteSize: number;
  sha256: string;
  taskCount: number;
  createdByAccountId: number;
  createdByUsername: string;
  createdAt: string;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
  downloadCount: number;
};

export type DeliveryBatchItem = {
  id: number;
  ordinal: number;
  taskId: number;
  copyRevisionId: number;
  imageRunId: string;
  query: string;
  queryPackageId: number | null;
  queryPackageName: string | null;
};

export type DeliveryBatchDetail = DeliveryBatchSummary & { items: DeliveryBatchItem[] };
export type DeliveryBatchPage = { items: DeliveryBatchSummary[]; total: number };

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
  const packingState = ['UNPACKED', 'PACKED', 'VERSION_UPDATED'].includes(String(item.packingState))
    ? item.packingState as DeliveryEntry['packingState']
    : 'UNPACKED';
  return {
    id,
    taskId,
    copyRevisionId,
    imageRunId: item.imageRunId,
    status: 'READY',
    query: typeof item.query === 'string' ? item.query : '',
    queryPackageId,
    queryPackageName: normalizeQueryPackageName(item.queryPackageName),
    queryPackageDeleted: item.queryPackageDeleted === true,
    approvedAt: typeof item.approvedAt === 'string' ? item.approvedAt : '',
    preview: normalizePreviewLink(item.preview),
    packingState,
    deliveryBatch: normalizeEntryBatch(item.deliveryBatch),
    previousDeliveryBatch: normalizeEntryBatch(item.previousDeliveryBatch),
  };
}

function normalizeEntryBatch(value: unknown): DeliveryEntryBatch | null {
  const item = record(value);
  if (!item) return null;
  const id = Number(item.id);
  const publicId = typeof item.publicId === 'string' ? item.publicId.toLowerCase() : '';
  const code = typeof item.code === 'string' ? item.code : '';
  if (!Number.isSafeInteger(id) || id < 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(publicId)
    || !/^JF-[0-9A-F]{8}$/u.test(code)) return null;
  return {
    id,
    publicId,
    code,
    ...(['GENERATED', 'DOWNLOADED'].includes(String(item.status))
      ? { status: item.status as DeliveryEntryBatch['status'] }
      : {}),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    downloadedAt: typeof item.downloadedAt === 'string' ? item.downloadedAt : null,
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
    || !['PUBLISHED', 'REVOKING', 'REVOKE_FAILED', 'REVOKED'].includes(String(status))) return null;
  return {
    id,
    noteId,
    url,
    contentHash,
    status: status as DeliveryPreviewLink['status'],
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
  for (const value of rawQueryPackages) {
    const facet = record(value);
    const id = Number(facet?.id);
    const name = normalizeQueryPackageName(facet?.name);
    const count = Number(facet?.count);
    const unuploadedCount = Number(facet?.unuploadedCount);
    const publishedCount = Number(facet?.publishedCount);
    const revokedCount = Number(facet?.revokedCount);
    const pendingCount = facet?.pendingCount === undefined ? count : Number(facet.pendingCount);
    const packedCount = facet?.packedCount === undefined ? 0 : Number(facet.packedCount);
    const updatedCount = facet?.updatedCount === undefined ? 0 : Number(facet.updatedCount);
    if (!Number.isSafeInteger(id) || id < 1 || !name
      || [count, unuploadedCount, publishedCount, revokedCount, pendingCount, packedCount, updatedCount]
        .some((candidate) => !Number.isSafeInteger(candidate) || candidate < 0)
      || unuploadedCount + publishedCount + revokedCount > count
      || pendingCount + packedCount !== count || updatedCount > pendingCount
      || queryPackageMap.has(id)) continue;
    queryPackageMap.set(id, {
      id,
      name,
      deleted: facet?.deleted === true,
      count,
      unuploadedCount,
      publishedCount,
      revokedCount,
      pendingCount,
      packedCount,
      updatedCount,
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
        rawUnassigned.pendingCount === undefined
          ? Number(rawUnassigned.count) : Number(rawUnassigned.pendingCount),
        rawUnassigned.packedCount === undefined ? 0 : Number(rawUnassigned.packedCount),
        rawUnassigned.updatedCount === undefined ? 0 : Number(rawUnassigned.updatedCount),
      ]
    : [];
  const unassigned = rawUnassigned
    && unassignedCounts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && unassignedCounts[0] > 0
    && unassignedCounts[1] + unassignedCounts[2] + unassignedCounts[3] <= unassignedCounts[0]
    && unassignedCounts[4] + unassignedCounts[5] === unassignedCounts[0]
    && unassignedCounts[6] <= unassignedCounts[4]
    ? {
        count: unassignedCounts[0],
        unuploadedCount: unassignedCounts[1],
        publishedCount: unassignedCounts[2],
        revokedCount: unassignedCounts[3],
        pendingCount: unassignedCounts[4],
        packedCount: unassignedCounts[5],
        updatedCount: unassignedCounts[6],
      }
    : null;
  const rawSummary = record(payload?.summary);
  const summaryCounts = rawSummary
    ? [Number(rawSummary.readyCount), Number(rawSummary.pendingCount),
        Number(rawSummary.packedCount), Number(rawSummary.updatedCount)]
    : [];
  const fallbackSummary = {
    readyCount: queryPackages.reduce((sum, facet) => sum + facet.count, 0)
      + (unassigned?.count ?? (queryPackages.length ? 0 : items.length)),
    pendingCount: queryPackages.reduce((sum, facet) => sum + facet.pendingCount, 0)
      + (unassigned?.pendingCount ?? (queryPackages.length ? 0 : items.filter((item) => item.packingState !== 'PACKED').length)),
    packedCount: queryPackages.reduce((sum, facet) => sum + facet.packedCount, 0)
      + (unassigned?.packedCount ?? (queryPackages.length ? 0 : items.filter((item) => item.packingState === 'PACKED').length)),
    updatedCount: queryPackages.reduce((sum, facet) => sum + facet.updatedCount, 0)
      + (unassigned?.updatedCount ?? (queryPackages.length ? 0 : items.filter((item) => item.packingState === 'VERSION_UPDATED').length)),
  };
  const summary = summaryCounts.length === 4
    && summaryCounts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && summaryCounts[1] + summaryCounts[2] === summaryCounts[0]
    && summaryCounts[3] <= summaryCounts[1]
    ? { readyCount: summaryCounts[0], pendingCount: summaryCounts[1],
        packedCount: summaryCounts[2], updatedCount: summaryCounts[3] }
    : fallbackSummary;
  return { items, total, facets: { queryPackages, unassigned }, summary };
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
  const batchId = typeof item?.batchId === 'string' ? item.batchId.toLowerCase() : '';
  const batchCode = typeof item?.batchCode === 'string' ? item.batchCode : '';
  const batch = batchId || batchCode
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(batchId)
      && /^JF-[0-9A-F]{8}$/u.test(batchCode)
      ? { batchId, batchCode }
      : null
    : {};
  if (batch === null) throw new TypeError('交付批次凭证无效，请重新导出');
  return { downloadId, fileName, taskCount, expiresAt, ...batch };
}

export function normalizePreparedDeliveryExport(value: unknown): PreparedDeliveryExport {
  return normalizePreparedDeliveryDownload(value, '.zip');
}

export function normalizePreparedDeliveryXlsxExport(value: unknown): PreparedDeliveryExport {
  return normalizePreparedDeliveryDownload(value, '.xlsx');
}

function normalizeDeliveryBatchSummary(value: unknown): DeliveryBatchSummary | null {
  const item = record(value);
  if (!item) return null;
  const id = Number(item.id);
  const publicId = typeof item.publicId === 'string' ? item.publicId.toLowerCase() : '';
  const code = typeof item.code === 'string' ? item.code : '';
  const scope = String(item.scope);
  const status = String(item.status);
  const byteSize = Number(item.byteSize);
  const taskCount = Number(item.taskCount);
  const createdByAccountId = Number(item.createdByAccountId);
  const downloadCount = Number(item.downloadCount);
  const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : '';
  if (!Number.isSafeInteger(id) || id < 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(publicId)
    || !/^JF-[0-9A-F]{8}$/u.test(code)
    || !['ALL_READY', 'QUERY_PACKAGE', 'SELECTED'].includes(scope)
    || !['GENERATED', 'DOWNLOADED'].includes(status)
    || !Number.isSafeInteger(byteSize) || byteSize < 1
    || !Number.isSafeInteger(taskCount) || taskCount < 1
    || !Number.isSafeInteger(createdByAccountId) || createdByAccountId < 1
    || !Number.isSafeInteger(downloadCount) || downloadCount < 0
    || !/^[a-f0-9]{64}$/u.test(sha256)
    || typeof item.fileName !== 'string' || !item.fileName.endsWith('.zip')
    || typeof item.createdByUsername !== 'string') return null;
  return {
    id,
    publicId,
    code,
    scope: scope as DeliveryBatchSummary['scope'],
    queryPackageName: normalizeQueryPackageName(item.queryPackageName),
    queryPackageNames: Array.isArray(item.queryPackageNames)
      ? [...new Set(item.queryPackageNames.map(normalizeQueryPackageName).filter((name): name is string => Boolean(name)))]
      : [],
    status: status as DeliveryBatchSummary['status'],
    fileName: item.fileName,
    byteSize,
    sha256,
    taskCount,
    createdByAccountId,
    createdByUsername: item.createdByUsername,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    firstDownloadedAt: typeof item.firstDownloadedAt === 'string' ? item.firstDownloadedAt : null,
    lastDownloadedAt: typeof item.lastDownloadedAt === 'string' ? item.lastDownloadedAt : null,
    downloadCount,
  };
}

export function normalizeDeliveryBatchPage(value: unknown): DeliveryBatchPage {
  const payload = record(value);
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  const items = rows.map(normalizeDeliveryBatchSummary)
    .filter((item): item is DeliveryBatchSummary => item !== null);
  const rawTotal = Number(payload?.total);
  return {
    items,
    total: Number.isSafeInteger(rawTotal) && rawTotal >= items.length ? rawTotal : items.length,
  };
}

export function normalizeDeliveryBatchDetail(value: unknown): DeliveryBatchDetail {
  const payload = record(value);
  const summary = normalizeDeliveryBatchSummary(payload);
  if (!summary || !Array.isArray(payload?.items)) throw new TypeError('交付批次详情无效');
  const items = payload.items.map((value) => {
    const item = record(value);
    const id = Number(item?.id);
    const ordinal = Number(item?.ordinal);
    const taskId = Number(item?.taskId);
    const copyRevisionId = Number(item?.copyRevisionId);
    const queryPackageId = item?.queryPackageId == null ? null : Number(item.queryPackageId);
    if (![id, ordinal, taskId, copyRevisionId]
      .every((number) => Number.isSafeInteger(number) && number > 0)
      || (queryPackageId !== null && (!Number.isSafeInteger(queryPackageId) || queryPackageId < 1))
      || typeof item?.imageRunId !== 'string' || typeof item?.query !== 'string') {
      throw new TypeError('交付批次详情无效');
    }
    return {
      id,
      ordinal,
      taskId,
      copyRevisionId,
      imageRunId: item.imageRunId,
      query: item.query,
      queryPackageId,
      queryPackageName: normalizeQueryPackageName(item.queryPackageName),
    };
  });
  if (items.length !== summary.taskCount) throw new TypeError('交付批次详情数量不一致');
  return { ...summary, items };
}
