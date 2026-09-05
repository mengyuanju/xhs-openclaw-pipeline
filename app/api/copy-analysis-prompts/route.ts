import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { CopyAnalysisPromptLimitError } from '../../../src/admin/copy-knowledge-store.mjs';
import { ApiError } from '../../../src/admin/http.mjs';
import { withKnowledgeStore } from '../../../src/admin/knowledge-runtime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  content: z.string().trim().min(1).max(8_000),
}).strict();

export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER'] }, async () => ok(await withKnowledgeStore((store: any) => store.listCopyAnalysisPrompts())));
}

export async function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async () => {
    const input = await parseJson(request, bodySchema, { maxBytes: 40 * 1024 });
    try {
      const created = await withKnowledgeStore((store: any) => store.createCopyAnalysisPrompt(input));
      return ok(created, { status: 201 });
    } catch (error) {
      if (error instanceof CopyAnalysisPromptLimitError) {
        throw new ApiError(
          409,
          'PROMPT_LIMIT_REACHED',
          '已保存 10 条分析 Prompt，请选择一条进行替换',
        );
      }
      throw error;
    }
  });
}
