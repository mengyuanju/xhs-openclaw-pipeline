import { z } from 'zod';

import { apiHandler, parseJson } from '../../_lib';
import {
  createSessionToken,
  readSessionConfig,
  serializeAdminSessionCookie,
  verifySessionToken,
} from '../../../../src/admin/auth.mjs';
import { ApiError } from '../../../../src/admin/http.mjs';
import { loginRateLimitStore } from '../../../../src/admin/login-rate-limits.mjs';
import { controlPlaneUrl } from '../../../../src/control-plane/next-runtime.mjs';
import { getSessionMetadata } from '../../../../src/admin/session-renewal.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(50).default('admin'),
  password: z.string().min(1).max(1_024),
}).strict();
export async function POST(request: Request) {
  const response = await apiHandler(request, { mutation: true, auth: false }, async () => {
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
      if (userResponse.status >= 500) {
        throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '中心服务暂时不可用，请稍后重试');
      }
      loginRateLimitStore.recordFailure(username);
      throw new ApiError(401, 'INVALID_CREDENTIALS', '登录失败');
    }
    const user = (await userResponse.json().catch(() => null))?.data;
    if (!user) throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '中心服务返回的登录信息无效');
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = createSessionToken(config.sessionSecret, {
      nowSeconds: issuedAt,
      renewal: {},
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
    const metadata = getSessionMetadata(verifySessionToken(token, config.sessionSecret, { nowSeconds: issuedAt }));
    if (!metadata) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '无法建立登录会话');
    const maxAge = metadata.expiresAt - Math.floor(Date.now() / 1_000);
    loginRateLimitStore.resetAccount(username);

    const response = Response.json({
      data: {
        authenticated: true,
        session: metadata,
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
      { secure: new URL(request.url).protocol === 'https:', maxAge },
    ));
    response.headers.set('x-session-expires-in', String(maxAge));
    return response;
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}
