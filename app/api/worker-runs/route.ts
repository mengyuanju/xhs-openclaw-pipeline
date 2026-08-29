import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import {
  MAX_TASK_CONCURRENCY,
  MAX_WEB_WORKER_TASKS,
  webWorkerLauncher,
  WorkerRunConflictError,
} from '../../../src/admin/web-worker-launcher.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const workerRunSchema = z.object({
  max: z.number().int().min(1).max(MAX_WEB_WORKER_TASKS),
  confirmation: z.literal('LIVE_MODEL_COST_ACCEPTED'),
}).strict();

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, workerRunSchema);
    const stats = withAdminStore((store: any) => store.getDashboardStats());
    if (stats.tasks.processing > 0) {
      throw new ApiError(409, 'WORKER_ALREADY_RUNNING', '已有任务正在生成，请稍后再试');
    }
    if (stats.tasks.pending < 1) {
      throw new ApiError(409, 'NO_PENDING_TASKS', '当前队列没有待生成任务');
    }
    const max = Math.min(input.max, stats.tasks.pending, MAX_WEB_WORKER_TASKS);
    try {
      const run = await webWorkerLauncher.start({ max, concurrency: MAX_TASK_CONCURRENCY });
      return ok({ ...run, mode: 'LIVE' }, { status: 202 });
    } catch (error) {
      if (error instanceof WorkerRunConflictError) {
        throw new ApiError(409, 'WORKER_ALREADY_RUNNING', error.message);
      }
      throw error;
    }
  });
}
