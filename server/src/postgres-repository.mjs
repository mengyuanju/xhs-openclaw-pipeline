import {
  BUILTIN_LAYOUT_CATALOG,
  Pool,
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  autoCreateCopyQaBatchesV2,
  integerOption,
  invalidateTaskTotals,
  loadMigrations,
  migrateDatabase,
  pendingMigrations,
  postgresPoolOptions,
  taskListFactQueryable,
  taskListFactVersion,
  transaction
} from './repository-context.mjs';
import { WorkflowRepository } from './repository-workflows.mjs';
export { postgresPoolOptions } from './repository-context.mjs';

/** Stable public facade; implementation belongs to the repository domain modules. */
export class PostgresControlPlaneRepository extends WorkflowRepository {
  constructor({ connectionString, pool, env = process.env, totalCacheTtlMs, now = Date.now,
    executionSnapshotStorageEnabled = env.XHS_SERVER_ENV === 'development' || env.EXECUTION_SNAPSHOT_DEDUP_ENABLED === 'true' } = {}) {
    super();
    if (!pool && !connectionString) throw new TypeError('PostgreSQL connection string is required');
    this.pool = pool ?? new Pool({ connectionString, ...postgresPoolOptions(env) });
    this.factPool = taskListFactQueryable(this.pool);
    this.ownsPool = !pool;
    if (typeof executionSnapshotStorageEnabled !== 'boolean') throw new TypeError('executionSnapshotStorageEnabled must be boolean');
    this.executionSnapshotStorageEnabled = executionSnapshotStorageEnabled;
    this.totalCacheTtlMs = integerOption(totalCacheTtlMs ?? env.TASK_TOTAL_CACHE_TTL_MS,
      1_000, 'TASK_TOTAL_CACHE_TTL_MS', 0, 5_000);
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
  }

  getWorkspaceMutationVersion() { return taskListFactVersion(this.pool); }

  get supportsScopedWorkspaceCounts() { return true; }

  async close() {
    invalidateTaskTotals(this.pool);
    if (this.ownsPool) await this.pool.end();
  }

  async initialize({ migrate = true } = {}) {
    if (migrate) await migrateDatabase(this.pool);
    else {
      const pending = await pendingMigrations(this.pool, await loadMigrations());
      if (pending.length) throw new Error(`Pending database migrations: ${pending.map(item => item.id).join(', ')}. Run npm run server:db:upgrade -- --apply before starting.`);
    }
    await this.pool.query(`UPDATE global_settings SET value = value || jsonb_build_object('layoutCatalog', $1::jsonb), version = version + 1, updated_at = now()
      WHERE key = 'production' AND NOT (value ? 'layoutCatalog')`, [JSON.stringify(BUILTIN_LAYOUT_CATALOG)]);
  }

  async reconcileAutomaticCopyQaBatches() {
    const accounts = await this.pool.query(`SELECT id FROM app_users
      WHERE status='ACTIVE' AND auto_copy_batch_enabled=true ORDER BY id`);
    for (const account of accounts.rows) {
      await transaction(this.pool, client => autoCreateCopyQaBatchesV2(client, account.id));
    }
  }

  async health() {
    const result = await this.pool.query('SELECT now() AS now');
    return { ok: true, databaseTime: result.rows[0].now,
      capabilities: { taskRestoreVersion: 1, taskPriorityVersion: 1, executionHeartbeats: true, executionRetryControl: true, imageResume: true, executorConcurrency: true, codexConcurrencyPoolVersion: 1, imageEditExecutorVersion: 13, executorManagementVersion: 1, adminTaskFilters: true, adminTaskDateFilters: true, adminTaskActivityDateFilters: 1, creatorAccountFilters: true, assigneeAccountFilters: true, taskCursorPaginationVersion: 1, adminTaskOperations: true, savedTaskViews: true, imageControlsVersion: 1, taskAssignmentVersion: 3, autoAssignmentPoolVersion: 3, queryPackageVersion: 7, xiaohongshuQuerySearchVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION, xiaohongshuAccountStatusVersion: 2, duplicateQueryDiscardVersion: 1, copySamplingVersion: 2, copyQaBatchVersion: 1, copyQaReasonTagsVersion: 1, secondaryAssignmentVersion: 1, secondaryAssignmentBatchVersion: 1, accountQualityStatisticsVersion: 1, copyReturnedDiscardVersion: 1, blindCopyReviewVersion: 1, adminDirectCopyQaVersion: 1, copyReviewDraftVersion: 1, copyImagePlanRegenerationVersion: 2, finalDeliveryVersion: 5, sharedDeliveryVersion: 1, imageDiscardVersion: 1, imageReworkSubmissionVersion: 1, pendingImageEditResolutionVersion: 1, deliverySpreadsheetVersion: 3, deliveryPreviewVersion: 6 } };
  }
}

export function createPostgresControlPlaneRepository(options) {
  return new PostgresControlPlaneRepository(options);
}
