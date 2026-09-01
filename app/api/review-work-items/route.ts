import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVIEW_ROLES = ['ADMIN', 'QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'];
const seedSchema = z.object({
  reviewType: z.enum(['QUERY', 'COPY']),
  importBatchId: z.number().int().positive(),
}).strict();

export function GET(request: Request) {
  return apiHandler(request, { roles: REVIEW_ROLES }, (session) => {
    const search = new URL(request.url).searchParams;
    return ok(withAdminStore((store: any) => store.listReviewWorkItems(session, {
      page: search.get('page') || 1,
      pageSize: search.get('pageSize') || 30,
      reviewType: search.get('reviewType') || undefined,
      status: search.get('status') || undefined,
      importBatchId: search.get('batchId') || undefined,
      assigneeUserId: search.get('assigneeUserId') || undefined,
    })));
  });
}

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'QC_LEAD'] }, async (session) => {
    const input = await parseJson(request, seedSchema);
    return ok(withAdminStore((store: any) => store.seedReviewWorkItems(session, input)), { status: 201 });
  });
}
