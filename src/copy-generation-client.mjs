import { createDotsChatClient } from './dots-chat-client.mjs';
import { effectiveModelApiConfig } from './model-api-config.mjs';
import { createAgentClient } from './agent-client.mjs';
import { withWebSearchProvider } from './web-search-service.mjs';

export function createCopyGenerationClient({
  modelApi = {},
  environment = process.env,
  agentClient,
  fetchImpl = fetch,
} = {}) {
  const configuration = effectiveModelApiConfig(modelApi, environment);
  const resolvedAgent = agentClient
    ? withWebSearchProvider(agentClient, { environment, fetchImpl, settings: modelApi })
    : createAgentClient({ modelApi, environment, fetchImpl });
  const textClient = configuration.copyGenerationProvider === 'DOTS'
    ? createDotsChatClient({
      apiKey: environment.XHS_DOTS_API_KEY,
      baseUrl: configuration.dotsBaseUrl,
      model: configuration.dotsModel,
      fetchImpl,
    })
    : resolvedAgent;
  return {
    ...resolvedAgent,
    runText(input) {
      return textClient.runText({ ...input, thinking: configuration.copyGenerationThinking });
    },
    runReview(input) {
      return resolvedAgent.runReview({ ...input, thinking: configuration.copyGenerationThinking });
    },
    runWebSearch(input) {
      return resolvedAgent.runWebSearch(input);
    },
  };
}
