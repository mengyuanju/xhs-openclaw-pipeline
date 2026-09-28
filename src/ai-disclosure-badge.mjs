import {
  DELIVERY_IMAGE_HEIGHT,
  DELIVERY_IMAGE_WIDTH,
} from './image-output-contract.mjs';

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const DISCLOSURE_TEXT = /^[\p{L}\p{N}_-]{1,12}$/u;
const FONT_STACK = "'Microsoft YaHei','Noto Sans CJK SC','PingFang SC',sans-serif";

export const AI_DISCLOSURE_FALLBACK_COLOR = '#68744A';
export const AI_DISCLOSURE_BADGE_VERSION = 1;

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizedColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toUpperCase() : null;
}

export function normalizeAiDisclosureBadgeColor(value) {
  const color = typeof value === 'string' && value.length === 7 ? normalizedColor(value) : null;
  if (!color) throw new TypeError('程序生成标识颜色必须为 #RRGGBB 六位十六进制颜色');
  return color;
}

function visualPalette(visualStyle) {
  if (!visualStyle || typeof visualStyle !== 'object' || Array.isArray(visualStyle)) return [];
  return Array.isArray(visualStyle.palette)
    ? visualStyle.palette.map(normalizedColor).filter(Boolean).slice(0, 5)
    : [];
}

export function resolveAiDisclosureColor(visualStyle, { storedStyle = null, badgeColor } = {}) {
  if (badgeColor !== undefined) {
    return { color: normalizeAiDisclosureBadgeColor(badgeColor), colorSource: 'USER_SELECTED', colorRole: 'custom' };
  }
  const storedColor = normalizedColor(storedStyle?.color);
  if (storedColor) {
    return {
      color: storedColor,
      colorSource: 'STORED_IMAGE_STYLE',
      colorRole: ['disclosure', 'accent', 'fallback', 'custom'].includes(storedStyle.colorRole)
        ? storedStyle.colorRole : 'disclosure',
    };
  }
  const semantic = normalizedColor(visualStyle?.disclosureColor)
    ?? normalizedColor(visualStyle?.colors?.disclosure);
  if (semantic) return { color: semantic, colorSource: 'VISUAL_PLAN', colorRole: 'disclosure' };
  const palette = visualPalette(visualStyle);
  if (palette.length > 0) {
    return { color: palette.at(-1), colorSource: 'VISUAL_PLAN', colorRole: 'accent' };
  }
  return {
    color: AI_DISCLOSURE_FALLBACK_COLOR,
    colorSource: 'FALLBACK',
    colorRole: 'fallback',
  };
}

// WCAG 2.2 relative luminance and contrast ratio use linearized sRGB channels:
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
export function resolveAiDisclosureTextColor(backgroundColor) {
  const color = normalizedColor(backgroundColor);
  if (!color) throw new TypeError('AI disclosure background must be a six-digit hex color');
  const channels = [1, 3, 5].map(index => {
    const channel = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast
    ? { textColor: '#000000', contrastRatio: blackContrast }
    : { textColor: '#FFFFFF', contrastRatio: whiteContrast };
}

export function resolveAiDisclosureVisualStyle(visualPlan) {
  if (!visualPlan || typeof visualPlan !== 'object' || Array.isArray(visualPlan)) return null;
  if (visualPlan.visualStyle && typeof visualPlan.visualStyle === 'object') {
    return visualPlan.visualStyle;
  }
  const pages = Array.isArray(visualPlan.pages) ? visualPlan.pages : [];
  return pages.find((page) => page?.visualStyle)?.visualStyle ?? null;
}

export function createAiDisclosureStyle({ text, visualStyle = null, storedStyle = null, variant = 'outline-pill', badgeColor } = {}) {
  if (typeof text !== 'string' || !DISCLOSURE_TEXT.test(text.trim())) {
    throw new TypeError('AI disclosure text must contain 1 to 12 letters, numbers, underscores or hyphens');
  }
  if (!['outline-pill', 'solid-pill'].includes(variant)) {
    throw new TypeError('AI disclosure badge variant must be outline-pill or solid-pill');
  }
  const normalizedText = text.trim();
  const fontSize = 20;
  const horizontalPadding = 20;
  const width = Math.max(120, Math.min(300, [...normalizedText].length * fontSize + horizontalPadding * 2));
  const height = 36;
  const margin = 24;
  const color = resolveAiDisclosureColor(visualStyle, { storedStyle, badgeColor });
  return {
    version: AI_DISCLOSURE_BADGE_VERSION,
    text: normalizedText,
    ...color,
    fontSize,
    fontWeight: 600,
    position: 'bottom-right',
    variant,
    ...(variant === 'solid-pill' ? {
      ...resolveAiDisclosureTextColor(color.color),
      backgroundColor: color.color,
      borderColor: color.color,
    } : {}),
    width,
    height,
    margin,
    strokeWidth: 1.5,
    x: DELIVERY_IMAGE_WIDTH - margin - width,
    y: DELIVERY_IMAGE_HEIGHT - margin - height,
  };
}

export function aiDisclosureBadgeSvg(input) {
  const style = createAiDisclosureStyle(input);
  const centerX = style.x + style.width / 2;
  const centerY = style.y + style.height / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DELIVERY_IMAGE_WIDTH}" height="${DELIVERY_IMAGE_HEIGHT}" viewBox="0 0 ${DELIVERY_IMAGE_WIDTH} ${DELIVERY_IMAGE_HEIGHT}">
    <g data-overlay-role="ai-disclosure" fill="${style.backgroundColor ?? 'none'}" stroke="${style.color}" stroke-width="${style.strokeWidth}">
      <rect x="${style.x + style.strokeWidth / 2}" y="${style.y + style.strokeWidth / 2}" width="${style.width - style.strokeWidth}" height="${style.height - style.strokeWidth}" rx="${style.height / 2}"/>
    </g>
    <text x="${centerX}" y="${centerY}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" fill="${style.textColor ?? style.color}">${escapeXml(style.text)}</text>
  </svg>`;
}
