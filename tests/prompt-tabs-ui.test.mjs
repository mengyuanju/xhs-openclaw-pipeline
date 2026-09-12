import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('central prompt manager renders the shared prompt catalog in grouped accessible tabs', async () => {
  const source = await readFile(new URL('../app/prompts/central-prompt-workbench.tsx', import.meta.url), 'utf8');
  const guard = await readFile(new URL('../app/prompts/prompt-optimization-guard.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const { PROMPT_CATALOG } = await import('../src/prompt-catalog.mjs');
  for (const kind of ['TEXT_SYSTEM', 'IMAGE_SYSTEM', 'IMAGE_EDIT_SYSTEM', 'VISUAL_PLAN_SYSTEM', 'COPY_LENGTH_REPAIR_SYSTEM']) assert.ok(PROMPT_CATALOG.some(item => item.kind === kind));
  assert.match(source, /PROMPT_CATALOG\.map/);
  assert.match(source, /提示词分组/);
  assert.match(source, /保存草稿/);
  assert.match(source, /className="prompt-type-tabs" role="tablist"/u);
  assert.match(source, /className="prompt-type-tab" role="tab"/u);
  assert.match(source, /aria-selected=\{activeKind === template\.kind\}/u);
  assert.match(source, /hidden=\{activeKind !== template\.kind\}/u);
  assert.match(css, /\.prompt-type-tabs \{[^}]*display: flex/u);
  assert.match(css, /\.prompt-type-tab\[aria-selected="true"\]/u);
  assert.match(source, /<PromptOptimizationGuard kind=\{template\.kind\} content=\{content\}/u);
  assert.match(source, /missingPromptOptimizationGuards/u);
  assert.match(guard, /关键优化规则 · 请勿误删/u);
  assert.match(guard, /保护标识或规则内容已缺失/u);
  assert.match(css, /\.prompt-optimization-guard \{[^}]*var\(--red\)/u);
  assert.doesNotMatch(source, /workbench-view-tabs|workbench-view-tab/u);
});
