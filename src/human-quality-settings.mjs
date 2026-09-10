export const MAX_HUMAN_QUALITY_REASONS = 10;
export const MAX_HUMAN_QUALITY_REASON_LENGTH = 50;
export const MAX_HUMAN_QUALITY_SCORE_TITLE_LENGTH = 20;
export const MAX_HUMAN_QUALITY_SCORE_DESCRIPTION_LENGTH = 80;
export const MAX_HUMAN_QUALITY_NOTE_PLACEHOLDER_LENGTH = 100;

export const HUMAN_QUALITY_SCORES = Object.freeze([1, 2, 2.5, 3]);

function frozenScoreDefinition(score, title, description) {
  return Object.freeze({ score, title, description });
}

export const DEFAULT_HUMAN_SCORE_DEFINITIONS = Object.freeze([
  frozenScoreDefinition(1, '不可用', '废弃或重新处理'),
  frozenScoreDefinition(2, '可修改', '改后需重新评分'),
  frozenScoreDefinition(2.5, '已达标', '可放行 · 小修易达 3 分'),
  frozenScoreDefinition(3, '优质可用', '无需修改 · 直接放行'),
]);

export const DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE = Object.freeze({
  copyPlaceholder: '说明文案的具体问题与建议处理方式',
  imagePlaceholder: '说明图片的具体问题、问题页与建议处理方式',
});

export const DEFAULT_COPY_REVIEW_DISPLAY = Object.freeze({
  showScoreDescriptions: true,
  showDeductionReasons: true,
});

export const DEFAULT_IMAGE_REVIEW_DISPLAY = Object.freeze({
  showDeductionReasons: true,
});

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
  scoreDefinitions: DEFAULT_HUMAN_SCORE_DEFINITIONS,
  copyReasons: DEFAULT_COPY_REASONS,
  imageReasons: DEFAULT_IMAGE_REASONS,
  noteGuidance: DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE,
  copyReviewDisplay: DEFAULT_COPY_REVIEW_DISPLAY,
  imageReviewDisplay: DEFAULT_IMAGE_REVIEW_DISPLAY,
});

function normalizedText(value, path, maximum) {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`);
  const text = value.trim().normalize('NFC');
  if (!text || [...text].length > maximum) {
    throw new RangeError(`${path} must contain between 1 and ${maximum} characters`);
  }
  if (/\p{C}/u.test(text)) throw new TypeError(`${path} cannot contain control characters`);
  return text;
}

function normalizedReasonText(value, path) {
  return normalizedText(value, path, MAX_HUMAN_QUALITY_REASON_LENGTH);
}

function normalizedScoreDefinitions(value) {
  const source = value === undefined ? DEFAULT_HUMAN_SCORE_DEFINITIONS : value;
  if (!Array.isArray(source) || source.length !== HUMAN_QUALITY_SCORES.length) {
    throw new RangeError('scoreDefinitions must contain exactly four fixed score levels');
  }
  const definitions = source.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`scoreDefinitions[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => !['score', 'title', 'description'].includes(key))
      || !['score', 'title', 'description'].every((key) => keys.includes(key))) {
      throw new TypeError(`scoreDefinitions[${index}] must contain only score, title and description`);
    }
    if (typeof entry.score !== 'number' || !HUMAN_QUALITY_SCORES.includes(entry.score)) {
      throw new TypeError(`scoreDefinitions[${index}].score must be one of 1, 2, 2.5 or 3`);
    }
    return {
      score: entry.score,
      title: normalizedText(
        entry.title,
        `scoreDefinitions[${index}].title`,
        MAX_HUMAN_QUALITY_SCORE_TITLE_LENGTH,
      ),
      description: normalizedText(
        entry.description,
        `scoreDefinitions[${index}].description`,
        MAX_HUMAN_QUALITY_SCORE_DESCRIPTION_LENGTH,
      ),
    };
  });
  const byScore = new Map(definitions.map((definition) => [definition.score, definition]));
  if (byScore.size !== HUMAN_QUALITY_SCORES.length
    || HUMAN_QUALITY_SCORES.some((score) => !byScore.has(score))) {
    throw new TypeError('scoreDefinitions must define each fixed score exactly once');
  }
  return HUMAN_QUALITY_SCORES.map((score) => {
    const definition = byScore.get(score);
    if (!definition) throw new TypeError(`scoreDefinitions is missing score ${score}`);
    return definition;
  });
}

function normalizedNoteGuidance(value) {
  const source = value === undefined ? DEFAULT_HUMAN_QUALITY_NOTE_GUIDANCE : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('noteGuidance must be an object');
  }
  const keys = Object.keys(source);
  if (keys.some((key) => !['copyPlaceholder', 'imagePlaceholder'].includes(key))
    || !['copyPlaceholder', 'imagePlaceholder'].every((key) => keys.includes(key))) {
    throw new TypeError('noteGuidance must contain only copyPlaceholder and imagePlaceholder');
  }
  return {
    copyPlaceholder: normalizedText(
      source.copyPlaceholder,
      'noteGuidance.copyPlaceholder',
      MAX_HUMAN_QUALITY_NOTE_PLACEHOLDER_LENGTH,
    ),
    imagePlaceholder: normalizedText(
      source.imagePlaceholder,
      'noteGuidance.imagePlaceholder',
      MAX_HUMAN_QUALITY_NOTE_PLACEHOLDER_LENGTH,
    ),
  };
}

function normalizedCopyReviewDisplay(value) {
  const source = value === undefined ? DEFAULT_COPY_REVIEW_DISPLAY : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('copyReviewDisplay must be an object');
  }
  const keys = Object.keys(source);
  if (keys.some((key) => !['showScoreDescriptions', 'showDeductionReasons'].includes(key))
    || !['showScoreDescriptions', 'showDeductionReasons'].every((key) => keys.includes(key))) {
    throw new TypeError('copyReviewDisplay must contain only showScoreDescriptions and showDeductionReasons');
  }
  if (typeof source.showScoreDescriptions !== 'boolean') {
    throw new TypeError('copyReviewDisplay.showScoreDescriptions must be a boolean');
  }
  if (typeof source.showDeductionReasons !== 'boolean') {
    throw new TypeError('copyReviewDisplay.showDeductionReasons must be a boolean');
  }
  return {
    showScoreDescriptions: source.showScoreDescriptions,
    showDeductionReasons: source.showDeductionReasons,
  };
}

function normalizedImageReviewDisplay(value) {
  const source = value === undefined ? DEFAULT_IMAGE_REVIEW_DISPLAY : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('imageReviewDisplay must be an object');
  }
  const keys = Object.keys(source);
  if (keys.some((key) => key !== 'showDeductionReasons') || !keys.includes('showDeductionReasons')) {
    throw new TypeError('imageReviewDisplay must contain only showDeductionReasons');
  }
  if (typeof source.showDeductionReasons !== 'boolean') {
    throw new TypeError('imageReviewDisplay.showDeductionReasons must be a boolean');
  }
  return { showDeductionReasons: source.showDeductionReasons };
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
  if (Object.keys(input).some((key) => ![
    'scoreDefinitions', 'copyReasons', 'imageReasons', 'noteGuidance', 'copyReviewDisplay', 'imageReviewDisplay',
  ].includes(key))) {
    throw new TypeError('human quality settings contain unsupported fields');
  }
  return {
    scoreDefinitions: normalizedScoreDefinitions(input.scoreDefinitions),
    copyReasons: normalizedReasonList(input.copyReasons, DEFAULT_COPY_REASONS, 'copyReasons'),
    imageReasons: normalizedReasonList(input.imageReasons, DEFAULT_IMAGE_REASONS, 'imageReasons'),
    noteGuidance: normalizedNoteGuidance(input.noteGuidance),
    copyReviewDisplay: normalizedCopyReviewDisplay(input.copyReviewDisplay),
    imageReviewDisplay: normalizedImageReviewDisplay(input.imageReviewDisplay),
  };
}

/** @param {unknown} input @param {unknown} [current] */
export function normalizeHumanQualitySettingsUpdate(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'copyReasons') || !Object.hasOwn(input, 'imageReasons')) {
    throw new TypeError('copyReasons and imageReasons are required');
  }
  const baseline = current === undefined ? DEFAULT_HUMAN_QUALITY_SETTINGS : current;
  return normalizeHumanQualitySettings({ ...normalizeHumanQualitySettings(baseline), ...input });
}
