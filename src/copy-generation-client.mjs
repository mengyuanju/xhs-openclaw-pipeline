import { createDotsChatClient } from './dots-chat-client.mjs';
import { effectiveModelApiConfig } from './model-api-config.mjs';
import { createOpenClawClient } from './openclaw.mjs';

export function createCopyGenerationClient({
  modelApi = {},
  environment = process.env,
  openclaw,
  fetchImpl = fetch,
} = {}) {
  const configuration = effectiveModelApiConfig(modelApi, environment);
  const resolvedOpenClaw = openclaw ?? createOpenClawClient({ modelApi });
  if (configuration.copyGenerationProvider !== 'DOTS') return resolvedOpenClaw;

  const dots = createDotsChatClient({
    apiKey: environment.XHS_DOTS_API_KEY,
    baseUrl: configuration.dotsBaseUrl,
    model: configuration.dotsModel,
    fetchImpl,
  });
  return {
    runText(input) {
      return dots.runText(input);
    },
    runReview(input) {
      return resolvedOpenClaw.runReview(input);
    },
    runWebSearch(input) {
      return resolvedOpenClaw.runWebSearch(input);
    },
  };
}
