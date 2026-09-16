import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import {
  createSessionToken,
  readSessionConfig,
  serializeAdminSessionCookie,
} from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { loginRateLimitStore } from '../../../../src/admin/login-rate-limits.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(50).default('admin'),
  password: z.string().min(1).max(1_024),
}).strict();
export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, auth: false }, async () => {
    const { username, password } = await parseJson(request, loginSchema);
    const rateLimit = loginRateLimitStore.check(username);
    if (!rateLimit.allowed) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '登录尝试过多，请稍后再试', {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
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
      loginRateLimitStore.recordFailure(username);
      throw new ApiError(401, 'INVALID_CREDENTIALS', '登录失败');
    }
    const user = (await userResponse.json()).data;
    loginRateLimitStore.resetAccount(username);
    const token = createSessionToken(config.sessionSecret, {
      actor: {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: [user.role],
        credentialVersion: user.credentialVersion,
        mustChangePassword: user.mustChangePassword,
        copyReviewEnabled: user.copyReviewEnabled,
        copyQcEnabled: user.copyQcEnabled,
        imageQcEnabled: user.imageQcEnabled,
      },
    });

    const response = Response.json({
      data: {
        authenticated: true,
        homePath: user.mustChangePassword ? '/profile' : '/workbench/personal',
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        copyReviewEnabled: user.copyReviewEnabled,
        copyQcEnabled: user.copyQcEnabled,
        imageQcEnabled: user.imageQcEnabled,
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
