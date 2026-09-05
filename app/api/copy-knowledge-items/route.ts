import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withKnowledgeStore } from '../../../src/admin/knowledge-runtime.mjs';

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

export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER'] }, async (session) => {
    const url = new URL(request.url);
    return ok(await withKnowledgeStore((store: any) => store.listCopyKnowledge({
      page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'),
      label: url.searchParams.get('label') || undefined,
    }), session));
  });
}

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async (session) => {
    const input = await parseJson(request, bodySchema, { maxBytes: 192 * 1024 });
    const created = await withKnowledgeStore((store: any) => store.createCopyKnowledge(input), session);
    return ok(created, { status: 201 });
  });
}
