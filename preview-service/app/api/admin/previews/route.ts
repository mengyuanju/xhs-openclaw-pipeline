import {
  auditAuthAction,
  requireAdminSession,
  type AdminAuthContext,
} from '@/lib/server/auth';
import { assertSameOrigin, errorResponse } from '@/lib/server/http';
import {
  createPreviewResponse,
  listPreviewsResponse,
} from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireAdminSession(request);
    return await listPreviewsResponse();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  let actor: AdminAuthContext | null = null;
  try {
    assertSameOrigin(request, { requireOrigin: true });
    actor = await requireAdminSession(request);
    const response = await createPreviewResponse(request);
    await auditAuthAction({
      actor,
      action: 'preview.create',
      outcome: 'success',
    });
    return response;
  } catch (error) {
    if (actor) {
      await auditAuthAction({
        actor,
        action: 'preview.create',
        outcome: 'failure',
      });
    }
    return errorResponse(error);
  }
}
