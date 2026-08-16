import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import {
  LoginRateLimiter,
  attemptAdminLogin,
  serializeAdminSessionCookie,
} from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  password: z.string().min(1).max(1_024),
}).strict();
const loginLimiter = new LoginRateLimiter();

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, auth: false }, async () => {
    const { password } = await parseJson(request, loginSchema);
    const result = await attemptAdminLogin(password, { limiter: loginLimiter });
    if (result.status === 'blocked') {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    if (result.status === 'invalid') {
      throw new ApiError(401, 'INVALID_CREDENTIALS', '登录失败');
    }

    const response = Response.json({ data: { authenticated: true } });
    response.headers.set('cache-control', 'no-store');
    response.headers.set('set-cookie', serializeAdminSessionCookie(
      result.token,
      { secure: new URL(request.url).protocol === 'https:' },
    ));
    response.headers.set('x-session-expires-in', String(result.expiresInSeconds));
    return response;
  });
}
