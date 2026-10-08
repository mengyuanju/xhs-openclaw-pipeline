import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import { readSessionConfig, serializeAdminSessionCookie } from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { renewRequestSession } from '../../../../src/admin/session-renewal.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const renewSchema = z.object({
  expectedSessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
}).strict();

export async function POST(request: Request) {
  const response = await apiHandler(request, { mutation: true, auth: false }, async () => {
    const { expectedSessionId } = await parseJson(request, renewSchema, { maxBytes: 1_024 });
    const config = readSessionConfig();
    if (!config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '会话密钥尚未配置');
    const result = await renewRequestSession(request, {
      sessionSecret: config.sessionSecret,
      controlPlaneRoot: controlPlaneUrl(),
      expectedSessionId,
    });
    const renewedResponse = Response.json({ data: { ...result.metadata, renewed: result.renewed } });
    if (result.token && result.maxAge) {
      renewedResponse.headers.set('set-cookie', serializeAdminSessionCookie(result.token, {
        secure: new URL(request.url).protocol === 'https:',
        maxAge: result.maxAge,
      }));
      renewedResponse.headers.set('x-session-expires-in', String(result.maxAge));
    }
    return renewedResponse;
  });
  response.headers.set('cache-control', 'no-store');
  if (response.status === 401) {
    response.headers.set('set-cookie', serializeAdminSessionCookie('', {
      clear: true,
      secure: new URL(request.url).protocol === 'https:',
    }));
  }
  return response;
}
