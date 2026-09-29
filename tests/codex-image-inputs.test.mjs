import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  CODEX_NATIVE_IMAGE_MAX_BYTES,
  CODEX_NATIVE_IMAGE_MAX_INPUTS,
  prepareCodexImageInputs,
} from '../src/codex-image-inputs.mjs';

const CORNERS = [
  { x: 0.04, y: 0.04, rgb: [224, 32, 32], alpha: 48 },
  { x: 0.96, y: 0.04, rgb: [32, 208, 64], alpha: 96 },
  { x: 0.04, y: 0.96, rgb: [32, 64, 224], alpha: 160 },
  { x: 0.96, y: 0.96, rgb: [224, 208, 32], alpha: 224 },
];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-codex-image-inputs-'));
  const directory = join(root, 'prepared');
  await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory };
}

// Deterministic photographic noise makes the byte-budget transition real;
// solid corner markers reveal clipping and preserve observable alpha values.
function framePixels(width, height, { alpha = false, noise = 'soft' } = {}) {
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  let state = 0x91a73b;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const index = (y * width + x) * channels;
    const grey = 80 + (state & 15);
    const rgb = noise === 'soft' ? [grey, grey, grey]
      : [state & 255, (state >>> 8) & 255, (state >>> 16) & 255];
    for (let channel = 0; channel < 3; channel++) data[index + channel] = rgb[channel];
    if (alpha) data[index + 3] = 32 + ((state >>> 24) % 224);
    const left = x < width / 8, right = x >= width * 7 / 8;
    const top = y < height / 8, bottom = y >= height * 7 / 8;
    const corner = top && left ? CORNERS[0] : top && right ? CORNERS[1]
      : bottom && left ? CORNERS[2] : bottom && right ? CORNERS[3] : null;
    if (corner) {
      for (let channel = 0; channel < 3; channel++) data[index + channel] = corner.rgb[channel];
      if (alpha) data[index + 3] = corner.alpha;
    }
  }
  return { data, info: { width, height, channels } };
}

async function writeFrame(path, width, height, options) {
  const { data, info } = framePixels(width, height, options);
  const bytes = await sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path, bytes);
  return bytes;
}

async function checkDiagnostics(result, { native = true } = {}) {
  assert.equal(result.paths.length, result.diagnostics.length);
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    const bytes = await readFile(result.paths[index]);
    const metadata = await sharp(bytes).metadata();
    assert.equal(diagnostic.index, index + 1);
    assert.equal(diagnostic.path, result.paths[index]);
    assert.equal(diagnostic.format, metadata.format);
    assert.equal(extname(diagnostic.path), metadata.format === 'jpeg' ? '.jpg' : '.png');
    assert.equal(diagnostic.width, metadata.width);
    assert.equal(diagnostic.height, metadata.height);
    assert.equal(diagnostic.byteSize, bytes.length);
    assert.equal(diagnostic.sha256, createHash('sha256').update(bytes).digest('hex'));
    if (native) assert.ok(bytes.length <= CODEX_NATIVE_IMAGE_MAX_BYTES, 'native inputs stay below the relay budget');
  }
}

async function checkFrame(path, { alpha = false, tolerance = 3 } = {}) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const corner of CORNERS) {
    const x = Math.floor(info.width * corner.x), y = Math.floor(info.height * corner.y);
    const index = (y * info.width + x) * info.channels;
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(data[index + channel] - corner.rgb[channel]) <= tolerance,
        `full frame retains corner ${corner.x},${corner.y}, channel ${channel}`);
    }
    assert.ok(Math.abs(data[index + 3] - (alpha ? corner.alpha : 255)) <= tolerance,
      'alpha is retained at the corner marker');
  }
}

function checkAspect(diagnostic, width, height) {
  assert.ok(Math.abs(diagnostic.width / diagnostic.height - width / height) < 2 / diagnostic.height,
    'aspect ratio differs by at most integer-pixel rounding');
}

test('small native inputs preserve every pixel and retain their original files', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'source.png');
  const original = await writeFrame(source, 96, 64);
  const result = await prepareCodexImageInputs([source], directory, { preview: false });
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.format, 'png');
  assert.equal(diagnostic.resized, false);
  assert.equal(diagnostic.originalWidth, 96);
  assert.equal(diagnostic.originalHeight, 64);
  assert.equal(diagnostic.originalByteSize, diagnostic.byteSize);
  assert.deepEqual(await sharp(result.paths[0]).raw().toBuffer(), await sharp(original).raw().toBuffer());
  assert.deepEqual(await readFile(source), original);
  assert.notEqual(result.paths[0], source);
  await checkDiagnostics(result);
  await checkFrame(result.paths[0], { tolerance: 0 });
});

test('opaque oversized PNGs use high-quality JPEG while retaining the full original resolution', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'photograph.png');
  const original = await writeFrame(source, 1600, 1200);
  assert.ok(original.length > CODEX_NATIVE_IMAGE_MAX_BYTES, 'fixture crosses the native transport budget');
  const result = await prepareCodexImageInputs([source], directory, { preview: false });
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.format, 'jpeg');
  assert.equal(diagnostic.width, 1600);
  assert.equal(diagnostic.height, 1200);
  assert.equal(diagnostic.resized, false);
  assert.ok(diagnostic.originalByteSize > CODEX_NATIVE_IMAGE_MAX_BYTES);
  assert.equal((await sharp(result.paths[0]).metadata()).chromaSubsampling, '4:4:4');
  assert.deepEqual(await readFile(source), original);
  await checkDiagnostics(result);
  await checkFrame(result.paths[0]);
});

test('opaque images that remain oversized after JPEG compression shrink proportionally without clipping', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'detailed-photograph.png');
  const original = await writeFrame(source, 1600, 1200, { noise: 'hard' });
  const fullSizeJpeg = await sharp(original).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  assert.ok(fullSizeJpeg.length > CODEX_NATIVE_IMAGE_MAX_BYTES, 'fixture also exceeds the budget as full-size JPEG');
  const result = await prepareCodexImageInputs([source], directory, { preview: false });
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.format, 'jpeg');
  assert.equal(diagnostic.resized, true);
  assert.ok(diagnostic.width < 1600 && diagnostic.height < 1200);
  checkAspect(diagnostic, 1600, 1200);
  assert.deepEqual(await readFile(source), original);
  await checkDiagnostics(result);
  await checkFrame(result.paths[0]);
});

test('oversized transparent images remain PNG and preserve alpha plus all four frame corners', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'transparent-reference.png');
  const original = await writeFrame(source, 1000, 800, { alpha: true, noise: 'hard' });
  assert.ok(original.length > CODEX_NATIVE_IMAGE_MAX_BYTES);
  const result = await prepareCodexImageInputs([source], directory, { preview: false });
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.format, 'png');
  assert.equal(diagnostic.resized, true);
  assert.ok(diagnostic.width < 1000 && diagnostic.height < 800);
  assert.equal((await sharp(result.paths[0]).metadata()).hasAlpha, true);
  checkAspect(diagnostic, 1000, 800);
  assert.deepEqual(await readFile(source), original);
  await checkDiagnostics(result);
  await checkFrame(result.paths[0], { alpha: true });
});

test('EXIF rotation is applied exactly once before native dimensions and pixels are reported', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'rotated-camera-photo.jpg');
  const { data, info } = framePixels(120, 80);
  const original = await sharp(data, { raw: info }).withMetadata({ orientation: 6 })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  await writeFile(source, original);
  assert.equal((await sharp(source).metadata()).orientation, 6);
  const result = await prepareCodexImageInputs([source], directory, { preview: false });
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.originalWidth, 80);
  assert.equal(diagnostic.originalHeight, 120);
  assert.equal(diagnostic.width, 80);
  assert.equal(diagnostic.height, 120);
  assert.equal(diagnostic.resized, false);
  assert.deepEqual(await sharp(result.paths[0]).raw().toBuffer(), await sharp(source).rotate().raw().toBuffer());
  assert.notEqual((await sharp(result.paths[0]).metadata()).orientation, 6);
  assert.deepEqual(await readFile(source), original);
  await checkDiagnostics(result);
});

test('vision previews use JPEG, fit inside 900 by 1200 and never enlarge a small input', async t => {
  const { root, directory } = await fixture(t);
  const large = join(root, 'wide-source.png'), tall = join(root, 'tall-source.png');
  const small = join(root, 'small-source.png');
  const sources = [large, tall, small];
  const originals = await Promise.all([writeFrame(large, 1800, 1200), writeFrame(tall, 900, 1800),
    writeFrame(small, 96, 64)]);
  const result = await prepareCodexImageInputs(sources, directory);
  assert.deepEqual(result.diagnostics.map(image => [image.format, image.width, image.height]),
    [['jpeg', 900, 600], ['jpeg', 600, 1200], ['jpeg', 96, 64]]);
  for (const [index, path] of sources.entries()) assert.deepEqual(await readFile(path), originals[index]);
  await checkDiagnostics(result, { native: false });
  await checkFrame(result.paths[0]);
  await checkFrame(result.paths[1]);
});

test('five attachments retain their order and an out-of-range batch fails before reading inputs', async t => {
  const { root, directory } = await fixture(t);
  assert.equal(CODEX_NATIVE_IMAGE_MAX_INPUTS, 5);
  const sources = [];
  for (let index = 0; index < 5; index++) {
    const source = join(root, `source-${index}.png`);
    await writeFrame(source, 40 + index * 2, 30 + index);
    sources.push(source);
  }
  const result = await prepareCodexImageInputs(sources, directory, { preview: false });
  assert.deepEqual(result.diagnostics.map(image => image.width), [40, 42, 44, 46, 48]);
  await checkDiagnostics(result);
  const before = await readdir(directory);
  for (const input of [null, [], Array(6).fill(join(root, 'never-read.png'))]) {
    await assert.rejects(prepareCodexImageInputs(input, directory, { preview: false }), /requires 1-5 input images/u);
  }
  assert.deepEqual(await readdir(directory), before);
});

test('a corrupt input removes every concurrently prepared copy and preserves the source files', async t => {
  const { root, directory } = await fixture(t);
  const good = join(root, 'good.png'), corrupt = join(root, 'corrupt.png');
  const original = await writeFrame(good, 96, 64);
  const invalid = Buffer.from('this is not a decodable image');
  await writeFile(corrupt, invalid);
  await assert.rejects(prepareCodexImageInputs([good, corrupt, good], directory, { preview: false }));
  assert.deepEqual(await readdir(directory), [], 'cleanup waits for other conversions and writers');
  assert.deepEqual(await readFile(good), original);
  assert.deepEqual(await readFile(corrupt), invalid);
});

test('a filename collision cleans owned copies without deleting or overwriting pre-existing files', async t => {
  const { root, directory } = await fixture(t);
  const source = join(root, 'source.png');
  const original = await writeFrame(source, 96, 64);
  const occupied = join(directory, 'input-2.png'), otherFormat = join(directory, 'input-1.jpg');
  const sentinel = Buffer.from('existing unrelated asset');
  await Promise.all([writeFile(occupied, sentinel), writeFile(otherFormat, sentinel)]);
  await assert.rejects(prepareCodexImageInputs([source, source, source], directory, { preview: false }), { code: 'EEXIST' });
  assert.deepEqual((await readdir(directory)).sort(), ['input-1.jpg', 'input-2.png']);
  assert.deepEqual(await readFile(occupied), sentinel);
  assert.deepEqual(await readFile(otherFormat), sentinel);
  assert.deepEqual(await readFile(source), original);
});
