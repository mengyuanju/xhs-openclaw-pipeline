import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import { readSessionConfig, serializeAdminSessionCookie } from '../../../../src/admin/auth.mjs';
import { ApiError, assertRequestSize } from '../../../../src/admin/http.mjs';
import { readRequestSession } from '../../../../src/admin/session-renewal.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logoutSchema = z.object({
  expectedSessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u).optional(),
}).strict();

export async function POST(request: Request) {
  const response = await apiHandler(request, {
    mutation: true,
    auth: false,
  }, async () => {
    assertRequestSize(request, 1_024);
    const rawBody = await request.clone().text();
    if (new TextEncoder().encode(rawBody).byteLength > 1_024) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
    }
    const { expectedSessionId } = rawBody.trim()
      ? await parseJson(request, logoutSchema, { maxBytes: 1_024 })
      : {};
    if (expectedSessionId) {
      const config = readSessionConfig();
      if (!config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '会话密钥尚未配置');
      const session = readRequestSession(request, config.sessionSecret);
      if (session && session.sessionId !== expectedSessionId) {
        throw new ApiError(409, 'SESSION_CHANGED', '登录账号已变化，请刷新页面');
      }
    }
    const response = Response.json({ data: { authenticated: false } });
    response.headers.set('cache-control', 'no-store');
    response.headers.set('set-cookie', serializeAdminSessionCookie('', {
      clear: true,
      secure: new URL(request.url).protocol === 'https:',
    }));
    return response;
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}
