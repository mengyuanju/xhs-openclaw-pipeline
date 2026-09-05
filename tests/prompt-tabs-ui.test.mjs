import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('central prompt manager renders its three prompt kinds as independent styled tabs', async () => {
  const source = await readFile(new URL('../app/prompts/central-prompt-workbench.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  for (const kind of ['TEXT_SYSTEM', 'IMAGE_SYSTEM', 'IMAGE_EDIT_SYSTEM']) assert.match(source, new RegExp(kind));
  assert.match(source, /className="prompt-type-tabs" role="tablist"/u);
  assert.match(source, /className="prompt-type-tab" role="tab"/u);
  assert.match(source, /aria-selected=\{activeKind === template\.kind\}/u);
  assert.match(source, /hidden=\{activeKind !== template\.kind\}/u);
  assert.match(css, /\.prompt-type-tabs \{[^}]*display: flex/u);
  assert.match(css, /\.prompt-type-tab\[aria-selected="true"\]/u);
  assert.doesNotMatch(source, /workbench-view-tabs|workbench-view-tab/u);
});
