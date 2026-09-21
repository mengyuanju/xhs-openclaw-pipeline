import { ApiError } from '@/lib/preview-contract';
import {
  auditAuthAction,
  requireAdminSession,
  revokeApiKey,
} from '@/lib/server/auth';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request, { requireOrigin: true });
    const actor = await requireAdminSession(request);
    const { id } = await context.params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        id,
      )
    ) {
      throw new ApiError('API 密钥不存在。', 404, 'NOT_FOUND');
    }
    const result = await revokeApiKey(id);
    if (result.outcome === 'not-found') {
      throw new ApiError('API 密钥不存在。', 404, 'NOT_FOUND');
    }
    await auditAuthAction({
      actor,
      action: 'api_key.revoke',
      targetId: id,
      outcome: 'success',
    });
    return jsonResponse({
      changed: result.outcome === 'revoked',
      revokedAt: result.revokedAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
