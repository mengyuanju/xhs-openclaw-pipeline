import sharp from 'sharp';
import { safeRect, shortText, EDIT_WIDTH, EDIT_HEIGHT } from './image-edit-pixels.mjs';

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function knownFields(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('错字修复参数无效');
}
export function normalizeTextRepairs(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw new TypeError('请添加 1 至 16 处错字修复');
  const ids = new Set();
  return input.map(value => {
    knownFields(value, ['id', 'correctText', 'contextText', 'region']);
    const id = shortText(value.id, 80);
    if (!/^[\w-]+$/u.test(id) || ids.has(id)) throw new TypeError('错字修复编号无效或重复');
    ids.add(id);
    const correctText = shortText(value.correctText, 32);
    if ([...correctText].length < 1 || [...correctText].length > 8 || /\s/u.test(correctText)) throw new TypeError('正确文字限 1 至 8 个字，不能包含空格');
    knownFields(value.region, ['x', 'y', 'width', 'height']);
    const region = safeRect(value.region);
    if (region.width < 24 || region.height < 24) throw new TypeError('请框选完整句子或小段文字，选区至少为 24×24 像素');
    const contextText = value.contextText === undefined ? '' : shortText(value.contextText, 500, false);
    return { id, correctText, ...(contextText ? { contextText } : {}), region };
  });
}
export function validateTextRepairRect(rect, item) {
  knownFields(rect, ['x', 'y', 'width', 'height']);
  const actual = safeRect(rect);
  const context = safeRect(item?.region);
  if (actual.x < context.x || actual.y < context.y || actual.x + actual.width > context.x + context.width
    || actual.y + actual.height > context.y + context.height) throw new TypeError('实际修复位置超出用户框选的文字段落');
  if (actual.width === context.width && actual.height === context.height) throw new TypeError('请定位实际错字，不能把整段选区作为替换区域');
  return actual;
}
export function assertTextRepairRegions(regions) {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 16) throw new TypeError('错字修复位置数量无效');
  const safe = regions.map(region => safeRect(region));
  for (let a = 0; a < safe.length; a++) for (let b = a + 1; b < safe.length; b++) {
    const first = safe[a], second = safe[b];
    if (first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y) throw new TypeError('两处错字的实际替换位置重叠，请调整框选或合并修复项');
  }
  return safe;
}
export async function renderTextRepairMask(regions) {
  const safe = assertTextRepairRegions(regions);
  const rectangles = safe.map(rect => `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="white"/>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${EDIT_WIDTH}" height="${EDIT_HEIGHT}"><rect width="100%" height="100%" fill="black"/>${rectangles}</svg>`))
    .removeAlpha().greyscale().png().toBuffer();
}
