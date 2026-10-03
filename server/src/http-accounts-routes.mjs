import { requireJson, HttpError, json, requestActor, requiredAccountId, readAuthenticationUser } from './http-route-common.mjs';
export function installAccountsRoutes({
  passwordLimiter,
  currentPasswordLimiter,
  assertPasswordAttemptAllowed,
  router,
  repository
}) {
  router.post('/v1/auth/login', async ctx => {
    const body = requireJson(ctx);
    const user = await repository.authenticateUser(body.username, body.password);
    if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', '登录失败');
    json(ctx, 200, user);
  });
  router.get('/v1/users', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listUsers({
      status: ctx.query.status || null
    }));
  });
  router.post('/v1/users', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await repository.createUser(requireJson(ctx), {
      actor
    }));
  });
  router.patch('/v1/users/:userId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateUser(ctx.params.userId, {
      ...requireJson(ctx),
      actorUsername: actor.username
    }, {
      actor
    }));
  });
  router.delete('/v1/users/:userId', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.deleteUser(ctx.params.userId, {
      ...requireJson(ctx),
      actorUsername: actor.username
    }));
  });
  router.post('/v1/users/:userId/reset-password', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.resetUserPassword(ctx.params.userId));
  });
  router.get('/v1/auto-assignment', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getAutoAssignmentOverview());
  });
  router.patch('/v1/auto-assignment/settings', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.updateAutoAssignmentSettings({
      enabled: body.enabled,
      mode: body.mode,
      expectedVersion: body.expectedVersion,
      actor
    }));
  });
  router.put('/v1/auto-assignment/workers/:username', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.putAutoAssignmentWorker(ctx.params.username, {
      status: body.status,
      assignmentLimit: body.assignmentLimit,
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor
    }));
  });
  router.delete('/v1/auto-assignment/workers/:username', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.removeAutoAssignmentWorker(ctx.params.username, {
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor
    }));
  });
  router.post('/v1/auto-assignment/workers/:username/allocate', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 200, await repository.allocateAutoAssignmentWorker(ctx.params.username, {
      expectedVersion: body.expectedVersion,
      accountId: requiredAccountId(body.accountId),
      actor
    }));
  });
  router.get('/v1/profile', async ctx => {
    const actor = requestActor(ctx);
    const readUser = repository.getUserByIdentity ?? repository.getUserByUsername;
    const user = repository.getUserByIdentity ? await readAuthenticationUser(repository, readUser, actor) : await readAuthenticationUser(repository, readUser, actor.username);
    if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'SESSION_STALE', '账号状态已变化，请重新登录');
    json(ctx, 200, user);
  });
  router.patch('/v1/profile', async ctx => {
    const actor = requestActor(ctx);
    json(ctx, 200, await repository.updateOwnProfile(actor, requireJson(ctx)));
  });
  router.post('/v1/profile/password', async ctx => {
    const actor = requestActor(ctx);
    const limiter = currentPasswordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.changeOwnPassword(actor, requireJson(ctx));
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'CURRENT_PASSWORD_INVALID') limiter.recordFailure();
      throw error;
    }
  });
  router.post('/v1/profile/deletion-password', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    const limiter = passwordLimiter(actor.userId);
    assertPasswordAttemptAllowed(ctx, limiter);
    try {
      const result = await repository.setOwnDeletionPassword(actor, requireJson(ctx));
      limiter.reset();
      json(ctx, 200, result);
    } catch (error) {
      if (error?.code === 'CURRENT_PASSWORD_INVALID') limiter.recordFailure();else limiter.reset();
      throw error;
    }
  });
}
