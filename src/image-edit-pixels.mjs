import sharp from 'sharp';
import { createHash } from 'node:crypto';

export const EDIT_WIDTH = 1086;
export const EDIT_HEIGHT = 1448;
export const imageHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function boundedNumber(value, min, max, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new TypeError('图片参数超出安全范围');
  return value;
}
export function shortText(value, max = 2000, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b-\u001f]/u.test(value)) throw new TypeError('文字参数无效');
  return value.trim();
}
const escapeXml = value => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function safeRect(rect, margin = 0) {
  if (!rect || typeof rect !== 'object') throw new TypeError('缺少选区');
  const x = boundedNumber(rect.x, margin, EDIT_WIDTH - margin - 1);
  const y = boundedNumber(rect.y, margin, EDIT_HEIGHT - margin - 1);
  const width = boundedNumber(rect.width, 1, EDIT_WIDTH - margin - x);
  const height = boundedNumber(rect.height, 1, EDIT_HEIGHT - margin - y);
  return { x, y, width, height };
}
export function normalizeManualOverlay(input) {
  const text = shortText(input?.text, 48);
  if (/\s/u.test(text.replaceAll(' ', ''))) throw new TypeError('请输入单行短句');
  const size = boundedNumber(input.size ?? 32, 16, 100);
  const margin = boundedNumber(input.margin ?? 32, 16, 160);
  const opacity = boundedNumber(input.opacity ?? 1, 0.1, 1, false);
  const color = input.color ?? '#ffffff', background = input.background ?? '#111827';
  if (![color, background].every(value => /^#[a-f0-9]{6}$/iu.test(value))) throw new TypeError('颜色必须为六位十六进制');
  const width = [...text].length * size + 24, height = Math.ceil(size * 1.5) + 16;
  const position = input.position ?? 'bottom-right';
  if (!['top-left','top-right','bottom-left','bottom-right','top','bottom','custom'].includes(position)) throw new TypeError('文字位置无效');
  const x = position === 'custom' ? input.x : position.endsWith('left') ? margin : ['top','bottom'].includes(position) ? Math.floor((EDIT_WIDTH - width) / 2) : EDIT_WIDTH - margin - width;
  const y = position === 'custom' ? input.y : position.startsWith('top') ? margin : EDIT_HEIGHT - margin - height;
  const rect = safeRect({ x, y, width, height }, margin);
  const disclosureType = input.disclosureType ?? null;
  if (disclosureType !== null && disclosureType !== 'AI_GENERATED') throw new TypeError('标识类型无效');
  const textType = input.textType ?? (disclosureType === 'AI_GENERATED' ? 'AI_DISCLOSURE' : 'CUSTOM');
  if (!['HEADLINE','SUBTITLE','BULLET','LABEL','AI_DISCLOSURE','CUSTOM'].includes(textType)) throw new TypeError('文字类型无效');
  if (textType === 'AI_DISCLOSURE' && disclosureType !== 'AI_GENERATED') throw new TypeError('AI 标识文字必须记录合规标识类型');
  return { text, textType, size, margin, opacity, color, background, position, ...rect, disclosureType };
}
export function manualOverlaySvg(input) {
  const o = normalizeManualOverlay(input);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448"><g opacity="${o.opacity}"><rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" rx="8" fill="${o.background}"/><text x="${o.x + 12}" y="${o.y + 8 + o.size}" font-family="Noto Sans CJK SC,Microsoft YaHei,sans-serif" font-size="${o.size}" fill="${o.color}">${escapeXml(o.text)}</text></g></svg>`;
}
export async function decodeReference(bytes, mediaType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new TypeError('参考图片上限为 5 MB');
  const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
  if (!formats[mediaType]) throw new TypeError('仅支持 PNG/JPEG/WebP');
  const signature = mediaType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mediaType === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
      : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if(!signature)throw new TypeError('文件签名与声明类型不符');
  const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 16_000_000, animated: true });
  const metadata = await decoder.metadata();
  if (metadata.format !== formats[mediaType] || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new TypeError('图片类型不符或为动画');
  const clean = await decoder.rotate().png().toBuffer();
  if (clean.length > 10 * 1024 * 1024) throw new TypeError('解码后图片过大');
  const normalized = await sharp(clean).metadata();
  return { bytes: clean, sha256: imageHash(clean), originalSha256: imageHash(bytes), originalMediaType: mediaType, width: normalized.width, height: normalized.height };
}
export function normalizeMask(mask) {
  if (mask?.type === 'rect') return { type: 'rect', ...safeRect(mask) };
  if (mask?.type !== 'brush' || !Array.isArray(mask.points) || mask.points.length < 1 || mask.points.length > 2000) throw new TypeError('局部修改需要矩形或画笔选区');
  const radius = boundedNumber(mask.radius, 2, 150);
  return { type: 'brush', radius, points: mask.points.map(p => ({ x: boundedNumber(p.x, 0, 1085), y: boundedNumber(p.y, 0, 1447) })) };
}
export async function renderMask(input) {
  const m = normalizeMask(input);
  const shape = m.type === 'rect' ? `<rect x="${m.x}" y="${m.y}" width="${m.width}" height="${m.height}" fill="white"/>`
    : m.points.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${m.radius}" fill="white"/>${i ? `<line x1="${m.points[i-1].x}" y1="${m.points[i-1].y}" x2="${p.x}" y2="${p.y}" stroke="white" stroke-width="${m.radius*2}"/>` : ''}`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448"><rect width="1086" height="1448" fill="black"/>${shape}</svg>`)).greyscale().threshold(127).png().toBuffer();
}
export async function mergeWithMask(source, generated, mask) {
  const [s, g, m] = await Promise.all([source, generated, mask].map((bytes, i) => i === 2 ? sharp(bytes).greyscale().raw().toBuffer() : sharp(bytes).ensureAlpha().raw().toBuffer()));
  if (s.length !== 1086*1448*4 || g.length !== s.length || m.length !== 1086*1448) throw new TypeError('遮罩或图片尺寸错误');
  const result = Buffer.from(s);
  for (let p = 0; p < m.length; p++) if (m[p] === 255) g.copy(result, p*4, p*4, p*4+4);
  return sharp(result, { raw: { width: 1086, height: 1448, channels: 4 } }).png().toBuffer();
}
export async function assertOutsideMask(source, result, mask) {
  const [s,r,m] = await Promise.all([sharp(source).ensureAlpha().raw().toBuffer(), sharp(result).ensureAlpha().raw().toBuffer(), sharp(mask).greyscale().raw().toBuffer()]);
  if (s.length !== r.length || s.length !== m.length*4) throw new TypeError('遮罩尺寸不符');
  let changed = 0;
  for(let p=0;p<m.length;p++) if(m[p] !== 255 && !s.subarray(p*4,p*4+4).equals(r.subarray(p*4,p*4+4))) changed++;
  if(changed) throw new Error('遮罩外像素发生变化');
  return { passed: true, changedPixels: changed, threshold: 0 };
}
