import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadBindings, transformSync } from 'next/dist/build/swc/index.js';

const componentUrl = new URL('../app/workbench/model-response-view.tsx', import.meta.url);
await loadBindings();
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== componentUrl.href) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: transformSync(readFileSync(componentUrl, 'utf8'), {
      filename: componentUrl.pathname, jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' },
    }).code };
  },
});
const { ModelResponseView } = await import(componentUrl.href);
hook.deregister();
const render = (text) => renderToStaticMarkup(createElement(ModelResponseView, { text }));

test('actual response view renders nested model content without requiring known fields', () => {
  const html = render(JSON.stringify({ arbitrary: { content: '# 中文标题😀\n\n- **重点**\n- 第二项' }, zero: 0, flag: false, empty: '', nil: null }));
  assert.match(html, /<dt>arbitrary<\/dt>/u);
  assert.match(html, /<h5>中文标题😀<\/h5>/u);
  assert.match(html, /<strong>重点<\/strong>/u);
  assert.match(html, /<li>第二项<\/li>/u);
  for (const value of ['0', 'false', 'null']) assert.ok(html.includes(`>${value}</code>`));
  assert.match(html, /（空字符串）/u);
  assert.match(html, /aria-pressed="true"[^>]*>阅读视图/u);
  assert.match(html, /aria-pressed="false"[^>]*>原文/u);
});

test('tables and mixed prose are readable while incomplete JSON stays verbatim', () => {
  const html = render('前文\n\n| 项目 | 内容 |\n| --- | --- |\n| 一 | 二 |\n\n结尾');
  assert.match(html, /<table>/u);
  assert.match(html, /<th>项目<\/th>/u);
  assert.match(html, /<td>二<\/td>/u);
  assert.match(html, /前文/u);
  assert.match(html, /结尾/u);
  assert.ok(render('{"正文":"中文\\n').includes('{&quot;正文&quot;:&quot;中文\\n'));
});

test('model HTML and unsafe links cannot execute, and image URLs do not load automatically', () => {
  const html = render('# 返回\n\n<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![示例](https://example.com/tracker.png)');
  assert.doesNotMatch(html, /<script|<img|href="javascript:/iu);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /示例（查看图片）/u);
});

test('long strings and deeply nested objects keep their terminal content', () => {
  const long = '尾部😀'.repeat(20_000);
  assert.ok(render(long).includes(long));
  let deep = '最终正文';
  for (let depth = 0; depth < 30; depth++) deep = { nested: deep };
  assert.match(render(JSON.stringify(deep)), /最终正文/u);
});
