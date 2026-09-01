import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { parsePositiveId } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  roles: z.array(z.enum(['QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'])).min(1).max(3),
  status: z.enum(['ACTIVE', 'DISABLED']),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => {
    const userId = parsePositiveId((await context.params).id);
    const input = await parseJson(request, updateUserSchema);
    return ok(withAdminStore((store: any) => store.updateReviewUser(session, userId, input)));
  });
}
