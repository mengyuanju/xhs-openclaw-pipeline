import { internalPrompt } from './prompt-runtime.mjs';
import { businessPrompt } from './prompt-runtime.mjs';

export function buildResearchPrompt(query, limit) {
  return businessPrompt('RESEARCH_SYSTEM', { dataTag: 'untrusted_query', data: { query },
    contract: internalPrompt('INTERNAL_RESEARCH_OUTPUT', { slot1: (limit) }) });
}
