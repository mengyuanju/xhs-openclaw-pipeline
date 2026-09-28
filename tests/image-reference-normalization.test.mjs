import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { decodeReference, imageHash } from '../src/image-edit-pixels.mjs';
import { createImageEditingService } from '../server/src/image-editing.mjs';
import { createStandaloneImageEditor } from '../server/src/standalone-image-editor.mjs';

const MiB = 1024 * 1024;
const referenceOptions = { resizeOversized: true, maxPngBytes: 20 * MiB };
let largeReference;
async function noisyPhoto(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let seed = 478;
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[i] = seed & 255;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 35 }).toBuffer();
}
function oversizedPhoto() {
  largeReference ??= noisyPhoto(3840, 2592);
  return largeReference;
}

test('accepted reference images retain their dimensions, alpha, normalized bytes and hashes', async () => {
  const source = await sharp({ create: { width: 30, height: 40, channels: 4,
    background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const expected = await sharp(source).rotate().png().toBuffer();
  const decoded = await decodeReference(source, 'image/png', referenceOptions);
  assert.deepEqual(decoded.bytes, expected);
  assert.equal(decoded.sha256, imageHash(expected));
  assert.equal(decoded.originalSha256, imageHash(source));
  assert.equal(decoded.width, 30);
  assert.equal(decoded.height, 40);
  assert.equal((await sharp(decoded.bytes).metadata()).hasAlpha, true);
});

test('reference PNGs between 10 and 20 MiB retain their full resolution under the raised limit', async () => {
  const source = await noisyPhoto(2560, 1920);
  const expected = await sharp(source).rotate().png().toBuffer();
  assert.ok(source.length < 5 * MiB);
  assert.ok(expected.length > 10 * MiB && expected.length <= 20 * MiB);
  const decoded = await decodeReference(source, 'image/jpeg', referenceOptions);
  assert.deepEqual(decoded.bytes, expected);
  assert.equal(decoded.width, 1920);
  assert.equal(decoded.height, 2560);
  assert.equal(decoded.sha256, imageHash(expected));
});

test('a small JPEG that expands beyond the PNG limit is oriented and resized proportionally and deterministically', async () => {
  const source = await oversizedPhoto();
  assert.ok(source.length < 5 * MiB);
  assert.ok((await sharp(source).rotate().png().toBuffer()).length > 20 * MiB);
  const decoded = await decodeReference(source, 'image/jpeg', referenceOptions);
  const metadata = await sharp(decoded.bytes).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.ok(decoded.bytes.length <= 20 * MiB);
  assert.ok(decoded.width < 2592 && decoded.height < 3840);
  assert.ok(Math.abs(decoded.width - decoded.height * 2592 / 3840) <= 1);
  assert.equal(decoded.width, metadata.width);
  assert.equal(decoded.height, metadata.height);
  assert.equal(decoded.originalSha256, imageHash(source));
  assert.equal(decoded.originalMediaType, 'image/jpeg');
  assert.equal(decoded.sha256, imageHash(decoded.bytes));
  const repeated = await decodeReference(source, 'image/jpeg', referenceOptions);
  assert.equal(repeated.sha256, decoded.sha256);
  assert.deepEqual(repeated.bytes, decoded.bytes);
});

test('reference uploads enable normalization before starting their storage transaction', async () => {
  const storageBoundary = new Error('fake storage transaction reached');
  const service = createImageEditingService({
    pool: { connect: async () => { throw storageBoundary; } }, storageRoot: tmpdir(),
  });
  const source = await oversizedPhoto();
  await assert.rejects(() => service.upload(478, {
    base64: source.toString('base64'), mediaType: 'image/jpeg',
    purpose: '真实产品替换', source: '测试参考图',
  }, { role: 'ADMIN', username: 'fixture' }), error => error === storageBoundary);
});

test('automatic normalization still rejects images above the input pixel limit', async () => {
  const source = await sharp({ create: { width: 5000, height: 4000, channels: 3,
    background: 'white' } }).jpeg().toBuffer();
  await assert.rejects(() => decodeReference(source, 'image/jpeg', referenceOptions), /pixel limit/u);
});

test('standalone originals keep strict validation and do not enable reference resizing', async () => {
  const source = await oversizedPhoto();
  await assert.rejects(() => decodeReference(source, 'image/jpeg'), /解码后图片过大/u);
  const service = createStandaloneImageEditor({ pool: {}, storageRoot: tmpdir() });
  await assert.rejects(() => service.create({ requestId: randomUUID(),
    images: [{ mediaType: 'image/jpeg', base64: source.toString('base64') }],
  }, {}), /解码后图片过大/u);
});
