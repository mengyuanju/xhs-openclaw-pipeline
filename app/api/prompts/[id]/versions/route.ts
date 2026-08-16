import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../../../_lib';
import { parsePositiveId } from '../../../../../src/admin/http.mjs';
import { withAdminStore } from '../../../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ content: z.string().trim().min(1).max(20_000) }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiHandler(request, { mutation: true }, async () => {
    const templateId = parsePositiveId((await context.params).id);
    const body = await parseJson(request, bodySchema);
    const version = withAdminStore((store: any) => store.createPromptVersion({ templateId, ...body }));
    return ok(version, { status: 201 });
  });
}
