export const DELIVERY_POOL_LIST_LIMIT = 200;
export const DELIVERY_POOL_SELECTION_LIMIT = 200;

export type DeliveryEntry = {
  id: number;
  taskId: number;
  query: string;
  copyRevisionId: number;
  imageRunId: string;
  status: 'READY';
  approvedAt: string;
};

export type DeliveryPoolPage = {
  items: DeliveryEntry[];
  total: number;
};

export type PreparedDeliveryExport = {
  downloadId: string;
  fileName: string;
  taskCount: number;
  expiresAt: string;
};

export type DeliveryPoolExportInput =
  | { scope: 'ALL_READY' }
  | { scope: 'SELECTED'; taskIds: number[] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeEntry(value: unknown): DeliveryEntry | null {
  const item = record(value);
  if (!item) return null;
  const id = Number(item.id);
  const taskId = Number(item.taskId);
  const copyRevisionId = Number(item.copyRevisionId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(taskId) || taskId < 1
    || !Number.isSafeInteger(copyRevisionId) || copyRevisionId < 1 || item.status !== 'READY'
    || typeof item.imageRunId !== 'string' || !item.imageRunId.trim()) return null;
  return {
    id,
    taskId,
    copyRevisionId,
    imageRunId: item.imageRunId,
    status: 'READY',
    query: typeof item.query === 'string' ? item.query : '',
    approvedAt: typeof item.approvedAt === 'string' ? item.approvedAt : '',
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
  return { items, total };
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
    const candidate = `${entry.taskId} ${entry.query}`.toLocaleLowerCase('zh-CN');
    return terms.some((term) => candidate.includes(term));
  });
}

export function buildDeliveryPoolExportInput(selectedTaskIds: number[]): DeliveryPoolExportInput {
  if (!Array.isArray(selectedTaskIds)) throw new TypeError('交付池导出范围无效，请刷新后重试');
  if (selectedTaskIds.length === 0) return { scope: 'ALL_READY' };
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
