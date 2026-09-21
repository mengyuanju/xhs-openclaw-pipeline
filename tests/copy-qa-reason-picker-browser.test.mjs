import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('browser: copy QA reason picker groups labels and creates a private reusable tag', {
  skip: process.env.RUN_COPY_QA_REASON_PICKER_BROWSER !== '1',
  timeout: 90_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/copy-qa-reason-picker');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({
    stdin: {
      contents: `
        import './app/globals.css';
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {CopyQaReasonPicker} from './app/copy-qa/copy-qa-reason-picker';
        function App(){
          const [selected,setSelected]=useState([]);
          return <main style={{maxWidth:900,margin:'30px auto',padding:16}}>
            <CopyQaReasonPicker selected={selected} onChange={setSelected}/>
            <output aria-label="selected-codes">{selected.join(',')}</output>
          </main>;
        }
        createRoot(document.getElementById('root')).render(<App/>);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    outfile: bundle,
    jsx: 'automatic',
    platform: 'browser',
    conditions: ['style'],
    alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
  });
  const [js, rawCss] = await Promise.all([
    readFile(bundle),
    readFile(join(directory, 'bundle.css'), 'utf8'),
  ]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });

  const customTags = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/bundle.js') {
      response.setHeader('content-type', 'application/javascript'); response.end(js); return;
    }
    if (path === '/bundle.css') {
      response.setHeader('content-type', 'text/css'); response.end(css); return;
    }
    if (path === '/api/control-plane/v1/copy-qa/reason-tags' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { version: 1, canPublish: false,
        selectable: customTags, managed: customTags } })); return;
    }
    if (path === '/api/control-plane/v1/copy-qa/reason-tags' && request.method === 'POST') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const created = { code: 'CUSTOM:11111111-1111-4111-8111-111111111111',
        publicId: '11111111-1111-4111-8111-111111111111', group: body.group,
        label: body.label, visibility: 'PRIVATE', status: body.requestPublic ? 'PENDING' : 'ACTIVE',
        ownedByActor: true, canRequestPublic: !body.requestPublic, canPublish: false, canDisable: true };
      customTags.push(created);
      response.statusCode = 201; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: created })); return;
    }
    if (path.startsWith('/api/')) {
      response.statusCode = 404; response.end(path); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_QA_REASON_PICKER_BROWSER_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('region', { name: '问题标签' }).waitFor();
    for (const heading of ['标题', '正文', '图文规划']) {
      await page.getByText(heading, { exact: true }).first().waitFor();
    }
    await page.getByRole('button', { name: '缺少核心关键词', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '缺少核心关键词', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '添加我的标签', exact: true }).click();
    await page.getByRole('combobox', { name: '自定义问题标签分类' }).click();
    await page.getByRole('option', { name: '正文', exact: true }).click();
    await page.getByPlaceholder('例如：开头铺垫过长').fill('开头铺垫过长');
    await page.getByText('同时申请加入公共标签库', { exact: true }).click();
    await page.getByRole('button', { name: '添加并选中', exact: true }).click();
    const custom = page.getByRole('button', { name: '开头铺垫过长', exact: true });
    await custom.waitFor();
    assert.equal(await custom.getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '管理', exact: true }).click();
    await page.getByRole('heading', { name: '管理我的问题标签', exact: true }).waitFor();
    assert.match(await page.getByText(/开头铺垫过长/u).first().textContent(), /开头铺垫过长/u);
    await page.getByRole('button', { name: '完成', exact: true }).click();

    await page.setViewportSize({ width: 480, height: 812 });
    const first = await page.getByRole('button', { name: '缺少核心关键词', exact: true }).boundingBox();
    const second = await page.getByRole('button', { name: 'AI感严重', exact: true }).first().boundingBox();
    assert.ok(first && second && first.width > 100 && second.width > 100);
    assert.ok(Math.abs(first.y - second.y) < 4, 'mobile chips should form a compact two-column row');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
