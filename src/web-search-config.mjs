export const DEFAULT_WEB_SEARCH_PROVIDER = 'DEEPSEEK';
export const DEFAULT_DEEPSEEK_SEARCH_MODEL = 'deepseek-v4-pro';
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 120_000;
export const DEFAULT_WEB_SEARCH_RESULT_LIMIT = 5;
export const DEFAULT_DOUBAO_ICP_HOST_ONLY = true;
export const DEFAULT_DOUBAO_SEARCH_MODE = 'CUSTOM';
export const LEGACY_DOUBAO_SEARCH_MODE = 'GLOBAL';
export const WEB_SEARCH_PROVIDERS = Object.freeze(['DOUBAO', 'DEEPSEEK', 'CODEX']);
export const DEEPSEEK_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
export const DEFAULT_WEB_SEARCH_SETTINGS = Object.freeze({
  webSearchProvider: null,
  webSearchProviderOrder: null,
  deepseekSearchModel: null,
  webSearchTimeoutMs: null,
  webSearchResultLimit: null,
  doubaoSearchMode: null,
  doubaoIcpHostOnly: null,
});

// Resolve the current production default before a new task captures settings.
// Do not apply this to historical execution snapshots: their absent mode means Global.
export function pinDefaultDoubaoSearchMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const modelApi = value.modelApi;
  if (modelApi != null && (typeof modelApi !== 'object' || Array.isArray(modelApi))) return value;
  if (modelApi?.doubaoSearchMode != null) return value;
  return { ...value, modelApi: { ...(modelApi ?? {}), doubaoSearchMode: DEFAULT_DOUBAO_SEARCH_MODE } };
}

export function snapshotProductionSearchMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const modelApi = value.modelApi;
  if (!modelApi || typeof modelApi !== 'object' || Array.isArray(modelApi)) return value;
  const providers = modelApi.webSearchProviderOrder ?? [modelApi.webSearchProvider];
  const usesDoubao = Array.isArray(providers)
    && providers.some((provider) => typeof provider === 'string' && provider.trim().toUpperCase() === 'DOUBAO');
  if (usesDoubao) return pinDefaultDoubaoSearchMode(value);
  // Keep unrelated new snapshots readable by older executors whose settings
  // parser does not yet recognize the mode field.
  if (!Object.hasOwn(modelApi, 'doubaoSearchMode')) return value;
  const { doubaoSearchMode: _mode, ...withoutDoubaoMode } = modelApi;
  return { ...value, modelApi: withoutDoubaoMode };
}

export function validatedDeepSeekSearchModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!DEEPSEEK_MODEL_ID_PATTERN.test(model)) {
    throw new TypeError('DeepSeek search model must be a valid model identifier');
  }
  return model;
}

export function normalizeWebSearchSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('web search settings must be an object');
  }
  const rawProvider = input.webSearchProvider == null ? null : String(input.webSearchProvider).trim().toUpperCase();
  const legacyProvider = rawProvider === 'OPENCLAW' ? 'CODEX' : rawProvider;
  if (legacyProvider !== null && !WEB_SEARCH_PROVIDERS.includes(legacyProvider)) {
    throw new TypeError('webSearchProvider must be DOUBAO, DEEPSEEK or CODEX');
  }
  const webSearchProviderOrder = validatedWebSearchProviderOrder(input.webSearchProviderOrder);
  // Keep the legacy single-provider field in sync for older executors during rollout.
  const webSearchProvider = webSearchProviderOrder?.[0] ?? legacyProvider;
  const deepseekSearchModel = input.deepseekSearchModel == null
    ? null
    : validatedDeepSeekSearchModel(input.deepseekSearchModel);
  const webSearchTimeoutMs = input.webSearchTimeoutMs == null ? null : validatedWebSearchTimeout(input.webSearchTimeoutMs);
  const webSearchResultLimit = input.webSearchResultLimit == null
    ? null : validatedWebSearchResultLimit(input.webSearchResultLimit);
  const doubaoSearchMode = input.doubaoSearchMode == null ? null : input.doubaoSearchMode;
  if (doubaoSearchMode !== null && !['GLOBAL', 'CUSTOM'].includes(doubaoSearchMode)) {
    throw new TypeError('doubaoSearchMode must be GLOBAL or CUSTOM');
  }
  const doubaoIcpHostOnly = input.doubaoIcpHostOnly == null ? null : input.doubaoIcpHostOnly;
  if (doubaoIcpHostOnly !== null && typeof doubaoIcpHostOnly !== 'boolean') {
    throw new TypeError('doubaoIcpHostOnly must be a boolean');
  }
  return { webSearchProvider, webSearchProviderOrder, deepseekSearchModel,
    webSearchTimeoutMs, webSearchResultLimit, doubaoSearchMode, doubaoIcpHostOnly };
}

export function validatedWebSearchProviderOrder(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > WEB_SEARCH_PROVIDERS.length) {
    throw new TypeError('webSearchProviderOrder must list 1–3 search providers');
  }
  const providers = value.map((item) => {
    if (typeof item !== 'string') throw new TypeError('webSearchProviderOrder contains an invalid provider');
    const raw = item.trim().toUpperCase();
    const provider = raw === 'OPENCLAW' ? 'CODEX' : raw;
    if (!WEB_SEARCH_PROVIDERS.includes(provider)) {
      throw new TypeError('webSearchProviderOrder contains an invalid provider');
    }
    return provider;
  });
  if (new Set(providers).size !== providers.length) {
    throw new TypeError('webSearchProviderOrder must not repeat a provider');
  }
  return providers;
}

export function validatedWebSearchResultLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RangeError('webSearchResultLimit must be an integer between 1 and 10');
  }
  return value;
}

export function validatedWebSearchTimeout(value) {
  if (!Number.isInteger(value) || value < 5_000 || value > 120_000) {
    throw new RangeError('web search timeoutMs must be between 5000 and 120000');
  }
  return value;
}

// This configuration contains no credentials and is independent of generation models.
export function resolveWebSearchConfig(environment = process.env, input = {}) {
  const settings = normalizeWebSearchSettings(input);
  const rawProvider = String(settings.webSearchProviderOrder?.[0] ?? settings.webSearchProvider
    ?? (environment.XHS_WEB_SEARCH_PROVIDER || DEFAULT_WEB_SEARCH_PROVIDER)).trim().toUpperCase();
  const provider = rawProvider === 'OPENCLAW' ? 'CODEX' : rawProvider;
  if (!WEB_SEARCH_PROVIDERS.includes(provider)) {
    throw new TypeError('XHS_WEB_SEARCH_PROVIDER must be DOUBAO, DEEPSEEK or CODEX');
  }
  const resultLimit = settings.webSearchResultLimit ?? DEFAULT_WEB_SEARCH_RESULT_LIMIT;
  const providers = settings.webSearchProviderOrder;
  const usesDoubao = (providers ?? [provider]).includes('DOUBAO');
  const usesDeepSeek = (providers ?? [provider]).includes('DEEPSEEK');
  const usesApi = usesDeepSeek || usesDoubao;
  // Saved execution snapshots predating this field must keep using Global.
  // New snapshots and new installations store CUSTOM explicitly.
  const doubaoSearchMode = settings.doubaoSearchMode ?? LEGACY_DOUBAO_SEARCH_MODE;
  const model = usesDeepSeek ? validatedDeepSeekSearchModel(
    settings.deepseekSearchModel ?? (environment.XHS_DEEPSEEK_SEARCH_MODEL || DEFAULT_DEEPSEEK_SEARCH_MODEL),
  ) : undefined;
  const environmentTimeout = usesDeepSeek
    ? environment.XHS_DEEPSEEK_SEARCH_TIMEOUT_MS
    : environment.XHS_DOUBAO_SEARCH_TIMEOUT_MS;
  const timeoutMs = usesApi ? validatedWebSearchTimeout(Number(
    settings.webSearchTimeoutMs ?? (environmentTimeout || DEFAULT_WEB_SEARCH_TIMEOUT_MS),
  )) : undefined;
  if (providers) return { provider, providers, ...(model ? { model } : {}),
    ...(timeoutMs ? { timeoutMs } : {}), resultLimit,
    ...(usesDoubao ? { doubaoSearchMode } : {}),
    doubaoIcpHostOnly: settings.doubaoIcpHostOnly ?? DEFAULT_DOUBAO_ICP_HOST_ONLY };
  if (provider === 'CODEX') return { provider, resultLimit };
  if (provider === 'DOUBAO') return { provider, timeoutMs, resultLimit,
    doubaoSearchMode,
    doubaoIcpHostOnly: settings.doubaoIcpHostOnly ?? DEFAULT_DOUBAO_ICP_HOST_ONLY };
  return { provider, model, timeoutMs, resultLimit };
}
