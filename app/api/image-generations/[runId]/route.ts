import { apiHandler, ok } from '../../_lib';
import { ApiError } from '../../../../src/admin/http.mjs';
import { adminOutputRoot } from '../../../../src/admin/runtime.mjs';
import {
  cancelStandaloneImageRun,
  readStandaloneImageProgress,
} from '../../../../src/standalone-image-generation.mjs';
import { cancelActiveImageGeneration } from '../_runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return apiHandler(request, {}, async () => {
    const { runId } = await context.params;
    try {
      const progress = await readStandaloneImageProgress({
        outputRoot: adminOutputRoot(),
        runId,
      });
      if (progress.mode !== 'LIVE') {
        throw new Error('legacy non-Live runs are no longer available');
      }
      return ok(progress, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '独立图片运行不存在或尚未开始');
    }
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return apiHandler(request, { mutation: true }, async () => {
    const { runId } = await context.params;
    cancelActiveImageGeneration(runId);
    try {
      const progress = await cancelStandaloneImageRun({
        outputRoot: adminOutputRoot(),
        runId,
      });
      if (progress.mode !== 'LIVE') {
        throw new Error('legacy non-Live runs are no longer available');
      }
      return ok(progress, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '独立图片运行不存在或尚未开始');
    }
  });
}
