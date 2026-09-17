import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_DISCLOSURE_FALLBACK_COLOR,
  aiDisclosureBadgeSvg,
  createAiDisclosureStyle,
  resolveAiDisclosureColor,
  resolveAiDisclosureVisualStyle,
} from '../src/ai-disclosure-badge.mjs';

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
  assert.deepEqual({
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    position: style.position,
    variant: style.variant,
    width: style.width,
    height: style.height,
    margin: style.margin,
    strokeWidth: style.strokeWidth,
    x: style.x,
    y: style.y,
  }, {
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
});

test('AI disclosure badge has a deterministic fallback when visual-plan colors are unavailable', () => {
  assert.deepEqual(resolveAiDisclosureColor(null), {
    color: AI_DISCLOSURE_FALLBACK_COLOR,
    colorSource: 'FALLBACK',
    colorRole: 'fallback',
  });
  assert.equal(createAiDisclosureStyle({ text: 'AI生成' }).color, AI_DISCLOSURE_FALLBACK_COLOR);
  assert.throws(() => createAiDisclosureStyle({ text: '含 空格' }), /AI disclosure text/u);
});
