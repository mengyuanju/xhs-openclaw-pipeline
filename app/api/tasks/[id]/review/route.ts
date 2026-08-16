import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reviewSchema = z.object({
  status: z.enum(['WAITING_REVIEW', 'APPROVED', 'REJECTED']),
  note: z.string().trim().max(2_000).default(''),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const id = parsePositiveId((await context.params).id);
    const body = await parseJson(request, reviewSchema);
    return ok(withAdminStore((store: any) => store.setReviewStatus(id, body)));
  });
}
