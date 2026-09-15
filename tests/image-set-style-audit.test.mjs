import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessStyleConsistency,
  colorDistance,
  firstJsonObject,
  normalizeStyleAssessment,
} from '../scripts/audit-image-set-style.mjs';

function page(pageIndex, overrides = {}) {
  return {
    pageIndex,
    headlineFontCategory: 'SANS_SQUARE',
    bodyFontCategory: 'SANS_SQUARE',
    headlineWeight: 'BOLD',
    bodyWeight: 'MEDIUM',
    primaryTextBoxColor: '#F4E6C8',
    primaryTextBoxShape: '圆角矩形',
    accentColor: '#B96A3C',
    fontCountAtMostThree: true,
    textContrastPassed: true,
    evidence: '字体和卡片清晰可见',
    ...overrides,
  };
}

function assessment(pages) {
  return normalizeStyleAssessment({
    schemaVersion: 1,
    pages,
    setAssessment: {
      headlineFontConsistent: true,
      bodyFontConsistent: true,
      textBoxVisualLanguageConsistent: true,
      layoutDiverse: true,
      issueSummary: '没有明显问题',
    },
  }, pages.length);
}

test('style audit extracts one bounded JSON object and rejects incomplete page sets', () => {
  const parsed = firstJsonObject(`untrusted prefix {"schemaVersion":1,"pages":[]} suffix`);
  assert.equal(parsed.schemaVersion, 1);
  assert.throws(() => normalizeStyleAssessment({ ...parsed, setAssessment: {} }, 2), /exactly 2 pages/u);
});

test('style audit passes one font system and nearby text-box colors', () => {
  const result = assessStyleConsistency(assessment([
    page(1),
    page(2, { primaryTextBoxColor: '#EFE0C2' }),
    page(3, { primaryTextBoxColor: '#F7E9CB' }),
  ]));
  assert.equal(result.passed, true);
  assert.ok(colorDistance('#F4E6C8', '#EFE0C2') < 40);
});

test('style audit flags cross-page font and text-box color drift', () => {
  const result = assessStyleConsistency(assessment([
    page(1),
    page(2, { headlineFontCategory: 'HANDWRITTEN', primaryTextBoxColor: '#111827' }),
  ]));
  assert.equal(result.passed, false);
  assert.equal(result.program.headlineFontPassed, false);
  assert.equal(result.program.boxColorPassed, false);
});
