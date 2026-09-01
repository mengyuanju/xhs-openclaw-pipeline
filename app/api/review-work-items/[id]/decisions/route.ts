import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(20).default([]),
  note: z.string().trim().max(2_000).default(''),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {
    mutation: true,
    roles: ['QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'],
  }, async (session) => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, decisionSchema);
    return ok(withAdminStore((store: any) => store.decideReviewWorkItem(session, id, input)));
  });
}
