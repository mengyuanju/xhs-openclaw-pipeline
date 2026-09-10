import {
  auditAuthAction,
  requireAdminSession,
  type AdminAuthContext,
} from '@/lib/server/auth';
import { assertSameOrigin, errorResponse } from '@/lib/server/http';
import { createBatchPreviewResponse } from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let actor: AdminAuthContext | null = null;
  try {
    assertSameOrigin(request, { requireOrigin: true });
    actor = await requireAdminSession(request);
    const response = await createBatchPreviewResponse(request);
    await auditAuthAction({
      actor,
      action: 'preview.batch_create',
      outcome: 'success',
    });
    return response;
  } catch (error) {
    if (actor) {
      await auditAuthAction({
        actor,
        action: 'preview.batch_create',
        outcome: 'failure',
      });
    }
    return errorResponse(error);
  }
}
