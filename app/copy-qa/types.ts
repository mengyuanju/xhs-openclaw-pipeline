export type CopyQaStatus = 'PENDING' | 'PASSED' | 'RETURNED' | 'RELEASED' | 'BATCH_RETURNED' | 'BATCH_AFFECTED' | 'SUPERSEDED';
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
  prioritySummary?: string;
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
  reviewMethod: 'STANDARD' | 'ADMIN_DIRECT';
  taskId: number | null;
  productionBatchId: number | null;
  productionBatch: CopyQaCommon['productionBatch'] & { queryPackageName: string | null };
  freezeId: number | null;
  finalApproverAccountId: number | null;
  finalApproverUsername: string | null;
  assignedToUserId: string | null;
  createdByUserId: string | null;
  approvedRevision: ApprovedCopyRevision & { id: number | null };
};

export type CopyQaItem = CopyQaBlindItem | CopyQaNonBlindItem;

export type CopyQaStatistics = {
  random: Array<{
    finalApproverAccountId: number;
    finalApproverUsername: string | null;
    finalApproverDisplayName: string | null;
    passed: number;
    returned: number;
    decided: number;
    accuracyRate: number;
    overallPassed: number | null;
    overallPassRate: number | null;
  }>;
  mandatory: { passed: number; returned: number; pending: number };
  batchAffectedCount: number;
};

export type CopyQaPage = {
  items: CopyQaItem[];
  total: number | null;
  returnedCount: number;
};

export type CopyQaImagePlanPage = {
  kind: string;
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
};

export type CopyQaRevisionView = {
  title: string;
  body: string;
  tags: string[];
  imagePlan: CopyQaImagePlanPage[];
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

function boundedIdentity(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && [...normalized].length <= 80 ? normalized : null;
}

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeStatus(value: unknown): CopyQaStatus | null {
  return ['PENDING', 'PASSED', 'RETURNED', 'RELEASED', 'BATCH_RETURNED', 'BATCH_AFFECTED', 'SUPERSEDED'].includes(String(value))
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

export function normalizeCopyQaItem(
  value: unknown,
  { role }: { role?: string } = {},
): CopyQaItem | null {
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
    // The server is the primary redaction boundary. Keeping the administrator
    // exception here prevents a stale/mixed-version response flag from hiding
    // traceable fields that the administrator is already authorized to receive.
    blindReview: row.blindReview === true && role !== 'ADMIN',
    status,
    sampleKind: row.sampleKind === 'MANDATORY_RECHECK' ? 'MANDATORY_RECHECK' : 'RANDOM',
    ...(typeof row.prioritySummary === 'string' && /^(?:已暂停|生效 (?:10|100|150|200|300|350|400|500)) · 系统 (?:100|150|200|300|400) \/ 人工 (?:—|10|100|350|500)$/u.test(row.prioritySummary) ? { prioritySummary: row.prioritySummary } : {}),
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
    reviewMethod: row.reviewMethod === 'ADMIN_DIRECT' ? 'ADMIN_DIRECT' : 'STANDARD',
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
    finalApproverUsername: boundedIdentity(row.finalApproverUsername ?? source?.finalApproverUsername),
    assignedToUserId: boundedIdentity(row.assignedToUserId ?? source?.assignedToUserId),
    createdByUserId: boundedIdentity(row.createdByUserId ?? source?.createdByUserId),
    approvedRevision: { ...common.approvedRevision, id: positiveInteger(revision.id) },
  };
}

export function normalizeCopyQaPage(
  value: unknown,
  options: { role?: string } = {},
): CopyQaPage {
  const row = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(row?.items) ? row.items : [];
  const totalValue = row?.total;
  const rawTotal = Number(totalValue);
  return {
    items: rows.map((item) => normalizeCopyQaItem(item, options))
      .filter((item): item is CopyQaItem => item !== null),
    total: totalValue !== null && totalValue !== undefined && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null,
    returnedCount: rows.length,
  };
}

export function normalizeCopyQaList(value: unknown, options: { role?: string } = {}): CopyQaItem[] {
  return normalizeCopyQaPage(value, options).items;
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
      const overallPassedValue = Number(metric?.overallPassed);
      const overallPassRateValue = Number(metric?.overallPassRate);
      const finalApproverUsername = typeof metric?.finalApproverUsername === 'string'
        ? metric.finalApproverUsername.trim()
        : '';
      const finalApproverDisplayName = typeof metric?.finalApproverDisplayName === 'string'
        ? metric.finalApproverDisplayName.replace(/\s+/gu, ' ').trim()
        : '';
      return [{
        finalApproverAccountId: accountId,
        finalApproverUsername: finalApproverUsername && [...finalApproverUsername].length <= 50
          ? finalApproverUsername
          : null,
        finalApproverDisplayName: finalApproverDisplayName && [...finalApproverDisplayName].length <= 80
          ? finalApproverDisplayName
          : null,
        passed: count(metric?.passed),
        returned: count(metric?.returned),
        decided: count(metric?.decided),
        accuracyRate: Number.isFinite(accuracyRate) ? Math.max(0, Math.min(1, accuracyRate > 1 ? accuracyRate / 100 : accuracyRate)) : 0,
        overallPassed: Number.isSafeInteger(overallPassedValue) && overallPassedValue >= 0 ? overallPassedValue : null,
        overallPassRate: metric?.overallPassRate !== null && metric?.overallPassRate !== undefined && Number.isFinite(overallPassRateValue)
          ? Math.max(0, Math.min(1, overallPassRateValue > 1 ? overallPassRateValue / 100 : overallPassRateValue))
          : null,
      }];
    }),
    mandatory: { passed: count(mandatory.passed), returned: count(mandatory.returned), pending: count(mandatory.pending) },
    batchAffectedCount: count(row.batchAffectedCount),
  };
}

export function copyRevisionView(content: unknown): CopyQaRevisionView {
  let parsed = content;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch {
      return { title: '', body: String(parsed), tags: [], imagePlan: [] };
    }
  }
  const row = record(parsed);
  if (!row) return { title: '', body: String(content ?? ''), tags: [], imagePlan: [] };
  const reviewed = record(row.reviewed);
  const post = record(row.post);
  const source = record(row.copy) ?? record(reviewed?.copy) ?? post ?? row;
  const title = typeof source.title === 'string' ? source.title : '';
  const body = typeof source.body === 'string'
    ? source.body
    : typeof source.content === 'string' ? source.content : typeof source.text === 'string' ? source.text : '';
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((tag): tag is string => typeof tag === 'string')
    : typeof source.tags === 'string' ? source.tags.split(/[\s,，#]+/u).filter(Boolean) : [];
  const rawImagePlan = row.imagePlan ?? reviewed?.imagePlan ?? post?.imagePlan;
  const imagePlan = Array.isArray(rawImagePlan)
    ? rawImagePlan.slice(0, 5).flatMap((value): CopyQaImagePlanPage[] => {
        const page = record(value);
        if (!page) return [];
        return [{
          kind: typeof page.kind === 'string' ? page.kind : '',
          headline: typeof page.headline === 'string' ? page.headline : '',
          subtitle: typeof page.subtitle === 'string' ? page.subtitle : '',
          bullets: Array.isArray(page.bullets)
            ? page.bullets.filter((bullet): bullet is string => typeof bullet === 'string').slice(0, 5)
            : [],
          prompt: typeof page.prompt === 'string' ? page.prompt : '',
        }];
      })
    : [];
  return { title, body, tags, imagePlan };
}
