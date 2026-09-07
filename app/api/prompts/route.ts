import { apiHandler, ok } from '../_lib';
import { loadPromptConfiguration } from '../_prompt-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return apiHandler(request, {}, async (session) => ok((await loadPromptConfiguration(session)).templates));
}
