import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { analyzeTextRepairBackground } from '../src/text-repair-background.mjs';

const dimensions = { width: 104, height: 94 };
const rect = { x: 20, y: 14, width: 48, height: 62 };
const rectangles = [[25, 20, 7, 48], [56, 20, 7, 48], [25, 20, 38, 7], [25, 40, 38, 7], [25, 61, 38, 7]];
const inside = (x, y, area) => x >= area[0] && y >= area[1] && x < area[0] + area[2] && y < area[1] + area[3];
function coverage(x, y, antialias) {
  if (rectangles.some(area => inside(x, y, area))) return 1;
  if (antialias && rectangles.some(([left, top, width, height]) => inside(x, y, [left - 1, top - 1, width + 2, height + 2]))) return 0.25;
  return 0;
}
async function fixture({ background = () => [232, 228, 216], foreground = [24, 61, 44], antialias = false, neighbor = false, alpha = 255, rgb = false } = {}) {
  const data = Buffer.alloc(dimensions.width * dimensions.height * 4);
  const empty = Buffer.alloc(data.length);
  for (let y = 0; y < dimensions.height; y++) for (let x = 0; x < dimensions.width; x++) {
    const offset = (y * dimensions.width + x) * 4, bg = background(x, y);
    const ink = neighbor && x >= 72 && x < 77 && y >= 18 && y < 70 ? 1 : coverage(x, y, antialias);
    for (let channel = 0; channel < 3; channel++) {
      data[offset + channel] = Math.round(bg[channel] * (1 - ink) + foreground[channel] * ink);
      empty[offset + channel] = bg[channel];
    }
    data[offset + 3] = alpha; empty[offset + 3] = alpha;
  }
  let encoder = sharp(data, { raw: { ...dimensions, channels: 4 } });
  if (rgb) encoder = encoder.removeAlpha();
  return { source: await encoder.png().toBuffer(), empty, data };
}
const raw = bytes => sharp(bytes).ensureAlpha().raw().toBuffer();
async function compareCleaned(result, empty, tolerance = 0) {
  const pixels = await raw(result.cleaned);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const local = (y * rect.width + x) * 4, global = ((y + rect.y) * dimensions.width + x + rect.x) * 4;
    for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(pixels[local + channel] - empty[global + channel]) <= tolerance,
      `residue at ${x},${y}, channel ${channel}`);
  }
}

test('opaque RGB text is erased without mutating the source or the neighboring letter outside the patch', async () => {
  const { source, empty } = await fixture({ rgb: true, neighbor: true });
  const frozen = Buffer.from(source), result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.equal(result.style.color, '#183d2c');
  assert.deepEqual(result.style.glyphRect, { x: 25, y: 20, width: 38, height: 48 });
  assert.ok(result.metrics.erasedPixels > result.metrics.inkPixels);
  await compareCleaned(result, empty);
  const output = await sharp(source).composite([{ input: result.cleaned, left: rect.x, top: rect.y }]).png().toBuffer();
  const [before, after] = await Promise.all([source, output].map(raw));
  for (let y = 0; y < dimensions.height; y++) for (let x = 0; x < dimensions.width; x++) {
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue;
    const offset = (y * dimensions.width + x) * 4;
    assert.ok(before.subarray(offset, offset + 4).equals(after.subarray(offset, offset + 4)));
  }
  assert.ok(source.equals(frozen));
});

test('reverse white text on a dark background is recognized and erased without assuming dark ink', async () => {
  const { source, empty } = await fixture({ background: () => [18, 29, 52], foreground: [245, 240, 225] });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.equal(result.style.color, '#f5f0e1');
  await compareCleaned(result, empty);
});

test('colored text is separated using RGB even when the background is also saturated', async () => {
  const { source, empty } = await fixture({ background: () => [29, 47, 150], foreground: [195, 35, 51] });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.equal(result.style.color, '#c32333');
  await compareCleaned(result, empty);
});

test('a slight two-dimensional gradient is reconstructed and antialiased old edges leave no visible trace', async () => {
  const background = (x, y) => [224 + Math.round(x * 0.08 + y * 0.025), 220 + Math.round(x * 0.05), 209 + Math.round(y * 0.04)];
  const { source, empty } = await fixture({ background, antialias: true });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.ok(result.metrics.backgroundRange < 12);
  await compareCleaned(result, empty, 1);
});

test('very faint background grain is tolerated without replacing the entire rectangle', async () => {
  const { source } = await fixture({ background: (x, y) => [230 + (x + y) % 2, 226 + x % 2, 214 + y % 2] });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.ok(result.metrics.erasedPixels < rect.width * rect.height * 0.8);
});

test('a narrow pale outline touching the old strokes is removed, while broad shadows are rejected', async () => {
  const { data, empty } = await fixture();
  for (let y = 0; y < dimensions.height; y++) for (let x = 0; x < dimensions.width; x++) {
    if (coverage(x, y, false) || !coverage(x, y, true)) continue;
    const offset = (y * dimensions.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.min(255, empty[offset + channel] + 12);
  }
  const outlined = await sharp(data, { raw: { ...dimensions, channels: 4 } }).png().toBuffer();
  const accepted = await analyzeTextRepairBackground({ source: outlined, rect });
  assert.equal(accepted.simple, true); await compareCleaned(accepted, empty);
  const { source } = await fixture({ background: (x, y) => inside(x, y, [22, 17, 44, 54]) ? [210, 206, 194] : [232, 228, 216] });
  const rejected = await analyzeTextRepairBackground({ source, rect });
  assert.equal(rejected.simple, false); assert.equal(rejected.cleaned, null);
});

test('an isolated colored antialias speck beside a stroke cannot remain as an old-text remnant', async () => {
  const { data, empty } = await fixture();
  const offset = (31 * dimensions.width + 34) * 4;
  data[offset] = 132; data[offset + 1] = 141; data[offset + 2] = 135;
  const source = await sharp(data, { raw: { ...dimensions, channels: 4 } }).png().toBuffer();
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, true); assert.ok(result.metrics.remainingContrast < 1);
  await compareCleaned(result, empty);
});

test('a small dense glyph can use its clear outer corners when two-pixel edge cleanup fills its tiny interior gaps', async () => {
  const data = Buffer.alloc(80 * 70 * 3, 232), region = { x: 24, y: 16, width: 30, height: 35 };
  for (let y = 18; y < 49; y++) for (let x = 26; x < 52; x++) {
    if ((x - 26) % 6 < 3 || (y - 18) % 7 < 3) {
      const offset = (y * 80 + x) * 3;
      data[offset] = 22; data[offset + 1] = 42; data[offset + 2] = 30;
    }
  }
  const source = await sharp(data, { raw: { width: 80, height: 70, channels: 3 } }).png().toBuffer();
  const result = await analyzeTextRepairBackground({ source, rect: region });
  assert.equal(result.simple, true); assert.equal(result.metrics.cornerCoverage, 1);
  const cleaned = await raw(result.cleaned);
  for (let index = 0; index < cleaned.length; index += 4) assert.deepEqual([...cleaned.subarray(index, index + 4)], [232, 232, 232, 255]);
});

test('photographic color variation is not blindly flattened into a fitted plane', async () => {
  const background = (x, y) => [(x * 47 + y * 19) % 230, (x * 13 + y * 71) % 220, (x * 61 + y * 23) % 240];
  const { source } = await fixture({ background });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, false); assert.equal(result.cleaned, null);
});

test('monochrome photographic texture and a split-color panel both require background-only model cleanup', async () => {
  for (const background of [(x, y) => { const gray = 200 + (x * 11 + y * 17) % 31; return [gray, gray, gray]; },
    (x) => x < 46 ? [235, 231, 220] : [150, 175, 189]]) {
    const { source } = await fixture({ background });
    const result = await analyzeTextRepairBackground({ source, rect });
    assert.equal(result.simple, false); assert.equal(result.cleaned, null);
  }
});

test('a severe gradient is rejected rather than extrapolated across the glyph', async () => {
  const { source } = await fixture({ background: x => [145 + x, 140 + x, 130 + x] });
  const result = await analyzeTextRepairBackground({ source, rect });
  assert.equal(result.simple, false); assert.equal(result.cleaned, null);
});

test('a clipped old stroke is detected so replacing only the supplied rectangle cannot leave an exterior remnant', async () => {
  const { source } = await fixture();
  const result = await analyzeTextRepairBackground({ source, rect: { ...rect, x: 26, width: 42 } });
  assert.equal(result.simple, false); assert.equal(result.cleaned, null);
  assert.equal(result.metrics.reason, 'INK_CROSSES_BOUNDARY');
});

test('clipped strokes on a textured background are rejected before a paid background cleanup can be considered', async () => {
  const { source } = await fixture({ background: (x, y) => { const gray = 200 + (x * 11 + y * 17) % 31; return [gray, gray, gray]; } });
  const result = await analyzeTextRepairBackground({ source, rect: { ...rect, x: 26, width: 42 } });
  assert.equal(result.simple, false); assert.equal(result.cleaned, null); assert.equal(result.metrics.styleReliable, true);
  assert.equal(result.metrics.reason, 'INK_CROSSES_BOUNDARY');
});

test('ink near a different edge is not mistaken for a continuation of an unclipped target stroke', async () => {
  const { data } = await fixture();
  const offset = (13 * dimensions.width + 40) * 4;
  data[offset] = 24; data[offset + 1] = 61; data[offset + 2] = 44;
  const source = await sharp(data, { raw: { ...dimensions, channels: 4 } }).png().toBuffer();
  const result = await analyzeTextRepairBackground({ source, rect: { ...rect, x: 25, width: 43 } });
  assert.equal(result.simple, true); assert.notEqual(result.metrics.reason, 'INK_CROSSES_BOUNDARY');
});

test('missing contrast, transparency and tiny regions cannot produce a supposedly safe cleaned patch', async () => {
  const cases = [await fixture({ foreground: [231, 227, 215] }), await fixture({ alpha: 180 })];
  for (const { source } of cases) {
    const result = await analyzeTextRepairBackground({ source, rect });
    assert.equal(result.simple, false); assert.equal(result.cleaned, null);
  }
  const { source } = await fixture();
  assert.equal((await analyzeTextRepairBackground({ source, rect: { x: 1, y: 1, width: 2, height: 2 } })).simple, false);
});

test('source type and rectangle bounds fail before unsafe image operations', async () => {
  const { source } = await fixture();
  for (const invalid of [{ ...rect, x: -1 }, { ...rect, width: 900 }, { ...rect, height: 1.5 }, { ...rect, extra: true }, null]) {
    await assert.rejects(analyzeTextRepairBackground({ source, rect: invalid }), /区域越界或无效/u);
  }
  await assert.rejects(analyzeTextRepairBackground({ source: 'not bytes', rect }), /源图无效/u);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>');
  await assert.rejects(analyzeTextRepairBackground({ source: svg, rect }), /静态位图/u);
});
