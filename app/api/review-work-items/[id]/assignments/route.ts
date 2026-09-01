import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const assignmentSchema = z.object({
  assigneeUserId: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'QC_LEAD'] }, async (session) => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, assignmentSchema);
    return ok(withAdminStore((store: any) => store.assignReviewWorkItem(session, id, input)));
  });
}
