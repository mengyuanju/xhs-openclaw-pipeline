import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('copy QA detail browser: fixed header and footer frame a compact scrolling comparison', {
  skip: process.env.RUN_COPY_QA_DETAIL_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'copy-qa-detail-browser-'));
  const bundle = join(root, 'bundle.js');
  const stylesheet = join(root, 'bundle.css');
  const item = {
    id: randomUUID(), freezePublicId: randomUUID(), anonymousCode: 'QC-AB0D469A297F',
    status: 'PENDING', sampleKind: 'RANDOM', blindReview: false, reviewMethod: 'STANDARD',
    taskId: 701, productionBatchId: 81, freezeId: 91, finalApproverAccountId: 12,
    query: 'tar.gz怎么解压', createdAt: '2026-09-15T08:00:00.000Z',
    approvedRevision: {
      id: 801, contentSha256: '6c0a443fdda2'.padEnd(64, 'a'), revisionToken: 'b'.repeat(64),
      content: {
        copy: {
          title: 'tar.gz怎么解压，4步完成操作',
          body: Array.from({ length: 7 }, (_, index) => `${index + 1}、操作说明\n这是用于检查弹窗内部滚动的完整正文内容，步骤清晰并保留必要注意事项。`).join('\n\n'),
          tags: ['压缩包', '命令行'],
        },
        imagePlan: Array.from({ length: 5 }, (_, index) => ({
          kind: index === 0 ? 'hero' : 'steps',
          headline: index === 0 ? 'tar.gz怎么解压' : `第${index}步操作`,
          subtitle: '快速完成查看、解压与核对',
          bullets: ['先查看包内文件', '准备目标目录', '执行解压并核对结果'],
          prompt: '简洁技术教程画面，清晰编号卡片，深色终端窗口与压缩包图标，保留标题、副标题和重点文字区域。',
        })),
      },
    },
    productionBatch: { id: 81, anonymousCode: 'QCB-178A892213D5', queryPackageName: '命令行教程' },
    source: { finalApproverAccountId: 12 },
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
  };
  let browser;
  let server;
  try {
    await build({
      stdin: {
        contents: "import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CopyQaWorkbench role=\"REVIEWER\"/></ConfirmDialogProvider>);",
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
      if (request.url?.match(/\/api\/control-plane\/v1\/copy-qa\/items\/[0-9a-f-]+$/u)) {
        response.end(JSON.stringify({ data: item })); return;
      }
      if (request.url?.startsWith('/api/control-plane/v1/copy-qa/items')) {
        response.end(JSON.stringify({ data: [item] })); return;
      }
      response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>[data-slot="dialog-content"]{translate:-50% -50%}</style><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.COPY_QA_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1174, height: 866 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('QC-AB0D469A297F', { exact: true }).waitFor({ timeout: 5_000 }).catch(async () => {
      assert.fail(JSON.stringify({ browserErrors, body: await page.locator('body').innerText() }));
    });
    await page.getByRole('button', { name: '查看', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('QC-AB0D469A297F', { exact: true }).waitFor();
    if (process.env.COPY_QA_DETAIL_SCREENSHOT) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: process.env.COPY_QA_DETAIL_SCREENSHOT, fullPage: false });
    }

    const metrics = await dialog.evaluate((element) => {
      const [header, body, footer] = Array.from(element.children);
      const dialogBox = element.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      return {
        dialogTop: dialogBox.top, dialogBottom: dialogBox.bottom,
        headerBottom: headerBox.bottom, bodyTop: bodyBox.top, bodyBottom: bodyBox.bottom, footerTop: footerBox.top,
        dialogOverflow: getComputedStyle(element).overflow,
        bodyOverflowY: getComputedStyle(body).overflowY,
        bodyScrolls: body.scrollHeight > body.clientHeight,
        planColumns: getComputedStyle(body.querySelector('[class*="planGrid"]')).gridTemplateColumns.split(' ').length,
      };
    });
    assert.ok(metrics.dialogTop >= 0 && metrics.dialogBottom <= 866, JSON.stringify(metrics));
    assert.ok(metrics.headerBottom <= metrics.bodyTop + 1, JSON.stringify(metrics));
    assert.ok(metrics.bodyBottom <= metrics.footerTop + 1, JSON.stringify(metrics));
    assert.equal(metrics.dialogOverflow, 'hidden');
    assert.equal(metrics.bodyOverflowY, 'auto');
    assert.equal(metrics.bodyScrolls, true);
    assert.equal(metrics.planColumns, 2);
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((done) => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});
