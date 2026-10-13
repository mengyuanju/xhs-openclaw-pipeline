import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { getTextRepairFontMetadata, renderTextRepairGlyph, renderTextRepairReference,
  TEXT_REPAIR_FONT_SHA256, TEXT_REPAIR_RENDERER_VERSION, validateTextRepairFontCoverage } from '../src/text-repair-font.mjs';

const fontBytes = await readFile(new URL('../assets/fonts/NotoSansSC-VF.ttf', import.meta.url));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
function tableOffset(buffer, name) {
  for (let index = 0; index < buffer.readUInt16BE(4); index++) {
    const entry = 12 + index * 16;
    if (buffer.toString('ascii', entry, entry + 4) === name) return buffer.readUInt32BE(entry + 8);
  }
  throw new Error(`Missing test font table ${name}`);
}
function unicodeSubtable(buffer, format) {
  const cmap = tableOffset(buffer, 'cmap');
  for (let index = 0; index < buffer.readUInt16BE(cmap + 2); index++) {
    const entry = cmap + 4 + index * 8, offset = cmap + buffer.readUInt32BE(entry + 4);
    if (buffer.readUInt16BE(offset) === format) return offset;
  }
  throw new Error(`Missing cmap format ${format}`);
}

test('bundled font has a pinned official fingerprint and redistribution license', async () => {
  assert.equal(hash(fontBytes), TEXT_REPAIR_FONT_SHA256);
  const metadata = await getTextRepairFontMetadata();
  assert.deepEqual(metadata, { renderer: 'STANDARD_FONT', rendererVersion: TEXT_REPAIR_RENDERER_VERSION,
    fontFamily: 'Noto Sans SC', fontSha256: TEXT_REPAIR_FONT_SHA256 });
  const license = await readFile(new URL('../assets/fonts/OFL-NotoSansSC.txt', import.meta.url), 'utf8');
  assert.match(license, /Copyright 2014-2021 Adobe/u);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/u);
});

test('Unicode cmap includes the actual complex characters and full phrases, rejects missing glyphs', () => {
  for (const text of ['鳖', '鼬', '先建鳖池', '搭好鳖池', '一二三四五六七八']) {
    assert.equal(validateTextRepairFontCoverage(fontBytes, text), true);
  }
  assert.throws(() => validateTextRepairFontCoverage(fontBytes, '🧑'), /字库不包含/u);
});

test('malformed and truncated OpenType table directories fail closed', () => {
  const badCount = Buffer.from(fontBytes); badCount.writeUInt16BE(129, 4);
  const badTable = Buffer.from(fontBytes); badTable.writeUInt32BE(fontBytes.length + 1, 20);
  for (const invalid of [null, Buffer.alloc(0), fontBytes.subarray(0, 100), badCount, badTable]) {
    assert.throws(() => validateTextRepairFontCoverage(invalid, '鳖'), /字库损坏/u);
  }
});

test('cmap group bounds and range pointers cannot escape the font bytes', () => {
  const badGroup = Buffer.from(fontBytes), format12 = unicodeSubtable(badGroup, 12);
  badGroup.writeUInt32BE(100001, format12 + 12);
  assert.throws(() => validateTextRepairFontCoverage(badGroup, '鳖'), /字库损坏/u);
  const badRange = Buffer.from(fontBytes), format4 = unicodeSubtable(badRange, 4);
  const segmentCount = badRange.readUInt16BE(format4 + 6) / 2;
  const ranges = format4 + 16 + segmentCount * 6;
  badRange.writeUInt16BE(0xfffe, ranges);
  assert.throws(() => validateTextRepairFontCoverage(badRange, '鳖'), /字库损坏/u);
  const badOffset = Buffer.from(fontBytes), cmap = tableOffset(badOffset, 'cmap');
  badOffset.writeUInt32BE(0xffffffff, cmap + 8);
  assert.throws(() => validateTextRepairFontCoverage(badOffset, '鳖'), /字库损坏/u);
});

test('reference is a real white square with dark standard glyph ink and portable metadata', async () => {
  const { png, metadata } = await renderTextRepairReference({ text: '鳖鼬' });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1024); assert.equal(info.height, 1024); assert.equal(info.channels, 3);
  assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
  assert.deepEqual([...data.subarray(data.length - 3)], [255, 255, 255]);
  assert.ok(data.some(value => value < 30), 'font ink must exist');
  assert.equal(metadata.text, '鳖鼬'); assert.equal(metadata.fontSha256, TEXT_REPAIR_FONT_SHA256);
});

test('transparent glyph uses validated dimensions and chosen RGB color for one through eight characters', async () => {
  for (const length of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const text = '鳖鼬先建池搭好字'.slice(0, length);
    const { png, metadata } = await renderTextRepairGlyph({ text, width: 320, height: 72, weight: 600, color: { r: 22, g: 53, b: 41 } });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 320); assert.equal(info.height, 72); assert.equal(info.channels, 4);
    const alphas = data.filter((value, index) => index % 4 === 3);
    assert.ok(alphas.some(value => value === 0)); assert.ok(alphas.some(value => value === 255));
    const opaque = data.findIndex((value, index) => index % 4 === 3 && value === 255) - 3;
    assert.deepEqual([...data.subarray(opaque, opaque + 3)], [22, 53, 41]);
    assert.equal(metadata.color, '#163529'); assert.equal(metadata.text, text);
  }
});

test('same font, input and geometry are deterministic; chosen weight changes the real glyph pixels', async () => {
  const input = { text: '鼬', width: 160, height: 180, weight: 700, color: '#163529' };
  const first = await renderTextRepairGlyph(input), second = await renderTextRepairGlyph(input);
  assert.deepEqual(first.metadata, second.metadata); assert.equal(hash(first.png), hash(second.png));
  const light = await renderTextRepairGlyph({ ...input, weight: 400 });
  assert.notEqual(hash(first.png), hash(light.png));
  const refA = await renderTextRepairReference({ text: '鳖' }), refB = await renderTextRepairReference({ text: '鳖' });
  assert.equal(hash(refA.png), hash(refB.png));
});

test('Pango control characters are rendered literally and cannot inject markup', async () => {
  for (const text of ['<b>鳖', '"&<>鳖', '&#40150;']) {
    const literal = await renderTextRepairReference({ text });
    assert.equal(literal.metadata.text, text);
    const plain = await renderTextRepairReference({ text: '鳖' });
    assert.notEqual(hash(literal.png), hash(plain.png));
  }
});

test('untrusted text, geometry, weight and color are rejected before drawing', async () => {
  const base = { text: '鳖', width: 100, height: 100 };
  for (const text of ['', '一二三四五六七八九', '鳖 池', '\n鳖', '\u202e鳖', '\ud800', null, 123]) {
    await assert.rejects(renderTextRepairGlyph({ ...base, text }), /正确文字/u);
  }
  for (const [width, height] of [[0, 10], [10, 2049], [1.5, 10], [10, NaN], ['100', 10]]) {
    await assert.rejects(renderTextRepairGlyph({ ...base, width, height }), /文字尺寸/u);
  }
  for (const weight of [399, 901, 700.5, '700']) await assert.rejects(renderTextRepairGlyph({ ...base, weight }), /文字粗细/u);
  for (const color of ['red', '#fff', '#000000"/><b>', { r: 1, g: 2, b: 300 }, { r: 1, g: 2, b: 3, a: 1 }, null]) {
    await assert.rejects(renderTextRepairGlyph({ ...base, color }), /文字颜色/u);
  }
  await assert.rejects(renderTextRepairReference({ text: '🧑' }), /字库不包含/u);
});

test('missing or changed font files do not fall back to a machine font', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'text-repair-font-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(renderTextRepairReference({ text: '鳖', fontPath: join(directory, 'missing.ttf') }), /字库缺失/u);
  const wrongFont = join(directory, 'wrong.ttf');
  await writeFile(wrongFont, Buffer.alloc(1024));
  await assert.rejects(renderTextRepairReference({ text: '鳖', fontPath: wrongFont }), /字库校验失败/u);
});
