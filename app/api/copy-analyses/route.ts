import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { analyzeExcellentCopy } from '../../../src/admin/copy-knowledge-service.mjs';
import { withKnowledgeStore, readKnowledgeModelApi } from '../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sourceCopy: z.string().trim().min(1).max(20_000),
  analysisPrompt: z.string().trim().min(1).max(8_000),
}).strict();

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true }, async () => {
    const input = await parseJson(request, bodySchema, { maxBytes: 128 * 1024 });
    const modelApi = await withKnowledgeStore(readKnowledgeModelApi);
    return ok(await analyzeExcellentCopy({ ...input, modelApi }));
  });
}
