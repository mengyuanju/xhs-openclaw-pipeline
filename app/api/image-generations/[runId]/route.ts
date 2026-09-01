import { apiHandler, ok } from '../../_lib';
import { ApiError } from '../../../../src/admin/http.mjs';
import { adminOutputRoot } from '../../../../src/admin/runtime.mjs';
import { readStandaloneImageProgress } from '../../../../src/standalone-image-generation.mjs';

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
      return ok(progress, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '独立图片运行不存在或尚未开始');
    }
  });
}
