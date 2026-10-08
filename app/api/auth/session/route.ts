import { apiHandler } from '../../_lib';
import { readSessionConfig } from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { getSessionMetadata, readRequestSession } from '../../../../src/admin/session-renewal.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const response = await apiHandler(request, { auth: false }, () => {
    const config = readSessionConfig();
    if (!config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '会话密钥尚未配置');
    const session = readRequestSession(request, config.sessionSecret);
    if (!session) throw new ApiError(401, 'AUTH_REQUIRED', '登录已过期，请重新登录');
    return Response.json({ data: getSessionMetadata(session) });
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}
