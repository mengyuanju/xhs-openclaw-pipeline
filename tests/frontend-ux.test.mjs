import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('mobile navigation stays compact and exposes the active page', async () => {
  const [navigation, styles] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(navigation, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.sidebar \{[\s\S]*grid-template-columns: 1fr auto/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.nav-item \{[^}]*white-space: nowrap/);
});

test('task rows provide readable mobile card labels instead of narrow table columns', async () => {
  const tasksPage = await readFile(projectFile('app/tasks/page.tsx'), 'utf8');

  assert.match(tasksPage, /className="table-wrap mobile-cards task-table-wrap"/);
  for (const label of ['ID', '选题', '外部 ID', '图片数', '生成状态', '审核状态']) {
    assert.match(tasksPage, new RegExp(`data-label="${label}"`));
  }
});

test('dashboard and import tables use the same readable mobile card treatment', async () => {
  const [dashboard, importsPage, importWorkbench] = await Promise.all([
    readFile(projectFile('app/page.tsx'), 'utf8'),
    readFile(projectFile('app/imports/page.tsx'), 'utf8'),
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
  ]);

  assert.match(dashboard, /className="table-wrap mobile-cards"/);
  assert.match(importsPage, /className="table-wrap mobile-cards"/);
  assert.match(importWorkbench, /className="table-wrap mobile-cards"/);
  assert.match(dashboard, /data-label="审核"/);
  assert.match(importsPage, /data-label="创建时间"/);
  assert.match(importWorkbench, /data-label="校验结果"/);
});

test('file uploads use the branded, keyboard-focusable control', async () => {
  const [importWorkbench, knowledgeWorkbench, styles] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(importWorkbench, /id="excel-file" className="input file-input"/);
  assert.match(knowledgeWorkbench, /className="input file-input" id="knowledge-image"/);
  assert.match(styles, /\.file-input::file-selector-button\s*\{/);
  assert.match(styles, /\.file-input:focus-visible\s*\{/);
});

test('review decision appears before the image-heavy editor on narrow screens', async () => {
  const reviewPanel = await readFile(projectFile('app/tasks/[id]/review-panel.tsx'), 'utf8');
  const decisionIndex = reviewPanel.indexOf('review-decision');
  const assetsIndex = reviewPanel.indexOf('review-assets');

  assert.ok(decisionIndex >= 0, 'review decision needs a stable layout class');
  assert.ok(assetsIndex >= 0, 'image editor needs a stable layout class');
  assert.ok(decisionIndex < assetsIndex, 'review decision must precede the image editor in source order');
  assert.doesNotMatch(reviewPanel, /<button(?![^>]*type=)[^>]*onClick=/);
});

test('interactive editors announce operation results and use explicit button behavior', async () => {
  const [importWorkbench, promptEditor, retryButton] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/prompts/prompt-editor.tsx'), 'utf8'),
    readFile(projectFile('app/tasks/[id]/retry-button.tsx'), 'utf8'),
  ]);

  assert.match(importWorkbench, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.match(promptEditor, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.match(retryButton, /role="alert"/);
  for (const source of [importWorkbench, promptEditor, retryButton]) {
    assert.doesNotMatch(source, /<button(?![^>]*type=)[^>]*onClick=/);
  }
});

test('prompt editors allow publishing an unchanged non-empty version', async () => {
  const promptEditor = await readFile(projectFile('app/prompts/prompt-editor.tsx'), 'utf8');

  assert.match(promptEditor, /disabled=\{busy \|\| !content\.trim\(\)\}/);
  assert.doesNotMatch(promptEditor, /content\.trim\(\) === published\?\.content/);
});

test('primary actions and small login copy meet WCAG AA text contrast', async () => {
  const styles = await readFile(projectFile('app/globals.css'), 'utf8');
  const primaryRed = styles.match(/--red:\s*(#[\da-f]{6})/i)?.[1];
  const footnote = styles.match(/\.login-story \.login-footnote \{[^}]*color:\s*(#[\da-f]{6})/i)?.[1];

  assert.ok(primaryRed, 'primary red token must be a six-digit hex color');
  assert.ok(footnote, 'login footnote must use an explicit six-digit hex color');
  assert.ok(contrastRatio(primaryRed, '#ffffff') >= 4.5, 'white primary-button text needs 4.5:1 contrast');
  assert.ok(contrastRatio(footnote, '#20201f') >= 4.5, 'small login footnote text needs 4.5:1 contrast');
});

test('visual knowledge is a first-class module with accessible analysis and retention controls', async () => {
  const [navigation, page, workbench] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/page.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
  ]);

  assert.match(navigation, /href: '\/knowledge', label: '视觉知识库'/);
  assert.match(page, /图片只作临时分析/);
  assert.match(workbench, /htmlFor="knowledge-image"/);
  assert.match(workbench, /PROMPT_ONLY/);
  assert.match(workbench, /IMAGE_AND_PROMPT/);
  assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.doesNotMatch(workbench, /<button(?![^>]*type=)[^>]*onClick=/);
});
