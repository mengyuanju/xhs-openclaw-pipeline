import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import {
  LoginRateLimiter,
  attemptAdminLogin,
  attemptReviewUserLogin,
  readAuthConfig,
  serializeAdminSessionCookie,
} from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(50).default('admin'),
  password: z.string().min(1).max(1_024),
}).strict();
const MAX_LOGIN_LIMITERS = 100;
const loginLimiters = new Map<string, LoginRateLimiter>();
const globalLoginLimiter = new LoginRateLimiter({ maxFailures: 50 });

function getLoginLimiter(username: string) {
  const existing = loginLimiters.get(username);
  if (existing) {
    loginLimiters.delete(username);
    loginLimiters.set(username, existing);
    return existing;
  }
  if (loginLimiters.size >= MAX_LOGIN_LIMITERS) {
    const oldestUsername = loginLimiters.keys().next().value;
    if (oldestUsername) loginLimiters.delete(oldestUsername);
  }
  const limiter = new LoginRateLimiter();
  loginLimiters.set(username, limiter);
  return limiter;
}

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, auth: false }, async () => {
    const { username, password } = await parseJson(request, loginSchema);
    const globalRateLimit = globalLoginLimiter.check();
    if (!globalRateLimit.allowed) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试', {
        retryAfterSeconds: globalRateLimit.retryAfterSeconds,
      });
    }
    const limiter = getLoginLimiter(username);
    const result = username === 'admin'
      ? await attemptAdminLogin(password, { limiter })
      : await withAdminStore((store: any) => {
        const config = readAuthConfig();
        if (!config) return { status: 'invalid' } as const;
        return attemptReviewUserLogin({
          username,
          password,
          lookupUser: (candidate: string) => store.findReviewUserForLogin(candidate),
          sessionSecret: config.sessionSecret,
          limiter,
        });
      });
    if (result.status === 'blocked') {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    if (result.status === 'invalid') {
      globalLoginLimiter.recordFailure();
      throw new ApiError(401, 'INVALID_CREDENTIALS', '登录失败');
    }

    const response = Response.json({
      data: {
        authenticated: true,
        homePath: username === 'admin' ? '/' : '/reviews',
      },
    });
    response.headers.set('cache-control', 'no-store');
    response.headers.set('set-cookie', serializeAdminSessionCookie(
      result.token,
      { secure: new URL(request.url).protocol === 'https:' },
    ));
    response.headers.set('x-session-expires-in', String(result.expiresInSeconds));
    return response;
  });
}
