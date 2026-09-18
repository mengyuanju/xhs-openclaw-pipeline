import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';
import { defaultBusinessPrompt, DEFAULT_PROMPT_POLICY } from '../src/prompt-runtime.mjs';

test('prompt catalog browser: search, actual defaults, draft editing, readonly contracts and draft retention', {
  skip: process.env.RUN_PROMPT_CATALOG_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'prompt-catalog-browser-'));
  const catalog = PROMPT_CATALOG.map(item => ({ ...item, candidate: defaultBusinessPrompt(item.kind) }));
  const kind = 'INTERNAL_EDIT_LOCAL_TEXT';
  const templates = [{ id: 11, kind, name: '按文字定位局部编辑', versions: [{ id: 21, version: 1,
    content: '未发布的旧草稿', status: 'DRAFT', createdAt: new Date().toISOString(), publishedAt: null }] }];
  const writes = [], errors = [];
  let server, browser;
  try {
    await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { ConfirmDialogProvider } from './components/ui/confirm-dialog';
      import { CentralPromptWorkbench } from './app/prompts/central-prompt-workbench';
      import './app/globals.css';
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CentralPromptWorkbench catalog={${JSON.stringify(catalog)}} /></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic',
      platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
    const [js, rawCss] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    server = createServer(async (req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (req.url.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        let value;
        if (req.url === '/api/prompt-runtime') value = { source: 'CENTER', active: false, settings: DEFAULT_PROMPT_POLICY,
          contract: '程序约束', contractDetails: [], variables: [] };
        else if (req.url === '/api/control-plane/v1/prompts') value = templates;
        else if (req.url === '/api/control-plane/v1/prompts/versions') {
          const input = JSON.parse(body); writes.push(input);
          value = { id: 22, version: 2, content: input.content, status: 'DRAFT', createdAt: new Date().toISOString(), publishedAt: null };
          templates[0].versions.unshift(value);
        } else if (req.url.includes('prompt-runs')) value = [];
        else { res.statusCode = 404; value = null; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: value })); return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab', { name: '文案生成', exact: true }).waitFor();
    const search = page.getByLabel('查找所有提示词');
    await search.fill('按文字定位局部编辑');
    await page.getByRole('button', { name: '图片编辑 · 按文字定位局部编辑', exact: true }).click();
    const panel = page.locator(`#prompt-panel-${kind}`);
    assert.equal(await panel.getByLabel('提示词内容', { exact: true }).inputValue(), '未发布的旧草稿');
    assert.match(await panel.innerText(), /当前生效来源：系统默认模板/u);
    await panel.getByRole('button', { name: '查看实际默认内容、调用位置和变量', exact: true }).click();
    assert.ok((await panel.innerText()).includes(defaultBusinessPrompt(kind)));
    await panel.getByLabel('提示词内容', { exact: true }).fill('新的局部编辑草稿');
    await search.fill('Codex 文本执行协议');
    await page.getByRole('button', { name: '模型执行协议 · Codex 文本执行协议（只读）', exact: true }).click();
    const protocol = page.locator('#prompt-panel-INTERNAL_CODEX_TEXT_EXECUTION');
    assert.equal(await protocol.getByLabel('提示词内容', { exact: true }).getAttribute('readonly'), '');
    assert.equal(await protocol.getByRole('button', { name: '提交更新', exact: true }).count(), 0);
    await search.fill('按文字定位局部编辑');
    await page.getByRole('button', { name: '图片编辑 · 按文字定位局部编辑', exact: true }).click();
    assert.equal(await panel.getByLabel('提示词内容', { exact: true }).inputValue(), '新的局部编辑草稿');
    await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
    await panel.getByText('v2', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, kind);
    assert.equal(writes[0].content, '新的局部编辑草稿');
    assert.match(await panel.innerText(), /当前生效来源：系统默认模板/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
