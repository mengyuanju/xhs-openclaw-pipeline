import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allocationSchema = z.object({
  importBatchId: z.number().int().positive(),
  assigneeUserId: z.number().int().positive(),
  count: z.number().int().min(1).max(500),
}).strict();

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'QC_LEAD'] }, async (session) => {
    const input = await parseJson(request, allocationSchema);
    return ok(withAdminStore((store: any) => store.allocateReviewTasks(session, input)), { status: 201 });
  });
}
