import { requestActor, assertTaskAccess, json, requireJson, HttpError, assignmentTarget, userVisibleTaskList, normalizedBatchTaskIds, applyBatchTaskAction, streamPreparedArchive, safeStoragePath, assertCurrentActorIdentity, userVisibleTask } from './http-route-common.mjs';
import { ControlPlaneConflictError, normalizeTaskCreatorRole, ControlPlaneNotFoundError } from './domain.mjs';
import { applyBatchPermanentDeletion, quarantineTaskStorage, removeQuarantine, scheduleQuarantineCleanup } from './http-task-storage.mjs';
import { loadReadyDeliveryTask, assertDeliveryBindingsReady, assertReadyDeliveryTask } from './delivery-export.mjs';
import { relative } from 'node:path';
import { createReadStream } from 'node:fs';
import { archiveFileName } from './task-archive.mjs';
import { UNASSIGNED_CREATOR_COPY_CONTROL_STATES } from './task-assignment-domain.mjs';
export function installTasksRoutes({
  archivePreparation,
  sweepReferences,
  passwordLimiter,
  assertPasswordAttemptAllowed,
  router,
  repository,
  storageRoot
}) {
  router.get('/v1/tasks/:taskId/model-calls', async ctx => {
    requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const result = await repository.listModelCalls(ctx.params.taskId, {
      limit: ctx.query.limit,
      offset: ctx.query.offset
    });
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, result);
  });
  router.get('/v1/tasks/:taskId/model-calls/:callId', async ctx => {
    requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const result = await repository.getModelCall(ctx.params.taskId, ctx.params.callId);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, result);
  });
  router.post('/v1/tasks', async ctx => {
    // Ordinary workers must enter production through an assigned Query package
    // after screening. Keeping the legacy direct creator admin-only prevents a
    // disabled import switch from being bypassed with raw task payloads.
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const {
      skipCopyReview = false
    } = body;
    if (typeof skipCopyReview !== 'boolean') throw new TypeError('skipCopyReview must be a boolean');
    if (skipCopyReview) requestActor(ctx, ['ADMIN']);
    if (actor.role !== 'ADMIN' && (Object.hasOwn(body, 'assignedToUserId') || Object.hasOwn(body, 'assignedToAccountId'))) {
      throw new HttpError(403, 'FORBIDDEN', '仅管理员可以指定任务负责人');
    }
    let target = actor.role === 'ADMIN' ? assignmentTarget(body) : {
      assignedToUserId: null,
      assignedToAccountId: null
    };
    if (skipCopyReview && target.assignedToUserId === null) {
      throw new ControlPlaneConflictError('SKIP_COPY_REVIEW_ASSIGNEE_REQUIRED', '免人工文案审核的任务必须在创建时明确指定负责人');
    }
    if (!skipCopyReview && target.assignedToUserId !== null) {
      throw new ControlPlaneConflictError('TASK_NOT_READY_FOR_ASSIGNMENT', '普通任务将在文案生成完成后分配审核负责人');
    }
    if (!skipCopyReview) target = {
      assignedToUserId: null,
      assignedToAccountId: null
    };
    json(ctx, 201, await repository.createTasks({
      nodeId: body.nodeId,
      createdByUserId: actor.username,
      actor,
      ...target,
      assignmentSource: target.assignedToUserId === null ? null : 'MANUAL',
      skipCopyReview,
      tasks: body.tasks
    }));
  });
  router.get('/v1/tasks', async ctx => {
    const actor = requestActor(ctx);
    if (actor.role === 'USER' && ctx.query.queryPackageName !== undefined) {
      throw new HttpError(403, 'FORBIDDEN', '标注不能按词包名称筛选任务');
    }
    const personal = ctx.query.personal === 'true';
    if (ctx.query.personal !== undefined && !['true', 'false'].includes(ctx.query.personal)) {
      throw new TypeError('personal must be true or false');
    }
    const personalScope = String(ctx.query.personalScope ?? 'ALL').toUpperCase();
    if (!['ALL', 'ASSIGNED', 'CREATED'].includes(personalScope)) {
      throw new TypeError('personalScope must be ALL, ASSIGNED or CREATED');
    }
    if (!personal && ctx.query.personalScope !== undefined) {
      throw new TypeError('personalScope requires personal=true');
    }
    if (ctx.query.lastPage !== undefined && !['true', 'false'].includes(ctx.query.lastPage)) {
      throw new TypeError('lastPage must be true or false');
    }
    if (ctx.query.refreshTotal !== undefined && !['true', 'false'].includes(ctx.query.refreshTotal)) {
      throw new TypeError('refreshTotal must be true or false');
    }
    if (ctx.query.copyQaReturned !== undefined && !['true', 'false'].includes(ctx.query.copyQaReturned)) {
      throw new TypeError('copyQaReturned must be true or false');
    }
    if (personal && ['assignedToUserId', 'assignedToAccountId', 'unassigned', 'createdByUserId', 'createdByAccountId', 'nodeId'].some(key => ctx.query[key] !== undefined)) {
      throw new TypeError('personal task scope cannot be combined with ownership filters');
    }
    if (ctx.query.createdByRole !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.createdByAccountId !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.assignedToAccountId !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.attention !== undefined) requestActor(ctx, ['ADMIN']);
    if (ctx.query.createdDateFrom !== undefined || ctx.query.createdDateTo !== undefined) {
      requestActor(ctx, ['ADMIN']);
    }
    if (ctx.query.unassigned !== undefined || ctx.query.assignedToUserId !== undefined && actor.role !== 'ADMIN' && ctx.query.assignedToUserId !== actor.username) {
      requestActor(ctx, ['ADMIN']);
    }
    const createdByRole = normalizeTaskCreatorRole(ctx.query.createdByRole);
    const result = await repository.listTasks({
      ...(actor.role === 'REVIEWER' ? {
        reviewAssignedToAccountId: actor.userId
      } : {}),
      state: ctx.query.state,
      states: ctx.query.states,
      nodeId: ctx.query.nodeId,
      createdByUserId: personalScope === 'CREATED' ? actor.username : ctx.query.createdByUserId,
      createdByAccountId: personalScope === 'CREATED' ? actor.userId : ctx.query.createdByAccountId,
      assignedToUserId: personalScope === 'ASSIGNED' ? actor.username : personal ? undefined : actor.role === 'USER' ? actor.username : ctx.query.assignedToUserId,
      assignedToAccountId: personalScope === 'ASSIGNED' ? actor.userId : personal ? undefined : actor.role === 'USER' ? actor.userId : ctx.query.assignedToAccountId,
      visibleToUserId: personal && personalScope === 'ALL' ? actor.username : undefined,
      visibleToAccountId: personal && personalScope === 'ALL' ? actor.userId : undefined,
      unassignedOnly: !personal && actor.role === 'ADMIN' && ctx.query.unassigned === 'true',
      excludeUnassigned: actor.role !== 'ADMIN' && !personal,
      ...(createdByRole !== null ? {
        createdByRole
      } : {}),
      ...(ctx.query.createdDateFrom !== undefined ? {
        createdDateFrom: ctx.query.createdDateFrom
      } : {}),
      ...(ctx.query.createdDateTo !== undefined ? {
        createdDateTo: ctx.query.createdDateTo
      } : {}),
      ...(ctx.query.taskId !== undefined ? {
        taskId: ctx.query.taskId
      } : {}),
      query: ctx.query.query,
      queryPackageName: ctx.query.queryPackageName,
      deduplicateQuery: ctx.query.deduplicateQuery === 'true',
      ...(ctx.query.attention !== undefined ? {
        attention: ctx.query.attention
      } : {}),
      ...(ctx.query.priorityMode !== undefined ? {
        priorityMode: ctx.query.priorityMode
      } : {}),
      ...(ctx.query.sortBy !== undefined ? {
        sortBy: ctx.query.sortBy
      } : {}),
      ...(ctx.query.sortOrder !== undefined ? {
        sortOrder: ctx.query.sortOrder
      } : {}),
      limit: ctx.query.limit,
      offset: ctx.query.offset,
      cursor: ctx.query.cursor,
      lastPage: ctx.query.lastPage === 'true',
      includeTotal: ctx.query.includeTotal === 'true',
      refreshTotal: ctx.query.refreshTotal === 'true',
      countCacheIdentity: actor,
      excludeActiveBlindQa: actor.role === 'REVIEWER',
      ...(ctx.query.copyQaReturned === 'true' ? {
        copyQaReturnedOnly: true
      } : {})
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTaskList(result) : result);
  });
  router.post('/v1/tasks/duplicate-query-discard-preview', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.previewDuplicateQueryDiscard(requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/duplicate-query-discard', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.discardDuplicateQueries(requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/task-views', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listSavedTaskViews(actor.username));
  });
  router.post('/v1/task-views', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.saveTaskView(actor.username, requireJson(ctx), {
      actor
    }));
  });
  router.delete('/v1/task-views/:viewId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.deleteSavedTaskView(actor.username, ctx.params.viewId, {
      actor
    }));
  });
  router.post('/v1/tasks/priority-scope', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getPriorityScope(requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/priority', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.setTaskPriority(requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/tasks/:taskId/priority-audit', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getTaskPriorityAudit(ctx.params.taskId, {
      actor
    }));
  });
  router.post('/v1/tasks/batch-actions', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 100);
    json(ctx, 200, await applyBatchTaskAction(repository, taskIds, String(body.action ?? ''), actor));
  });
  router.post('/v1/tasks/batch-assignee', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 100);
    const target = assignmentTarget(body);
    json(ctx, 200, await repository.assignTasks(taskIds, {
      ...target,
      actor,
      reason: body.reason
    }));
  });
  router.post('/v1/tasks/batch-permanent-delete', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const taskIds = normalizedBatchTaskIds(body.taskIds, 20);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await applyBatchPermanentDeletion(repository, storageRoot, taskIds, actor, body.deletionPassword);
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();else limiter.reset();
      throw error;
    }
  });
  router.post('/v1/tasks/batch-archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const taskIds = normalizedBatchTaskIds(requireJson(ctx).taskIds, 20);
    const snapshots = await Promise.all(taskIds.map(taskId => loadReadyDeliveryTask(repository, taskId)));
    const tasks = snapshots.map(snapshot => snapshot.task);
    await streamPreparedArchive(ctx, signal => archivePreparation.prepareBatch(tasks, async (task, assetId) => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return {
        ...asset,
        content: createReadStream(path, {
          signal
        })
      };
    }, {
      signal
    }), async () => {
      await assertDeliveryBindingsReady(repository, snapshots.map(snapshot => snapshot.binding));
      await assertCurrentActorIdentity(repository, actor);
    }, `attachment; filename="task-resources-batch.zip"; filename*=UTF-8''${encodeURIComponent('批量作业资源.zip')}`);
  });
  router.get('/v1/task-counts', async ctx => {
    json(ctx, 200, await repository.taskCounts({
      nodeId: ctx.query.nodeId
    }));
  });
  router.get('/v1/tasks/:taskId/copy-review-drafts', async ctx => {
    const {
      actor
    } = await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, await repository.listCopyReviewDrafts(ctx.params.taskId, {
      actor
    }));
  });
  router.post('/v1/tasks/:taskId/copy-review-drafts', async ctx => {
    const {
      actor
    } = await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const result = await repository.saveCopyReviewDraft(ctx.params.taskId, requireJson(ctx), {
      actor
    });
    json(ctx, result.created ? 201 : 200, result);
  });
  router.post('/v1/tasks/:taskId/regenerate-image-plan', async ctx => {
    const {
      actor
    } = await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const result = await repository.createImagePlanRegeneration(ctx.params.taskId, requireJson(ctx), {
      actor
    });
    json(ctx, result.created ? 202 : 200, result);
  });
  router.get('/v1/tasks/:taskId/regenerate-image-plan/:jobId', async ctx => {
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    if (ctx.query.metadata !== undefined && !['true', 'false'].includes(ctx.query.metadata)) throw new TypeError('metadata must be true or false');
    const result = await repository.getImagePlanRegeneration(ctx.params.taskId, ctx.params.jobId, {
      metadataOnly: ctx.query.metadata === 'true'
    });
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, result);
  });
  router.get('/v1/tasks/:taskId', async ctx => {
    const historyMode = ctx.query.historyMode ?? 'all';
    if (!['all', 'current'].includes(historyMode)) throw new TypeError('task history mode is invalid');
    const {
      task,
      actor
    } = await assertTaskAccess(ctx, repository, {
      allowCreatorRead: true,
      historyMode
    });
    // Execution snapshots include internal prompts and model configuration.
    const {
      executions,
      ...reviewableTask
    } = task;
    json(ctx, 200, actor.role === 'ADMIN' ? task : actor.role === 'USER' ? userVisibleTask(reviewableTask, {
      includeXhsSearch: true
    }) : reviewableTask);
  });
  router.get('/v1/tasks/:taskId/history/:kind', async ctx => {
    if (ctx.params.kind === 'executions') requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      allowCreatorRead: true,
      summaryOnly: true
    });
    const page = await repository.listTaskHistory(ctx.params.taskId, {
      kind: ctx.params.kind,
      limit: ctx.query.limit,
      cursor: ctx.query.cursor
    });
    await assertTaskAccess(ctx, repository, {
      allowCreatorRead: true,
      summaryOnly: true
    });
    json(ctx, 200, page);
  });
  router.get('/v1/tasks/:taskId/history/:kind/:itemId', async ctx => {
    if (ctx.params.kind === 'executions') requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      allowCreatorRead: true,
      summaryOnly: true
    });
    const detail = await repository.getTaskHistoryItem(ctx.params.taskId, {
      kind: ctx.params.kind,
      itemId: ctx.params.itemId
    });
    if (!detail) throw new ControlPlaneNotFoundError('task history item not found');
    await assertTaskAccess(ctx, repository, {
      allowCreatorRead: true,
      summaryOnly: true
    });
    json(ctx, 200, detail);
  });
  router.patch('/v1/tasks/:taskId/assignee', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    const target = assignmentTarget(body);
    json(ctx, 200, await repository.assignTask(ctx.params.taskId, {
      ...target,
      actor,
      reason: body.reason
    }));
  });
  router.head('/v1/tasks/:taskId/archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    const {
      task
    } = await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN'
    });
    await assertReadyDeliveryTask(repository, task);
    ctx.status = 200;
    ctx.type = 'application/zip';
    ctx.set('Content-Disposition', `attachment; filename="task-${task.id}-resources.zip"; filename*=UTF-8''${encodeURIComponent(archiveFileName(task))}`);
  });
  router.get('/v1/tasks/:taskId/archive', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      ownerOnly: actor.role !== 'ADMIN',
      summaryOnly: true
    });
    const {
      task,
      binding
    } = await loadReadyDeliveryTask(repository, ctx.params.taskId);
    await streamPreparedArchive(ctx, signal => archivePreparation.prepareTask(task, async assetId => {
      const asset = await repository.getAsset(assetId);
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      return {
        ...asset,
        content: createReadStream(path, {
          signal
        })
      };
    }, {
      signal
    }), async () => {
      await assertDeliveryBindingsReady(repository, [binding]);
      await assertCurrentActorIdentity(repository, actor);
      if (actor.role === 'USER') await assertTaskAccess(ctx, repository, {
        ownerOnly: true,
        summaryOnly: true
      });
    }, `attachment; filename="task-${task.id}-resources.zip"; filename*=UTF-8''${encodeURIComponent(archiveFileName(task))}`);
  });
  router.post('/v1/tasks/:taskId/approve-copy', async ctx => {
    const access = await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const task = await repository.approveCopy(ctx.params.taskId, requireJson(ctx), {
      actor: access.actor
    });
    json(ctx, 200, access.actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/discard-returned-copy', async ctx => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    const task = await repository.discardReturnedCopy(ctx.params.taskId, requireJson(ctx), {
      actor
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/admin-direct-copy-qa', async ctx => {
    throw new HttpError(410, 'LEGACY_COPY_QA_RETIRED', '旧文案质检入口已停用，请使用新质检批次');
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository);
    json(ctx, 200, await repository.adminDirectApproveCopyQa(ctx.params.taskId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/:taskId/submit-image-self-review', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: true
    });
    const result = await repository.submitImageSelfReview(ctx.params.taskId, requireJson(ctx), {
      actor
    });
    json(ctx, 200, result);
    void sweepReferences();
  });
  router.post('/v1/tasks/:taskId/review-images', async () => {
    throw new HttpError(410, 'IMAGE_REVIEW_MOVED', '图片初审已改由任务负责人提交；图片质检请在图片质检池处理');
  });
  router.post('/v1/tasks/:taskId/discard-images', async ctx => {
    const actor = requestActor(ctx, ['ADMIN', 'USER']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: true
    });
    json(ctx, 200, await repository.discardTaskImages(ctx.params.taskId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/:taskId/retry', async ctx => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN',
      allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES
    });
    const task = await repository.retryTask(ctx.params.taskId, {
      ...requireJson(ctx),
      actor
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/retry-image', async ctx => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    const task = await repository.requeueImageTask(ctx.params.taskId, {
      actor
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/image-revisions', async ctx => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN'
    });
    const task = await repository.reviseImages(ctx.params.taskId, requireJson(ctx), actor.username, actor.role, actor);
    json(ctx, 201, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/cancel', async ctx => {
    const actor = requestActor(ctx);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true,
      ownerOnly: actor.role !== 'ADMIN',
      allowUnassignedCreatorStates: UNASSIGNED_CREATOR_COPY_CONTROL_STATES
    });
    const task = await repository.cancelTask(ctx.params.taskId, {
      actor
    });
    json(ctx, 200, actor.role === 'USER' ? userVisibleTask(task) : task);
  });
  router.post('/v1/tasks/:taskId/restore', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, await repository.restoreCancelledTask(ctx.params.taskId, requireJson(ctx), {
      actor
    }));
  });
  router.post('/v1/tasks/:taskId/requeue', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    json(ctx, 200, await repository.requeueCancelledTask(ctx.params.taskId, {
      actor
    }));
  });
  router.delete('/v1/tasks/:taskId/permanent', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    await assertTaskAccess(ctx, repository, {
      summaryOnly: true
    });
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    let quarantine = null;
    let deleted;
    try {
      deleted = await repository.permanentlyDeleteTask(ctx.params.taskId, {
        actor,
        deletionPassword: requireJson(ctx).deletionPassword,
        beforeDelete: async taskId => {
          quarantine = await quarantineTaskStorage(storageRoot, taskId);
        }
      });
      limiter.reset();
    } catch (error) {
      if (error?.code === 'DELETION_PASSWORD_INVALID') limiter.recordFailure();else limiter.reset();
      if (quarantine) {
        try {
          await quarantine.restore();
        } catch (restoreError) {
          console.error('failed to restore quarantined task files', restoreError);
        }
      }
      throw error;
    }
    let cleaned = true;
    if (quarantine) {
      await quarantine.markCommitted().catch(error => console.error('failed to mark task deletion quarantine', error));
      cleaned = await removeQuarantine(quarantine.quarantineRoot);
      if (!cleaned) scheduleQuarantineCleanup(quarantine.quarantineRoot);
    }
    json(ctx, 200, {
      id: deleted.id,
      deleted: true,
      cleanupPending: !cleaned
    });
  });
}
