import { createAssetDelivery } from './asset-delivery.mjs';
import { createTaskArchivePreparation } from './task-archive-preparation.mjs';
import { installStandaloneImageEditorRoutes } from './standalone-image-editor-routes.mjs';
import { requestActor, requireJson, json, readBody, assertCurrentActorIdentity, HttpError } from './http-route-common.mjs';
import { createDeliveryExportRegistry } from './delivery-export.mjs';
import { installSharedDeliveryRoutes } from './delivery-routes.mjs';
import { cleanStaleDeliveryExportDirectories, DELIVERY_EXPORT_SWEEP_MS } from './http-delivery-artifacts.mjs';
import { drainDeliveryPreviewRevocations } from './delivery-preview.mjs';
import { createCoalescedWorker } from './coalesced-worker.mjs';
import { PostgresControlPlaneRepository } from './postgres-repository.mjs';
import pg from 'pg';
import { createTaskReportExportWorker } from './task-report-exports.mjs';
import { createReportProjectionWorker } from './report-query-projections.mjs';
import { drainDeliveryModelCallCleanup, backfillDeliveryModelCallCleanup } from './model-call-cleanup.mjs';
import { drainDeliveredCopyReviewDrafts } from './delivery-draft-cleanup.mjs';
import { drainExpiredClaimReceipts } from './claim-receipt-cleanup.mjs';
import { drainExecutionSnapshotBackfill } from './execution-snapshot-storage.mjs';
import { drainTerminalModelCallPayloadArchive } from './model-call-payload-archive.mjs';
import { drainCopyReviewDraftArchive } from './copy-review-draft-archive.mjs';
import { backfillEligibleReferenceCleanup, drainReferenceCleanup } from './image-reference-cleanup.mjs';
import { LoginRateLimiter } from '../../src/admin/auth.mjs';
import { createImageEditingService } from './image-editing.mjs';
import { taskListFactQueryable } from './task-list-facts.mjs';
import { disposeImageQualityTailDrain } from './image-quality-control.mjs';
import { createExecutionWorkNotifications } from './execution-work-notifications.mjs';
export function createControlPlaneRouteResources({
  router,
  repository,
  storageRoot,
  analyzeCopy,
  analyzeVisual,
  previewClient,
  previewUrlResolver,
  xhsSearchMachineTokenConfigured,
  onProgrammaticReady,
  reportProjectionEnabled,
  disposableCleanupEnabled,
  storageOptimizationEnabled
}) {
  const factPool = typeof repository.pool?.query === 'function'
    ? taskListFactQueryable(repository.pool) : repository.pool;
  const executionWorkNotifications = createExecutionWorkNotifications({ pool: repository.pool ?? repository });
  const domainRepository = new Proxy(repository, {
    get(target, key) {
      if (key === 'pool') return factPool;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const deliverAsset = createAssetDelivery({
    storageRoot
  });
  const archivePreparation = createTaskArchivePreparation({
    storageRoot
  });
  const standaloneImageEditor = installStandaloneImageEditorRoutes(router, domainRepository, storageRoot, {
    requestActor,
    requireJson,
    json,
    onProgrammaticReady,
    readBody
  });
  const deliveryExportRegistry = createDeliveryExportRegistry();
  const disposeSharedDelivery = installSharedDeliveryRoutes(router, domainRepository, storageRoot, {
    requestActor,
    requireJson,
    json,
    assertCurrentActorIdentity
  });
  const initialDeliveryExportCleanup = cleanStaleDeliveryExportDirectories(storageRoot).catch(error => console.error('failed to clean stale delivery exports', error));
  const deliveryExportSweep = setInterval(() => {
    void cleanStaleDeliveryExportDirectories(storageRoot).catch(error => console.error('failed to clean stale delivery exports', error));
  }, DELIVERY_EXPORT_SWEEP_MS);
  deliveryExportSweep.unref?.();
  const previewRevocationWorker = createCoalescedWorker(
    signal => drainDeliveryPreviewRevocations(repository, previewClient, { signal }),
    { onError: error => console.error('failed to revoke withdrawn delivery previews', error) },
  );
  const drainRevocations = () => previewRevocationWorker.wake();
  const previewRevocationSweep = setInterval(() => {
    void drainRevocations();
  }, 5_000);
  previewRevocationSweep.unref?.();
  void drainRevocations();
  const imageQualitySweep = setInterval(() => {
    void repository.flushExpiredImageQualityBatches?.().catch(error => console.error('failed to freeze expired image QA tails', error));
  }, 60_000);
  imageQualitySweep.unref?.();
  let referenceCleanupDrain = Promise.resolve();
  let referenceCleanupRunning = false;
  let routeResourcesStopping = false;
  const reportExportWorker = repository instanceof PostgresControlPlaneRepository && repository.pool instanceof pg.Pool ? createTaskReportExportWorker(repository.pool, storageRoot) : null;
  const reportProjectionWorker = reportProjectionEnabled && repository instanceof PostgresControlPlaneRepository && repository.pool instanceof pg.Pool ? createReportProjectionWorker(repository.pool) : null;
  void reportProjectionWorker?.wake();
  let modelCleanupDrain = null;
  const wakeModelCleanup = () => {
    if (routeResourcesStopping) return;
    if (!(repository instanceof PostgresControlPlaneRepository) || !(repository.pool instanceof pg.Pool)) return;
    if (modelCleanupDrain) return modelCleanupDrain;
    modelCleanupDrain = drainDeliveryModelCallCleanup(repository.pool).catch(error => console.error('failed to clean delivered model calls', error)).finally(() => {
      modelCleanupDrain = null;
    });
    return modelCleanupDrain;
  };
  const sweepReferences = () => {
    if (routeResourcesStopping) return referenceCleanupDrain;
    if (!(repository instanceof PostgresControlPlaneRepository) || !(repository.pool instanceof pg.Pool)) {
      return referenceCleanupDrain;
    }
    if (referenceCleanupRunning) return referenceCleanupDrain;
    referenceCleanupRunning = true;
    referenceCleanupDrain = referenceCleanupDrain.then(async () => {
      if (routeResourcesStopping) return;
      if (disposableCleanupEnabled) {
        await drainDeliveredCopyReviewDrafts(repository.pool).catch(error => console.error('failed to clean delivered copy review drafts', error));
        if (routeResourcesStopping) return;
        await drainExpiredClaimReceipts(repository.pool).catch(error => console.error('failed to clean expired claim receipts', error));
      }
      if (routeResourcesStopping) return;
      await backfillEligibleReferenceCleanup(repository.pool, {
        limitTasks: 50
      });
      await drainReferenceCleanup(repository.pool, storageRoot, {
        limit: 100
      });
      await backfillDeliveryModelCallCleanup(repository.pool);
      await wakeModelCleanup();
      if (storageOptimizationEnabled && !routeResourcesStopping) {
        await drainExecutionSnapshotBackfill(repository.pool).catch(error => console.error('failed to compact execution snapshots', error));
        if (routeResourcesStopping) return;
        await drainTerminalModelCallPayloadArchive(repository.pool).catch(error => console.error('failed to archive terminal model call bodies', error));
        if (routeResourcesStopping) return;
        await drainCopyReviewDraftArchive(repository.pool).catch(error => console.error('failed to archive inactive copy review drafts', error));
      }
      void reportExportWorker?.wake();
      void reportProjectionWorker?.wake();
    }).catch(error => console.error('failed to clean image edit references', error)).finally(() => {
      referenceCleanupRunning = false;
    });
    return referenceCleanupDrain;
  };
  void sweepReferences();
  const referenceCleanupSweep = setInterval(() => {
    void sweepReferences();
  }, 15_000);
  referenceCleanupSweep.unref?.();
  const passwordLimiters = new Map();
  const currentPasswordLimiters = new Map();
  function limiterFor(limiters, userId) {
    const existing = limiters.get(userId);
    if (existing) {
      limiters.delete(userId);
      limiters.set(userId, existing);
      return existing;
    }
    if (limiters.size >= 100) limiters.delete(limiters.keys().next().value);
    const limiter = new LoginRateLimiter();
    limiters.set(userId, limiter);
    return limiter;
  }
  const passwordLimiter = userId => limiterFor(passwordLimiters, userId);
  const currentPasswordLimiter = userId => limiterFor(currentPasswordLimiters, userId);
  function assertPasswordAttemptAllowed(ctx, limiter) {
    const status = limiter.check();
    if (status.allowed) return;
    ctx.set('Retry-After', String(status.retryAfterSeconds));
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '密码尝试过多，请稍后再试');
  }
  const imageEditing = createImageEditingService({
    pool: factPool,
    storageRoot,
    onProgrammaticReady
  });
  const dispose = async () => {
    routeResourcesStopping = true;
    executionWorkNotifications.dispose();
    clearInterval(deliveryExportSweep);
    clearInterval(previewRevocationSweep);
    clearInterval(imageQualitySweep);
    clearInterval(referenceCleanupSweep);
    const previewRevocationStopped = previewRevocationWorker.dispose();
    const imageQualityStopped = disposeImageQualityTailDrain(factPool);
    await initialDeliveryExportCleanup;
    await standaloneImageEditor.uploads.dispose();
    await previewRevocationStopped;
    await imageQualityStopped;
    await referenceCleanupDrain;
    await modelCleanupDrain;
    await reportExportWorker?.dispose();
    await reportProjectionWorker?.dispose();
    await archivePreparation.dispose();
    await deliverAsset.dispose?.();
    await deliveryExportRegistry.dispose();
    await disposeSharedDelivery();
  };
  dispose.onMutationCommitted = () => {
    if (!routeResourcesStopping) {
      void wakeModelCleanup();
      void reportExportWorker?.wake();
      void reportProjectionWorker?.wake();
    }
  };
  return {
    executionWorkNotifications,
    deliverAsset,
    archivePreparation,
    deliveryExportRegistry,
    initialDeliveryExportCleanup,
    reportExportWorker,
    sweepReferences,
    passwordLimiter,
    currentPasswordLimiter,
    assertPasswordAttemptAllowed,
    imageEditing,
    dispose
  };
}
