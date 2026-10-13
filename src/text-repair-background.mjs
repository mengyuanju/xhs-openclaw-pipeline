import sharp from 'sharp';

const MAX_PIXELS = 16_000_000;
const distance = (a, b) => Math.max(...a.map((value, channel) => Math.abs(value - b[channel])));
const quantile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};
const medianColor = pixels => [0, 1, 2].map(channel => quantile(pixels.map(pixel => pixel.rgb[channel]), 0.5));
const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
const hexColor = rgb => '#' + rgb.map(value => clamp(value).toString(16).padStart(2, '0')).join('');
const basis = (x, y, rect) => [1, (x - rect.x) / Math.max(1, rect.width - 1) * 2 - 1,
  (y - rect.y) / Math.max(1, rect.height - 1) * 2 - 1];
const predict = (model, point) => model.map(channel => channel.reduce((sum, value, i) => sum + value * point[i], 0));

function solve(matrix, values) {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    if (Math.abs(divisor) < 1e-8) return null;
    for (let i = column; i < 4; i++) rows[column][i] /= divisor;
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = rows[row][column];
      for (let i = column; i < 4; i++) rows[row][i] -= factor * rows[column][i];
    }
  }
  return rows.map(row => row[3]);
}

function fitPlane(pixels, fallback) {
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const values = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const pixel of pixels) for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) matrix[i][j] += pixel.b[i] * pixel.b[j];
    for (let channel = 0; channel < 3; channel++) values[channel][i] += pixel.rgb[channel] * pixel.b[i];
  }
  const model = values.map(value => solve(matrix, value));
  return model.every(Boolean) ? model : fallback.map(value => [value, 0, 0]);
}

function normalizeRect(rect, width, height) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)
    || Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key))
    || ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
    || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
    || rect.x + rect.width > width || rect.y + rect.height > height) throw new TypeError('文字背景修复区域越界或无效');
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function pixelsIn(data, width, rect, margin) {
  const expanded = { x: Math.max(0, rect.x - margin), y: Math.max(0, rect.y - margin),
    right: Math.min(width, rect.x + rect.width + margin), bottom: rect.y + rect.height + margin };
  const height = data.length / width / 4;
  expanded.bottom = Math.min(height, expanded.bottom);
  const inside = [], ring = [];
  for (let y = expanded.y; y < expanded.bottom; y++) for (let x = expanded.x; x < expanded.right; x++) {
    const offset = (y * width + x) * 4;
    const pixel = { x, y, rgb: [data[offset], data[offset + 1], data[offset + 2]], alpha: data[offset + 3], b: basis(x, y, rect) };
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) inside.push(pixel);
    else ring.push(pixel);
  }
  return { inside, ring };
}

function projection(pixel, background, foreground) {
  const bg = predict(background, pixel.b), fg = predict(foreground, pixel.b);
  const delta = fg.map((value, channel) => value - bg[channel]);
  const denominator = delta.reduce((sum, value) => sum + value * value, 0);
  const raw = denominator ? delta.reduce((sum, value, channel) => sum + value * (pixel.rgb[channel] - bg[channel]), 0) / denominator : 0;
  const amount = Math.max(0, Math.min(1, raw));
  return { amount, residual: distance(pixel.rgb, bg.map((value, channel) => value + amount * delta[channel])),
    backgroundDistance: distance(pixel.rgb, bg), contrast: distance(fg, bg) };
}

function inkBounds(pixels, rect) {
  if (!pixels.length) return null;
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const pixel of pixels) {
    x = Math.min(x, pixel.x); y = Math.min(y, pixel.y);
    right = Math.max(right, pixel.x); bottom = Math.max(bottom, pixel.y);
  }
  return { x, y, width: Math.min(rect.x + rect.width - x, right - x + 1),
    height: Math.min(rect.y + rect.height - y, bottom - y + 1) };
}

function backgroundModel(ring, rect) {
  const opaque = ring.filter(pixel => pixel.alpha === 255);
  if (opaque.length < 24) return null;
  // Corners sit away from neighboring glyphs on the same text baseline.
  const corners = opaque.filter(pixel => (pixel.x < rect.x || pixel.x >= rect.x + rect.width)
    && (pixel.y < rect.y || pixel.y >= rect.y + rect.height));
  if (corners.length < 24) return null;
  const center = medianColor(corners);
  let selected = opaque.filter(pixel => distance(pixel.rgb, center) <= 40);
  if (selected.length / opaque.length < 0.4) return null;
  let model;
  for (let iteration = 0; iteration < 4; iteration++) {
    if (selected.length < 24) return null;
    model = fitPlane(selected, center);
    selected = opaque.filter(pixel => distance(pixel.rgb, predict(model, pixel.b)) <= 5);
  }
  const residuals = selected.map(pixel => distance(pixel.rgb, predict(model, pixel.b)));
  return { model, coverage: selected.length / ring.length, residual: quantile(residuals, 0.95),
    cornerCoverage: corners.filter(pixel => distance(pixel.rgb, predict(model, pixel.b)) <= 5).length / corners.length };
}

function dilatedMask(pixels, rect, radius) {
  const mask = new Uint8Array(rect.width * rect.height);
  for (const pixel of pixels) {
    const x = pixel.x - rect.x, y = pixel.y - rect.y;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx >= 0 && x + dx < rect.width && y + dy >= 0 && y + dy < rect.height) mask[(y + dy) * rect.width + x + dx] = 1;
    }
  }
  return mask;
}

function crossesInkBoundary(pixels, ring, background, foreground, rect) {
  const outside = new Map(ring.map(pixel => [`${pixel.x},${pixel.y}`, pixel]));
  for (const pixel of pixels) {
    if (pixel.amount <= 0.12 || pixel.backgroundDistance <= 12 || pixel.residual > 12) continue;
    const adjacent = [];
    if (pixel.x === rect.x) for (let delta = -1; delta <= 1; delta++) adjacent.push([pixel.x - 1, pixel.y + delta]);
    if (pixel.x === rect.x + rect.width - 1) for (let delta = -1; delta <= 1; delta++) adjacent.push([pixel.x + 1, pixel.y + delta]);
    if (pixel.y === rect.y) for (let delta = -1; delta <= 1; delta++) adjacent.push([pixel.x + delta, pixel.y - 1]);
    if (pixel.y === rect.y + rect.height - 1) for (let delta = -1; delta <= 1; delta++) adjacent.push([pixel.x + delta, pixel.y + 1]);
    for (const [x, y] of adjacent) {
      const neighbor = outside.get(`${x},${y}`);
      if (!neighbor || neighbor.alpha !== 255 || distance(pixel.rgb, neighbor.rgb) > Math.max(16, pixel.contrast * 0.15)) continue;
      const projected = projection(neighbor, background, foreground);
      if (projected.amount > 0.12 && projected.backgroundDistance > 12 && projected.residual <= 12) return true;
    }
  }
  return false;
}

/** Estimate a conservative smooth-background patch. It never edits or expands the supplied rectangle. */
export async function analyzeTextRepairBackground({ source, rect }) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > 40 * 1024 * 1024) throw new TypeError('文字背景源图无效或过大');
  const decoder = sharp(source, { failOn: 'warning', limitInputPixels: MAX_PIXELS, animated: true });
  const metadata = await decoder.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new TypeError('文字背景源图必须是静态位图');
  const { data, info } = await decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const region = normalizeRect(rect, info.width, info.height);
  const style = { color: null, fontWeight: null, glyphRect: null };
  const metrics = { reason: null, styleReliable: false, inkPixels: 0, erasedPixels: 0 };
  const reject = reason => ({ simple: false, cleaned: null, style, metrics: { ...metrics, reason } });
  if (region.width < 4 || region.height < 4 || region.width * region.height > 1_000_000) return reject('REGION_SIZE_UNSAFE');
  const margin = Math.max(8, Math.min(16, Math.round(Math.min(region.width, region.height) * 0.2)));
  const { inside, ring } = pixelsIn(data, info.width, region, margin);
  if (inside.some(pixel => pixel.alpha !== 255)) return reject('TRANSPARENT_BACKGROUND');
  const fitted = backgroundModel(ring, region);
  // A constant ring median still provides a tentative style for the model-only background fallback.
  const background = fitted?.model ?? medianColor(ring.length ? ring : inside).map(value => [value, 0, 0]);
  if (fitted) metrics.backgroundModel = background;
  const distances = inside.map(pixel => distance(pixel.rgb, predict(background, pixel.b)));
  const strongCutoff = Math.max(24, quantile(distances, 0.95) * 0.85);
  const strong = inside.filter((pixel, index) => distances[index] >= strongCutoff);
  if (strong.length < Math.max(4, inside.length * 0.005)) return reject('INSUFFICIENT_TEXT_CONTRAST');
  const color = medianColor(strong);
  let foreground = fitPlane(strong, color);
  const foregroundInliers = strong.filter(pixel => distance(pixel.rgb, predict(foreground, pixel.b)) < 12);
  if (foregroundInliers.length >= strong.length * 0.75) foreground = fitPlane(foregroundInliers, color);
  else foreground = color.map(value => [value, 0, 0]);
  const projected = inside.map(pixel => ({ ...pixel, ...projection(pixel, background, foreground) }));
  const ink = projected.filter(pixel => pixel.amount > 0.08 && pixel.backgroundDistance > 6 && pixel.residual <= 8);
  const coherent = strong.filter(pixel => distance(pixel.rgb, predict(foreground, pixel.b)) <= 16).length / strong.length;
  const contrast = quantile(ink.map(pixel => pixel.contrast), 0.5);
  metrics.inkPixels = ink.length;
  metrics.contrast = contrast;
  metrics.foregroundCoherence = coherent;
  style.glyphRect = inkBounds(ink, region);
  style.color = hexColor(color);
  // This is a size/density hint for the fixed-font renderer, not an identification of the source font.
  style.fontWeight = style.glyphRect && style.glyphRect.height >= 72
    && ink.length / (style.glyphRect.width * style.glyphRect.height) >= 0.52 ? 900 : 700;
  metrics.styleReliable = Boolean(style.glyphRect && coherent >= 0.75 && contrast >= 24);
  // Reject clipped strokes even when the background itself needs the model fallback.
  if (metrics.styleReliable && crossesInkBoundary(projected, ring, background, foreground, region)) return reject('INK_CROSSES_BOUNDARY');
  metrics.backgroundCoverage = fitted?.coverage ?? 0;
  metrics.backgroundResidual = fitted?.residual ?? null;
  metrics.cornerCoverage = fitted?.cornerCoverage ?? 0;
  if (!fitted || fitted.coverage < 0.4 || fitted.cornerCoverage < 0.8 || fitted.residual > 4.5) return reject('BACKGROUND_NOT_SMOOTH');
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => predict(background, [1, x, y]));
  metrics.backgroundRange = Math.max(...[0, 1, 2].map(channel => Math.max(...corners.map(rgb => rgb[channel])) - Math.min(...corners.map(rgb => rgb[channel]))));
  if (metrics.backgroundRange > 40 || corners.some(rgb => rgb.some(value => value < -1 || value > 256))) return reject('BACKGROUND_GRADIENT_UNSAFE');
  if (!metrics.styleReliable) return reject('FOREGROUND_NOT_UNIFORM');
  metrics.inkFraction = ink.length / inside.length;
  if (metrics.inkFraction < 0.005 || metrics.inkFraction > 0.85) return reject('TEXT_SHAPE_UNSAFE');
  // Generated lettering often has a narrow pale halo that is not a foreground/background blend.
  // Accept it only immediately beside a coherent opaque stroke, never as a broad background texture.
  const core = projected.filter(pixel => pixel.amount >= 0.72 && pixel.backgroundDistance >= 24 && pixel.residual <= 8);
  const coreMask = dilatedMask(core, region, 2);
  const haloNeighborhood = dilatedMask(core, region, 4);
  const mask = coreMask;
  let haloPixels = 0;
  for (let index = 0; index < projected.length; index++) {
    if (mask[index] || !haloNeighborhood[index]) continue;
    const pixel = projected[index], bg = predict(background, pixel.b);
    const delta = pixel.rgb.map((value, channel) => value - bg[channel]);
    const neutralRinging = pixel.backgroundDistance <= 24 && Math.max(...delta) - Math.min(...delta) <= 5;
    const coloredAntialias = pixel.amount > 0.025 && pixel.residual <= 18;
    if (pixel.backgroundDistance > 2 && (coloredAntialias || (pixel.backgroundDistance <= 48
      && (pixel.rgb.every((value, channel) => value >= bg[channel] - 2) || neutralRinging)))) {
      mask[index] = 1; haloPixels++;
    }
  }
  metrics.haloPixels = haloPixels;
  const backgroundPixels = projected.filter((pixel, index) => !mask[index]);
  metrics.unexplainedFraction = backgroundPixels.filter(pixel => pixel.backgroundDistance > 6).length / inside.length;
  metrics.intermediateFraction = projected.filter((pixel, index) => !mask[index] && pixel.amount >= 0.08).length / Math.max(1, ink.length);
  metrics.textureResidual = quantile(backgroundPixels.map(pixel => pixel.backgroundDistance), 0.95);
  metrics.remainingContrast = backgroundPixels.reduce((maximum, pixel) => Math.max(maximum, pixel.backgroundDistance), 0);
  metrics.backgroundFraction = backgroundPixels.length / inside.length;
  const denseGlyphWithClearCorners = fitted.cornerCoverage >= 0.95 && coherent >= 0.8;
  if ((!denseGlyphWithClearCorners && metrics.backgroundFraction < 0.1) || metrics.unexplainedFraction > 0.015
    || metrics.intermediateFraction > 0.05 || metrics.textureResidual > 5.5
    || metrics.remainingContrast > 24) return reject('TEXTURE_OR_SHADOW_UNSAFE');
  const patch = Buffer.alloc(inside.length * 4);
  for (let index = 0; index < inside.length; index++) {
    const pixel = inside[index], rgb = mask[index] ? predict(background, pixel.b).map(clamp) : pixel.rgb;
    for (let channel = 0; channel < 3; channel++) patch[index * 4 + channel] = rgb[channel];
    patch[index * 4 + 3] = pixel.alpha;
    metrics.erasedPixels += mask[index];
  }
  const cleaned = await sharp(patch, { raw: { width: region.width, height: region.height, channels: 4 } }).png().toBuffer();
  return { simple: true, cleaned, style, metrics: { ...metrics, reason: 'SMOOTH_BACKGROUND', backgroundModel: background } };
}
