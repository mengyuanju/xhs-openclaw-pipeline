import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeImageSettings, normalizePageLayout } from '../server/src/image-options.mjs';
import { prepareImageArtifacts } from '../src/image-artifacts.mjs';

test('image options reject unsupported formats, alpha loss and untrusted configuration fields', () => {
  assert.equal(normalizeImageSettings({ format: 'jpg' }).format, 'JPEG');
  assert.throws(() => normalizeImageSettings({ format: 'SVG' }), /format/);
  assert.throws(() => normalizeImageSettings({ format: 'TIFF' }), /format/);
  assert.throws(() => normalizeImageSettings({ format: 'JPEG', background: 'TRANSPARENT' }), /JPEG/);
  assert.throws(() => normalizeImageSettings({ backgroundColor: 'url(secret)' }), /backgroundColor/);
  assert.throws(() => normalizeImageSettings({ quality: 101 }), /quality/);
  assert.throws(() => normalizeImageSettings({ outputPath: '../secret' }), /outputPath/);
  assert.throws(() => normalizePageLayout({ mode: 'TEMPLATE', template: 'HERO_LEFT' }, 'steps'), /template/);
  const custom = normalizePageLayout({ mode: 'CUSTOM', direction: '标题放下方，右侧留出插画区', imageShare: 65 }, 'hero');
  assert.equal(custom.direction, '标题放下方，右侧留出插画区');
  assert.equal(custom.imageShare, 65);
});

test('all supported formats produce actual encoded delivery and a preview decoded from delivery; source alpha survives', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'image-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await sharp({ create: { width: 24, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  for (const [format, detected] of Object.entries({ PNG: 'png', JPEG: 'jpeg', WEBP: 'webp', AVIF: 'heif', GIF: 'gif' })) {
    const result = await prepareImageArtifacts({ source, outputDir: directory, file: '01-hero.png', settings: { format, backgroundColor: '#29aabb' } });
    const delivery = await readFile(join(directory, result.deliveryFile));
    assert.equal((await sharp(delivery).metadata()).format, detected);
    assert.equal(result.transparency.source, true);
    assert.equal(result.transparency.delivery, false);
    assert.equal((await sharp(join(directory, result.sourceFile)).stats()).isOpaque, false);
    const actual = await sharp(delivery).ensureAlpha().raw().toBuffer();
    const preview = await sharp(join(directory, result.file)).ensureAlpha().raw().toBuffer();
    assert.deepEqual(preview, actual, format);
    assert.ok(Math.abs(actual[0] - 41) < 6 && Math.abs(actual[1] - 170) < 6, format);
  }
  const result = await prepareImageArtifacts({ source, outputDir: directory, file: '01-hero.png', settings: { format: 'PNG', background: 'TRANSPARENT' } });
  assert.equal(result.transparency.delivery, true);
});

test('delivery-only SVG overlay keeps the editable source clean', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'image-options-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await sharp({
    create: { width: 24, height: 32, channels: 4, background: '#ffffff' },
  }).png().toBuffer();
  const overlay = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32"><rect x="18" y="26" width="4" height="4" fill="#68744A"/></svg>';
  const result = await prepareImageArtifacts({
    source,
    outputDir: directory,
    file: '01-hero.png',
    settings: { format: 'PNG', background: 'SOLID' },
    deliveryOverlaySvg: overlay,
  });

  const clean = await sharp(join(directory, result.sourceFile)).ensureAlpha().raw().toBuffer();
  const delivery = await sharp(join(directory, result.file)).ensureAlpha().raw().toBuffer();
  const offset = (27 * 24 + 19) * 4;
  assert.deepEqual([...clean.subarray(offset, offset + 3)], [255, 255, 255]);
  assert.deepEqual([...delivery.subarray(offset, offset + 3)], [104, 116, 74]);
});
