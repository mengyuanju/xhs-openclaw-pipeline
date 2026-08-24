import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateSchema = z.object({ status: z.enum(['PUBLISHED', 'RETIRED']) }).strict();

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const id = parsePositiveId((await context.params).id);
    const item = withAdminStore((store: any) => store.getVisualKnowledge(id));
    if (!item) notFound('视觉配方不存在');
    return ok(item);
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const id = parsePositiveId((await context.params).id);
    const input = await parseJson(request, updateSchema);
    return ok(withAdminStore((store: any) => {
      const item = store.getVisualKnowledge(id);
      if (!item) notFound('视觉配方不存在');
      if (input.status === 'RETIRED') return store.retireVisualKnowledge(id);
      if (!item.latestVersion) throw new Error('视觉配方版本不存在');
      store.publishVisualKnowledgeVersion(item.latestVersion.id);
      return store.getVisualKnowledge(id);
    }));
  });
}
