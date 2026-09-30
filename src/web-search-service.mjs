import { runDeepSeekWebSearch } from './deepseek-web-search.mjs';
import { runDoubaoWebSearch } from './doubao-search.mjs';
import { resolveWebSearchConfig } from './web-search-config.mjs';

export function withWebSearchProvider(client, { environment = process.env, fetchImpl = fetch, settings = {} } = {}) {
  const configuration = resolveWebSearchConfig(environment, settings);
  // Preserve the original client for saved single-provider CODEX settings.
  if (configuration.provider === 'CODEX' && !configuration.providers) return client;
  const providers = configuration.providers ?? [configuration.provider];
  const allowedProviders = new Set(providers.map((provider) => provider.toLowerCase()));
  const originalSearch = typeof client?.runWebSearch === 'function' ? client.runWebSearch.bind(client) : null;
  return {
    ...client,
    webSearchProviders: [...allowedProviders],
    ...(configuration.providers?.length > 1 ? { webSearchTimeoutMs: configuration.timeoutMs ?? 120_000 } : {}),
    runWebSearch(input) {
      const provider = String(input?.provider ?? configuration.provider).toLowerCase();
      if (!allowedProviders.has(provider)) throw new TypeError('web search provider is not configured');
      if (provider === 'codex') {
        if (!originalSearch) throw new TypeError('Codex web search client is unavailable');
        return originalSearch({ ...input, provider: 'codex' });
      }
      if (provider === 'doubao') {
        return runDoubaoWebSearch({
          // Credentials are read only for an actual search call and never enter settings or snapshots.
          apiKey: environment.DOUBAO_SEARCH_API_KEY,
          mode: configuration.doubaoSearchMode,
          timeoutMs: configuration.timeoutMs,
          icpHostOnly: configuration.doubaoIcpHostOnly,
          fetchImpl,
        }, input);
      }
      return runDeepSeekWebSearch({
        apiKey: environment.DEEPSEEK_API_KEY,
        model: configuration.model,
        timeoutMs: configuration.timeoutMs,
        fetchImpl,
      }, input);
    },
  };
}
