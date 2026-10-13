import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const TEXT_REPAIR_RENDERER_VERSION = 'standard-font-v1';
export const TEXT_REPAIR_FONT_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da';
const FONT_PATH = fileURLToPath(new URL('../assets/fonts/NotoSansSC-VF.ttf', import.meta.url));
const FONT_FAMILY = 'Noto Sans SC';
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const cachedFonts = new Map();

function invalidFont() { throw new TypeError('标准中文字库损坏或不支持安全字形检查'); }
function bounded(buffer, start, length, end = buffer.length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > end) invalidFont();
}
function fontTables(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_FONT_BYTES) invalidFont();
  if (![0x00010000, 0x4f54544f].includes(buffer.readUInt32BE(0))) invalidFont();
  const count = buffer.readUInt16BE(4);
  if (!count || count > 128) invalidFont();
  bounded(buffer, 12, count * 16);
  const tables = new Map();
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    const name = buffer.toString('ascii', record, record + 4);
    const offset = buffer.readUInt32BE(record + 8), length = buffer.readUInt32BE(record + 12);
    bounded(buffer, offset, length);
    if (tables.has(name)) invalidFont();
    tables.set(name, { offset, length });
  }
  return tables;
}
function format12Coverage(buffer, start, cmapEnd, glyphCount) {
  bounded(buffer, start, 16, cmapEnd);
  const length = buffer.readUInt32BE(start + 4), count = buffer.readUInt32BE(start + 12);
  if (length < 16 || count > 100000 || 16 + count * 12 > length) invalidFont();
  bounded(buffer, start, length, cmapEnd);
  const groups = [];
  let previous = -1;
  for (let index = 0; index < count; index++) {
    const offset = start + 16 + index * 12;
    const first = buffer.readUInt32BE(offset), last = buffer.readUInt32BE(offset + 4), glyph = buffer.readUInt32BE(offset + 8);
    if (first <= previous || last < first || last > 0x10ffff || glyph + last - first >= glyphCount) invalidFont();
    groups.push({ first, last, glyph }); previous = last;
  }
  return codepoint => {
    let low = 0, high = groups.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1, group = groups[middle];
      if (codepoint < group.first) high = middle - 1;
      else if (codepoint > group.last) low = middle + 1;
      else return group.glyph + codepoint - group.first !== 0;
    }
    return false;
  };
}
function format4Coverage(buffer, start, cmapEnd, glyphCount) {
  bounded(buffer, start, 16, cmapEnd);
  const length = buffer.readUInt16BE(start + 2), segCountX2 = buffer.readUInt16BE(start + 6);
  const count = segCountX2 / 2;
  if (!count || !Number.isInteger(count) || count > 8192 || length < 16 + count * 8) invalidFont();
  bounded(buffer, start, length, cmapEnd);
  const ends = start + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, ranges = deltas + count * 2;
  const segments = [];
  let previous = -1;
  for (let index = 0; index < count; index++) {
    const first = buffer.readUInt16BE(starts + index * 2), last = buffer.readUInt16BE(ends + index * 2);
    const delta = buffer.readInt16BE(deltas + index * 2), range = buffer.readUInt16BE(ranges + index * 2);
    if (first > last || first <= previous) invalidFont();
    const glyphOffset = ranges + index * 2 + range;
    if (range) {
      if (range % 2 || glyphOffset < ranges + count * 2) invalidFont();
      bounded(buffer, glyphOffset, (last - first + 1) * 2, start + length);
    }
    segments.push({ first, last, delta, range, glyphOffset }); previous = last;
  }
  return codepoint => {
    if (codepoint > 0xffff) return false;
    let low = 0, high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1, segment = segments[middle];
      if (codepoint < segment.first) high = middle - 1;
      else if (codepoint > segment.last) low = middle + 1;
      else {
        let glyph = segment.range ? buffer.readUInt16BE(segment.glyphOffset + (codepoint - segment.first) * 2) : codepoint;
        if (!segment.range || glyph !== 0) glyph = (glyph + segment.delta) & 0xffff;
        if (glyph >= glyphCount) invalidFont();
        return glyph !== 0;
      }
    }
    return false;
  };
}
function readFontCoverage(buffer) {
  const tables = fontTables(buffer), cmap = tables.get('cmap'), maxp = tables.get('maxp');
  if (!cmap || !maxp || cmap.length < 4 || maxp.length < 6) invalidFont();
  const glyphCount = buffer.readUInt16BE(maxp.offset + 4), count = buffer.readUInt16BE(cmap.offset + 2);
  if (!glyphCount || buffer.readUInt16BE(cmap.offset) !== 0 || !count || count > 64) invalidFont();
  const cmapEnd = cmap.offset + cmap.length;
  bounded(buffer, cmap.offset + 4, count * 8, cmapEnd);
  const coverage = [], visited = new Set();
  for (let index = 0; index < count; index++) {
    const entry = cmap.offset + 4 + index * 8;
    const platform = buffer.readUInt16BE(entry), encoding = buffer.readUInt16BE(entry + 2);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const start = cmap.offset + buffer.readUInt32BE(entry + 4);
    bounded(buffer, start, 2, cmapEnd);
    if (start < cmap.offset + 4 + count * 8) invalidFont();
    if (visited.has(start)) continue;
    visited.add(start);
    const format = buffer.readUInt16BE(start);
    if (format === 12) coverage.push(format12Coverage(buffer, start, cmapEnd, glyphCount));
    else if (format === 4) coverage.push(format4Coverage(buffer, start, cmapEnd, glyphCount));
  }
  if (!coverage.length) invalidFont();
  return codepoint => coverage.some(supports => supports(codepoint));
}
function checkedText(text) {
  if (typeof text !== 'string' || [...text].length < 1 || [...text].length > 8 || /[\p{C}\p{Z}\s]/u.test(text)) {
    throw new TypeError('正确文字限 1 至 8 个可见字，不能包含空格或控制字符');
  }
  return text;
}
function assertCoverage(supports, text) {
  const missing = [...text].filter(character => !supports(character.codePointAt(0)));
  if (missing.length) throw new TypeError(`标准中文字库不包含：${[...new Set(missing)].join('')}，请更换文字`);
}
// Exposed for validating an OpenType file before trusting any fallback-free rendering.
export function validateTextRepairFontCoverage(fontBytes, text) {
  const cleanText = checkedText(text);
  assertCoverage(readFontCoverage(fontBytes), cleanText);
  return true;
}
async function loadFont(fontPath = FONT_PATH) {
  if (typeof fontPath !== 'string' || !fontPath) throw new TypeError('标准中文字库路径无效');
  const details = await stat(fontPath).catch(() => { throw new Error('标准中文字库缺失，请部署 assets/fonts/NotoSansSC-VF.ttf'); });
  if (!details.isFile() || details.size < 12 || details.size > MAX_FONT_BYTES) invalidFont();
  const key = `${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
  const previous = cachedFonts.get(fontPath);
  if (previous?.key === key) return previous;
  const bytes = await readFile(fontPath), sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== TEXT_REPAIR_FONT_SHA256) throw new Error('标准中文字库校验失败，请恢复随项目部署的原始字库');
  const entry = { key, fontPath, sha256, supports: readFontCoverage(bytes) };
  cachedFonts.set(fontPath, entry);
  return entry;
}
function weightValue(weight) {
  if (!Number.isInteger(weight) || weight < 400 || weight > 900) throw new TypeError('文字粗细必须为 400 至 900 的整数');
  return weight;
}
function dimensions(width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048)) {
    throw new TypeError('文字尺寸必须为 1 至 2048 的整数像素');
  }
}
function colorValue(color) {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)) return color.toLowerCase();
  if (color && typeof color === 'object' && !Array.isArray(color) && Object.keys(color).sort().join(',') === 'b,g,r'
    && [color.r, color.g, color.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return `#${[color.r, color.g, color.b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new TypeError('文字颜色必须为 #RRGGBB 或 RGB 整数');
}
function escapeMarkup(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function metadata(font, text, weight, color, width, height) {
  return { renderer: 'STANDARD_FONT', rendererVersion: TEXT_REPAIR_RENDERER_VERSION,
    fontFamily: FONT_FAMILY, fontSha256: font.sha256, text, weight, color, width, height };
}
async function glyphInk({ text, weight, color, fontPath }) {
  const font = await loadFont(fontPath);
  assertCoverage(font.supports, text);
  const png = await sharp({ text: { text: `<span fallback="false" weight="${weight}" foreground="${color}">${escapeMarkup(text)}</span>`,
    font: `${FONT_FAMILY} 256`, fontfile: font.fontPath, rgba: true, dpi: 144, wrap: 'none' } })
    .trim({ background: '#00000000', threshold: 0 }).png().toBuffer();
  return { font, png };
}
export async function getTextRepairFontMetadata({ fontPath } = {}) {
  const font = await loadFont(fontPath);
  return { renderer: 'STANDARD_FONT', rendererVersion: TEXT_REPAIR_RENDERER_VERSION, fontFamily: FONT_FAMILY, fontSha256: font.sha256 };
}
export async function renderTextRepairGlyph({ text, width, height, weight = 700, color = '#000000', fontPath } = {}) {
  checkedText(text); dimensions(width, height); weightValue(weight);
  const rgb = colorValue(color), ink = await glyphInk({ text, weight, color: rgb, fontPath });
  // Resize coverage only, then apply the exact chosen RGB. Resampling premultiplied
  // coloured pixels otherwise introduces coloured fringes around dense strokes.
  const alpha = await sharp(ink.png).resize(width, height, { fit: 'fill' }).extractChannel('alpha').raw().toBuffer();
  const png = await sharp({ create: { width, height, channels: 3, background: rgb } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return { png, metadata: metadata(ink.font, text, weight, rgb, width, height) };
}
export async function renderTextRepairReference({ text, weight = 700, fontPath } = {}) {
  checkedText(text); weightValue(weight);
  const ink = await glyphInk({ text, weight, color: '#000000', fontPath });
  const foreground = await sharp(ink.png).resize(896, 896, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } })
    .composite([{ input: foreground.data, left: Math.floor((1024 - foreground.info.width) / 2), top: Math.floor((1024 - foreground.info.height) / 2) }])
    .removeAlpha().png().toBuffer();
  return { png, metadata: metadata(ink.font, text, weight, '#000000', 1024, 1024) };
}
