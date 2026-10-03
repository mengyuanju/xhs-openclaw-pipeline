import { HttpError, requestActor, json, requireJson, safeStoragePath } from './http-route-common.mjs';
import { getCopyQualityQueues } from './copy-quality-control.mjs';
import { listCopyQaCandidatesV2, createCopyQaBatchV2, listCopyQaBatchesV2, listCopyQaBatchItemsV2, decideCopyQaItemV2 } from './copy-qa-v2.mjs';
import { normalizeReassignmentBatchInput } from './secondary-assignment.mjs';
import { relative } from 'node:path';
import { taskListFactQueryable } from './task-list-facts.mjs';

function optionalBoolean(value, name) {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new HttpError(400, 'INVALID_PARAMETER', `${name} must be true or false`);
}

export function installQualityRoutes({
  deliverAsset,
  sweepReferences,
  router,
  repository,
  storageRoot
}) {
  router.get('/v1/production-batches/:batchId/copy-sampling-readiness', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.getProductionBatchSamplingReadiness(ctx.params.batchId, {
      actor
    }));
  });
  router.post('/v1/production-batches/:batchId/copy-sampling-freeze', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.freezeCopySamplingBatch(ctx.params.batchId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/copy-quality/queues', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await getCopyQualityQueues(repository.pool, actor));
  });
  router.get('/v2/copy-qa/candidates', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await listCopyQaCandidatesV2(repository.pool, actor, ctx.query.accountId, {
      summaryOnly: optionalBoolean(ctx.query.summaryOnly, 'summaryOnly')
    }));
  });
  router.post('/v2/copy-qa/batches', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await createCopyQaBatchV2(taskListFactQueryable(repository.pool), requireJson(ctx), actor));
  });
  router.get('/v2/copy-qa/batches', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await listCopyQaBatchesV2(repository.pool, actor, ctx.query.view ?? 'PENDING',
      ctx.query.limit !== undefined || ctx.query.offset !== undefined ? { limit: ctx.query.limit, offset: ctx.query.offset } : undefined));
  });
  router.get('/v2/copy-qa/batches/:batchId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await listCopyQaBatchItemsV2(repository.pool, ctx.params.batchId, actor,
      ctx.query.limit !== undefined || ctx.query.offset !== undefined ? { limit: ctx.query.limit, offset: ctx.query.offset } : undefined));
  });
  router.post('/v2/copy-qa/items/:itemId/decision', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await decideCopyQaItemV2(taskListFactQueryable(repository.pool), ctx.params.itemId, requireJson(ctx), actor, {
      storageRoot
    }));
  });
  router.get('/v1/copy-qa/statistics', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getCopyQaStatistics({
      actor
    }));
  });
  router.get('/v1/copy-qa/reason-tags', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listCopyQaReasonTags({
      actor
    }));
  });
  router.post('/v1/copy-qa/reason-tags', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 201, await repository.createCopyQaReasonTag(requireJson(ctx), {
      actor
    }));
  });
  router.patch('/v1/copy-qa/reason-tags/:tagId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.updateCopyQaReasonTag(ctx.params.tagId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/copy-qa/items', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listCopyQaItems({
      status: ctx.query.status,
      taskId: ctx.query.taskId,
      queryPackageName: ctx.query.queryPackageName,
      personName: ctx.query.personName,
      limit: ctx.query.limit,
      offset: ctx.query.offset
    }, {
      actor
    }));
  });
  router.post('/v1/copy-qa/items/:itemId/escalate', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
  });
  router.get('/v1/admin/reassignment-cases', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listReassignmentCases(ctx.query, {
      actor
    }));
  });
  router.post('/v1/admin/reassignment-cases/batch', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const input = requireJson(ctx);
    normalizeReassignmentBatchInput(input);
    json(ctx, 200, await repository.batchReassignmentCases(input, {
      actor,
      storageRoot
    }));
  });
  router.get('/v1/admin/reassignment-cases/:caseId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getReassignmentCase(ctx.params.caseId, {
      actor
    }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/restore', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.restoreReassignmentCase(ctx.params.caseId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/regenerate', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.regenerateReassignmentBaseline(ctx.params.caseId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/admin/reassignment-cases/:caseId/reset', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.retryReassignmentReset(ctx.params.caseId, requireJson(ctx), {
      actor,
      storageRoot
    }));
  });
  for (const operation of ['REASSIGN', 'DISCARD']) router.post(`/v1/admin/reassignment-cases/:caseId/${operation.toLowerCase()}`, async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.disposeReassignmentCase(ctx.params.caseId, requireJson(ctx), {
      actor,
      operation
    }));
  });
  router.get('/v1/copy-qa/items/:itemId', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getCopyQaItem(ctx.params.itemId, {
      actor
    }));
  });
  router.post('/v1/copy-qa/items/:itemId/pass', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.passCopyQaItem(ctx.params.itemId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/copy-qa/items/:itemId/return', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.returnCopyQaItem(ctx.params.itemId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/copy-qa/freezes/:freezePublicId/batch-return-preview', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getCopyQaBatchReturnPreview(ctx.params.freezePublicId, {
      actor
    }));
  });
  router.post('/v1/copy-qa/batch-return', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.batchReturnCopyQa(requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/copy-qa/freezes/:freezePublicId/release-rest', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.releaseCopyQaFreeze(ctx.params.freezePublicId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/:taskId/copy-qa-return', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.returnCopyQaItem(body.samplingItemId, body, {
      actor,
      expectedTaskId: ctx.params.taskId
    }));
  });
  router.post('/v1/tasks/batch-copy-qa-return', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.batchReturnCopyQa(requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/image-qa/items', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.listImageQaItems({
      status: ctx.query.status,
      personName: ctx.query.personName,
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      ...(ctx.query.includeSummary === undefined ? {} : {
        includeSummary: optionalBoolean(ctx.query.includeSummary, 'includeSummary')
      })
    }, {
      actor
    }));
  });
  router.get('/v1/image-qa/items/:itemId/assets/:assetId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    const asset = await repository.getImageQaAsset(ctx.params.itemId, ctx.params.assetId, {
      actor
    });
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    await deliverAsset(ctx, asset, path);
    await repository.getImageQaAsset(ctx.params.itemId, ctx.params.assetId, { actor });
  });
  router.post('/v1/image-qa/items/:itemId/pass', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    const result = await repository.passImageQaItem(ctx.params.itemId, requireJson(ctx), {
      actor
    });
    json(ctx, 200, result);
    void sweepReferences();
  });
  router.post('/v1/image-qa/items/:itemId/return', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.returnImageQaItem(ctx.params.itemId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/image-qa/freezes/:freezePublicId/batch-return-preview', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.getImageQaBatchReturnPreview(ctx.params.freezePublicId, {
      actor
    }));
  });
  router.post('/v1/image-qa/batch-return', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.batchReturnImageQa(requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/image-qa/close-tail', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const result = await repository.closeImageSamplingTail(requireJson(ctx), {
      actor
    });
    json(ctx, 200, result);
    void sweepReferences();
  });
  router.post('/v1/image-qa/items/:itemId/discard', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER']);
    json(ctx, 200, await repository.discardImageQaItem(ctx.params.itemId, requireJson(ctx), {
      actor
    }));
  });
}
