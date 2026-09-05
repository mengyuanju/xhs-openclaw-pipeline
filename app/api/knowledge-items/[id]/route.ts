import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withKnowledgeStore } from '../../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateSchema = z.object({ status: z.enum(['PUBLISHED', 'RETIRED']) }).strict();

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const id = parsePositiveId((await context.params).id);
    const item = await withKnowledgeStore((store: any) => store.getVisualKnowledge(id));
    if (!item) notFound('视觉配方不存在');
    return ok(item);
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, updateSchema);
    return ok(await withKnowledgeStore(async (store: any) => {
      const item = await store.getVisualKnowledge(id);
      if (!item) notFound('视觉配方不存在');
      if (input.status === 'RETIRED') return store.retireVisualKnowledge(id);
      if (!item.latestVersion) throw new Error('视觉配方版本不存在');
      await store.publishVisualKnowledgeVersion(item.latestVersion.id);
      return store.getVisualKnowledge(id);
    }));
  });
}
