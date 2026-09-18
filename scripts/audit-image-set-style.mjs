#!/usr/bin/env node
import { internalPrompt } from '../src/prompt-runtime.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAgentClient } from '../src/agent-client.mjs';

const FONT_CATEGORIES = new Set([
  'SANS_SQUARE',
  'SANS_ROUNDED',
  'SERIF',
  'HANDWRITTEN',
  'DISPLAY_OTHER',
  'NONE',
  'UNCERTAIN',
]);
const MAX_IMAGES = 5;
const BOX_COLOR_DISTANCE_WARNING = 40;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} must be non-empty text of at most ${max} characters`);
  }
  return value.trim();
}

function optionalHex(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new TypeError(`${name} must be #RRGGBB or null`);
  }
  return value.toUpperCase();
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function firstJsonObject(rawText) {
  const raw = requiredText(String(rawText ?? ''), 'vision response', 100_000);
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(raw.slice(start, index + 1));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (record(parsed)) return parsed;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  throw new SyntaxError('vision response does not contain a valid JSON object');
}

export function normalizeStyleAssessment(input, expectedPages) {
  if (!record(input) || Number(input.schemaVersion) !== 1 || !Array.isArray(input.pages)) {
    throw new TypeError('style assessment root is invalid');
  }
  if (input.pages.length !== expectedPages) {
    throw new TypeError(`style assessment must contain exactly ${expectedPages} pages`);
  }
  const seen = new Set();
  const pages = input.pages.map((page, position) => {
    if (!record(page)) throw new TypeError(`pages[${position}] must be an object`);
    const pageIndex = Number(page.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > expectedPages || seen.has(pageIndex)) {
      throw new TypeError(`pages[${position}].pageIndex is invalid`);
    }
    seen.add(pageIndex);
    const headlineFontCategory = requiredText(page.headlineFontCategory, `pages[${position}].headlineFontCategory`, 30);
    const bodyFontCategory = requiredText(page.bodyFontCategory, `pages[${position}].bodyFontCategory`, 30);
    if (!FONT_CATEGORIES.has(headlineFontCategory) || !FONT_CATEGORIES.has(bodyFontCategory)) {
      throw new TypeError(`pages[${position}] contains an unsupported font category`);
    }
    return {
      pageIndex,
      headlineFontCategory,
      bodyFontCategory,
      headlineWeight: requiredText(page.headlineWeight, `pages[${position}].headlineWeight`, 30),
      bodyWeight: requiredText(page.bodyWeight, `pages[${position}].bodyWeight`, 30),
      primaryTextBoxColor: optionalHex(page.primaryTextBoxColor, `pages[${position}].primaryTextBoxColor`),
      primaryTextBoxShape: requiredText(page.primaryTextBoxShape, `pages[${position}].primaryTextBoxShape`, 100),
      accentColor: optionalHex(page.accentColor, `pages[${position}].accentColor`),
      fontCountAtMostThree: boolean(page.fontCountAtMostThree, `pages[${position}].fontCountAtMostThree`),
      textContrastPassed: boolean(page.textContrastPassed, `pages[${position}].textContrastPassed`),
      evidence: requiredText(page.evidence, `pages[${position}].evidence`, 1000),
    };
  }).sort((left, right) => left.pageIndex - right.pageIndex);
  const set = record(input.setAssessment) ? input.setAssessment : {};
  return {
    schemaVersion: 1,
    pages,
    setAssessment: {
      headlineFontConsistent: boolean(set.headlineFontConsistent, 'setAssessment.headlineFontConsistent'),
      bodyFontConsistent: boolean(set.bodyFontConsistent, 'setAssessment.bodyFontConsistent'),
      textBoxVisualLanguageConsistent: boolean(set.textBoxVisualLanguageConsistent, 'setAssessment.textBoxVisualLanguageConsistent'),
      layoutDiverse: boolean(set.layoutDiverse, 'setAssessment.layoutDiverse'),
      issueSummary: requiredText(set.issueSummary, 'setAssessment.issueSummary', 2000),
    },
  };
}

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export function colorDistance(left, right) {
  const [lr, lg, lb] = rgb(left);
  const [rr, rg, rb] = rgb(right);
  return Math.sqrt((lr - rr) ** 2 + (lg - rg) ** 2 + (lb - rb) ** 2);
}

function maximumColorDistance(colors) {
  let maximum = 0;
  for (let left = 0; left < colors.length; left += 1) {
    for (let right = left + 1; right < colors.length; right += 1) {
      maximum = Math.max(maximum, colorDistance(colors[left], colors[right]));
    }
  }
  return Math.round(maximum * 100) / 100;
}

export function assessStyleConsistency(assessment) {
  const headlineCategories = new Set(assessment.pages
    .map((page) => page.headlineFontCategory)
    .filter((value) => !['NONE', 'UNCERTAIN'].includes(value)));
  const bodyCategories = new Set(assessment.pages
    .map((page) => page.bodyFontCategory)
    .filter((value) => !['NONE', 'UNCERTAIN'].includes(value)));
  const boxColors = assessment.pages.map((page) => page.primaryTextBoxColor).filter(Boolean);
  const maxBoxColorDistance = maximumColorDistance(boxColors);
  const program = {
    headlineFontCategoryCount: headlineCategories.size,
    bodyFontCategoryCount: bodyCategories.size,
    maxBoxColorDistance,
    boxColorDistanceWarningThreshold: BOX_COLOR_DISTANCE_WARNING,
    fontCountPassed: assessment.pages.every((page) => page.fontCountAtMostThree),
    contrastPassed: assessment.pages.every((page) => page.textContrastPassed),
    headlineFontPassed: headlineCategories.size <= 1,
    bodyFontPassed: bodyCategories.size <= 1,
    boxColorPassed: boxColors.length >= 2 && maxBoxColorDistance <= BOX_COLOR_DISTANCE_WARNING,
  };
  const vision = assessment.setAssessment;
  return {
    passed: program.fontCountPassed && program.contrastPassed
      && program.headlineFontPassed && program.bodyFontPassed && program.boxColorPassed
      && vision.headlineFontConsistent && vision.bodyFontConsistent
      && vision.textBoxVisualLanguageConsistent && vision.layoutDiverse,
    program,
    vision,
  };
}

function styleAuditPrompt(imageCount) {
  return internalPrompt('INTERNAL_STYLE_AUDIT_TOOL', { slot1: imageCount });
}

export async function auditImageSetStyle({ inputPaths, outputPath, agentClient = createAgentClient() }) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 2 || inputPaths.length > MAX_IMAGES) {
    throw new RangeError('style audit requires 2-5 images');
  }
  const paths = inputPaths.map((path) => resolve(requiredText(path, 'image path', 1000)));
  const response = await agentClient.runVision({
    prompt: styleAuditPrompt(paths.length),
    inputPaths: paths,
    timeoutMs: 300_000,
  });
  const assessment = normalizeStyleAssessment(firstJsonObject(response.rawText), paths.length);
  const report = {
    generatedAt: new Date().toISOString(),
    model: response.model ?? null,
    inputPaths: paths,
    assessment,
    result: assessStyleConsistency(assessment),
  };
  if (outputPath) {
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  return report;
}

async function main(args) {
  const separator = args.indexOf('--output');
  const inputPaths = separator < 0 ? args : args.slice(0, separator);
  const outputPath = separator < 0 ? null : args[separator + 1];
  if (separator >= 0 && (!outputPath || args.length !== separator + 2)) {
    throw new Error('usage: node scripts/audit-image-set-style.mjs <2-5 images> [--output report.json]');
  }
  const report = await auditImageSetStyle({ inputPaths, outputPath });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.result.passed ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
