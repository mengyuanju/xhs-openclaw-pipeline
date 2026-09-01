import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceCopy: z.string().trim().min(1).max(20_000),
  analysisPrompt: z.string().trim().min(1).max(8_000),
  summary: z.string().trim().min(1).max(2_000),
  analysis: z.string().trim().min(1).max(15_000),
  labels: z.array(z.string().trim().min(1).max(50)).min(1).max(12),
  analysisModel: z.string().trim().max(200).optional().default(''),
}).strict();

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, bodySchema, { maxBytes: 192 * 1024 });
    const created = withAdminStore((store: any) => store.createCopyKnowledge(input));
    return ok(created, { status: 201 });
  });
}
