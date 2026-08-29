import { apiHandler } from '../../../_lib';
import { ApiError, notFound, parsePositiveId } from '../../../../../src/admin/http.mjs';
import { adminAssetRoot, withAdminStore } from '../../../../../src/admin/runtime.mjs';
import {
  buildTaskExportArchive,
  TaskExportError,
} from '../../../../../src/admin/task-export.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const id = parsePositiveId((await context.params).id);
    const task = withAdminStore((store: any) => store.getTask(id));
    if (!task) notFound('任务不存在');

    let archive;
    try {
      archive = await buildTaskExportArchive({ task, assetRoot: adminAssetRoot() });
    } catch (error) {
      if (error instanceof TaskExportError && error.code === 'NOT_READY') {
        throw new ApiError(409, 'EXPORT_NOT_READY', error.message);
      }
      if (error instanceof TaskExportError && error.code === 'ASSET_MISSING') {
        throw new ApiError(404, 'EXPORT_ASSET_MISSING', error.message);
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
