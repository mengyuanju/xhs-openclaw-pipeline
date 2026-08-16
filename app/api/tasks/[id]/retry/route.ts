import { apiHandler, ok } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const id = parsePositiveId((await context.params).id);
    return ok(withAdminStore((store: any) => store.retryTask(id)));
  });
}
