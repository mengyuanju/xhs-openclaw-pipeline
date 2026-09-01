import { apiHandler } from '../../../../_lib';
import { ApiError } from '../../../../../../src/admin/http.mjs';
import { adminOutputRoot } from '../../../../../../src/admin/runtime.mjs';
import { readStandaloneImageFile } from '../../../../../../src/standalone-image-generation.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; file: string }> },
) {
  return apiHandler(request, {}, async () => {
    const { runId, file } = await context.params;
    let image;
    try {
      image = await readStandaloneImageFile({
        outputRoot: adminOutputRoot(),
        runId,
        file,
      });
    } catch {
      throw new ApiError(404, 'NOT_FOUND', '独立图片不存在或尚未完成');
    }
    const body = Uint8Array.from(image.content).buffer;
    return new Response(body, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(image.content.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
