import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const claimSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {
    mutation: true,
    roles: ['QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'],
  }, async (session) => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, claimSchema);
    return ok(withAdminStore((store: any) => store.claimReviewWorkItem(session, id, input)));
  });
}
