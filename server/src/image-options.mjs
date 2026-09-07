// Pure, versioned contract shared by the center, executor and browser.
export const IMAGE_CONTROLS_VERSION = 1;
export const IMAGE_FORMATS = Object.freeze({
  PNG: { extension: 'png', mediaType: 'image/png' },
  JPEG: { extension: 'jpg', mediaType: 'image/jpeg' },
  WEBP: { extension: 'webp', mediaType: 'image/webp' },
  AVIF: { extension: 'avif', mediaType: 'image/avif' },
  TIFF: { extension: 'tiff', mediaType: 'image/tiff' },
  GIF: { extension: 'gif', mediaType: 'image/gif' },
});
export const DEFAULT_IMAGE_SETTINGS = Object.freeze({ version: 1, format: 'PNG', quality: 90, background: 'SOLID', backgroundColor: '#f2eee7' });
export const PAGE_TEMPLATES = Object.freeze({
  hero: ['HERO_LEFT', 'HERO_RIGHT'], steps: ['STEPS_LEFT', 'STEPS_RIGHT', 'STEPS_DIAGONAL'],
  detail: ['DETAIL_LEFT_STACK', 'DETAIL_RIGHT_STACK', 'DETAIL_SPLIT'],
  comparison: ['COMPARISON_RIGHT_STACK', 'COMPARISON_TWO_COLUMN', 'COMPARISON_FOUR_COLUMN'],
  checklist: ['CHECKLIST_RIGHT', 'CHECKLIST_LOWER_GRID'], summary: ['SUMMARY_GRID'],
});

function record(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(`${name}.${key} is unsupported`);
}
function choice(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${field} must be ${min}–${max}`);
  return value;
}

export function normalizeImageSettings(value = {}) {
  record(value, Object.keys(DEFAULT_IMAGE_SETTINGS), 'imageSettings');
  const format = String(value.format ?? 'PNG').toUpperCase().replace(/^JPG$/, 'JPEG');
  choice(format, Object.keys(IMAGE_FORMATS), 'imageSettings.format');
  const background = choice(value.background ?? 'SOLID', ['SOLID', 'TRANSPARENT'], 'imageSettings.background');
  if (format === 'JPEG' && background === 'TRANSPARENT') throw new TypeError('JPEG 不支持透明背景，请选择实底或其他格式');
  const backgroundColor = value.backgroundColor ?? DEFAULT_IMAGE_SETTINGS.backgroundColor;
  if (typeof backgroundColor !== 'string' || !/^#[a-f0-9]{6}$/iu.test(backgroundColor)) throw new TypeError('imageSettings.backgroundColor must be #RRGGBB');
  return {
    version: choice(value.version ?? 1, [1], 'imageSettings.version'), format,
    quality: integer(value.quality ?? 90, 1, 100, 'imageSettings.quality'), background, backgroundColor: backgroundColor.toLowerCase(),
  };
}

export function normalizePageLayout(value, kind) {
  record(value, ['mode', 'template', 'titlePosition', 'subjectPosition', 'textPosition', 'alignment', 'imageShare', 'spacing', 'direction'], 'layout');
  const mode = choice(value.mode ?? 'AUTO', ['AUTO', 'TEMPLATE', 'CUSTOM'], 'layout.mode');
  if (mode === 'AUTO') return { mode };
  if (mode === 'TEMPLATE') return { mode, template: choice(value.template, PAGE_TEMPLATES[kind] ?? [], 'layout.template') };
  if (value.direction !== undefined && (typeof value.direction !== 'string' || [...value.direction].length > 1_000)) throw new TypeError('layout.direction must be at most 1000 characters');
  return {
    mode, titlePosition: choice(value.titlePosition ?? 'top-center', ['top-left', 'top-center', 'top-right', 'bottom'], 'layout.titlePosition'),
    subjectPosition: choice(value.subjectPosition ?? 'center', ['left', 'center', 'right', 'top', 'bottom', 'full'], 'layout.subjectPosition'),
    textPosition: choice(value.textPosition ?? 'bottom', ['left', 'right', 'top', 'bottom', 'overlay'], 'layout.textPosition'),
    alignment: choice(value.alignment ?? 'left', ['left', 'center', 'right'], 'layout.alignment'),
    imageShare: integer(value.imageShare ?? 60, 20, 90, 'layout.imageShare'),
    spacing: choice(value.spacing ?? 'normal', ['compact', 'normal', 'airy'], 'layout.spacing'),
    direction: (value.direction ?? '').trim(),
  };
}

export function hasImageControls(content) {
  return Boolean(content?.imageSettings || content?.imagePlan?.some(page => page.layout));
}
