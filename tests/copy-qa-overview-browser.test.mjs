import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function copyQaItem(index) {
  const mandatory = index % 3 === 0;
  return {
    id: randomUUID(), freezePublicId: randomUUID(), anonymousCode: `QC-${String(index).padStart(4, '0')}`,
    status: 'PENDING', sampleKind: mandatory ? 'MANDATORY_RECHECK' : 'RANDOM', blindReview: false,
    reviewMethod: 'STANDARD', taskId: 700 + index, productionBatchId: 80 + index, freezeId: 90 + index,
    finalApproverAccountId: 10 + (index % 4), query: `示例选题 ${index}：用于检查紧凑质检列表是否在一屏工作区内完整显示`,
    createdAt: `2026-09-15T08:${String(index).padStart(2, '0')}:00.000Z`,
    approvedRevision: {
      id: 800 + index, contentSha256: String(index).padStart(64, 'a'), revisionToken: randomUUID(),
      content: { copy: { title: `示例最终稿标题 ${index}`, body: '示例正文', tags: ['测试'] } },
    },
    productionBatch: { anonymousCode: `QCB-${String(index).padStart(4, '0')}`, queryPackageName: '布局验证词包' },
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: !mandatory },
  };
}

test('copy QA overview browser: every workspace tab uses the full panel and mobile does not overflow', {
  skip: process.env.RUN_COPY_QA_OVERVIEW_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'copy-qa-overview-browser-'));
  const bundle = join(root, 'bundle.js');
  const stylesheet = join(root, 'bundle.css');
  const items = Array.from({ length: 18 }, (_, index) => copyQaItem(index + 1));
  let browser;
  let server;
  try {
    await build({
      stdin: {
        contents: "import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CopyQaWorkbench role=\"ADMIN\"/></ConfirmDialogProvider>);",
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, outfile: bundle, jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    });
    const [javascript, css] = await Promise.all([readFile(bundle), readFile(stylesheet)]);
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('content-type', 'application/javascript'); response.end(javascript); return;
      }
      if (request.url === '/bundle.css') {
        response.setHeader('content-type', 'text/css'); response.end(css); return;
      }
      response.setHeader('content-type', request.url?.startsWith('/api/') ? 'application/json' : 'text/html');
      if (request.url?.startsWith('/api/control-plane/v1/copy-qa/statistics')) {
        response.end(JSON.stringify({ data: {
          random: Array.from({ length: 7 }, (_, index) => ({
            finalApproverAccountId: index + 1, finalApproverDisplayName: `质检 ${index + 1}`,
            finalApproverUsername: `reviewer${index + 1}`, decided: 10, passed: 8, returned: 2, accuracyRate: 0.8,
          })),
          mandatory: { passed: 12, returned: 3, pending: 6 }, batchAffectedCount: 4,
        } })); return;
      }
      if (request.url?.startsWith('/api/control-plane/v1/copy-qa/items')) {
        response.end(JSON.stringify({ data: { items, total: items.length } })); return;
      }
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_QA_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab', { name: /质检队列/u }).waitFor();
    await page.getByText('QC-0001', { exact: true }).waitFor();

    assert.equal(await page.getByRole('tab', { name: /质检队列/u }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: '数据概览', exact: true }).click();
    assert.equal(await page.getByLabel('质检数据概览').isVisible(), true);
    await page.getByRole('tab', { name: '标注', exact: true }).click();
    await page.getByLabel('文案质检标注数据，可滚动查看').waitFor();
    assert.equal(await page.getByText('质检 1', { exact: true }).isVisible(), true);
    await page.getByRole('tab', { name: '规则说明', exact: true }).click();
    await page.getByRole('heading', { name: '质检类型与状态变化', exact: true }).waitFor();
    await page.getByRole('tab', { name: /质检队列/u }).click();

    const firstQueueRow = page.getByText('QC-0001', { exact: true }).locator('xpath=ancestor::tr');
    const [viewButton, passButton, returnButton] = await Promise.all([
      firstQueueRow.getByRole('button', { name: '查看', exact: true }).boundingBox(),
      firstQueueRow.getByRole('button', { name: '通过抽检', exact: true }).boundingBox(),
      firstQueueRow.getByRole('button', { name: '仅打回此条', exact: true }).boundingBox(),
    ]);
    assert.ok(viewButton && passButton && returnButton);
    assert.ok(Math.abs(viewButton.y - passButton.y) < 1, 'view and pass actions share the first row');
    assert.ok(returnButton.y > passButton.y, 'return action occupies the second row');
    assert.ok(Math.abs(returnButton.x - passButton.x) < 1 && Math.abs(returnButton.width - passButton.width) < 1,
      'primary and return actions use the same stable column');

    const desktop = await page.evaluate(() => {
      const workbench = document.querySelector('[aria-label="质检数据与标注"]');
      const activePanel = document.querySelector('[role="tabpanel"][data-state="active"]');
      const queue = document.querySelector('[aria-label="待质检队列，可横向滚动"]');
      return {
        workbenchWidth: workbench?.getBoundingClientRect().width ?? 0,
        activePanelWidth: activePanel?.getBoundingClientRect().width ?? 0,
        queueScrolls: queue ? queue.scrollHeight > queue.clientHeight : false,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.ok(desktop.workbenchWidth > 1400, 'the tabbed workbench uses the desktop content width');
    assert.ok(Math.abs(desktop.workbenchWidth - desktop.activePanelWidth) <= 4, `the active tab fills the workbench width: ${JSON.stringify(desktop)}`);
    assert.equal(desktop.queueScrolls, true);
    assert.equal(desktop.horizontalOverflow, false);
    if (process.env.COPY_QA_OVERVIEW_SCREENSHOT) {
      await page.screenshot({ path: process.env.COPY_QA_OVERVIEW_SCREENSHOT, fullPage: false });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const workbench = document.querySelector('[aria-label="质检数据与标注"]');
      return {
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        workbenchBounds: workbench ? { rect: workbench.getBoundingClientRect().toJSON(), clientWidth: workbench.clientWidth, scrollWidth: workbench.scrollWidth, overflow: getComputedStyle(workbench).overflow } : null,
        offenders: Array.from(document.querySelectorAll('body *')).flatMap((element) => {
        const box = element.getBoundingClientRect();
        return box.right > document.documentElement.clientWidth + 1
          ? [{ tag: element.tagName, className: element.className, right: Math.round(box.right), width: Math.round(box.width) }]
          : [];
        }).slice(0, 10),
      };
    });
    assert.equal(mobile.horizontalOverflow, false, JSON.stringify({ bounds: mobile.workbenchBounds, offenders: mobile.offenders }));
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((done) => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});
