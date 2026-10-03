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

test('copy QA overview browser: V2 batch tabs, detail, final revision and mobile layout', {
  skip: process.env.RUN_COPY_QA_OVERVIEW_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'copy-qa-overview-browser-'));
  const bundle = join(root, 'bundle.js');
  const stylesheet = join(root, 'bundle.css');
  const items = Array.from({ length: 18 }, (_, index) => copyQaItem(index + 1));
  const batch = { id: randomUUID(), displayName: '布局验证批次', mode: 'PERSONAL_AUTO',
    status: 'INSPECTING', memberCount: items.length, sampleCount: items.length,
    pendingCount: items.length, passedCount: 0, returnedCount: 0, discardedCount: 0,
    affectedCount: 0, fullInspection: true, returnTriggerCount: items.length,
    createdAt: '2026-10-02T08:00:00.000Z' };
  const currentItems = items.map(item => ({ id: item.id, taskId: item.taskId, query: item.query,
    content: item.approvedRevision.content, status: item.status, approverUsername: 'fixture',
    revisionToken: item.approvedRevision.revisionToken, discardReasonCode: null, dispositionNote: null }));
  let browser;
  let server;
  try {
    await build({
      stdin: {
        contents: "import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CopyQaWorkbench/></ConfirmDialogProvider>);",
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
      if (request.url?.startsWith(`/api/control-plane/v2/copy-qa/batches/${batch.id}?`)) {
        response.end(JSON.stringify({ data: { batch, items: currentItems,
          pagination: { total: currentItems.length, limit: 50, offset: 0 } } })); return;
      }
      if (request.url?.startsWith('/api/control-plane/v2/copy-qa/batches?')) {
        const finished = new URL(request.url, 'http://fixture').searchParams.get('view') === 'FINISHED';
        response.end(JSON.stringify({ data: { items: finished ? [] : [batch], total: finished ? 0 : 1, limit: 20, offset: 0 } })); return;
      }
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_QA_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText(batch.displayName, { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '待质检批次', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: '已完成批次', exact: true }).click();
    await page.getByText('暂无已完成批次', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '待质检批次', exact: true }).click();
    await page.getByRole('button', { name: '进入批次', exact: true }).click();
    await page.getByText('示例最终稿标题 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看并质检', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: `${batch.displayName} · 最终稿质检`, exact: true }).waitFor();
    assert.equal(await dialog.getByText('示例最终稿标题 1', { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByText(`#${items[0].taskId}`, { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByRole('button', { name: '通过质检', exact: true }).isEnabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '仅打回此条', exact: true }).isEnabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '废弃任务', exact: true }).isEnabled(), true);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();

    const desktop = await page.evaluate(() => {
      const workbench = document.querySelector('.panel');
      const activePanel = workbench;
      const queue = document.querySelector('.table-wrap');
      return {
        workbenchWidth: workbench?.getBoundingClientRect().width ?? 0,
        activePanelWidth: activePanel?.getBoundingClientRect().width ?? 0,
        queueScrolls: queue ? queue.scrollHeight > queue.clientHeight : false,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.ok(desktop.workbenchWidth > 1400, 'the tabbed workbench uses the desktop content width');
    assert.ok(Math.abs(desktop.workbenchWidth - desktop.activePanelWidth) <= 4, `the active tab fills the workbench width: ${JSON.stringify(desktop)}`);
    assert.equal(desktop.horizontalOverflow, false);
    if (process.env.COPY_QA_OVERVIEW_SCREENSHOT) {
      await page.screenshot({ path: process.env.COPY_QA_OVERVIEW_SCREENSHOT, fullPage: false });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const workbench = document.querySelector('.panel');
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
