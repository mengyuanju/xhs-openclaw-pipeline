import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';

test('image edit history stays within the workspace with long failures and many records', {
  skip: process.env.RUN_IMAGE_EDIT_BROWSER !== '1', timeout: 30000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'image-edit-layout-'));
  const bundle = join(root, 'bundle.js');
  const longToken = 'reference_image_file_'.repeat(80);
  const warnings = Array.from({ length: 4 }, (_, index) => `删除白名单之外的可见文字：${index}、COHERENT.、LUMENTUM、HGTECH；只允许逐字保留正文。${longToken}`);
  const edits = Array.from({ length: 9 }, (_, index) => ({
    id: `edit-${index}`, version: 1, attempts: 1, status: index < 4 ? 'FAILED' : 'ACCEPTED',
    operation: 'AI_FUSION', source_asset_id: 1, target_page: 1, created_by: 'xiongqian',
    config: { instruction: '按 1 组参考图和框选区域，替换画面主体；保持场景、人物、构图和全部文字不变。' },
    error: index === 0 ? `Codex CODEX_IMAGE_UNVERIFIED: expected one native image generation with saved_path; final message: ${JSON.stringify({ rawText: `原生图像工具无法读取第二张参考图，返回 invalid base64 data：${longToken}` })}` : null,
    validation: { sourcePreflight: { warnings }, reference: longToken },
    events: [{ actor: 'xiongqian', action: '创建修改', reason: longToken }],
    ...(index >= 4 ? { result: { asset_id: 2, image_run_id: `run-${index}`, validation: { passed: false, sourcePreflight: { warnings }, reference: longToken } } } : {}),
  }));
  const png = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: '#eeeeee' } }).png().toBuffer();
  let browser, server;
  try {
    await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CurrentImageEditor}from'./app/components/current-image-editor';const asset={id:1,sha256:'a'.repeat(64),url:'/v1/assets/1'};createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CurrentImageEditor taskId={478} runId="run-1" copyRevisionId={1} asset={asset} page={1} runs={[]} onChanged={async()=>{}}/></ConfirmDialogProvider>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: bundle, jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
    const [js, rawCss] = await Promise.all([readFile(bundle), readFile(join(root, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    server = createServer((req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); }
      else if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); }
      else if (req.url?.includes('/assets/')) { res.setHeader('content-type', 'image/png'); res.end(png); }
      else if (req.url?.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: edits })); }
      else { res.setHeader('content-type', 'text/html'); res.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1010, height: 878 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '修改图片', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.getByRole('tab', { name: /任务记录/u }).click();
    const history = page.getByRole('list', { name: '图片修改记录' });
    await history.locator(':scope > li').last().waitFor();
    const reminders = history.getByLabel('执行前提醒', { exact: true });
    assert.equal(await reminders.count(), 9);
    assert.equal(await reminders.evaluateAll(elements => elements.every(element => !element.open)), true);
    const artifactDir = resolve('.codex_artifacts/image-edit-history');
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: join(artifactDir, 'history-default-desktop.png'), animations: 'disabled' });
    await reminders.first().locator('summary').click();
    await history.getByText('查看失败原因', { exact: true }).first().click();
    await history.getByText('质量校验记录', { exact: true }).first().click();
    await history.getByText('操作审计', { exact: true }).first().click();
    for (const viewport of [{ width: 1010, height: 878 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 840) await page.getByRole('tab', { name: '记录 9', exact: true }).click();
      const metrics = await page.getByRole('region', { name: '任务记录', exact: true }).evaluate(element => {
        const box = element.getBoundingClientRect();
        const dialog = element.closest('[data-slot="dialog-content"]');
        const dialogBox = dialog.getBoundingClientRect();
        return { panel: { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom }, dialog: { x: dialogBox.x, y: dialogBox.y, width: dialogBox.width, height: dialogBox.height, bottom: dialogBox.bottom }, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      assert.ok(metrics.panel.bottom <= metrics.dialog.bottom + 1, JSON.stringify(metrics));
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, JSON.stringify(metrics));
      assert.ok(metrics.scrollHeight > metrics.clientHeight, 'long history scrolls within its panel');
      assert.ok(metrics.dialog.x >= 0 && metrics.dialog.y >= 0 && metrics.dialog.x + metrics.dialog.width <= viewport.width && metrics.dialog.bottom <= viewport.height, JSON.stringify(metrics));
      await page.screenshot({ path: join(artifactDir, `history-${viewport.width}.png`), animations: 'disabled' });
      await page.getByRole('region', { name: '任务记录', exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
      const lastRecord = await history.locator(':scope > li').last().boundingBox();
      assert.ok(lastRecord.y >= metrics.panel.y && lastRecord.y + lastRecord.height <= metrics.panel.bottom + 1, JSON.stringify({ lastRecord, panel: metrics.panel }));
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(done => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});
