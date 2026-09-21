import { ApiError } from '@/lib/preview-contract';
import {
  auditAuthAction,
  createApiKey,
  listApiKeys,
  requireAdminSession,
} from '@/lib/server/auth';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireAdminSession(request);
    return jsonResponse({ keys: await listApiKeys() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request, { requireOrigin: true });
    const actor = await requireAdminSession(request);
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new ApiError('密钥请求格式不正确。', 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const body = await readCreateBody(request);
    const result = await createApiKey({
      name: body.name,
      scopes: body.scopes,
    });
    await auditAuthAction({
      actor,
      action: 'api_key.create',
      targetId: result.key.id,
      outcome: 'success',
    });
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

async function readCreateBody(request: Request) {
  try {
    return (await request.json()) as { name?: unknown; scopes?: unknown };
  } catch {
    throw new ApiError('密钥请求格式不正确。');
  }
}
