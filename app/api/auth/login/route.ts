import { ApiError } from '@/lib/preview-contract';
import { createSessionCookie, loginAdmin } from '@/lib/server/auth';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request, { requireOrigin: true });
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new ApiError('登录请求格式不正确。', 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const body = await readLoginBody(request);
    const session = await loginAdmin(request, body.username, body.password);
    const response = jsonResponse({
      user: { username: session.username },
      expiresAt: session.expiresAt,
    });
    response.headers.append(
      'Set-Cookie',
      createSessionCookie(request, session.token),
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

async function readLoginBody(request: Request) {
  try {
    return (await request.json()) as { username?: unknown; password?: unknown };
  } catch {
    throw new ApiError('登录请求格式不正确。');
  }
}
