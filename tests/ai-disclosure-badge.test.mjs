import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import {
  AI_DISCLOSURE_FALLBACK_COLOR,
  aiDisclosureBadgeSvg,
  createAiDisclosureStyle,
  normalizeAiDisclosureBadgeColor,
  resolveAiDisclosureColor,
  resolveAiDisclosureTextColor,
  resolveAiDisclosureVisualStyle,
} from '../src/ai-disclosure-badge.mjs';
import { assertOutsideMask, renderRegionsMask } from '../src/image-edit-pixels.mjs';

test('AI disclosure badge uses one set-wide visual-plan accent with locked geometry', () => {
  const visualPlan = {
    pages: [{ visualStyle: { palette: ['#F4E6A2', '#1D1D1D', '#6F7D5F'], tone: '自然克制' } }],
  };
  const visualStyle = resolveAiDisclosureVisualStyle(visualPlan);
  const style = createAiDisclosureStyle({ text: '该人物形象由AI生成', visualStyle });

  assert.deepEqual(resolveAiDisclosureColor(visualStyle), {
    color: '#6F7D5F',
    colorSource: 'VISUAL_PLAN',
    colorRole: 'accent',
  });
  assert.deepEqual(style, {
    version: 1,
    text: '该人物形象由AI生成',
    color: '#6F7D5F',
    colorSource: 'VISUAL_PLAN',
    colorRole: 'accent',
    fontSize: 20,
    fontWeight: 600,
    position: 'bottom-right',
    variant: 'outline-pill',
    width: 240,
    height: 36,
    margin: 24,
    strokeWidth: 1.5,
    x: 822,
    y: 1388,
  });
  const svg = aiDisclosureBadgeSvg({ text: style.text, visualStyle });
  assert.match(svg, /data-overlay-role="ai-disclosure"/u);
  assert.match(svg, /fill="none" stroke="#6F7D5F"/u);
  assert.doesNotMatch(svg, /<rect[^>]+fill="#[0-9A-F]{6}"/u);
  assert.equal(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1086" height="1448" viewBox="0 0 1086 1448">
    <g data-overlay-role="ai-disclosure" fill="none" stroke="#6F7D5F" stroke-width="1.5">
      <rect x="822.75" y="1388.75" width="238.5" height="34.5" rx="18"/>
    </g>
    <text x="942" y="1406" text-anchor="middle" dominant-baseline="central" font-family="'Microsoft YaHei','Noto Sans CJK SC','PingFang SC',sans-serif" font-size="20" font-weight="600" fill="#6F7D5F">该人物形象由AI生成</text>
  </svg>`);
  assert.equal(aiDisclosureBadgeSvg({ text: style.text, visualStyle, variant: 'outline-pill' }), svg);
});

test('AI disclosure badge has a deterministic fallback when visual-plan colors are unavailable', () => {
  assert.deepEqual(resolveAiDisclosureColor(null), {
    color: AI_DISCLOSURE_FALLBACK_COLOR,
    colorSource: 'FALLBACK',
    colorRole: 'fallback',
  });
  assert.equal(createAiDisclosureStyle({ text: 'AI生成' }).color, AI_DISCLOSURE_FALLBACK_COLOR);
  assert.throws(() => createAiDisclosureStyle({ text: '含 空格' }), /AI disclosure text/u);
  assert.throws(() => createAiDisclosureStyle({ text: 'AI生成', variant: 'url(file:///secret)' }), /badge variant/u);
});

test('disclosure color prefers a valid saved page color, then semantic color, then palette', () => {
  const visualStyle = { disclosureColor: '#123456', colors: { disclosure: '#654321' }, palette: ['#F4E6A2', '#6F7D5F'] };
  assert.deepEqual(resolveAiDisclosureColor(visualStyle, { storedStyle: { color: '#AbCdEf', colorRole: 'accent' } }), {
    color: '#ABCDEF', colorSource: 'STORED_IMAGE_STYLE', colorRole: 'accent',
  });
  assert.equal(resolveAiDisclosureColor(visualStyle, { storedStyle: { color: 'invalid' } }).color, '#123456');
  assert.equal(resolveAiDisclosureColor({ ...visualStyle, disclosureColor: 'invalid' }).color, '#654321');
  assert.equal(resolveAiDisclosureColor({ palette: ['#F4E6A2', 'invalid', '#6f7d5f'] }).color, '#6F7D5F');
});

test('custom badge color takes precedence and rejects anything outside strict six-digit hex', () => {
  const input = { text: 'AI生成', visualStyle: { disclosureColor: '#123456' },
    storedStyle: { color: '#654321', colorRole: 'accent' }, badgeColor: '#aBcDeF' };
  assert.equal(normalizeAiDisclosureBadgeColor(input.badgeColor), '#ABCDEF');
  const outline = createAiDisclosureStyle(input);
  assert.equal(outline.color, '#ABCDEF');
  assert.equal(outline.colorSource, 'USER_SELECTED');
  assert.equal(outline.colorRole, 'custom');
  assert.match(aiDisclosureBadgeSvg(input), /fill="none" stroke="#ABCDEF"/u);
  assert.match(aiDisclosureBadgeSvg(input), /<text[^>]+fill="#ABCDEF"/u);
  const solid = createAiDisclosureStyle({ ...input, variant: 'solid-pill' });
  assert.equal(solid.backgroundColor, '#ABCDEF');
  assert.equal(solid.borderColor, '#ABCDEF');
  assert.equal(solid.textColor, '#000000');
  assert.ok(solid.contrastRatio >= 4.5);
  assert.deepEqual(resolveAiDisclosureColor(null, { storedStyle: outline }), {
    color: '#ABCDEF', colorSource: 'STORED_IMAGE_STYLE', colorRole: 'custom',
  });
  for (const badgeColor of [null, '', 12, {}, ['#ABCDEF'], '#fff', '#12345678', '#12345G',
    '#ABCDEF\n', ' #ABCDEF', '#ABCDEF ', 'red', 'rgb(1,2,3)', 'url(file:///secret)',
    '#ABCDEF"/><image href="file:///secret"/>', '<svg/>']) {
    assert.throws(() => normalizeAiDisclosureBadgeColor(badgeColor), /#RRGGBB/u);
    assert.throws(() => createAiDisclosureStyle({ ...input, badgeColor }), /#RRGGBB/u);
    assert.throws(() => aiDisclosureBadgeSvg({ ...input, badgeColor }), /#RRGGBB/u);
  }
  assert.throws(() => normalizeAiDisclosureBadgeColor(undefined), /#RRGGBB/u);
});

test('solid badge chooses black or white text using WCAG luminance contrast', () => {
  assert.deepEqual(resolveAiDisclosureTextColor('#000000'), { textColor: '#FFFFFF', contrastRatio: 21 });
  assert.deepEqual(resolveAiDisclosureTextColor('#ffffff'), { textColor: '#000000', contrastRatio: 21 });
  const red = resolveAiDisclosureTextColor('#FF0000');
  assert.equal(red.textColor, '#000000');
  assert.ok(Math.abs(red.contrastRatio - 5.252) < 1e-10);
  const blue = resolveAiDisclosureTextColor('#0000FF');
  assert.equal(blue.textColor, '#FFFFFF');
  assert.ok(Math.abs(blue.contrastRatio - 8.592471358428805) < 1e-10);
  const nearThreshold = resolveAiDisclosureTextColor('#767676');
  assert.equal(nearThreshold.textColor, '#000000');
  assert.ok(nearThreshold.contrastRatio >= 4.5);
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        const color = `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
        assert.ok(resolveAiDisclosureTextColor(color).contrastRatio >= 4.5, color);
      }
    }
  }
  assert.throws(() => resolveAiDisclosureTextColor('rgba(0,0,0,1)'), /six-digit hex/u);
});

test('solid badge fills the pill while both variants preserve all outside pixels', async () => {
  const badgeInput = { text: '该人物形象由AI生成', visualStyle: { disclosureColor: '#111827' } };
  const outline = createAiDisclosureStyle(badgeInput);
  const solid = createAiDisclosureStyle({ ...badgeInput, variant: 'solid-pill' });
  assert.deepEqual({ x: solid.x, y: solid.y, width: solid.width, height: solid.height },
    { x: outline.x, y: outline.y, width: outline.width, height: outline.height });
  assert.equal(solid.backgroundColor, '#111827');
  assert.equal(solid.borderColor, '#111827');
  assert.equal(solid.textColor, '#FFFFFF');
  const solidSvg = aiDisclosureBadgeSvg({ ...badgeInput, variant: 'solid-pill' });
  assert.match(solidSvg, /fill="#111827" stroke="#111827"/u);
  assert.match(solidSvg, /<text[^>]+fill="#FFFFFF"/u);
  const source = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: 'white' } }).png().toBuffer();
  const mask = await renderRegionsMask([{ x: solid.x, y: solid.y, width: solid.width, height: solid.height }]);
  const results = await Promise.all([aiDisclosureBadgeSvg(badgeInput), solidSvg].map(async svg => {
    const bytes = await sharp(source).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    assert.deepEqual(await assertOutsideMask(source, bytes, mask), { passed: true, changedPixels: 0, threshold: 0 });
    return sharp(bytes).ensureAlpha().raw().toBuffer();
  }));
  const index = ((solid.y + 18) * 1086 + solid.x + 12) * 4;
  assert.deepEqual([...results[0].subarray(index, index + 4)], [255, 255, 255, 255]);
  assert.deepEqual([...results[1].subarray(index, index + 4)], [17, 24, 39, 255]);
});

test('custom badge renders the selected stroke or fill and preserves every outside pixel', async () => {
  const source = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: 'white' } }).png().toBuffer();
  for (const variant of ['outline-pill', 'solid-pill']) {
    const input = { text: 'AI生成', badgeColor: '#123456', variant };
    const style = createAiDisclosureStyle(input);
    const mask = await renderRegionsMask([{ x: style.x, y: style.y, width: style.width, height: style.height }]);
    const bytes = await sharp(source).composite([{ input: Buffer.from(aiDisclosureBadgeSvg(input)) }]).png().toBuffer();
    assert.deepEqual(await assertOutsideMask(source, bytes, mask), { passed: true, changedPixels: 0, threshold: 0 });
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
    const strokeIndex = (style.y * 1086 + style.x + style.width / 2) * 4;
    const fillIndex = ((style.y + 18) * 1086 + style.x + 12) * 4;
    assert.deepEqual([...raw.subarray(strokeIndex, strokeIndex + 4)], [18, 52, 86, 255]);
    assert.deepEqual([...raw.subarray(fillIndex, fillIndex + 4)],
      variant === 'solid-pill' ? [18, 52, 86, 255] : [255, 255, 255, 255]);
  }
});
