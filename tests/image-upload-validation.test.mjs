import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodeReference } from '../src/image-edit-pixels.mjs';
import { REFERENCE_UPLOAD_MAX_BYTES, detectReferenceImageMediaType, referenceUploadSizeMessage, referenceImageTypeMismatchMessage } from '../src/image-upload-validation.mjs';

const signatures = [
  ['image/png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ['image/jpeg', Uint8Array.from([255, 216, 255])],
  ['image/webp', Uint8Array.from([82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80])],
];

test('image signatures are read from Uint8Array views without relying on Buffer or filenames', () => {
  for (const [mediaType, signature] of signatures) {
    const wrapped = Uint8Array.from([0, 0, ...signature, 0]);
    assert.equal(detectReferenceImageMediaType(wrapped.subarray(2, 2 + signature.length)), mediaType);
    for (let length = 0; length < signature.length; length++) {
      assert.equal(detectReferenceImageMediaType(signature.subarray(0, length)), null);
    }
  }
  for (const bytes of [null, [], 'PNG', new Uint8Array(), Uint8Array.from([255, 216, 0]),
    new TextEncoder().encode('RIFF1234WAVE'), new TextEncoder().encode('<svg/>')]) {
    assert.equal(detectReferenceImageMediaType(bytes), null);
  }
});

test('format mismatch guidance requires verified content before recommending a supported suffix', async () => {
  const expected = {
    'image/png': /图片内容实际为 PNG[\s\S]*改为 \.png 后重新上传/u,
    'image/jpeg': /图片内容实际为 JPEG[\s\S]*改为 \.jpg 或 \.jpeg 后重新上传/u,
    'image/webp': /图片内容实际为 WebP[\s\S]*改为 \.webp 后重新上传/u,
  };
  for (const [mediaType] of signatures) {
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } })
      .toFormat(mediaType.slice(6)).toBuffer();
    const message = referenceImageTypeMismatchMessage(image, 'image/png', { contentValidated: true });
    assert.match(message, /^文件签名与声明类型不符：/u);
    assert.match(message, expected[mediaType]);
  }
  for (const [, signature] of signatures) {
    const unverified = referenceImageTypeMismatchMessage(signature, 'image/png');
    assert.match(unverified, /请重新导出为 PNG、JPEG 或 WebP 后上传/u);
    assert.doesNotMatch(unverified, /改为|\.png|\.jpg|\.jpeg|\.webp/u);
  }
  const unknown = referenceImageTypeMismatchMessage(new TextEncoder().encode('not an image'), 'image/png');
  assert.match(unknown, /^文件签名与声明类型不符：[\s\S]*请重新导出为 PNG、JPEG 或 WebP 后上传/u);
  assert.doesNotMatch(unknown, /改为|\.png|\.jpg|\.jpeg|\.webp/u);
});

test('oversize guidance states the exact byte counts even when MiB rounding looks equal', () => {
  assert.equal(REFERENCE_UPLOAD_MAX_BYTES, 5_242_880);
  assert.match(referenceUploadSizeMessage(5_678_448), /当前 5\.42 MiB（5,678,448 字节）\/上限 5 MiB（5,242,880 字节）/u);
  assert.match(referenceUploadSizeMessage(5_242_881), /当前 5\.00 MiB（5,242,881 字节）\/上限 5 MiB（5,242,880 字节）/u);
  assert.match(referenceUploadSizeMessage(5_242_881), /超出 1 字节/u);
});

test('reference decoding accepts the original byte limit and rejects one extra byte before format decoding', async () => {
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  const atLimit = Buffer.concat([image, Buffer.alloc(REFERENCE_UPLOAD_MAX_BYTES - image.length)]);
  const decoded = await decodeReference(atLimit, 'image/png', { resizeOversized: true });
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 3);
  await assert.rejects(() => decodeReference(Buffer.concat([atLimit, Buffer.from([0])]), 'image/png', {
    resizeOversized: true,
  }), /当前 5\.00 MiB（5,242,881 字节）\/上限 5 MiB（5,242,880 字节）/u);
  await assert.rejects(() => decodeReference(Buffer.alloc(REFERENCE_UPLOAD_MAX_BYTES + 1), 'image/svg+xml'),
    /图片文件超过大小限制/u);
});

test('shared signature detection does not bypass MIME, decoder, or empty-content validation', async () => {
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } }).jpeg().toBuffer();
  assert.equal(detectReferenceImageMediaType(image), 'image/jpeg');
  await assert.rejects(() => decodeReference(image, 'image/png'), /实际为 JPEG[\s\S]*\.jpg 或 \.jpeg/u);
  await assert.rejects(() => decodeReference(image, 'image/jpg'), /仅支持 PNG\/JPEG\/WebP/u);
  await assert.rejects(() => decodeReference(image, '__proto__'), /仅支持 PNG\/JPEG\/WebP/u);
  await assert.rejects(() => decodeReference(Buffer.from(signatures[0][1]), 'image/png'));
  await assert.rejects(() => decodeReference(Buffer.alloc(0), 'image/png'), /内容为空或无效[\s\S]*重新导出/u);
});

test('all three decodable formats receive correct suffix guidance without accepting a wrong MIME', async () => {
  const extensions = { 'image/png': /\.png/u, 'image/jpeg': /\.jpg 或 \.jpeg/u, 'image/webp': /\.webp/u };
  for (const [mediaType] of signatures) {
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } })
      .toFormat(mediaType.slice(6)).toBuffer();
    const decoded = await decodeReference(image, mediaType);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 3);
    const declaredMediaType = mediaType === 'image/png' ? 'image/jpeg' : 'image/png';
    await assert.rejects(() => decodeReference(image, declaredMediaType), error => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^文件签名与声明类型不符：/u);
      assert.match(error.message, /请将文件后缀改为/u);
      assert.match(error.message, extensions[mediaType]);
      return true;
    });
  }
});

test('truncated headers and corrupt bodies receive export guidance rather than suffix advice', async () => {
  for (const [mediaType, signature] of signatures) {
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } })
      .toFormat(mediaType.slice(6)).toBuffer();
    const corruptBody = Buffer.from(image);
    corruptBody.fill(0, signature.length);
    const declaredMediaType = mediaType === 'image/png' ? 'image/jpeg' : 'image/png';
    for (const bytes of [Buffer.from(signature), corruptBody]) {
      assert.equal(detectReferenceImageMediaType(bytes), mediaType);
      await assert.rejects(() => decodeReference(bytes, declaredMediaType), error => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^文件签名与声明类型不符：[\s\S]*请重新导出/u);
        assert.doesNotMatch(error.message, /后缀|\.png|\.jpg|\.jpeg|\.webp/u);
        return true;
      });
    }
  }
});

test('a PNG with readable dimensions and corrupt pixels cannot receive suffix advice', async () => {
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  const idat = image.indexOf('IDAT');
  assert.ok(idat > 0);
  const corruptPixels = Buffer.from(image);
  corruptPixels[idat + 4] = 0;
  const metadata = await sharp(corruptPixels, { failOn: 'warning' }).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 3);
  await assert.rejects(() => decodeReference(corruptPixels, 'image/jpeg'), error => {
    assert.match(error.message, /请重新导出/u);
    assert.doesNotMatch(error.message, /后缀/u);
    return true;
  });
});

test('a mismatched MIME does not give suffix advice for animation or excess pixels', async () => {
  const frame = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  const secondFrame = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
  const animated = await sharp([frame, secondFrame], { join: { animated: true } }).webp().toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  const excessPixels = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: 'white' } }).jpeg().toBuffer();
  for (const bytes of [animated, excessPixels]) {
    await assert.rejects(() => decodeReference(bytes, 'image/png'), error => {
      assert.match(error.message, /请重新导出/u);
      assert.doesNotMatch(error.message, /后缀/u);
      return true;
    });
  }
});
