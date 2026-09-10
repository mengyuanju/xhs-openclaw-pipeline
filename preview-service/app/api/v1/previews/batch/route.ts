import {
  auditAuthAction,
  requireApiKey,
  type ApiKeyAuthContext,
} from '@/lib/server/auth';
import { errorResponse } from '@/lib/server/http';
import { createBatchPreviewResponse } from '@/lib/server/preview-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let actor: ApiKeyAuthContext | null = null;
  try {
    actor = await requireApiKey(request, 'preview:create');
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
