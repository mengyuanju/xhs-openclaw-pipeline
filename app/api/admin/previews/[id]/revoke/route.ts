import {
  auditAuthAction,
  requireAdminSession,
  type AdminAuthContext,
} from '@/lib/server/auth';
import { assertSameOrigin, errorResponse } from '@/lib/server/http';
import { revokePreviewResponse } from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let actor: AdminAuthContext | null = null;
  let id: string | null = null;
  try {
    assertSameOrigin(request, { requireOrigin: true });
    actor = await requireAdminSession(request);
    ({ id } = await context.params);
    const response = await revokePreviewResponse(id);
    await auditAuthAction({
      actor,
      action: 'preview.revoke',
      targetId: id,
      outcome: 'success',
    });
    return response;
  } catch (error) {
    if (actor) {
      await auditAuthAction({
        actor,
        action: 'preview.revoke',
        targetId: id,
        outcome: 'failure',
      });
    }
    return errorResponse(error);
  }
}
