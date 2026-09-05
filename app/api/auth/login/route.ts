import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import {
  LoginRateLimiter,
  createSessionToken,
  readSessionConfig,
  serializeAdminSessionCookie,
} from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';

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
    const accountRateLimit = limiter.check();
    if (!accountRateLimit.allowed) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试', {
        retryAfterSeconds: accountRateLimit.retryAfterSeconds,
      });
    }
    const root = controlPlaneUrl();
    const config = readSessionConfig();
    if (!root || !config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '中心服务或会话密钥尚未配置');
    const userResponse = await fetch(`${root}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!userResponse) throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '无法连接中心服务');
    if (!userResponse.ok) {
      globalLoginLimiter.recordFailure();
      limiter.recordFailure();
      throw new ApiError(401, 'INVALID_CREDENTIALS', '登录失败');
    }
    const user = (await userResponse.json()).data;
    limiter.reset();
    const token = createSessionToken(config.sessionSecret, {
      actor: {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: [user.role],
        credentialVersion: user.credentialVersion,
        mustChangePassword: user.mustChangePassword,
      },
    });

    const response = Response.json({
      data: {
        authenticated: true,
        homePath: user.mustChangePassword ? '/profile' : '/workbench/personal',
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    });
    response.headers.set('cache-control', 'no-store');
    response.headers.set('set-cookie', serializeAdminSessionCookie(
      token,
      { secure: new URL(request.url).protocol === 'https:' },
    ));
    response.headers.set('x-session-expires-in', String(8 * 60 * 60));
    return response;
  });
}
