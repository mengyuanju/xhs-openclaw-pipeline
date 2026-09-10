export type CopyQaStatus = 'PENDING' | 'PASSED' | 'RETURNED' | 'RELEASED' | 'BATCH_RETURNED' | 'BATCH_AFFECTED';
export type CopyQaSampleKind = 'RANDOM' | 'MANDATORY_RECHECK';

export type CopyQaCapabilities = {
  canPass: boolean;
  canReturnSingle: boolean;
  canReturnBatch: boolean;
};

export type ApprovedCopyRevision = {
  content: unknown;
  contentSha256: string;
  revisionToken: string;
};

export type CopyQaCommon = {
  id: string;
  freezePublicId: string;
  anonymousCode: string;
  blindReview: boolean;
  status: CopyQaStatus;
  sampleKind: CopyQaSampleKind;
  query: string | null;
  approvedRevision: ApprovedCopyRevision;
  productionBatch: { anonymousCode: string };
  capabilities: CopyQaCapabilities;
  createdAt?: string;
};

export type CopyQaBlindItem = CopyQaCommon & { blindReview: true };

export type CopyQaNonBlindItem = CopyQaCommon & {
  blindReview: false;
  taskId: number | null;
  productionBatchId: number | null;
  productionBatch: CopyQaCommon['productionBatch'] & { queryPackageName: string | null };
  freezeId: number | null;
  finalApproverAccountId: number | null;
  approvedRevision: ApprovedCopyRevision & { id: number | null };
};

export type CopyQaItem = CopyQaBlindItem | CopyQaNonBlindItem;

export type CopyQaStatistics = {
  random: Array<{
    finalApproverAccountId: number;
    passed: number;
    returned: number;
    decided: number;
    accuracyRate: number;
  }>;
  mandatory: { passed: number; returned: number; pending: number };
  batchAffectedCount: number;
};

export type CopyQaPage = {
  items: CopyQaItem[];
  total: number | null;
  returnedCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function opaqueToken(value: unknown) {
  return typeof value === 'string' && value.trim().length >= 8 ? value.trim() : null;
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeStatus(value: unknown): CopyQaStatus | null {
  return ['PENDING', 'PASSED', 'RETURNED', 'RELEASED', 'BATCH_RETURNED', 'BATCH_AFFECTED'].includes(String(value))
    ? String(value) as CopyQaStatus
    : null;
}

export function canStartCopyQaBatchReturn(
  item: Pick<CopyQaCommon, 'sampleKind' | 'status' | 'capabilities'>,
) {
  return item.sampleKind === 'RANDOM'
    && ['PENDING', 'RETURNED'].includes(item.status)
    && item.capabilities.canReturnBatch;
}

export function canReleaseCopyQaFreezeRest(
  item: Pick<CopyQaCommon, 'sampleKind' | 'status'>,
) {
  return item.sampleKind === 'RANDOM' && item.status === 'RETURNED';
}

export function normalizeCopyQaItem(value: unknown): CopyQaItem | null {
  const row = record(value);
  if (!row) return null;
  const id = opaqueToken(row.id);
  const freezePublicId = opaqueToken(row.freezePublicId);
  const revision = record(row.approvedRevision);
  const revisionToken = opaqueToken(revision?.revisionToken);
  const batch = record(row.productionBatch);
  const source = record(row.source);
  const status = normalizeStatus(row.status);
  const anonymousBatchCode = typeof batch?.anonymousCode === 'string' ? batch.anonymousCode.trim() : '';
  if (!id || !freezePublicId || !revision || !revisionToken || !anonymousBatchCode || !status) return null;
  const capability = record(row.capabilities);
  const common: CopyQaCommon = {
    id,
    freezePublicId,
    anonymousCode: typeof row.anonymousCode === 'string' && row.anonymousCode.trim()
      ? row.anonymousCode.trim()
      : `匿名样本 ${id.slice(0, 8)}`,
    blindReview: row.blindReview === true,
    status,
    sampleKind: row.sampleKind === 'MANDATORY_RECHECK' ? 'MANDATORY_RECHECK' : 'RANDOM',
    query: typeof row.query === 'string' && row.query.trim() ? row.query : null,
    approvedRevision: {
      content: revision.content ?? '',
      contentSha256: typeof revision.contentSha256 === 'string' ? revision.contentSha256 : '',
      revisionToken,
    },
    productionBatch: { anonymousCode: anonymousBatchCode },
    capabilities: {
      canPass: capability?.canPass === true,
      canReturnSingle: capability?.canReturnSingle === true,
      canReturnBatch: capability?.canReturnBatch === true,
    },
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
  };

  // Blind records are reduced to a strict allow-list before they enter React state.
  if (common.blindReview) return { ...common, blindReview: true, query: null };
  const rawQueryPackageName = typeof batch?.queryPackageName === 'string'
    ? batch.queryPackageName.replace(/\s+/gu, ' ').trim()
    : '';
  return {
    ...common,
    blindReview: false,
    taskId: positiveInteger(row.taskId),
    // The current control-plane DTO groups batch and account provenance under
    // productionBatch/source. Keep the root-field fallbacks for older servers
    // and local snapshots that predate that shape.
    productionBatchId: positiveInteger(row.productionBatchId ?? batch?.id),
    productionBatch: {
      ...common.productionBatch,
      queryPackageName: rawQueryPackageName && [...rawQueryPackageName].length <= 200
        ? rawQueryPackageName
        : null,
    },
    freezeId: positiveInteger(row.freezeId),
    finalApproverAccountId: positiveInteger(row.finalApproverAccountId ?? source?.finalApproverAccountId),
    approvedRevision: { ...common.approvedRevision, id: positiveInteger(revision.id) },
  };
}

export function normalizeCopyQaPage(value: unknown): CopyQaPage {
  const row = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(row?.items) ? row.items : [];
  const totalValue = row?.total;
  const rawTotal = Number(totalValue);
  return {
    items: rows.map(normalizeCopyQaItem).filter((item): item is CopyQaItem => item !== null),
    total: totalValue !== null && totalValue !== undefined && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null,
    returnedCount: rows.length,
  };
}

export function normalizeCopyQaList(value: unknown): CopyQaItem[] {
  return normalizeCopyQaPage(value).items;
}

export function normalizeCopyQaStatistics(value: unknown): CopyQaStatistics | null {
  const row = record(value);
  const mandatory = record(row?.mandatory);
  if (!row || !mandatory || !Array.isArray(row.random)) return null;
  return {
    random: row.random.flatMap((entry) => {
      const metric = record(entry);
      const accountId = positiveInteger(metric?.finalApproverAccountId);
      if (!accountId) return [];
      const accuracyRate = Number(metric?.accuracyRate);
      return [{
        finalApproverAccountId: accountId,
        passed: count(metric?.passed),
        returned: count(metric?.returned),
        decided: count(metric?.decided),
        accuracyRate: Number.isFinite(accuracyRate) ? Math.max(0, Math.min(1, accuracyRate > 1 ? accuracyRate / 100 : accuracyRate)) : 0,
      }];
    }),
    mandatory: { passed: count(mandatory.passed), returned: count(mandatory.returned), pending: count(mandatory.pending) },
    batchAffectedCount: count(row.batchAffectedCount),
  };
}

export function copyRevisionView(content: unknown): { title: string; body: string; tags: string[] } {
  let parsed = content;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return { title: '', body: String(parsed), tags: [] }; }
  }
  const row = record(parsed);
  if (!row) return { title: '', body: String(content ?? ''), tags: [] as string[] };
  const nested = record(row.copy);
  const source = nested ?? row;
  const title = typeof source.title === 'string' ? source.title : '';
  const body = typeof source.body === 'string'
    ? source.body
    : typeof source.content === 'string' ? source.content : typeof source.text === 'string' ? source.text : '';
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((tag): tag is string => typeof tag === 'string')
    : typeof source.tags === 'string' ? source.tags.split(/[\s,，#]+/u).filter(Boolean) : [];
  return { title, body, tags };
}
