import {
  auditAuthAction,
  requireApiKey,
  type ApiKeyAuthContext,
} from '@/lib/server/auth';
import { errorResponse } from '@/lib/server/http';
import {
  createPreviewResponse,
  listPreviewsResponse,
} from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireApiKey(request, 'preview:list');
    return await listPreviewsResponse();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  let actor: ApiKeyAuthContext | null = null;
  try {
    actor = await requireApiKey(request, 'preview:create');
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
