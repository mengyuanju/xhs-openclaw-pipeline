import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../_lib';
import { notFound, parsePositiveId } from '../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const textRevisionSchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
}).strict();

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, {}, async () => {
    const id = parsePositiveId((await context.params).id);
    const task = withAdminStore((store: any) => store.getTask(id));
    if (!task) notFound('任务不存在');
    return ok(task);
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const id = parsePositiveId((await context.params).id);
    const body = await parseJson(request, textRevisionSchema);
    const revision = withAdminStore((store: any) => store.addTextRevision(id, {
      ...body,
      source: 'MANUAL',
    }));
    return ok(revision, { status: 201 });
  });
}
