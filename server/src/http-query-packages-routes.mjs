import { requestActor, json, requireJson, HttpError, readBody } from './http-route-common.mjs';
import { QUERY_PACKAGE_SPREADSHEET_BYTES, parseQueryPackageSpreadsheet } from './query-package-spreadsheet.mjs';
export function installQueryPackagesRoutes({
  passwordLimiter,
  assertPasswordAttemptAllowed,
  router,
  repository
}) {
  router.get('/v1/query-packages', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.listQueryPackages({
      limit: ctx.query.limit,
      offset: ctx.query.offset
    }, {
      actor
    }));
  });
  router.post('/v1/query-packages', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createQueryPackage(requireJson(ctx), {
      actor
    }));
  });
  router.put('/v1/query-packages/import-preview', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
    if (mediaType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请上传 .xlsx 工作簿');
    }
    const body = await readBody(ctx.req, QUERY_PACKAGE_SPREADSHEET_BYTES);
    json(ctx, 200, await parseQueryPackageSpreadsheet(body, {
      sheet: ctx.query.sheet,
      column: ctx.query.column
    }));
  });
  router.get('/v1/query-packages/:packageId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.getQueryPackage(ctx.params.packageId, {
      actor,
      itemPage: {
        limit: ctx.query.itemLimit,
        cursor: ctx.query.itemCursor,
        filter: ctx.query.itemFilter,
        search: ctx.query.itemSearch
      }
    }));
  });
  router.patch('/v1/query-packages/:packageId/assignee', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.assignQueryPackage(ctx.params.packageId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/query-packages/:packageId/item-assignment-summary', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getQueryPackageItemAssignmentSummary(ctx.params.packageId, {
      actor
    }));
  });
  router.put('/v1/query-packages/:packageId/item-assignments', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.assignQueryPackageItems(ctx.params.packageId, requireJson(ctx), {
      actor
    }));
  });
  router.put('/v1/query-packages/:packageId/screening', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'REVIEWER', 'USER']);
    json(ctx, 200, await repository.updateQueryPackageScreening(ctx.params.packageId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/query-packages/:packageId/production-batches', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createQueryPackageProductionBatch(ctx.params.packageId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/query-packages/:packageId/abandon', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.abandonQueryPackage(ctx.params.packageId, requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/query-packages/:packageId/permanent-delete-preview', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.previewPermanentQueryPackageDeletion(ctx.params.packageId, {
      actor
    }));
  });
  router.delete('/v1/query-packages/:packageId/permanent', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.permanentlyDeleteQueryPackage(ctx.params.packageId, requireJson(ctx), {
        actor
      });
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();else limiter.reset();
      throw error;
    }
  });
}
