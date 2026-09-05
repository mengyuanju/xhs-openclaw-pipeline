export const DEFAULT_WEB_SEARCH_PROVIDER = 'DEEPSEEK';
export const DEFAULT_DEEPSEEK_SEARCH_MODEL = 'deepseek-v4-flash';
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 120_000;
export const DEFAULT_WEB_SEARCH_SETTINGS = Object.freeze({
  webSearchProvider: null,
  deepseekSearchModel: null,
  webSearchTimeoutMs: null,
});

export function normalizeWebSearchSettings(input = {}) {
  const webSearchProvider = input.webSearchProvider == null ? null : String(input.webSearchProvider).trim().toUpperCase();
  if (webSearchProvider !== null && !['OPENCLAW', 'DEEPSEEK'].includes(webSearchProvider)) {
    throw new TypeError('webSearchProvider must be OPENCLAW or DEEPSEEK');
  }
  const deepseekSearchModel = input.deepseekSearchModel == null ? null : String(input.deepseekSearchModel).trim();
  if (deepseekSearchModel !== null && !['deepseek-v4-pro', 'deepseek-v4-flash'].includes(deepseekSearchModel)) {
    throw new TypeError('DeepSeek search model must be deepseek-v4-pro or deepseek-v4-flash');
  }
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
  const provider = String(settings.webSearchProvider ?? (environment.XHS_WEB_SEARCH_PROVIDER || DEFAULT_WEB_SEARCH_PROVIDER)).trim().toUpperCase();
  if (!['OPENCLAW', 'DEEPSEEK'].includes(provider)) {
    throw new TypeError('XHS_WEB_SEARCH_PROVIDER must be OPENCLAW or DEEPSEEK');
  }
  if (provider === 'OPENCLAW') return { provider };
  const model = String(settings.deepseekSearchModel ?? (environment.XHS_DEEPSEEK_SEARCH_MODEL || DEFAULT_DEEPSEEK_SEARCH_MODEL)).trim();
  if (!['deepseek-v4-pro', 'deepseek-v4-flash'].includes(model)) {
    throw new TypeError('DeepSeek search model must be deepseek-v4-pro or deepseek-v4-flash');
  }
  const timeoutMs = validatedWebSearchTimeout(Number(
    settings.webSearchTimeoutMs ?? (environment.XHS_DEEPSEEK_SEARCH_TIMEOUT_MS || DEFAULT_WEB_SEARCH_TIMEOUT_MS),
  ));
  return { provider, model, timeoutMs };
}
