import { imageEditExecutionIdentity, json, imageEditExecutorAsset, requireJson, HttpError, readBody, ASSET_BODY_LIMIT, requestActor, assertTaskAccess } from './http-route-common.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';
export function installImageEditingRoutes({
  imageEditing,
  router,
  repository
}) {
  router.get('/v1/executions/:executionId/image-edit/context', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    const context = await imageEditing.executorContext(identity.executionId, identity.editId, identity.leaseToken);
    json(ctx, 200, {
      ...context,
      source: imageEditExecutorAsset(context.source),
      repairSource: imageEditExecutorAsset(context.repairSource),
      refs: context.refs.map(imageEditExecutorAsset)
    });
  });
  router.get('/v1/executions/:executionId/image-edit/assets/:assetId', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    const result = await imageEditing.executorAsset(identity.executionId, identity.editId, identity.leaseToken, ctx.params.assetId);
    ctx.type = result.asset.media_type;
    ctx.body = result.bytes;
  });
  router.get('/v1/executions/:executionId/image-edit/asset-metadata/:assetId', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    const result = await imageEditing.executorAsset(identity.executionId, identity.editId, identity.leaseToken, ctx.params.assetId);
    json(ctx, 200, imageEditExecutorAsset(result.asset));
  });
  router.post('/v1/executions/:executionId/image-edit/heartbeat', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    json(ctx, 200, {
      active: await imageEditing.heartbeatExecutor(identity.executionId, identity.editId, identity.leaseToken)
    });
  });
  router.post('/v1/executions/:executionId/image-edit/validation', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    json(ctx, 200, await imageEditing.stageExecutorValidation(identity.executionId, identity.editId, identity.leaseToken, requireJson(ctx).validation));
  });
  router.put('/v1/executions/:executionId/image-edit/result', async ctx => {
    if (String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim() !== 'image/png') {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'image edit result must be image/png');
    }
    const identity = imageEditExecutionIdentity(ctx);
    json(ctx, 200, await imageEditing.completeExecutor(identity.executionId, identity.editId, identity.leaseToken, await readBody(ctx.req, ASSET_BODY_LIMIT)));
  });
  router.put('/v1/executions/:executionId/image-edit/rejected-result', async ctx => {
    if (String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim() !== 'image/png') {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'rejected image edit result must be image/png');
    }
    const identity = imageEditExecutionIdentity(ctx);
    json(ctx, 200, await imageEditing.rejectExecutor(identity.executionId, identity.editId, identity.leaseToken, await readBody(ctx.req, ASSET_BODY_LIMIT)));
  });
  router.post('/v1/executions/:executionId/image-edit/fail', async ctx => {
    const identity = imageEditExecutionIdentity(ctx);
    json(ctx, 200, await imageEditing.failExecutor(identity.executionId, identity.editId, identity.leaseToken, requireJson(ctx)));
  });
  router.post('/v1/tasks/:taskId/image-edit-references', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 201, await imageEditing.upload(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.delete('/v1/tasks/:taskId/image-edit-references/:assetId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, await imageEditing.deleteReference(ctx.params.taskId, ctx.params.assetId, actor));
  });
  router.post('/v1/tasks/:taskId/image-edits', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 201, await imageEditing.create(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.post('/v1/tasks/:taskId/image-edits/batch', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 201, await imageEditing.createBatch(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.post('/v1/tasks/:taskId/image-edits/batch/:batchId/accept', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, await imageEditing.acceptBatch(ctx.params.taskId, ctx.params.batchId, requireJson(ctx), actor));
  });
  router.get('/v1/tasks/:taskId/image-edits', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    const result = await imageEditing.list(ctx.params.taskId, {
      pendingOnly: ctx.query.pending === 'true'
    });
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, result);
  });
  router.get('/v1/tasks/:taskId/image-edits/state', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    const result = await imageEditing.state(ctx.params.taskId, {
      ids: ctx.query.ids ? String(ctx.query.ids).split(',') : []
    });
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, result);
  });
  router.post('/v1/tasks/:taskId/image-edits/resolve-pending', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, await imageEditing.resolvePending(ctx.params.taskId, requireJson(ctx), actor));
  });
  router.get('/v1/image-edits/:editId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const edit = await imageEditing.get(ctx.params.editId);
    ctx.params.taskId = String(edit.task_id);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 200, edit);
  });
  for (const action of ['queue', 'retry', 'apply-suggestion', 'cancel', 'accept', 'reject']) {
    router.post(`/v1/image-edits/:editId/${action}`, async ctx => {
      const actor = requestActor(ctx, ['ADMIN', 'USER']);
      const edit = await imageEditing.get(ctx.params.editId);
      ctx.params.taskId = String(edit.task_id);
      await assertTaskAccess(ctx, repository, {
        summaryOnly: true,
        ownerOnly: actor.role !== 'ADMIN'
      });
      json(ctx, 200, await imageEditing.action(ctx.params.editId, action, requireJson(ctx), actor));
    });
  }
  router.post('/v1/tasks/:taskId/image-versions/:runId/restore', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    json(ctx, 201, await imageEditing.create(ctx.params.taskId, {
      ...requireJson(ctx),
      operation: 'RESTORE',
      restoreRunId: ctx.params.runId
    }, actor));
  });
  router.get('/v1/tasks/:taskId/image-capabilities', async ctx => {
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      allowCreatorRead: true
    });
    json(ctx, 200, {
      version: 1,
      reviewImagePlanEdits: true,
      formats: Object.keys(IMAGE_FORMATS)
    });
  });
}
