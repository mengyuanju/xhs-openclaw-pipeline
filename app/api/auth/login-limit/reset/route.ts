import { apiHandler, ok } from '../../../_lib';
import { loginRateLimitStore } from '../../../../../src/admin/login-rate-limits.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, () => {
    const result = loginRateLimitStore.resetAll();
    return ok({
      released: true,
      clearedAccountCount: result.clearedAccountCount,
      releasedAt: new Date().toISOString(),
    });
  });
}
