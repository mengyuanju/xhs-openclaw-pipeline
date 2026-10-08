import { json, requestActor, HttpError, userVisibleTaskList, assertCurrentActorIdentity, requireJson } from './http-route-common.mjs';
import { readTaskDataReport, exportTaskDataReportCsv, readTaskDataReportTask } from './task-data-report.mjs';
import { createTaskReportExport, listTaskReportExports, taskReportExportStatus, readyTaskReportExport } from './task-report-exports.mjs';
import { createReadStream } from 'node:fs';
import { listSavedTaskReportQueries, createSavedTaskReportQuery, updateSavedTaskReportQuery, deleteSavedTaskReportQuery } from './saved-task-report-queries.mjs';
import { loadWorkModePage } from './work-mode.mjs';
export function installReportsRoutes({
  reportExportWorker,
  router,
  repository,
  storageRoot
}) {
  router.get('/v1/personal-workspace/qa-activities', async ctx => {
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await repository.personalQualityActivity(requestActor(ctx), ctx.query));
  });
  for (const kind of ['statistics', 'tasks']) router.get(`/v1/personal-workspace/${kind}`, async ctx => {
    const actor = requestActor(ctx);
    if (actor.role === 'USER' && ctx.query.queryPackageName) throw new HttpError(403, 'FORBIDDEN', '标注不能按词包名称筛选任务');
    const result = await repository.personalWorkspace(actor, ctx.query, kind === 'statistics');
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, kind === 'tasks' && actor.role === 'USER' ? userVisibleTaskList(result) : result);
  });
  router.get('/v1/admin/operator-performance', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    const {
      refresh,
      ...filters
    } = ctx.query;
    if (refresh !== undefined && !['true', 'false'].includes(refresh)) throw new TypeError('refresh must be true or false');
    json(ctx, 200, await repository.operatorPerformance(actor, filters, {
      forceRefresh: refresh === 'true'
    }));
  });
  router.get('/v1/admin/annotation-job-report', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    const {
      refresh,
      ...filters
    } = ctx.query;
    if (refresh !== undefined && !['true', 'false'].includes(refresh)) throw new TypeError('refresh must be true or false');
    json(ctx, 200, await repository.operatorPerformance(actor, {
      ...filters,
      activity: 'PRODUCTION',
      stage: ''
    }, {
      kind: 'annotationJobReport',
      forceRefresh: refresh === 'true'
    }));
  });
  router.post('/v1/admin/task-data-report/query', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertCurrentActorIdentity(repository, actor);
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await readTaskDataReport(repository.pool, actor, requireJson(ctx)));
  });
  router.post('/v1/admin/task-data-report/export', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertCurrentActorIdentity(repository, actor);
    const csv = await exportTaskDataReportCsv(repository.pool, actor, requireJson(ctx));
    ctx.set('Cache-Control', 'private, no-store');
    ctx.set('Content-Disposition', 'attachment; filename="task-data-report.csv"');
    ctx.type = 'text/csv; charset=utf-8';
    ctx.body = csv;
  });
  router.post('/v1/admin/task-data-report/exports', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertCurrentActorIdentity(repository, actor);
    const job = await createTaskReportExport(repository.pool, actor, requireJson(ctx));
    json(ctx, 202, job);
    void reportExportWorker?.wake();
  });
  router.get('/v1/admin/task-data-report/exports', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await listTaskReportExports(repository.pool, actor));
  });
  router.get('/v1/admin/task-data-report/exports/:id', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await taskReportExportStatus(repository.pool, actor, ctx.params.id));
  });
  router.get('/v1/admin/task-data-report/exports/:id/download', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertCurrentActorIdentity(repository, actor);
    const file = await readyTaskReportExport(repository.pool, actor, ctx.params.id, storageRoot);
    await assertCurrentActorIdentity(repository, actor);
    ctx.set('Cache-Control', 'private, no-store');
    ctx.set('Content-Disposition', 'attachment; filename="task-data-report.csv"');
    ctx.type = 'text/csv; charset=utf-8';
    ctx.length = file.size;
    ctx.body = createReadStream(file.path);
  });
  router.get('/v1/admin/task-data-report/saved-queries', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await listSavedTaskReportQueries(repository.pool, actor));
  });
  router.post('/v1/admin/task-data-report/saved-queries', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 201, await createSavedTaskReportQuery(repository.pool, actor, requireJson(ctx)));
  });
  router.patch('/v1/admin/task-data-report/saved-queries/:id', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await updateSavedTaskReportQuery(repository.pool, actor, ctx.params.id, requireJson(ctx)));
  });
  router.delete('/v1/admin/task-data-report/saved-queries/:id', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await deleteSavedTaskReportQuery(repository.pool, actor, ctx.params.id));
  });
  router.get('/v1/admin/task-data-report/tasks/:taskId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertCurrentActorIdentity(repository, actor);
    const report = await readTaskDataReportTask(repository.pool, actor, ctx.params.taskId);
    if (!report) throw new HttpError(404, 'TASK_NOT_FOUND', '任务不存在');
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, report);
  });
  router.get('/v1/admin/operator-performance/tasks', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const {
      currentPage,
      currentPageSize,
      ...filters
    } = ctx.query;
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await repository.operatorPerformance(actor, filters, {
      kind: 'detail',
      currentPage: currentPage === undefined ? undefined : Number(currentPage),
      currentPageSize: currentPageSize === undefined ? undefined : Number(currentPageSize)
    }));
  });
  router.get('/v1/admin/operator-performance/export', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const result = await repository.operatorPerformance(actor, ctx.query, {
      kind: 'export'
    });
    ctx.set('Cache-Control', 'private, no-store');
    ctx.set('Content-Disposition', 'attachment; filename="operator-performance.csv"');
    ctx.type = 'text/csv; charset=utf-8';
    ctx.body = result.csv;
  });
  for (const suffix of ['', '/tasks']) router.get(`/v1/admin/operator-performance/:accountId${suffix}`, async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const {
      currentPage,
      currentPageSize,
      ...filters
    } = ctx.query;
    ctx.set('Cache-Control', 'private, no-store');
    json(ctx, 200, await repository.operatorPerformance(actor, filters, {
      kind: 'detail',
      accountId: ctx.params.accountId,
      currentPage: currentPage === undefined ? undefined : Number(currentPage),
      currentPageSize: currentPageSize === undefined ? undefined : Number(currentPageSize)
    }));
  });
  router.get('/v1/task-completions', async ctx => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.listPersonalTaskCompletions({
      accountId: actor.userId,
      username: actor.username,
      from: ctx.query.from,
      to: ctx.query.to
    }));
  });
  router.get('/v1/work-mode/items', async ctx => {
    const actor = requestActor(ctx);
    json(ctx, 200, await loadWorkModePage(repository, {
      kind: ctx.query.kind,
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      itemId: ctx.query.itemId,
      sampleKind: ctx.query.sampleKind
    }, actor));
  });
}
