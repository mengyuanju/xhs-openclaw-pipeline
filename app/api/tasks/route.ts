import { apiHandler, ok } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return apiHandler(request, {}, () => {
    const url = new URL(request.url);
    return ok(withAdminStore((store: any) => store.listTasks({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      status: url.searchParams.get('status') || undefined,
      reviewStatus: url.searchParams.get('reviewStatus') || undefined,
      query: url.searchParams.get('query') || undefined,
    })));
  });
}
