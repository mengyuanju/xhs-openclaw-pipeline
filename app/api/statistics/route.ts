import { z } from 'zod';

import { apiHandler, ok } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function GET(request: Request) {
  return apiHandler(request, {}, () => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      throw new ApiError(400, 'INVALID_INPUT', '统计查询参数无效', parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }
    const query = parsed.data;
    return ok(withAdminStore((store: any) => store.listProductionStatistics(query)));
  });
}
