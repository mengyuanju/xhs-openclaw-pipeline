import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

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
        contents: "import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ImageQaWorkbench}from'./app/image-qa/image-qa-workbench';createRoot(document.getElementById('root')).render(<ImageQaWorkbench role=\"REVIEWER\"/>);",
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
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_QA_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    await page.getByText('IQ-BLIND-ONE', { exact: true }).waitFor();
    assert.equal(await page.getByText('匿名', { exact: true }).count(), 1);
    assert.equal(await page.getByText('不应泄露的真实任务', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '打回', exact: true }).click();
    await page.getByText('2 个最终成品页', { exact: true }).waitFor();
    assert.equal(await page.getByText('第 01 / 02 页', { exact: true }).count(), 1);
    assert.equal(await page.getByText('01-image.png', { exact: true }).count(), 2);
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
    await page.getByText('当前筛选下没有图片质检项。', { exact: true }).waitFor();
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
