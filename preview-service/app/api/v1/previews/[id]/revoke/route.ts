import { ApiError } from '@/lib/preview-contract';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';
import { revokePreview } from '@/lib/server/preview-repository';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        id,
      )
    ) {
      throw new ApiError('预览记录不存在。', 404, 'NOT_FOUND');
    }

    const result = await revokePreview(id);
    if (result.outcome === 'not-found') {
      throw new ApiError('预览记录不存在。', 404, 'NOT_FOUND');
    }

    return jsonResponse({
      status: 'REVOKED',
      changed: result.outcome === 'revoked',
      revokedAt: result.revokedAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
