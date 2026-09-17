import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

test('image QA uses Sonner and the shared dialog with white, contained image previews', async () => {
  const [workbench, styles, preview, globals, toaster, layout] = await Promise.all([
    readFile(new URL('../app/image-qa/image-qa-workbench.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/image-qa/image-qa.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/image-preview.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../components/ui/sonner.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(workbench, /import \{ Dialog, DialogContent, DialogDescription, DialogTitle \} from '@\/components\/ui\/dialog'/u);
  assert.match(workbench, /<Dialog open=\{detail !== null\}/u);
  assert.match(workbench, /<DialogContent className=\{qaStyles\.detailDialog\}/u);
  assert.match(workbench, /<DialogTitle>\{detail\.anonymousCode\}<\/DialogTitle>/u);
  assert.match(workbench, /<DialogDescription>按页码顺序检查当前最终交付图/u);
  assert.doesNotMatch(workbench, /<section className=\{`panel \$\{qaStyles\.detail\}`\}/u);
  assert.match(workbench, /<ImagePreview hideTrigger isOpen initialMode="fit"/u);
  assert.match(preview, /const viewMode = modeOverride \?\? initialMode \?\? defaultMode/u);
  assert.match(styles, /\.stage\s*\{[^}]*background:\s*#fff;[^}]*\}/su);
  assert.match(styles, /\.stage img\s*\{[^}]*object-fit:\s*contain;/su);
  assert.match(styles, /\.thumbnail img\s*\{[^}]*object-fit:\s*contain;[^}]*background:\s*#fff;/su);
  assert.doesNotMatch(styles, /\.detailDialog\s*\{[^}]*transform:/su);
  assert.doesNotMatch(globals, /\.image-preview-dialog\s*\{[^}]*transform:/su);
  assert.match(workbench, /role="tablist" aria-label="图片质检处理状态"/u);
  assert.match(workbench, /role === 'ADMIN' && personName[\s\S]*params\.set\('personName', personName\)/u);
  assert.match(workbench, /aria-label="按人员姓名筛选全部图片质检项"/u);
  assert.match(workbench, />应用人员<\/Button>/u);
  assert.match(workbench, /<h2 id="image-qa-queue-title">质检队列<\/h2>/u);
  assert.match(workbench, /当前没有待质检任务/u);
  assert.match(workbench, /<th>状态<\/th>/u);
  assert.match(styles, /\.overview\s*\{[^}]*grid-template-columns:\s*repeat\(4,/su);
  assert.match(styles, /\.emptyState\s*\{[^}]*min-height:\s*250px;/su);
  assert.match(workbench, /import \{ toast \} from 'sonner'/u);
  assert.match(workbench, /toast\.success/u);
  assert.match(workbench, /toast\.error/u);
  assert.match(toaster, /import \{ toast, Toaster as Sonner \} from 'sonner'/u);
  assert.match(toaster, /position="top-center"/u);
  assert.match(toaster, /closeButton/u);
  assert.match(layout, /<Toaster \/>/u);
});

test('image QA browser: blind queue, required return feedback, mandatory recheck and pass', {
  skip: process.env.RUN_IMAGE_QA_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'image-qa-browser-'));
  const bundle = join(root, 'bundle.js');
  const stylesheet = join(root, 'bundle.css');
  const firstId = randomUUID();
  const secondId = randomUUID();
  const freezeId = randomUUID();
  const png = await sharp({ create: { width: 400, height: 500, channels: 4, background: '#ddeee8' } }).png().toBuffer();
  let phase = 0;
  let returned = null;
  let passed = null;
  let browser;
  let server;
  const item = (id, sampleKind) => ({
    id, freezePublicId: freezeId, anonymousCode: sampleKind === 'RANDOM' ? 'IQ-BLIND-ONE' : 'IQ-RECHECK',
    status: 'PENDING', sampleKind, blindReview: true,
    assets: [1, 2].map((assetId) => ({ id: assetId, mediaType: 'image/png', sha256: 'a'.repeat(64), originalName: null, pageIndex: assetId, url: `/v1/assets/${assetId}` })),
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
  });
  try {
    await build({
      stdin: {
        contents: "import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{Toaster}from'./components/ui/sonner';import{ImageQaWorkbench}from'./app/image-qa/image-qa-workbench';createRoot(document.getElementById('root')).render(<><ImageQaWorkbench role=\"REVIEWER\"/><Toaster/></>);",
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, outfile: bundle, jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    });
    const [javascript, css] = await Promise.all([readFile(bundle), readFile(stylesheet)]);
    server = createServer(async (request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('content-type', 'application/javascript'); response.end(javascript); return;
      }
      if (request.url === '/bundle.css') {
        response.setHeader('content-type', 'text/css'); response.end(css); return;
      }
      if (request.url?.startsWith('/api/control-plane/v1/') && request.url.includes('/assets/')) {
        response.setHeader('content-type', 'image/png'); response.end(png); return;
      }
      if (request.url === '/api/human-quality-settings') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: {
          scoreDefinitions: [
            { score: 1, title: '不可用', description: '返工' }, { score: 2, title: '修改', description: '返工' },
            { score: 2.5, title: '达标', description: '通过' }, { score: 3, title: '优质', description: '通过' },
          ],
          copyReasons: [], imageReasons: [{ code: 'TEXT_ERROR', label: '画面文字错误' }],
          noteGuidance: { copyPlaceholder: '文案说明', imagePlaceholder: '图片修改说明' },
          copyReviewDisplay: { showScoreDescriptions: true, showDeductionReasons: false },
          imageReviewDisplay: { showDeductionReasons: true },
        } })); return;
      }
      if (request.url?.startsWith('/api/control-plane/v1/image-qa/items') && request.method === 'GET') {
        const items = phase === 0 ? [item(firstId, 'RANDOM')] : phase === 1 ? [item(secondId, 'MANDATORY_RECHECK')] : [];
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: { items, limit: 200, offset: 0 } })); return;
      }
      if (request.url?.startsWith('/api/control-plane/v1/image-qa/items/') && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (request.url.endsWith('/return')) { returned = JSON.parse(body); phase = 1; }
        if (request.url.endsWith('/pass')) { passed = JSON.parse(body); phase = 2; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: { status: 'OK' } })); return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>.dialog-content{transform:translate(-50%,-50%)}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_QA_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    await page.getByText('IQ-BLIND-ONE', { exact: true }).waitFor();
    const overviewPresentation = await page.locator('[aria-label="图片质检概况"]').evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      width: element.getBoundingClientRect().width,
    }));
    assert.equal(overviewPresentation.columns, 4);
    assert.ok(overviewPresentation.width > 1000);
    assert.equal(await page.getByRole('tab', { name: /待质检|已通过|已打回|全部记录/u }).count(), 4);
    assert.equal(await page.getByText('匿名', { exact: true }).count(), 1);
    assert.equal(await page.getByText('不应泄露的真实任务', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '打回', exact: true }).click();
    const qaDialog = page.getByRole('dialog', { name: 'IQ-BLIND-ONE' });
    await qaDialog.waitFor();
    await page.getByText('2 个最终成品页', { exact: true }).waitFor();
    assert.equal(await page.getByText('第 01 / 02 页', { exact: true }).count(), 1);
    assert.equal(await page.getByText('01-image.png', { exact: true }).count(), 2);
    const previewTrigger = qaDialog.getByRole('button', { name: '放大查看第 1 页：01-image.png' });
    const stagePresentation = await previewTrigger.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      imageFit: getComputedStyle(element.querySelector('img')).objectFit,
    }));
    assert.equal(stagePresentation.backgroundColor, 'rgb(255, 255, 255)');
    assert.equal(stagePresentation.imageFit, 'contain');
    await previewTrigger.click();
    const previewDialog = page.locator('.image-preview-dialog');
    await previewDialog.waitFor();
    assert.equal(await previewDialog.getAttribute('role'), 'dialog');
    assert.equal(await previewDialog.getAttribute('aria-label'), '图片预览：第 1 页：01-image.png');
    assert.equal(await previewDialog.getByRole('button', { name: '完整显示' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await previewDialog.locator('.image-preview-viewport').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    const closePreview = previewDialog.getByRole('button', { name: '关闭图片预览' });
    const [dialogBox, closeBox] = await Promise.all([previewDialog.boundingBox(), closePreview.boundingBox()]);
    assert.ok(dialogBox && closeBox && closeBox.x >= 0 && closeBox.y >= 0 && closeBox.x < 1280 && closeBox.y < 900,
      `preview controls must stay in the viewport: ${JSON.stringify({ dialogBox, closeBox })}`);
    await closePreview.click();
    assert.equal(await page.getByText('返工原因 （至少一项）', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '确认单条打回', exact: true }).click();
    await page.getByRole('alert').getByText('至少选择一项返工原因', { exact: false }).waitFor();
    await page.getByLabel('画面文字错误', { exact: true }).check();
    await page.getByLabel('第 01 页 · 01-image.png', { exact: true }).check();
    await page.getByLabel('具体修改要求（必填）', { exact: true }).fill('修正第一张中的错别字，其他内容保持不变');
    await page.getByRole('button', { name: '确认单条打回', exact: true }).click();
    await page.getByText('IQ-RECHECK', { exact: true }).waitFor();
    assert.deepEqual(returned.reasonCodes, ['TEXT_ERROR']);
    assert.deepEqual(returned.problemAssetIds, [1]);
    assert.equal(returned.reworkTarget, 'IMAGE');
    assert.match(returned.requestId, /^[a-f0-9-]{36}$/u);
    await page.getByRole('button', { name: '通过', exact: true }).click();
    await page.getByText('当前没有待质检任务', { exact: true }).waitFor();
    const successFeedback = page.getByText('IQ-RECHECK 已通过；本冻结批次全部通过后才会整体进入交付池。', { exact: true });
    await successFeedback.waitFor();
    const successToast = successFeedback.locator('xpath=ancestor::*[@data-sonner-toast]');
    assert.equal(await successToast.getAttribute('data-type'), 'success');
    await page.waitForTimeout(450);
    const toastBox = await successToast.boundingBox();
    assert.ok(toastBox && toastBox.y >= 16 && toastBox.x >= 0 && toastBox.x + toastBox.width <= 1280,
      `Sonner feedback must stay inside the viewport: ${JSON.stringify(toastBox)}`);
    const emptyPresentation = await page.getByText('当前没有待质检任务', { exact: true }).locator('..').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      centered: getComputedStyle(element).textAlign,
    }));
    assert.ok(emptyPresentation.height >= 240 && emptyPresentation.height <= 330,
      `empty queue should stay compact: ${JSON.stringify(emptyPresentation)}`);
    assert.equal(emptyPresentation.centered, 'center');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(mobileOverflow <= 1, `mobile page must not overflow horizontally: ${mobileOverflow}px`);
    assert.equal(passed.score, 3);
    assert.match(passed.requestId, /^[a-f0-9-]{36}$/u);
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((done) => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});
