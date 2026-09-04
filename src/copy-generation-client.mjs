import { createDotsChatClient } from './dots-chat-client.mjs';
import { effectiveModelApiConfig } from './model-api-config.mjs';
import { createOpenClawClient } from './openclaw.mjs';
import { withWebSearchProvider } from './web-search-service.mjs';

export function createCopyGenerationClient({
  modelApi = {},
  environment = process.env,
  openclaw,
  fetchImpl = fetch,
} = {}) {
  const configuration = effectiveModelApiConfig(modelApi, environment);
  const resolvedOpenClaw = openclaw
    ? withWebSearchProvider(openclaw, { environment, fetchImpl, settings: modelApi })
    : createOpenClawClient({ modelApi, environment, fetchImpl });
  const textClient = configuration.copyGenerationProvider === 'DOTS'
    ? createDotsChatClient({
      apiKey: environment.XHS_DOTS_API_KEY,
      baseUrl: configuration.dotsBaseUrl,
      model: configuration.dotsModel,
      fetchImpl,
    })
    : resolvedOpenClaw;
  return {
    ...resolvedOpenClaw,
    runText(input) {
      return textClient.runText({ ...input, thinking: configuration.copyGenerationThinking });
    },
    runReview(input) {
      return resolvedOpenClaw.runReview({ ...input, thinking: configuration.copyGenerationThinking });
    },
    runWebSearch(input) {
      return resolvedOpenClaw.runWebSearch(input);
    },
  };
}
