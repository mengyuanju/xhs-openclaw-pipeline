import { apiHandler, ok, parseJson } from '../_lib';
import { withPromptStore } from '../_prompt-runtime';
import { z } from 'zod';
import { PROMPT_CATALOG, PROMPT_CONTRACT_DESCRIPTION, PROMPT_CONTRACT_DETAILS, PROMPT_VARIABLES } from '../../../src/prompt-catalog.mjs';
import { DEFAULT_PROMPT_POLICY, defaultBusinessPrompt } from '../../../src/prompt-runtime.mjs';
import { readPromptConfiguration, preparePromptDrafts, savePromptPolicy } from '../../../src/admin/prompt-runtime-service.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN'] }, (session) => withPromptStore(session, async (options: any) => {
    const config = await readPromptConfiguration(options);
    return ok({ source: config.source, active: Boolean(config.settings), settings: config.settings ?? DEFAULT_PROMPT_POLICY,
      templates: config.templates, catalog: PROMPT_CATALOG.map((item) => ({ ...item, candidate: defaultBusinessPrompt(item.kind) })),
      variables: PROMPT_VARIABLES, contract: PROMPT_CONTRACT_DESCRIPTION, contractDetails: PROMPT_CONTRACT_DETAILS });
  }));
}
export function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => {
    await parseJson(request, z.object({ action: z.literal('PREPARE_DRAFTS') }).strict());
    return withPromptStore(session, async (options: any) => ok({ created: (await preparePromptDrafts(options)).length }));
  });
}
export function PUT(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => {
    const input = await parseJson(request, z.record(z.string(), z.unknown()), { maxBytes: 4096 });
    return withPromptStore(session, async (options: any) => ok(await savePromptPolicy(input, options)));
  });
}
