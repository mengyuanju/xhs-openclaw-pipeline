export const DEFAULT_DEEPSEEK_SEARCH_MODEL = 'deepseek-v4-pro';
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 120_000;

export function validatedWebSearchTimeout(value) {
  if (!Number.isInteger(value) || value < 5_000 || value > 120_000) {
    throw new RangeError('web search timeoutMs must be between 5000 and 120000');
  }
  return value;
}

// This configuration contains no credentials and is independent of generation models.
export function resolveWebSearchConfig(environment = process.env) {
  const provider = String(environment.XHS_WEB_SEARCH_PROVIDER || 'OPENCLAW').trim().toUpperCase();
  if (!['OPENCLAW', 'DEEPSEEK'].includes(provider)) {
    throw new TypeError('XHS_WEB_SEARCH_PROVIDER must be OPENCLAW or DEEPSEEK');
  }
  if (provider === 'OPENCLAW') return { provider };
  const model = String(environment.XHS_DEEPSEEK_SEARCH_MODEL || DEFAULT_DEEPSEEK_SEARCH_MODEL).trim();
  if (!['deepseek-v4-pro', 'deepseek-v4-flash'].includes(model)) {
    throw new TypeError('DeepSeek search model must be deepseek-v4-pro or deepseek-v4-flash');
  }
  const timeoutMs = validatedWebSearchTimeout(Number(
    environment.XHS_DEEPSEEK_SEARCH_TIMEOUT_MS || DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  ));
  return { provider, model, timeoutMs };
}
