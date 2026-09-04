import { runDeepSeekWebSearch } from './deepseek-web-search.mjs';
import { resolveWebSearchConfig } from './web-search-config.mjs';

export function withWebSearchProvider(client, { environment = process.env, fetchImpl = fetch } = {}) {
  const configuration = resolveWebSearchConfig(environment);
  if (configuration.provider === 'OPENCLAW') return client;
  return {
    ...client,
    webSearchProviders: ['deepseek'],
    runWebSearch(input) {
      // Read credentials only when searching; unrelated model operations need no search key.
      return runDeepSeekWebSearch({
        apiKey: environment.DEEPSEEK_API_KEY,
        model: configuration.model,
        timeoutMs: configuration.timeoutMs,
        fetchImpl,
      }, input);
    },
  };
}
