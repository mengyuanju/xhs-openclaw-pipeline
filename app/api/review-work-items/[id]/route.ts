import { apiHandler, ok } from '../../_lib';
import { parsePositiveId } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVIEW_ROLES = ['ADMIN', 'QC_LEAD', 'QUERY_REVIEWER', 'COPY_REVIEWER'];

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { roles: REVIEW_ROLES }, async (session) => {
    const id = parsePositiveId((await context.params).id);
    return ok(withAdminStore((store: any) => ({
      item: store.getReviewWorkItem(session, id),
      events: store.listReviewEvents(session, id),
    })));
  });
}
