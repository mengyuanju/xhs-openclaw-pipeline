export type ImageQaAsset = {
  id: number;
  mediaType: string;
  sha256: string;
  originalName: string | null;
  pageIndex: number;
  url: string;
};

export type ImageQaItem = {
  id: string;
  freezePublicId: string;
  anonymousCode: string;
  status: string;
  sampleKind: 'RANDOM' | 'MANDATORY_RECHECK';
  blindReview: boolean;
  assets: ImageQaAsset[];
  capabilities: { canPass: boolean; canReturnSingle: boolean; canReturnBatch: boolean };
  blockers: { pendingImageEdits: number };
  taskId?: number;
  query?: string;
  productionBatch?: { id: number; queryPackageName: string | null };
  submitter?: { accountId: number; username: string };
  imageRunId?: string;
  copyRevisionId?: number;
  createdAt?: string;
};

export function normalizeImageQaItem(value: unknown, role: 'ADMIN' | 'REVIEWER'): ImageQaItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.anonymousCode !== 'string' || !Array.isArray(row.assets)) return null;
  const capabilities = row.capabilities && typeof row.capabilities === 'object'
    ? row.capabilities as Record<string, unknown> : {};
  const blindReview = row.blindReview === true && role !== 'ADMIN';
  const common: ImageQaItem = {
    id: row.id,
    freezePublicId: String(row.freezePublicId ?? ''),
    anonymousCode: row.anonymousCode,
    status: String(row.status ?? 'PENDING'),
    sampleKind: row.sampleKind === 'MANDATORY_RECHECK' ? 'MANDATORY_RECHECK' : 'RANDOM',
    // The center remains the redaction boundary. This second role check keeps a
    // mixed-version blind flag from hiding fields from an authorized admin.
    blindReview,
    assets: row.assets.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return [];
      const asset = entry as Record<string, unknown>;
      const id = Number(asset.id);
      const pageIndex = Number(asset.pageIndex);
      return Number.isSafeInteger(id) && id > 0 && typeof asset.url === 'string' ? [{
        id,
        mediaType: String(asset.mediaType ?? 'image/png'),
        sha256: String(asset.sha256 ?? ''),
        originalName: typeof asset.originalName === 'string' ? asset.originalName : null,
        pageIndex: Number.isSafeInteger(pageIndex) && pageIndex > 0 ? pageIndex : index + 1,
        url: asset.url,
      }] : [];
    }),
    capabilities: {
      canPass: capabilities.canPass === true,
      canReturnSingle: capabilities.canReturnSingle === true,
      canReturnBatch: capabilities.canReturnBatch === true,
    },
    blockers: {
      pendingImageEdits: Number.isSafeInteger(Number((row.blockers as Record<string, unknown> | undefined)?.pendingImageEdits))
        ? Math.max(0, Number((row.blockers as Record<string, unknown>).pendingImageEdits)) : 0,
    },
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
  };
  if (blindReview) return common;
  return {
    ...common,
    ...(Number.isSafeInteger(Number(row.taskId)) ? { taskId: Number(row.taskId) } : {}),
    ...(typeof row.query === 'string' ? { query: row.query } : {}),
    ...(row.productionBatch && typeof row.productionBatch === 'object'
      ? { productionBatch: row.productionBatch as ImageQaItem['productionBatch'] } : {}),
    ...(row.submitter && typeof row.submitter === 'object'
      ? { submitter: row.submitter as ImageQaItem['submitter'] } : {}),
    ...(typeof row.imageRunId === 'string' && row.imageRunId ? { imageRunId: row.imageRunId } : {}),
    ...(Number.isSafeInteger(Number(row.copyRevisionId)) && Number(row.copyRevisionId) > 0
      ? { copyRevisionId: Number(row.copyRevisionId) } : {}),
  };
}
