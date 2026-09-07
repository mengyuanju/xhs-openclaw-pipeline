import { z } from 'zod';
import { apiHandler, ok, parseJson } from '../../_lib';
import { loadPromptConfiguration } from '../../_prompt-runtime';
import { previewPrompt } from '../../../../src/admin/prompt-preview.mjs';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => {
    const input = await parseJson(request, z.object({ kind: z.string(), content: z.string(), query: z.string().max(500).optional() }).strict());
    return ok(previewPrompt(input, await loadPromptConfiguration(session)));
  });
}
