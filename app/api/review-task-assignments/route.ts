import { apiHandler, ok } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVIEW_ROLES = ['ADMIN', 'QC_LEAD', 'COPY_REVIEWER'];

export function GET(request: Request) {
  return apiHandler(request, { roles: REVIEW_ROLES }, (session) => {
    const search = new URL(request.url).searchParams;
    return ok(withAdminStore((store: any) => store.listReviewTaskAssignments(session, {
      page: search.get('page') || 1,
      pageSize: search.get('pageSize') || 30,
      importBatchId: search.get('batchId') || undefined,
      assigneeUserId: search.get('assigneeUserId') || undefined,
    })));
  });
}
