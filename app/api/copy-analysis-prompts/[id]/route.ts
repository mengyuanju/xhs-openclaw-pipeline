import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withKnowledgeStore } from '../../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  content: z.string().trim().min(1).max(8_000),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, bodySchema, { maxBytes: 40 * 1024 });
    const updated = await withKnowledgeStore((store: any) => store.replaceCopyAnalysisPrompt(id, input));
    if (!updated) notFound('已保存的分析 Prompt 不存在');
    return ok(updated);
  });
}
