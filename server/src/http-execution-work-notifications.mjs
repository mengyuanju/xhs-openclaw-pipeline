import { EXECUTION_WORK_NOTIFICATIONS_VERSION, ExecutionWorkWaitError } from './execution-work-notifications.mjs';
import { HttpError, json, requireJson } from './http-route-common.mjs';

export function installExecutionWorkNotificationRoutes({ router, executionWorkNotifications }) {
  router.post('/v1/executions/work-notifications/wait', async ctx => {
    const controller = new AbortController();
    const disconnected = () => controller.abort(new DOMException('request disconnected', 'AbortError'));
    ctx.req.once('aborted', disconnected);
    ctx.res.once('close', disconnected);
    try {
      const result = await executionWorkNotifications.wait(requireJson(ctx), { signal: controller.signal });
      json(ctx, 200, result);
    } catch (error) {
      if (controller.signal.aborted) { ctx.respond = false; return; }
      if (error instanceof ExecutionWorkWaitError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    } finally {
      ctx.req.off('aborted', disconnected);
      ctx.res.off('close', disconnected);
    }
  });
}

export const executionWorkNotificationCapabilities = { executionWorkNotificationsVersion: EXECUTION_WORK_NOTIFICATIONS_VERSION };
