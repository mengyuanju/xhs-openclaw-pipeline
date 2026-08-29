import { z } from 'zod';

import { apiHandler, parseJson } from '../_lib';
import { ApiError, notFound } from '../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../src/admin/runtime.mjs';
import {
  buildTaskBatchExportArchive,
  MAX_BATCH_EXPORT_TASKS,
  TaskExportError,
} from '../../../src/admin/task-export.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const batchExportSchema = z.object({
  taskIds: z.array(z.number().int().positive())
    .min(1, '请至少选择 1 个任务')
    .max(MAX_BATCH_EXPORT_TASKS, `一次最多导出 ${MAX_BATCH_EXPORT_TASKS} 个任务`)
    .refine((taskIds) => new Set(taskIds).size === taskIds.length, '任务 ID 不能重复'),
}).strict();

export function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const { taskIds } = await parseJson(request, batchExportSchema, { maxBytes: 4 * 1024 });
    const tasks = withAdminStore((store: any) => taskIds.map((taskId) => {
      const task = store.getTask(taskId);
      if (!task) notFound(`任务 #${taskId} 不存在`);
      return task;
    }));

    let archive;
    try {
      archive = await buildTaskBatchExportArchive({ tasks, assetRoot: adminAssetRoot() });
    } catch (error) {
      if (error instanceof TaskExportError) {
        if (error.code === 'NOT_READY') {
          throw new ApiError(409, 'EXPORT_NOT_READY', error.message);
        }
        if (error.code === 'ASSET_MISSING') {
          throw new ApiError(404, 'EXPORT_ASSET_MISSING', error.message);
        }
        if (error.code === 'ASSET_TOO_LARGE' || error.code === 'BATCH_TOO_LARGE') {
          throw new ApiError(413, 'EXPORT_TOO_LARGE', error.message);
        }
        if (error.code === 'INVALID_BATCH') {
          throw new ApiError(400, 'INVALID_INPUT', error.message);
        }
      }
      throw error;
    }

    const body = Uint8Array.from(archive.buffer).buffer;
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(archive.buffer.byteLength),
        'Content-Disposition': `attachment; filename="${archive.fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
