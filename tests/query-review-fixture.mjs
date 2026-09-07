import { PROMPT_KINDS } from '../src/prompt-catalog.mjs';
import { createPromptRuntime, defaultBusinessPrompt } from '../src/prompt-runtime.mjs';

export function enabledQueryReviewRuntime() {
  return createPromptRuntime({ settings: { queryReviewEnabled: true },
    prompts: Object.fromEntries(PROMPT_KINDS.map((kind) => [kind, { content: defaultBusinessPrompt(kind) }])) });
}
