export const DEFAULT_WEB_SEARCH_PROVIDER = 'DEEPSEEK';
export const DEFAULT_DEEPSEEK_SEARCH_MODEL = 'deepseek-v4-pro';
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 120_000;
export const DEEPSEEK_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
export const DEFAULT_WEB_SEARCH_SETTINGS = Object.freeze({
  webSearchProvider: null,
  deepseekSearchModel: null,
  webSearchTimeoutMs: null,
});

export function validatedDeepSeekSearchModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!DEEPSEEK_MODEL_ID_PATTERN.test(model)) {
    throw new TypeError('DeepSeek search model must be a valid model identifier');
  }
  return model;
}

export function normalizeWebSearchSettings(input = {}) {
  const rawProvider = input.webSearchProvider == null ? null : String(input.webSearchProvider).trim().toUpperCase();
  const webSearchProvider = rawProvider === 'OPENCLAW' ? 'CODEX' : rawProvider;
  if (webSearchProvider !== null && !['CODEX', 'DEEPSEEK'].includes(webSearchProvider)) {
    throw new TypeError('webSearchProvider must be CODEX or DEEPSEEK');
  }
  const deepseekSearchModel = input.deepseekSearchModel == null
    ? null
    : validatedDeepSeekSearchModel(input.deepseekSearchModel);
  const webSearchTimeoutMs = input.webSearchTimeoutMs == null ? null : validatedWebSearchTimeout(input.webSearchTimeoutMs);
  return { webSearchProvider, deepseekSearchModel, webSearchTimeoutMs };
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
  const rawProvider = String(settings.webSearchProvider
    ?? (environment.XHS_WEB_SEARCH_PROVIDER || DEFAULT_WEB_SEARCH_PROVIDER)).trim().toUpperCase();
  const provider = rawProvider === 'OPENCLAW' ? 'CODEX' : rawProvider;
  if (!['CODEX', 'DEEPSEEK'].includes(provider)) {
    throw new TypeError('XHS_WEB_SEARCH_PROVIDER must be CODEX or DEEPSEEK');
  }
  if (provider === 'CODEX') return { provider };
  const model = validatedDeepSeekSearchModel(
    settings.deepseekSearchModel ?? (environment.XHS_DEEPSEEK_SEARCH_MODEL || DEFAULT_DEEPSEEK_SEARCH_MODEL),
  );
  const timeoutMs = validatedWebSearchTimeout(Number(
    settings.webSearchTimeoutMs ?? (environment.XHS_DEEPSEEK_SEARCH_TIMEOUT_MS || DEFAULT_WEB_SEARCH_TIMEOUT_MS),
  ));
  return { provider, model, timeoutMs };
}
