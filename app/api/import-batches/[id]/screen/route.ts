import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { notFound, parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const screeningSchema = z.object({
  decisions: z.array(z.object({
    rowId: z.number().int().positive(),
    demandLevel: z.enum(['STRONG', 'MEDIUM', 'WEAK', 'NONE']),
    reason: z.string().trim().min(1).max(500),
  })).min(1).max(5_000),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const batchId = parsePositiveId((await context.params).id);
    const input = await parseJson(request, screeningSchema, { maxBytes: 10 * 1024 * 1024 });
    return ok(withAdminStore((store: any) => {
      if (!store.getImportBatch(batchId)) notFound('导入批次不存在');
      store.screenImportBatch(batchId, input);
      return store.getImportBatch(batchId);
    }));
  });
}
