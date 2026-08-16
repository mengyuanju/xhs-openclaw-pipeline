import { apiHandler, ok } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const id = parsePositiveId((await context.params).id);
    const batch = withAdminStore((store: any) => store.getImportBatch(id));
    if (!batch) notFound('导入批次不存在');
    return ok(batch);
  });
}
