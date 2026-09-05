import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withKnowledgeStore } from '../../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceCopy: z.string().trim().min(1).max(20_000),
  analysisPrompt: z.string().trim().min(1).max(8_000),
  summary: z.string().trim().min(1).max(2_000),
  analysis: z.string().trim().min(1).max(15_000),
  labels: z.array(z.string().trim().min(1).max(50)).min(1).max(12),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, updateSchema, { maxBytes: 192 * 1024 });
    const updated = await withKnowledgeStore((store: any) => store.updateCopyKnowledge(id, input));
    if (!updated) notFound('文案知识不存在');
    return ok(updated);
  });
}
