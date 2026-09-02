export const DEFAULT_TEXT_MODEL = 'openai/gpt-5.6-sol';
export const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-2';
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;
export const DEFAULT_COPY_GENERATION_PROVIDER = 'OPENCLAW';
export const DEFAULT_COPY_GENERATION_THINKING = 'low';
export const DEFAULT_DOTS_BASE_URL = 'https://note3-prev-api.askdiandian.com';
export const DEFAULT_DOTS_MODEL = 'dots3-note-prev';
export const COPY_GENERATION_THINKING_LEVELS = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const COPY_GENERATION_PROVIDERS = new Set(['OPENCLAW', 'DOTS']);
const COPY_GENERATION_THINKING_LEVEL_SET = new Set(COPY_GENERATION_THINKING_LEVELS);

const MODEL_API_FIELDS = new Set([
  'textModel',
  'screeningModel',
  'reviewModel',
  'visionModel',
  'qualityModel',
  'imageModel',
  'modelProxyUrl',
  'imageProxyUrl',
  'imageTimeoutMs',
  'copyGenerationProvider',
  'copyGenerationThinking',
  'dotsBaseUrl',
  'dotsModel',
]);
const LEGACY_PROVIDER = /^openai-codex\//iu;

export const DEFAULT_MODEL_API_SETTINGS = Object.freeze({
  textModel: null,
  screeningModel: null,
  reviewModel: null,
  visionModel: null,
  qualityModel: null,
  imageModel: null,
  modelProxyUrl: null,
  imageProxyUrl: null,
  imageTimeoutMs: null,
  copyGenerationProvider: null,
  copyGenerationThinking: null,
  dotsBaseUrl: null,
  dotsModel: null,
});

export function validatedModelRef(value, fallback, name) {
  const model = String(value || fallback || '').trim();
  if (model.length < 3 || model.length > 200 || !model.includes('/') || /\s/u.test(model)) {
    throw new TypeError(`${name} must be a provider/model reference`);
  }
  if (LEGACY_PROVIDER.test(model)) {
    throw new TypeError(`${name} uses legacy provider openai-codex; migrate it to openai/<model>`);
  }
  return model;
}

function optionalModelRef(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return validatedModelRef(value, null, name);
}

function optionalProxyUrl(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.length > 500) throw new RangeError(`${name} cannot exceed 500 characters`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${name} must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`${name} must be an HTTP(S) URL`);
  }
  if (url.username || url.password) throw new TypeError(`${name} cannot contain credentials`);
  return url.toString().replace(/\/$/u, '');
}

function optionalImageTimeout(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 30_000 || value > 540_000) {
    throw new RangeError('imageTimeoutMs must be an integer between 30000 and 540000');
  }
  return value;
}

function optionalCopyGenerationProvider(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const provider = String(value).trim().toUpperCase();
  if (!COPY_GENERATION_PROVIDERS.has(provider)) {
    throw new TypeError('copyGenerationProvider must be OPENCLAW or DOTS');
  }
  return provider;
}

export function validatedCopyGenerationThinking(
  value,
  fallback = DEFAULT_COPY_GENERATION_THINKING,
) {
  const thinking = String(value ?? fallback ?? '').trim().toLowerCase();
  if (!COPY_GENERATION_THINKING_LEVEL_SET.has(thinking)) {
    throw new TypeError(
      `copyGenerationThinking must be one of: ${COPY_GENERATION_THINKING_LEVELS.join(', ')}`,
    );
  }
  return thinking;
}

function optionalCopyGenerationThinking(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return validatedCopyGenerationThinking(value);
}

export function validatedDotsBaseUrl(value, fallback = DEFAULT_DOTS_BASE_URL) {
  const text = String(value || fallback || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('dotsBaseUrl must use the documented Dots API origin');
  }
  if (url.origin !== DEFAULT_DOTS_BASE_URL || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError('dotsBaseUrl must use the documented Dots API origin');
  }
  return url.origin;
}

export function validatedDotsModel(value, fallback = DEFAULT_DOTS_MODEL) {
  const model = String(value || fallback || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(model)) {
    throw new TypeError('dotsModel must be a model name without whitespace');
  }
  return model;
}

function optionalDotsBaseUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return validatedDotsBaseUrl(value);
}

function optionalDotsModel(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return validatedDotsModel(value);
}

export function normalizeModelApiSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('model API settings must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!MODEL_API_FIELDS.has(key)) throw new TypeError(`unknown model API setting: ${key}`);
  }
  return {
    textModel: optionalModelRef(input.textModel, 'textModel'),
    screeningModel: optionalModelRef(input.screeningModel, 'screeningModel'),
    reviewModel: optionalModelRef(input.reviewModel, 'reviewModel'),
    visionModel: optionalModelRef(input.visionModel, 'visionModel'),
    qualityModel: optionalModelRef(input.qualityModel, 'qualityModel'),
    imageModel: optionalModelRef(input.imageModel, 'imageModel'),
    modelProxyUrl: optionalProxyUrl(input.modelProxyUrl, 'modelProxyUrl'),
    imageProxyUrl: optionalProxyUrl(input.imageProxyUrl, 'imageProxyUrl'),
    imageTimeoutMs: optionalImageTimeout(input.imageTimeoutMs),
    copyGenerationProvider: optionalCopyGenerationProvider(input.copyGenerationProvider),
    copyGenerationThinking: optionalCopyGenerationThinking(input.copyGenerationThinking),
    dotsBaseUrl: optionalDotsBaseUrl(input.dotsBaseUrl),
    dotsModel: optionalDotsModel(input.dotsModel),
  };
}

function effectiveTimeout(override, environmentValue) {
  if (override !== null) return override;
  if (environmentValue === undefined || String(environmentValue).trim() === '') {
    return DEFAULT_IMAGE_TIMEOUT_MS;
  }
  const timeoutMs = Number(environmentValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 540_000) {
    throw new RangeError('imageTimeoutMs must be an integer between 30000 and 540000');
  }
  return timeoutMs;
}

export function effectiveModelApiConfig(input = {}, environment = process.env) {
  const settings = normalizeModelApiSettings(input);
  const copyGenerationProvider = optionalCopyGenerationProvider(
    settings.copyGenerationProvider ?? environment.XHS_COPY_GENERATION_PROVIDER,
  ) ?? DEFAULT_COPY_GENERATION_PROVIDER;
  const textModel = validatedModelRef(
    settings.textModel ?? environment.XHS_TEXT_MODEL,
    DEFAULT_TEXT_MODEL,
    'textModel',
  );
  const visionModel = validatedModelRef(
    settings.visionModel ?? environment.XHS_VISION_MODEL,
    textModel,
    'visionModel',
  );
  return {
    copyGenerationProvider,
    copyGenerationThinking: validatedCopyGenerationThinking(
      settings.copyGenerationThinking ?? environment.XHS_COPY_GENERATION_THINKING,
    ),
    dotsBaseUrl: validatedDotsBaseUrl(
      settings.dotsBaseUrl ?? environment.XHS_DOTS_BASE_URL,
    ),
    dotsModel: validatedDotsModel(settings.dotsModel ?? environment.XHS_DOTS_MODEL),
    textModel,
    screeningModel: validatedModelRef(
      settings.screeningModel ?? environment.XHS_SCREENING_MODEL,
      textModel,
      'screeningModel',
    ),
    reviewModel: validatedModelRef(
      settings.reviewModel ?? environment.XHS_REVIEW_MODEL,
      textModel,
      'reviewModel',
    ),
    visionModel,
    qualityModel: validatedModelRef(
      settings.qualityModel ?? environment.XHS_QUALITY_MODEL,
      visionModel,
      'qualityModel',
    ),
    imageModel: validatedModelRef(
      settings.imageModel ?? environment.XHS_IMAGE_MODEL,
      DEFAULT_IMAGE_MODEL,
      'imageModel',
    ),
    modelProxyUrl: optionalProxyUrl(
      settings.modelProxyUrl ?? environment.XHS_MODEL_PROXY_URL,
      'modelProxyUrl',
    ),
    imageProxyUrl: optionalProxyUrl(
      settings.imageProxyUrl ?? environment.XHS_IMAGE_PROXY_URL,
      'imageProxyUrl',
    ),
    imageTimeoutMs: effectiveTimeout(settings.imageTimeoutMs, environment.XHS_IMAGE_TIMEOUT_MS),
  };
}

export function publicModelApiStatus(input = {}, environment = process.env) {
  const effective = effectiveModelApiConfig(input, environment);
  return {
    copyGenerationProvider: effective.copyGenerationProvider,
    copyGenerationThinking: effective.copyGenerationThinking,
    dotsBaseUrl: effective.dotsBaseUrl,
    dotsModel: effective.dotsModel,
    dotsApiKeyConfigured: Boolean(String(environment.XHS_DOTS_API_KEY ?? '').trim()),
    textModel: effective.textModel,
    screeningModel: effective.screeningModel,
    reviewModel: effective.reviewModel,
    visionModel: effective.visionModel,
    qualityModel: effective.qualityModel,
    imageModel: effective.imageModel,
    modelProxyConfigured: Boolean(effective.modelProxyUrl),
    imageProxyConfigured: Boolean(effective.imageProxyUrl),
    imageTimeoutMs: effective.imageTimeoutMs,
  };
}
