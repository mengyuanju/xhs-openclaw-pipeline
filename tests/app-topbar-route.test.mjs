import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

test('the real topbar labels quality routes and uses an independent neutral fallback', async t => {
  const compiled = await build({ stdin: { contents: `
    import React from 'react';import{renderToStaticMarkup}from'react-dom/server';
    import{AppTopbar}from'./app/components/app-topbar';
    export function render(path){globalThis.__topbarRouteFixture=path;return renderToStaticMarkup(<AppTopbar/>)};
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    packages: 'external', alias: { '@': process.cwd() }, plugins: [{ name: 'router-fixture', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$|^\.\/background-tasks$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: resolve('.'), contents:
        args.path === 'next/navigation' ? 'export const usePathname=()=>globalThis.__topbarRouteFixture;'
          : args.path === 'next/link' ? "import React from'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}"
            : 'export function BackgroundTaskNotifications(){return null}' }));
    } }] });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
  try {
    for (const [path, title, section] of [
      ['/copy-flow', '文案工作入口', '质量与审核'], ['/image-qa', '图片质检', '质量与审核'],
      ['/copy-qa', '文案质检', '质量与审核'], ['/workbench/personal-statistics', '个人数据统计', '作业中心'],
      ['/knowledge', '知识库', '内容资产'], ['/unknown', '工作台', '作业中心'],
    ]) await t.test(path, () => {
      const html = loaded.exports.render(path);
      assert.equal(html.match(/<li class="topbar-title"[\s\S]*?<strong>([^<]+)<\/strong>/u)?.[1], title);
      assert.equal(html.match(/<li class="topbar-section"[\s\S]*?<span>([^<]+)<\/span>/u)?.[1], section);
      assert.match(html, /aria-label="当前位置"/u); assert.match(html, /aria-current="page"/u);
      if (path !== '/workbench/personal-statistics') assert.equal(html.includes('个人数据统计'), false);
    });
  } finally { delete globalThis.__topbarRouteFixture; }
});
