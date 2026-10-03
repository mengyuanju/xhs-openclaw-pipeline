import { requestActor, requireJson, assertOperatorDeliveryTaskAccess, assertCurrentActorIdentity, json } from './http-route-common.mjs';
import { normalizeDeliveryExportRequest, resolveDeliveryExportTaskIds, assertDeliveryBindingsReady } from './delivery-export.mjs';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError } from './domain.mjs';
import { recordDeliveryBatchDownload, stageDeliveryPoolArchive, persistDeliveryBatchArchive, assertDeliveryExportArtifact, storedDeliveryBatchArtifact, stageDeliveryBatchSpreadsheet, stageDeliveryPoolSpreadsheet } from './http-delivery-artifacts.mjs';
import { randomUUID } from 'node:crypto';
import { deliveryBatchCode } from './delivery-batches.mjs';
import { queryPackageFileNameSegment } from './task-archive.mjs';
import { Transform } from 'node:stream';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DELIVERY_SPREADSHEET_MEDIA_TYPE } from './delivery-spreadsheet.mjs';
import { addDeliveryPreviewUrls, publishDeliveryPreviews } from './delivery-preview.mjs';
export function installDeliveryRoutes({
  deliveryExportRegistry,
  initialDeliveryExportCleanup,
  router,
  repository,
  storageRoot,
  previewClient,
  previewUrlResolver
}) {
  router.post('/v1/delivery-pool/archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const request = normalizeDeliveryExportRequest(requireJson(ctx));
    if (actor.role === 'USER' && request.scope !== 'SELECTED') {
      throw new ControlPlaneAuthorizationError('标注只能打包明确选中的本人作业');
    }
    const controller = new AbortController();
    const cancellation = () => new DOMException('delivery export client disconnected', 'AbortError');
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(actor, reason => controller.abort(reason));
      await initialDeliveryExportCleanup;
      const batchHistoryEnabled = typeof repository.createDeliveryBatch === 'function' && typeof repository.getDeliveryBatchArtifact === 'function' && typeof repository.recordDeliveryBatchDownload === 'function';
      if (actor.role === 'USER' && !batchHistoryEnabled) {
        throw new ControlPlaneConflictError('FINAL_DELIVERY_UNAVAILABLE', '中心服务尚未支持标注交付留痕，请升级后重试');
      }
      const taskIds = await resolveDeliveryExportTaskIds(repository, request, actor, {
        unpackedOnly: batchHistoryEnabled
      });
      await assertOperatorDeliveryTaskAccess(repository, taskIds, actor);
      staged = await stageDeliveryPoolArchive(repository, storageRoot, taskIds, {
        signal: controller.signal
      });
      const expectedBindings = requireJson(ctx).expectedBindings;
      if (expectedBindings !== undefined) {
        if (!Array.isArray(expectedBindings) || expectedBindings.length !== staged.bindings.length || new Set(expectedBindings.map(binding => binding?.taskId)).size !== expectedBindings.length || expectedBindings.some(expected => !staged.bindings.some(binding => binding.taskId === expected?.taskId && binding.copyRevisionId === expected?.copyRevisionId && binding.imageRunId === expected?.imageRunId))) {
          throw new ControlPlaneConflictError('DELIVERY_VERSION_CHANGED', '所选内容版本已变化，请刷新后重新确认打包范围');
        }
      }
      await assertDeliveryBindingsReady(repository, staged.bindings);
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const batchPublicId = batchHistoryEnabled ? randomUUID() : null;
      const batchCode = batchPublicId ? deliveryBatchCode(batchPublicId) : null;
      const sourceFileName = request.scope === 'ALL_READY' ? '交付池-全部可交付项.zip' : request.scope === 'QUERY_PACKAGE' ? `${queryPackageFileNameSegment(request.queryPackageName)}-交付资源.zip` : request.scope === 'CLIENT_BATCH' ? `${queryPackageFileNameSegment(request.clientBatchCode)}-交付资源.zip` : '交付池-已选资源.zip';
      const fileName = batchCode ? `${batchCode}-${sourceFileName}` : sourceFileName;
      let deliveryBatch = null;
      if (batchPublicId) {
        const persisted = await persistDeliveryBatchArchive(storageRoot, staged, batchPublicId);
        staged = null;
        try {
          deliveryBatch = await repository.createDeliveryBatch({
            publicId: batchPublicId,
            scope: request.scope,
            ...(request.scope === 'QUERY_PACKAGE' ? {
              queryPackageName: request.queryPackageName
            } : {}),
            ...(request.scope === 'CLIENT_BATCH' ? {
              clientBatchCode: request.clientBatchCode
            } : {}),
            fileName,
            byteSize: persisted.byteSize,
            sha256: persisted.sha256,
            bindings: persisted.bindings
          }, {
            actor
          });
        } catch (error) {
          await persisted.removePersistent().catch(() => {});
          throw error;
        }
        staged = persisted;
      }
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName,
        taskCount: staged.taskCount,
        bindings: staged.bindings,
        deliveryBatch
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.head('/v1/delivery-pool/archive/:downloadId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const record = assertDeliveryExportArtifact(await deliveryExportRegistry.peek(ctx.params.downloadId, actor), 'archivePath');
    if (record.deliveryBatch) {
      await storedDeliveryBatchArtifact(repository, storageRoot, record.deliveryBatch.publicId, actor);
    } else {
      await assertDeliveryBindingsReady(repository, record.bindings);
    }
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-pool.zip"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
  });
  router.get('/v1/delivery-pool/archive/:downloadId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const {
      downloadId
    } = ctx.params;
    assertDeliveryExportArtifact(await deliveryExportRegistry.peek(downloadId, actor), 'archivePath');
    const record = await deliveryExportRegistry.take(downloadId, actor);
    try {
      if (record.deliveryBatch) {
        await storedDeliveryBatchArtifact(repository, storageRoot, record.deliveryBatch.publicId, actor);
      } else {
        await assertDeliveryBindingsReady(repository, record.bindings);
      }
      await assertCurrentActorIdentity(repository, actor);
      record.downloadSignal.throwIfAborted();
    } catch (error) {
      await deliveryExportRegistry.complete(downloadId, record);
      throw error;
    }
    const content = new Transform({
      transform(chunk, encoding, callback) {
        deliveryExportRegistry.touch(downloadId, record);
        callback(null, chunk);
      }
    });
    const source = createReadStream(record.staged.archivePath, {
      signal: record.downloadSignal
    });
    void pipeline(source, content, {
      signal: record.downloadSignal
    }).catch(error => {
      if (!content.destroyed) content.destroy(error);
    });
    let cleanupStarted = false;
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) {
        record.downloadController.abort(new DOMException('delivery export client disconnected', 'AbortError'));
      }
    };
    ctx.res.once('close', onResponseClosed);
    if (record.deliveryBatch) {
      ctx.res.once('finish', () => recordDeliveryBatchDownload(repository, record.deliveryBatch.publicId, actor));
    }
    content.once('close', () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      ctx.res.off('close', onResponseClosed);
      void deliveryExportRegistry.complete(downloadId, record).catch(error => {
        console.error('failed to clean staged delivery export', error);
      });
    });
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-pool.zip"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
    ctx.body = content;
  });
  router.head('/v1/delivery-batches/:batchId/archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const batch = await storedDeliveryBatchArtifact(repository, storageRoot, ctx.params.batchId, actor);
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = batch.byteSize;
    ctx.set('X-Delivery-Task-Count', String(batch.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-batch.zip"; filename*=UTF-8''${encodeURIComponent(batch.fileName)}`);
  });
  router.get('/v1/delivery-batches/:batchId/archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const batch = await storedDeliveryBatchArtifact(repository, storageRoot, ctx.params.batchId, actor);
    await assertCurrentActorIdentity(repository, actor);
    ctx.res.once('finish', () => recordDeliveryBatchDownload(repository, batch.publicId, actor));
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.length = batch.byteSize;
    ctx.set('X-Delivery-Task-Count', String(batch.taskCount));
    ctx.set('Content-Disposition', `attachment; filename="delivery-batch.zip"; filename*=UTF-8''${encodeURIComponent(batch.fileName)}`);
    ctx.body = createReadStream(batch.archivePath);
  });
  router.post('/v1/delivery-batches/:batchId/xlsx', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const controller = new AbortController();
    const cancellation = () => new DOMException('delivery batch spreadsheet client disconnected', 'AbortError');
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(actor, reason => controller.abort(reason));
      await initialDeliveryExportCleanup;
      staged = await stageDeliveryBatchSpreadsheet(repository, storageRoot, ctx.params.batchId, actor, {
        signal: controller.signal
      });
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName: `${staged.batch.code}-交付内容${staged.fileExtension}`,
        taskCount: staged.taskCount,
        bindings: staged.bindings,
        validateBindings: false
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.post('/v1/delivery-pool/xlsx', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const request = normalizeDeliveryExportRequest(requireJson(ctx));
    const controller = new AbortController();
    const cancellation = () => new DOMException('delivery spreadsheet client disconnected', 'AbortError');
    const onRequestAborted = () => controller.abort(cancellation());
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) controller.abort(cancellation());
    };
    ctx.req.once('aborted', onRequestAborted);
    ctx.res.once('close', onResponseClosed);
    let releasePreparation = () => {};
    let staged = null;
    try {
      releasePreparation = deliveryExportRegistry.beginPreparation(actor, reason => controller.abort(reason));
      await initialDeliveryExportCleanup;
      const taskIds = await resolveDeliveryExportTaskIds(repository, request, actor);
      staged = await stageDeliveryPoolSpreadsheet(repository, storageRoot, taskIds, {
        signal: controller.signal
      });
      await assertDeliveryBindingsReady(repository, staged.bindings);
      await assertCurrentActorIdentity(repository, actor);
      controller.signal.throwIfAborted();
      const fileStem = request.scope === 'ALL_READY' ? '交付池-全部文章与图片' : request.scope === 'QUERY_PACKAGE' ? `${queryPackageFileNameSegment(request.queryPackageName)}-交付内容` : request.scope === 'CLIENT_BATCH' ? `${queryPackageFileNameSegment(request.clientBatchCode)}-交付内容` : '交付池-已选文章与图片';
      const prepared = deliveryExportRegistry.issue(staged, actor, {
        fileName: `${fileStem}${staged.fileExtension}`,
        taskCount: staged.taskCount,
        bindings: staged.bindings
      });
      staged = null;
      json(ctx, 201, prepared);
    } finally {
      releasePreparation();
      ctx.req.off('aborted', onRequestAborted);
      ctx.res.off('close', onResponseClosed);
      await staged?.cleanup().catch(() => {});
    }
  });
  router.head('/v1/delivery-pool/xlsx/:downloadId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const record = assertDeliveryExportArtifact(await deliveryExportRegistry.peek(ctx.params.downloadId, actor), 'spreadsheetPath');
    if (record.validateBindings) {
      await assertDeliveryBindingsReady(repository, record.bindings);
    }
    await assertCurrentActorIdentity(repository, actor);
    ctx.status = 200;
    ctx.type = record.staged.mediaType ?? DELIVERY_SPREADSHEET_MEDIA_TYPE;
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('X-Delivery-Part-Count', String(record.staged.partCount ?? 1));
    const fallbackFileName = record.staged.fileExtension === '.zip' ? 'delivery-pool.zip' : 'delivery-pool.xlsx';
    ctx.set('Content-Disposition', `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
  });
  router.get('/v1/delivery-pool/xlsx/:downloadId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const {
      downloadId
    } = ctx.params;
    assertDeliveryExportArtifact(await deliveryExportRegistry.peek(downloadId, actor), 'spreadsheetPath');
    const record = await deliveryExportRegistry.take(downloadId, actor);
    try {
      if (record.validateBindings) {
        await assertDeliveryBindingsReady(repository, record.bindings);
      }
      await assertCurrentActorIdentity(repository, actor);
      record.downloadSignal.throwIfAborted();
    } catch (error) {
      await deliveryExportRegistry.complete(downloadId, record);
      throw error;
    }
    const content = new Transform({
      transform(chunk, encoding, callback) {
        deliveryExportRegistry.touch(downloadId, record);
        callback(null, chunk);
      }
    });
    const source = createReadStream(record.staged.spreadsheetPath, {
      signal: record.downloadSignal
    });
    void pipeline(source, content, {
      signal: record.downloadSignal
    }).catch(error => {
      if (!content.destroyed) content.destroy(error);
    });
    let cleanupStarted = false;
    const onResponseClosed = () => {
      if (!ctx.res.writableEnded) {
        record.downloadController.abort(new DOMException('delivery spreadsheet client disconnected', 'AbortError'));
      }
    };
    ctx.res.once('close', onResponseClosed);
    content.once('close', () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      ctx.res.off('close', onResponseClosed);
      void deliveryExportRegistry.complete(downloadId, record).catch(error => {
        console.error('failed to clean staged delivery spreadsheet', error);
      });
    });
    ctx.status = 200;
    ctx.type = record.staged.mediaType ?? DELIVERY_SPREADSHEET_MEDIA_TYPE;
    ctx.length = record.staged.byteSize;
    ctx.set('X-Delivery-Task-Count', String(record.taskCount));
    ctx.set('X-Delivery-Part-Count', String(record.staged.partCount ?? 1));
    const fallbackFileName = record.staged.fileExtension === '.zip' ? 'delivery-pool.zip' : 'delivery-pool.xlsx';
    ctx.set('Content-Disposition', `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
    ctx.body = content;
  });
  router.get('/v1/delivery-pool', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const deliveryPool = await repository.listDeliveryPool({
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      includeTotal: ctx.query.includeTotal === 'true',
      ...(ctx.query.queryPackageName === undefined ? {} : {
        queryPackageName: ctx.query.queryPackageName
      }),
      ...(ctx.query.clientBatchCode === undefined ? {} : {
        clientBatchCode: ctx.query.clientBatchCode
      }),
      ...(ctx.query.packingState === undefined ? {} : {
        packingState: ctx.query.packingState
      })
    }, {
      actor
    });
    json(ctx, 200, addDeliveryPreviewUrls(deliveryPool, previewUrlResolver));
  });
  router.get('/v1/delivery-batches', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    json(ctx, 200, await repository.listDeliveryBatches({
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      ...(ctx.query.status === undefined ? {} : {
        status: ctx.query.status
      }),
      ...(ctx.query.queryPackageName === undefined ? {} : {
        queryPackageName: ctx.query.queryPackageName
      }),
      ...(ctx.query.clientBatchCode === undefined ? {} : {
        clientBatchCode: ctx.query.clientBatchCode
      })
    }, {
      actor
    }));
  });
  router.get('/v1/delivery-batches/:batchId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    json(ctx, 200, await repository.getDeliveryBatch(ctx.params.batchId, {
      actor
    }));
  });
  router.post('/v1/delivery-batches/:batchId/confirm', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    if (typeof repository.confirmDeliveryBatch !== 'function') {
      throw new ControlPlaneConflictError('FINAL_DELIVERY_UNAVAILABLE', '中心服务尚未支持确认交付，请升级后重试');
    }
    await assertCurrentActorIdentity(repository, actor);
    json(ctx, 200, await repository.confirmDeliveryBatch(ctx.params.batchId, {
      actor
    }));
  });
  router.post('/v1/delivery-pool/previews', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const controller = new AbortController();
    const cancel = () => controller.abort(new DOMException('delivery preview client disconnected', 'AbortError'));
    ctx.req.once('aborted', cancel);
    try {
      json(ctx, 200, await publishDeliveryPreviews({
        repository,
        storageRoot,
        previewClient,
        input: requireJson(ctx),
        actor,
        signal: controller.signal
      }));
    } finally {
      ctx.req.off('aborted', cancel);
    }
  });
}
