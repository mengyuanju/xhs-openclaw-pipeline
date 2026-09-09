import { z } from 'zod';
import { apiHandler, ok } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
import { statisticsService } from '../../../src/web-statistics/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  scope: z.enum(['personal', 'admin']).default('personal'),
  period: z.enum(['today', '7d', '30d', 'custom']).default('today'),
  from: z.string().max(10).optional(), to: z.string().max(10).optional(),
  username: z.string().max(128).default(''),
  createdByAccountId: z.coerce.number().int().positive().optional(),
  role: z.enum(['', 'USER', 'REVIEWER', 'ADMIN']).default(''),
  details: z.enum(['0', '1']).default('0'), refresh: z.enum(['0', '1']).default('0'),
}).strict();

export async function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'USER', 'REVIEWER'] }, async session => {
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', '统计筛选参数无效');
    const result = await statisticsService.read({
      root: controlPlaneUrl(), session, ...parsed.data,
      from: parsed.data.from, to: parsed.data.to,
      details: parsed.data.details === '1', refresh: parsed.data.refresh === '1',
    });
    return ok(result, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
