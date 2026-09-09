export const MAX_HUMAN_QUALITY_REASONS = 10;
export const MAX_HUMAN_QUALITY_REASON_LENGTH = 50;

function frozenReason(code, label) {
  return Object.freeze({ code, label });
}

export const DEFAULT_COPY_REASONS = Object.freeze([
  frozenReason('FACT_OR_COMPLIANCE', '事实或合规风险'),
  frozenReason('STRUCTURE', '结构需要调整'),
  frozenReason('EXPRESSION', '措辞或语气问题'),
  frozenReason('TITLE', '标题吸引力不足'),
  frozenReason('INFORMATION_VALUE', '信息价值不足'),
  frozenReason('PLATFORM_FIT', '不符合平台表达'),
  frozenReason('TAGS', '标签需要调整'),
  frozenReason('IMAGE_PLAN', '图片文案规划问题'),
]);

export const DEFAULT_IMAGE_REASONS = Object.freeze([
  frozenReason('TEXT_ERROR', '画面文字错误'),
  frozenReason('CONTENT_MISMATCH', '与文案内容不符'),
  frozenReason('READABILITY', '排版或可读性'),
  frozenReason('AESTHETICS', '风格或美观度'),
  frozenReason('COMPOSITION', '构图或主体问题'),
  frozenReason('ARTIFACT', '图片瑕疵或清晰度'),
  frozenReason('COHERENCE', '图集重复或不连贯'),
  frozenReason('COMPLIANCE', '合规或版权风险'),
]);

export const DEFAULT_HUMAN_QUALITY_SETTINGS = Object.freeze({
  copyReasons: DEFAULT_COPY_REASONS,
  imageReasons: DEFAULT_IMAGE_REASONS,
});

function normalizedReasonText(value, path) {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`);
  const text = value.trim().normalize('NFC');
  if (!text || [...text].length > MAX_HUMAN_QUALITY_REASON_LENGTH) {
    throw new RangeError(`${path} must contain between 1 and ${MAX_HUMAN_QUALITY_REASON_LENGTH} characters`);
  }
  if (/\p{C}/u.test(text)) throw new TypeError(`${path} cannot contain control characters`);
  return text;
}

function normalizedReasonList(value, fallback, path) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source) || source.length > MAX_HUMAN_QUALITY_REASONS) {
    throw new RangeError(`${path} must contain at most ${MAX_HUMAN_QUALITY_REASONS} items`);
  }
  const result = source.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${path}[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => !['code', 'label'].includes(key)) || !keys.includes('code') || !keys.includes('label')) {
      throw new TypeError(`${path}[${index}] must contain only code and label`);
    }
    return {
      code: normalizedReasonText(entry.code, `${path}[${index}].code`),
      label: normalizedReasonText(entry.label, `${path}[${index}].label`),
    };
  });
  for (const field of ['code', 'label']) {
    const values = result.map((entry) => entry[field].toLocaleLowerCase('zh-CN'));
    if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicate ${field} values`);
  }
  return result;
}

/** @param {unknown} [input] */
export function normalizeHumanQualitySettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('human quality settings must be an object');
  }
  if (Object.keys(input).some((key) => !['copyReasons', 'imageReasons'].includes(key))) {
    throw new TypeError('human quality settings contain unsupported fields');
  }
  return {
    copyReasons: normalizedReasonList(input.copyReasons, DEFAULT_COPY_REASONS, 'copyReasons'),
    imageReasons: normalizedReasonList(input.imageReasons, DEFAULT_IMAGE_REASONS, 'imageReasons'),
  };
}

export function normalizeHumanQualitySettingsUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'copyReasons') || !Object.hasOwn(input, 'imageReasons')) {
    throw new TypeError('copyReasons and imageReasons are required');
  }
  return normalizeHumanQualitySettings(input);
}
