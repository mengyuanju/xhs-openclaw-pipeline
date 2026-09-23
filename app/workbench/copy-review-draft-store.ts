const DATABASE_NAME = 'xhs-copy-review-drafts-v1';
const DATABASE_VERSION = 1;
const DRAFT_STORE = 'drafts';
const MIGRATION_STORE = 'migration';
const HISTORY_LIMIT = 20;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LocalCopyReviewDraftScope = {
  accountId: number;
  taskId: number;
  baseCopyRevisionId: number;
  reviewerUsername: string;
};

export type LocalCopyReviewDraftRecord<TContent> = {
  id: string;
  taskId: number;
  baseCopyRevisionId: number;
  reviewerAccountId: number;
  reviewerUsername: string;
  version: number;
  content: TContent;
  createdAt: string;
};

export type LegacyCopyReviewDraftRecord<TContent> = {
  id: number;
  taskId: number;
  baseCopyRevisionId: number;
  reviewerAccountId: number;
  version: number;
  content: TContent;
  createdAt: string;
};

type StoredDraft<TContent> = LocalCopyReviewDraftRecord<TContent> & {
  scopeKey: string;
  createdAtMs: number;
  fingerprint: string;
};

type MigrationMarker = { scopeKey: string; completedAt: string };

export class LocalCopyReviewDraftStorageError extends Error {
  readonly code = 'LOCAL_COPY_REVIEW_DRAFT_STORAGE_UNAVAILABLE';

  constructor(cause?: unknown) {
    super('此浏览器无法使用本机草稿数据库，请检查浏览器的网站存储权限。', { cause });
    this.name = 'LocalCopyReviewDraftStorageError';
  }
}

export class LocalCopyReviewDraftConflictError extends Error {
  readonly code = 'COPY_REVIEW_DRAFT_CONFLICT';

  constructor() {
    super('其他窗口已保存更新的本机草稿。请重新打开任务后再编辑。');
    this.name = 'LocalCopyReviewDraftConflictError';
  }
}

function scopeKey(scope: LocalCopyReviewDraftScope): string {
  for (const value of [scope.accountId, scope.taskId, scope.baseCopyRevisionId]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('草稿的账号、任务和文案修订版 ID 必须是正整数。');
    }
  }
  return `${scope.accountId}:${scope.taskId}:${scope.baseCopyRevisionId}`;
}

export function copyReviewDraftFingerprint(content: unknown): string {
  const fingerprint = JSON.stringify(content, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0));
  });
  if (typeof fingerprint !== 'string') throw new TypeError('草稿内容必须是可序列化的数据。');
  return fingerprint;
}

function newDraftId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `local:${random}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本机草稿数据库操作失败。'));
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('本机草稿数据库事务已取消。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('本机草稿数据库事务失败。'));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new LocalCopyReviewDraftStorageError();
  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  } catch (cause) {
    throw new LocalCopyReviewDraftStorageError(cause);
  }
  return new Promise((resolve, reject) => {
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        const drafts = database.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
        drafts.createIndex('scopeKey', 'scopeKey');
        drafts.createIndex('createdAtMs', 'createdAtMs');
      }
      if (!database.objectStoreNames.contains(MIGRATION_STORE)) {
        database.createObjectStore(MIGRATION_STORE, { keyPath: 'scopeKey' });
      }
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(new LocalCopyReviewDraftStorageError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(new LocalCopyReviewDraftStorageError(new Error('本机草稿数据库被其他页面阻塞。')));
    };
  });
}

async function withTransaction<TResult>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<TResult>,
): Promise<TResult> {
  const database = await openDatabase();
  try {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(stores, mode);
    } catch (cause) {
      throw new LocalCopyReviewDraftStorageError(cause);
    }
    const finished = transactionFinished(transaction);
    // Attach a handler immediately: a request failure can abort before work returns.
    void finished.catch(() => {});
    try {
      const result = await work(transaction);
      await finished;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* already completed or aborted */ }
      try { await finished; } catch { /* preserve the original error */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

async function deleteExpired(drafts: IDBObjectStore, now: number): Promise<void> {
  const keys = await requestResult(drafts.index('createdAtMs').getAllKeys(
    IDBKeyRange.upperBound(now - DRAFT_TTL_MS),
  ));
  for (const key of keys) drafts.delete(key);
}

async function scopedDrafts<TContent>(drafts: IDBObjectStore, key: string): Promise<StoredDraft<TContent>[]> {
  const rows = await requestResult(drafts.index('scopeKey').getAll(IDBKeyRange.only(key)));
  return (rows as StoredDraft<TContent>[]).sort((left, right) =>
    right.version - left.version || right.createdAtMs - left.createdAtMs);
}

function publicDraft<TContent>(draft: StoredDraft<TContent>): LocalCopyReviewDraftRecord<TContent> {
  const { id, taskId, baseCopyRevisionId, reviewerAccountId, reviewerUsername, version, content, createdAt } = draft;
  return { id, taskId, baseCopyRevisionId, reviewerAccountId, reviewerUsername, version, content, createdAt };
}

function markMigrated(migrations: IDBObjectStore, key: string): void {
  const marker: MigrationMarker = { scopeKey: key, completedAt: new Date().toISOString() };
  migrations.put(marker);
}

async function trimScope<TContent>(drafts: IDBObjectStore, key: string): Promise<void> {
  const rows = await scopedDrafts<TContent>(drafts, key);
  for (const row of rows.slice(HISTORY_LIMIT)) drafts.delete(row.id);
}

/** List the most recent, unexpired drafts for one account, task and copy revision. */
export async function listLocalCopyReviewDrafts<TContent>(scope: LocalCopyReviewDraftScope): Promise<{
  baseCopyRevisionId: number;
  drafts: LocalCopyReviewDraftRecord<TContent>[];
}> {
  const key = scopeKey(scope);
  return withTransaction([DRAFT_STORE], 'readwrite', async transaction => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    await deleteExpired(drafts, Date.now());
    const rows = await scopedDrafts<TContent>(drafts, key);
    return {
      baseCopyRevisionId: scope.baseCopyRevisionId,
      drafts: rows.slice(0, HISTORY_LIMIT).map(publicDraft),
    };
  });
}

/** An atomic compare-and-swap save. Replaying identical content creates no new version. */
export async function saveLocalCopyReviewDraft<TContent>(
  scope: LocalCopyReviewDraftScope,
  input: { expectedLatestDraftId: string | null; content: TContent },
): Promise<{ created: boolean; draft: LocalCopyReviewDraftRecord<TContent> }> {
  const key = scopeKey(scope);
  const fingerprint = copyReviewDraftFingerprint(input.content);
  return withTransaction([DRAFT_STORE, MIGRATION_STORE], 'readwrite', async transaction => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const migrations = transaction.objectStore(MIGRATION_STORE);
    await deleteExpired(drafts, Date.now());
    const latest = (await scopedDrafts<TContent>(drafts, key))[0] ?? null;
    if (latest?.fingerprint === fingerprint) {
      markMigrated(migrations, key);
      return { created: false, draft: publicDraft(latest) };
    }
    if ((latest?.id ?? null) !== input.expectedLatestDraftId) {
      throw new LocalCopyReviewDraftConflictError();
    }
    const now = Date.now();
    const draft: StoredDraft<TContent> = {
      id: newDraftId(), scopeKey: key, taskId: scope.taskId,
      baseCopyRevisionId: scope.baseCopyRevisionId,
      reviewerAccountId: scope.accountId, reviewerUsername: scope.reviewerUsername,
      version: (latest?.version ?? 0) + 1, content: input.content,
      createdAt: new Date(now).toISOString(), createdAtMs: now, fingerprint,
    };
    await requestResult(drafts.add(draft));
    await trimScope<TContent>(drafts, key);
    markMigrated(migrations, key);
    return { created: true, draft: publicDraft(draft) };
  });
}

/** Returns true once per scope until legacy drafts have been imported or dismissed. */
export async function needsLegacyCopyReviewDraftImport(scope: LocalCopyReviewDraftScope): Promise<boolean> {
  const key = scopeKey(scope);
  return withTransaction([DRAFT_STORE, MIGRATION_STORE], 'readwrite', async transaction => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const migrations = transaction.objectStore(MIGRATION_STORE);
    await deleteExpired(drafts, Date.now());
    if (await requestResult(migrations.get(key))) return false;
    if ((await scopedDrafts(drafts, key)).length > 0) {
      markMigrated(migrations, key);
      return false;
    }
    return true;
  });
}

/** Import server drafts once. Local edits always take precedence over legacy records. */
export async function importLegacyCopyReviewDrafts<TContent>(
  scope: LocalCopyReviewDraftScope,
  legacyDrafts: LegacyCopyReviewDraftRecord<TContent>[],
): Promise<void> {
  const key = scopeKey(scope);
  if (!Array.isArray(legacyDrafts)) throw new TypeError('旧草稿历史必须是数组。');
  return withTransaction([DRAFT_STORE, MIGRATION_STORE], 'readwrite', async transaction => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const migrations = transaction.objectStore(MIGRATION_STORE);
    await deleteExpired(drafts, Date.now());
    if (await requestResult(migrations.get(key))) return;
    if ((await scopedDrafts(drafts, key)).length > 0) {
      markMigrated(migrations, key);
      return;
    }
    const importedAtMs = Date.now();
    const valid = legacyDrafts.filter(draft => {
      if (draft.taskId !== scope.taskId || draft.baseCopyRevisionId !== scope.baseCopyRevisionId
        || draft.reviewerAccountId !== scope.accountId) {
        throw new TypeError('旧草稿不属于当前账号、任务和文案修订版。');
      }
      return Number.isSafeInteger(draft.version) && draft.version > 0
        && Number.isFinite(Date.parse(draft.createdAt));
    }).sort((left, right) => right.version - left.version).slice(0, HISTORY_LIMIT).reverse();
    for (const legacy of valid) {
      const draft: StoredDraft<TContent> = {
        id: newDraftId(), scopeKey: key, taskId: scope.taskId,
        baseCopyRevisionId: scope.baseCopyRevisionId,
        reviewerAccountId: scope.accountId, reviewerUsername: scope.reviewerUsername,
        version: legacy.version, content: legacy.content,
        createdAt: legacy.createdAt, createdAtMs: importedAtMs,
        fingerprint: copyReviewDraftFingerprint(legacy.content),
      };
      drafts.add(draft);
    }
    markMigrated(migrations, key);
  });
}

/** Clear a completed revision's local history while retaining its migration marker. */
export async function clearLocalCopyReviewDrafts(scope: LocalCopyReviewDraftScope): Promise<void> {
  const key = scopeKey(scope);
  return withTransaction([DRAFT_STORE, MIGRATION_STORE], 'readwrite', async transaction => {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const rows = await scopedDrafts(drafts, key);
    for (const row of rows) drafts.delete(row.id);
    markMigrated(transaction.objectStore(MIGRATION_STORE), key);
  });
}
