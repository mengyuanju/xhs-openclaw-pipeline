import { json, requireJson, requestActor, assertTaskAccess, safeStoragePath } from './http-route-common.mjs';
import { uploadAsset } from './http-asset-storage.mjs';
import { ControlPlaneNotFoundError } from './domain.mjs';
import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { installExecutionWorkNotificationRoutes, executionWorkNotificationCapabilities } from './http-execution-work-notifications.mjs';
export function installExecutionsRoutes({
  deliverAsset,
  router,
  repository,
  storageRoot,
  xhsSearchMachineTokenConfigured,
  executionWorkNotifications
}) {
  installExecutionWorkNotificationRoutes({ router, executionWorkNotifications });
  router.get('/health', async ctx => {
    const health = await repository.health();
    json(ctx, 200, { ...health, xhsSearchMachineTokenConfigured,
      capabilities: { ...health.capabilities, ...executionWorkNotificationCapabilities } });
  });
  router.put('/v1/executions/:executionId/model-calls/:callId', async ctx => {
    json(ctx, 200, await repository.recordModelCall(ctx.params.executionId, ctx.params.callId, requireJson(ctx)));
  });
  router.post('/v1/nodes', async ctx => {
    json(ctx, 200, await repository.registerNode(requireJson(ctx)));
  });
  router.get('/v1/nodes', async ctx => {
    json(ctx, 200, await repository.listNodes());
  });
  router.get('/v1/executor-statuses', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listNodes({
      includeRunningImageEdits: true
    }));
  });
  router.get('/v1/xhs-search-statuses', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listXhsQuerySearchNodes());
  });
  router.delete('/v1/xhs-search-statuses', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retireXhsQuerySearchNode(requireJson(ctx).nodeId, actor));
  });
  router.delete('/v1/executor-statuses', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retireNode(requireJson(ctx).nodeId, actor));
  });
  router.post('/v1/executions/claim-copy', async ctx => {
    json(ctx, 200, await repository.claimCopy(requireJson(ctx).nodeId));
  });
  router.post('/v1/executions/heartbeat', async ctx => {
    json(ctx, 200, await repository.heartbeatExecutions(requireJson(ctx)));
  });
  router.post('/v1/executions/claim-image', async ctx => {
    await repository.flushExpiredCopyQualityBatches?.();
    const body = requireJson(ctx);
    json(ctx, 200, await repository.claimImage(body.nodeId, body.imageControlsVersion, body.layoutCatalogVersion, body.imageEditExecutorVersion));
  });
  router.post('/v1/executions/claim-copy-batch', async ctx => {
    json(ctx, 200, await repository.claimCopyBatch(requireJson(ctx)));
  });
  router.post('/v1/executions/claim-image-batch', async ctx => {
    await repository.flushExpiredCopyQualityBatches?.();
    json(ctx, 200, await repository.claimImageBatch(requireJson(ctx)));
  });
  router.patch('/v1/executions/:executionId/progress', async ctx => {
    json(ctx, 200, await repository.updateProgress(ctx.params.executionId, requireJson(ctx)));
  });
  router.put('/v1/executions/:executionId/visual-plan', async ctx => {
    json(ctx, 200, await repository.saveVisualPlan(ctx.params.executionId, requireJson(ctx)));
  });
  router.post('/v1/executions/:executionId/complete-copy', async ctx => {
    json(ctx, 200, await repository.completeCopy(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/complete-image-plan-regeneration', async ctx => {
    json(ctx, 200, await repository.completeImagePlanRegeneration(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/fail-image-plan-regeneration', async ctx => {
    json(ctx, 200, await repository.failImagePlanRegeneration(ctx.params.executionId, requireJson(ctx).error));
  });
  router.post('/v1/executions/:executionId/complete-image', async ctx => {
    json(ctx, 200, await repository.completeImage(ctx.params.executionId, requireJson(ctx).result));
  });
  router.post('/v1/executions/:executionId/fail', async ctx => {
    const body = requireJson(ctx);
    json(ctx, 200, await repository.failExecution(ctx.params.executionId, body.error, {
      autoRetry: body.autoRetry
    }));
  });
  router.post('/v1/xhs-query-search/claim', async ctx => {
    json(ctx, 200, await repository.claimXhsQuerySearch(requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/complete', async ctx => {
    json(ctx, 200, await repository.completeXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/block', async ctx => {
    json(ctx, 200, await repository.blockXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/:jobId/fail', async ctx => {
    json(ctx, 200, await repository.failXhsQuerySearch(ctx.params.jobId, requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/resume', async ctx => {
    json(ctx, 200, await repository.resumeXhsQuerySearch(requireJson(ctx)));
  });
  router.post('/v1/xhs-query-search/retry-failed', async ctx => {
    json(ctx, 200, await repository.retryFailedXhsQuerySearch(requireJson(ctx)));
  });
  router.put('/v1/executions/:executionId/assets', async ctx => {
    const result = await uploadAsset({
      ctx,
      repository,
      storageRoot,
      executionId: ctx.params.executionId
    });
    json(ctx, 201, {
      ...result,
      url: `/v1/assets/${result.id}`
    });
  });
  router.get('/v1/assets/:assetId', async ctx => {
    const asset = await repository.getAsset(ctx.params.assetId);
    if (!asset) throw new ControlPlaneNotFoundError('asset not found');
    ctx.params.taskId = String(asset.taskId);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      allowCreatorRead: true
    });
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    await deliverAsset(ctx, asset, path);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      allowCreatorRead: true
    });
  });
  router.get('/v1/executions/:executionId/source-assets/:assetId', async ctx => {
    const asset = await repository.imageReprocessAsset(ctx.params.executionId, ctx.params.assetId);
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.type = asset.mediaType;
    ctx.body = await readFile(path);
  });
}
