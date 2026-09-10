import {
  auditAuthAction,
  requireApiKey,
  type ApiKeyAuthContext,
} from '@/lib/server/auth';
import { errorResponse } from '@/lib/server/http';
import { revokePreviewResponse } from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let actor: ApiKeyAuthContext | null = null;
  let id: string | null = null;
  try {
    actor = await requireApiKey(request, 'preview:revoke');
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
