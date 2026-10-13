import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { refineTextRepairLocalization } from '../src/text-repair-localization.mjs';
import { analyzeTextRepairBackground } from '../src/text-repair-background.mjs';

const foreground = [30, 60, 43], color = '#1e3c2b';
const inBox = (x, y, box) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
function gridGlyph(box, thickness = Math.max(3, Math.round(box.height * 0.12))) {
  return (x, y) => inBox(x, y, box) && (x < box.x + thickness || x >= box.x + box.width - thickness
    || y < box.y + thickness || y >= box.y + box.height - thickness
    || Math.abs(y - box.y - box.height / 2) < thickness / 2 || Math.abs(x - box.x - box.width / 2) < thickness / 2);
}
async function picture({ width = 240, height = 150, glyphs = [], background = () => [231, 226, 213], ink = foreground } = {}) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = glyphs.some(glyph => glyph(x, y)) ? ink : background(x, y), offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel++) raw[offset + channel] = rgb[channel];
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
const refine = (source, rect, region, correctText = '鳖') => refineTextRepairLocalization({ source, rect, region, correctText, color });
const uncertain = { code: 'TEXT_REPAIR_LOCALIZATION_UNCERTAIN' };

test('a coarse large heading box sheds both clipped neighboring glyphs without dropping target strokes', async () => {
  const ink = { x: 190, y: 65, width: 126, height: 140 };
  const source = await picture({ width: 480, height: 250, glyphs: [gridGlyph({ x: 50, y: 65, width: 126, height: 140 }),
    gridGlyph(ink), gridGlyph({ x: 321, y: 65, width: 126, height: 140 })] });
  const frozen = Buffer.from(source), result = await refine(source, { x: 184, y: 62, width: 141, height: 149 }, { x: 40, y: 45, width: 420, height: 180 });
  assert.deepEqual(result.metrics.inkRect, ink);
  assert.deepEqual(result.rect, { x: 187, y: 62, width: 132, height: 146 });
  assert.ok(result.rect.x + result.rect.width < 321); assert.ok(result.metrics.rejectedBoundaryComponents >= 2);
  assert.ok(source.equals(frozen));
});

test('a coarse small text box excludes a left neighbor remnant and keeps clean background on both sides', async () => {
  const ink = { x: 332, y: 370, width: 48, height: 50 };
  const source = await picture({ width: 470, height: 450, glyphs: [gridGlyph({ x: 276, y: 370, width: 50, height: 50 }),
    gridGlyph(ink), gridGlyph({ x: 385, y: 370, width: 48, height: 50 })] });
  const result = await refine(source, { x: 326, y: 367, width: 57, height: 55 }, { x: 260, y: 350, width: 180, height: 80 });
  assert.deepEqual(result.metrics.inkRect, ink); assert.deepEqual(result.rect, { x: 329, y: 367, width: 54, height: 56 });
  assert.equal((await analyzeTextRepairBackground({ source, rect: result.rect })).simple, true);
});

test('three disconnected strokes of 川 stay together instead of selecting only the middle stroke', async () => {
  const glyph = (x, y) => y >= 30 && y < 66 && [50, 61, 72].some(left => x >= left && x < left + 5);
  const source = await picture({ glyphs: [glyph] });
  const result = await refine(source, { x: 47, y: 27, width: 33, height: 42 }, { x: 35, y: 15, width: 60, height: 70 }, '川');
  assert.deepEqual(result.metrics.inkRect, { x: 50, y: 30, width: 27, height: 36 });
  assert.equal(result.metrics.componentCount, 3);
});

test('disconnected side strokes of 小 are included with its taller central stroke', async () => {
  const glyph = (x, y) => inBox(x, y, { x: 50, y: 40, width: 5, height: 22 })
    || inBox(x, y, { x: 61, y: 30, width: 5, height: 40 }) || inBox(x, y, { x: 73, y: 39, width: 5, height: 22 });
  const source = await picture({ glyphs: [glyph] });
  const result = await refine(source, { x: 47, y: 27, width: 34, height: 46 }, { x: 30, y: 15, width: 70, height: 75 }, '小');
  assert.deepEqual(result.metrics.inkRect, { x: 50, y: 30, width: 28, height: 40 });
});

test('a two-character target preserves the actual gap and both complete glyphs', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 }), gridGlyph({ x: 106, y: 30, width: 48, height: 50 })] });
  const result = await refine(source, { x: 46, y: 27, width: 112, height: 56 }, { x: 30, y: 15, width: 145, height: 80 }, '匍匐');
  assert.deepEqual(result.metrics.inkRect, { x: 50, y: 30, width: 104, height: 50 });
  assert.deepEqual(result.rect, { x: 47, y: 27, width: 110, height: 56 });
  assert.equal(result.metrics.characterCount, 2);
});

test('complete reliable lettering on a textured background can be localized for later background-only model cleanup', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 })],
    background: (x, y) => { const gray = 195 + (x * 11 + y * 17) % 35; return [gray, gray, gray]; } });
  const result = await refine(source, { x: 47, y: 27, width: 54, height: 56 }, { x: 30, y: 15, width: 85, height: 85 });
  assert.deepEqual(result.metrics.inkRect, { x: 50, y: 30, width: 48, height: 50 });
  assert.equal(result.metrics.background.simple, false);
  assert.notEqual(result.metrics.background.reason, 'INK_CROSSES_BOUNDARY');
});

test('white reversed lettering uses its supplied foreground color rather than a hardcoded dark threshold', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 })], ink: [245, 240, 225], background: () => [20, 30, 45] });
  const result = await refineTextRepairLocalization({ source, rect: { x: 47, y: 27, width: 54, height: 56 },
    region: { x: 30, y: 15, width: 85, height: 85 }, correctText: '鳖', color: '#f5f0e1' });
  assert.deepEqual(result.metrics.inkRect, { x: 50, y: 30, width: 48, height: 50 });
});

test('clipped target strokes, insufficient safe margins and compressed geometry are refused', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 })] });
  await assert.rejects(refine(source, { x: 57, y: 27, width: 38, height: 56 }, { x: 57, y: 20, width: 70, height: 75 }), uncertain);
  await assert.rejects(refine(source, { x: 50, y: 30, width: 48, height: 50 }, { x: 50, y: 30, width: 48, height: 50 }), uncertain);
  await assert.rejects(refine(source, { x: 45, y: 27, width: 80, height: 56 }, { x: 30, y: 15, width: 120, height: 85 }), uncertain);
});

test('a selected paragraph that cuts through the identified target gets an explicit boundary diagnosis', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 })] });
  const frozen = Buffer.from(source);
  await assert.rejects(refine(source, { x: 47, y: 33, width: 54, height: 50 }, { x: 30, y: 33, width: 85, height: 70 }),
    { ...uncertain, message: '框选区域切到原字笔画，请扩大句段选区' });
  assert.ok(source.equals(frozen));
});

test('visible antialias strokes outside the selected top edge are diagnosed without enlarging the write area', async () => {
  const glyphs = [gridGlyph({ x: 50, y: 30, width: 48, height: 50 }), gridGlyph({ x: 106, y: 30, width: 48, height: 50 })];
  const source = await picture({ glyphs, background: (x, y) => y === 29 && ((x >= 50 && x < 98) || (x >= 106 && x < 154))
    ? [151, 160, 145] : [231, 226, 213] });
  const frozen = Buffer.from(source), rect = { x: 46, y: 30, width: 112, height: 56 };
  await assert.rejects(refine(source, rect, { x: 30, y: 30, width: 145, height: 70 }, '匍匐'),
    { ...uncertain, message: '框选区域切到原字笔画，请扩大句段选区' });
  const expanded = { x: 30, y: 22, width: 145, height: 78 };
  const result = await refine(source, rect, expanded, '匍匐');
  assert.ok(result.rect.x >= expanded.x && result.rect.y >= expanded.y);
  assert.ok(result.rect.x + result.rect.width <= expanded.x + expanded.width);
  assert.ok(result.rect.y + result.rect.height <= expanded.y + expanded.height);
  assert.ok(source.equals(frozen));
});

test('a neighboring glyph touching the paragraph edge is not diagnosed as the target being cut', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 }),
    gridGlyph({ x: 100, y: 27, width: 48, height: 50 })] });
  await assert.rejects(refine(source, { x: 47, y: 27, width: 54, height: 56 }, { x: 30, y: 27, width: 140, height: 85 }),
    error => error.code === uncertain.code && !error.message.includes('框选区域切到原字笔画'));
});

test('an adjacent glyph with less than two clean pixels of margin is never included to make the crop fit', async () => {
  const source = await picture({ glyphs: [gridGlyph({ x: 50, y: 30, width: 48, height: 50 }), gridGlyph({ x: 100, y: 30, width: 48, height: 50 })] });
  await assert.rejects(refine(source, { x: 47, y: 27, width: 54, height: 56 }, { x: 30, y: 15, width: 140, height: 85 }), uncertain);
});

test('equally plausible component groupings are refused instead of guessing which strokes belong to one character', async () => {
  const source = await picture({ glyphs: [(x, y) => y >= 30 && y < 50 && [50, 57, 65, 72].some(left => x >= left && x < left + 6)] });
  await assert.rejects(refine(source, { x: 51, y: 27, width: 26, height: 26 }, { x: 30, y: 15, width: 70, height: 55 }, '川'), uncertain);
});

test('foreground-colored background objects and photographic noise do not become text boxes', async () => {
  const circle = await picture({ glyphs: [(x, y) => Math.hypot(x - 75, y - 55) <= 24] });
  await assert.rejects(refine(circle, { x: 48, y: 28, width: 54, height: 54 }, { x: 30, y: 15, width: 85, height: 85 }), uncertain);
  const noise = await picture({ background: (x, y) => [(x * 47 + y * 19) % 240, (x * 13 + y * 71) % 240, (x * 61 + y * 23) % 240] });
  await assert.rejects(refine(noise, { x: 48, y: 28, width: 54, height: 54 }, { x: 30, y: 15, width: 85, height: 85 }), uncertain);
});

test('invalid source, color, character count and out-of-user-region coordinates fail without changing the image', async () => {
  const source = await picture();
  const input = { source, rect: { x: 47, y: 27, width: 54, height: 56 }, region: { x: 30, y: 15, width: 85, height: 85 }, correctText: '鳖', color };
  for (const changes of [{ source: 'path' }, { color: null }, { color: '#fff' }, { correctText: '两 个' }, { correctText: '一二三四五六七八九' },
    { rect: { ...input.rect, x: 200 } }, { region: { x: 55, y: 30, width: 50, height: 50 } }]) {
    await assert.rejects(refineTextRepairLocalization({ ...input, ...changes }), uncertain);
  }
});
