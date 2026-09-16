import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workbenchUrl = new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url);
const stylesUrl = new URL('../app/copy-qa/copy-qa.module.css', import.meta.url);

test('copy QA detail keeps its header and actions outside the scrolling content region', async () => {
  const [source, styles] = await Promise.all([
    readFile(workbenchUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);

  assert.match(source, /<header className=\{styles\.detailHeader\}>[\s\S]*?<div className=\{styles\.detailBody\}>[\s\S]*?<footer className=\{`\$\{styles\.footer\} \$\{styles\.detailFooter\}`\}>/u);
  assert.match(styles, /\.detailDialog\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/su);
  assert.match(styles, /\.detailBody\s*\{[^}]*overflow-y:\s*auto;/su);
  assert.match(styles, /\.detailFooter\s*\{[^}]*border-top:/su);
});

test('copy QA image plan keeps each page full width and separates its content regions', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  assert.match(styles, /@media \(min-width:\s*1080px\)[\s\S]*?\.detailDialog \.planGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/u);
  assert.match(styles, /\.detailDialog \.planCard\s*\{[^}]*grid-template-areas:\s*"card-header card-header" "subtitle subtitle" "bullets prompt";/u);
  assert.match(styles, /\.detailDialog \.planPrompt\s*\{[^}]*border-left:\s*1px solid var\(--line\);/u);
});
