import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const imageRunId = '22345678-1234-4234-8234-123456789abc';
const now = '2026-10-12T00:00:00.000Z';
function items(count, state = 'UNPACKED') {
  return Array.from({ length: count }, (_, index) => ({
    itemId: state === 'UNPACKED' ? null : index + 1, entryId: index + 1, taskId: index + 1,
    query: `跨页交付 ${index + 1}`, copyRevisionId: index + 1001, imageRunId,
    packageName: '测试词包', clientBatchCode: '测试甲方批次', assigneeUsername: 'worker', ownerUsername: 'worker',
    batchCode: state === 'UNPACKED' ? null : 'JF-12345678', state,
    packedAt: state === 'UNPACKED' ? null : now, packedBy: state === 'UNPACKED' ? null : 'admin',
    deliveredAt: state === 'DELIVERED' ? now : null, deliveredBy: state === 'DELIVERED' ? 'worker' : null,
    readyAt: now, updatedAt: now, archivedAt: null, canConfirm: state === 'PACKED', downloadedByMe: true,
    isCurrent: true, versionUpdated: false, batchVisibleCount: count, batchDeliveredCount: state === 'DELIVERED' ? count : 0,
  }));
}

test('shared delivery browser: cross-page selection is explicit, bounded and stable', {
  skip: process.env.RUN_SHARED_DELIVERY_SELECTION_BROWSER !== '1', timeout: 120_000,
}, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-selection-browser-'));
  const qaRoot = await mkdtemp(join(tmpdir(), 'shared-delivery-selection-qa-'));
  let browser, server, page, rows = [], requests = [], selectionMode = '', releaseSelection;
  const errors = [];
  try {
    await build({
      stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
        import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
        import{SharedDeliveryWorkbench}from'./app/delivery-pool/shared-delivery-workbench';
        createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><SharedDeliveryWorkbench role={location.pathname.includes('operator')?'USER':'ADMIN'}/></ConfirmDialogProvider>);`,
        resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    });
    const [js, rawCss] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    server = createServer(async (req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (req.url.startsWith('/api/')) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = raw ? JSON.parse(raw) : null, url = new URL(req.url, 'http://localhost');
        requests.push({ url: req.url, input, method: req.method });
        let data;
        if (url.pathname.endsWith('/delivery-items')) {
          const state = url.searchParams.get('state'), search = url.searchParams.get('search');
          const filtered = rows.filter(row => (!search || row.query.includes(search))
            && (state === 'ALL' || (state === 'PENDING' ? row.state !== 'DELIVERED' : row.state === state)));
          const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
          data = { items: filtered.slice(offset, offset + limit), total: filtered.length,
            summary: { total: rows.length, unpacked: rows.filter(row => row.state === 'UNPACKED').length,
              packed: rows.filter(row => row.state === 'PACKED').length, delivered: rows.filter(row => row.state === 'DELIVERED').length, updated: 0 }, updatedAt: now };
          if (limit === 200 && offset === 0) {
            const mode = selectionMode; selectionMode = '';
            if (mode === 'hold') await new Promise(resolve => { releaseSelection = resolve; });
            if (mode === 'fail') {
              res.statusCode = 503; res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: { code: 'SELECTION_UNAVAILABLE', message: '测试全选请求失败' } })); return;
            }
            if (mode === 'incomplete') data.items = data.items.slice(0, 19);
            if (mode === 'grow') data.total++;
          }
        } else if (url.pathname.endsWith('/users')) data = [{ id: 1, username: 'admin', displayName: '管理员' }, { id: 2, username: 'worker', displayName: '标注甲' }];
        else if (url.pathname.endsWith('/delivery-items/confirm')) data = { confirmed: input.itemIds.length, alreadyConfirmed: 0 };
        else if (url.pathname.endsWith('/delivery-pool/archive')) data = { downloadId: imageRunId, fileName: 'selection.zip', taskCount: input.taskIds.length, expiresAt: '2099-01-01T00:00:00.000Z' };
        else if (url.pathname.includes('/delivery-pool/archive/')) {
          res.setHeader('content-type', 'application/zip'); res.setHeader('content-disposition', 'attachment; filename="selection.zip"'); res.end('Synthetic fixture; no real content.'); return;
        } else if (url.pathname.endsWith('/delivery-archives/preview')) data = { token: 'preview', itemCount: input.itemIds?.length ?? rows.length, totalBytes: 1000, batchCount: 1 };
        else if (url.pathname.endsWith('/delivery-archives')) data = req.method === 'POST'
          ? { id: 1, kind: 'ARCHIVE', status: 'SUCCEEDED', itemCount: rows.length, artifacts: [], createdBy: 'admin', createdAt: now }
          : { items: [], total: 0 };
        else { res.statusCode = 404; data = null; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    const open = async (count, state = 'UNPACKED', role = 'ADMIN', filters = {}) => {
      releaseSelection?.(); releaseSelection = undefined;
      await page?.close(); rows = items(count, state); requests = []; selectionMode = '';
      page = await browser.newPage({ viewport: { width: 1480, height: 1100 } });
      page.on('pageerror', error => errors.push(error.message));
      const query = new URLSearchParams(Object.entries(filters).map(([field, value]) => [`dl_${field}`, value]));
      await page.goto(`${base}/${role === 'USER' ? 'operator' : 'delivery-pool'}?${query}`);
      await page.getByRole('checkbox', { name: '选择交付任务 1', exact: true }).waitFor();
      await page.getByRole('navigation', { name: '任务列表分页' }).getByText(`第 1 / ${Math.ceil(count / 20)} 页`, { exact: true }).waitFor();
    };
    const fullButton = count => page.getByRole('button', { name: `选择全部筛选结果（${count} 条）`, exact: true });
    const selectAll = async count => {
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      await fullButton(count).click();
      await page.getByText(`已选择本次筛选的全部 ${count} 条`, { exact: true }).waitFor();
    };
    const selectedCount = count => page.getByText(`已选 ${count} 条（最多 200 条）`, { exact: true }).waitFor();
    const pack = async () => {
      await page.getByRole('button', { name: '打包并下载', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '打包并下载', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已创建并开始下载' }).waitFor();
      return requests.find(request => request.url.endsWith('/delivery-pool/archive')).input;
    };
    const startHeldSelection = async count => {
      selectionMode = 'hold';
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      await Promise.all([page.waitForRequest(request => request.url().includes('limit=200&offset=0')), fullButton(count).click()]);
      const deadline = Date.now() + 1000;
      while (!releaseSelection && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(typeof releaseSelection, 'function');
    };
    const finishHeldSelection = async () => {
      releaseSelection(); releaseSelection = undefined;
      // Allow a delayed HTTP response to settle after cancellation, then assert the visible result.
      await page.waitForTimeout(120);
    };

    await t.test('86 filtered items are selected without changing the 20 visible rows, and every binding is submitted', async () => {
      const filters = { state: 'UNPACKED', dateField: 'READY', from: '2026-10-01', to: '2026-10-12',
        search: '跨页交付', assigneeId: '2', packedById: '1', deliveredById: '2', archiveState: 'NO', versionState: 'ALL',
        packageName: '测试词包', clientBatchCode: '测试甲方批次', view: 'CURRENT' };
      await open(86, 'UNPACKED', 'ADMIN', filters);
      assert.equal(await fullButton(86).count(), 0, 'the second step appears only after selecting the page');
      await selectAll(86);
      const scope = page.getByRole('status', { name: '跨页选择范围', exact: true });
      await scope.screenshot({ path: join(qaRoot, 'cross-page-selection-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'cross-page selection must fit the mobile viewport');
      await scope.screenshot({ path: join(qaRoot, 'cross-page-selection-mobile.png') });
      await page.setViewportSize({ width: 1480, height: 1100 });
      assert.equal(await page.locator('tbody tr').count(), 20);
      assert.equal(await page.getByRole('combobox', { name: '每页条数', exact: true }).textContent(), '20 条 / 页');
      const fullRequest = requests.find(request => request.url.includes('limit=200&offset=0'));
      const actual = Object.fromEntries(new URL(fullRequest.url, base).searchParams);
      assert.deepEqual(actual, { ...filters, limit: '200', offset: '0' }, 'selection must retain every active filter');
      const input = await pack();
      assert.deepEqual(input.taskIds, Array.from({ length: 86 }, (_, index) => index + 1));
      assert.deepEqual(input.expectedBindings, rows.map(({ taskId, copyRevisionId, imageRunId }) => ({ taskId, copyRevisionId, imageRunId })));
    });

    await t.test('deselecting a row, changing pages and changing page size retain the remaining selection', async () => {
      await open(86); await selectAll(86);
      await page.getByRole('checkbox', { name: '选择交付任务 1', exact: true }).uncheck(); await selectedCount(85);
      await page.getByRole('navigation', { name: '任务列表分页' }).getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByRole('checkbox', { name: '选择交付任务 21', exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).isChecked(), true);
      await page.getByRole('combobox', { name: '每页条数', exact: true }).click();
      await page.getByRole('option', { name: '50 条 / 页', exact: true }).click();
      await page.getByRole('checkbox', { name: '选择交付任务 1', exact: true }).waitFor();
      assert.equal(await page.locator('tbody tr').count(), 50);
      assert.equal(await page.getByRole('checkbox', { name: '选择交付任务 1', exact: true }).isChecked(), false);
      assert.equal(await page.getByRole('checkbox', { name: '选择交付任务 50', exact: true }).isChecked(), true);
      const input = await pack(); assert.equal(input.taskIds.length, 85); assert.ok(!input.taskIds.includes(1));
    });

    await t.test('automatic refresh neither adds new tasks nor substitutes a new version of a selected task', async () => {
      await open(86); await selectAll(86);
      const originalBindings = rows.map(({ taskId, copyRevisionId, imageRunId }) => ({ taskId, copyRevisionId, imageRunId }));
      rows = [{ ...rows[0], copyRevisionId: 9999, imageRunId: '32345678-1234-4234-8234-123456789abc' }, ...rows.slice(1), items(87).at(-1)];
      await Promise.all([page.waitForResponse(response => response.url().includes('/delivery-items?')),
        page.evaluate(() => window.dispatchEvent(new Event('focus')))]);
      await page.getByText('文案 #9999 · 图片 32345678', { exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox', { name: '选择交付任务 1', exact: true }).isChecked(), false);
      await page.getByRole('navigation', { name: '任务列表分页' }).getByRole('button', { name: '尾页', exact: true }).click();
      await page.getByRole('checkbox', { name: '选择交付任务 87', exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox', { name: '选择交付任务 87', exact: true }).isChecked(), false);
      const input = await pack(); assert.deepEqual(input.expectedBindings, originalBindings);
    });

    await t.test('a failed or incomplete full-selection response preserves the original page selection', async () => {
      await open(86); await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      selectionMode = 'fail'; await fullButton(86).click();
      await page.getByRole('alert').filter({ hasText: '测试全选请求失败' }).waitFor(); await selectedCount(20);
      selectionMode = 'incomplete'; await fullButton(86).click();
      await page.getByRole('alert').waitFor(); await selectedCount(20);
      assert.equal(await page.getByText('已选择本次筛选的全部 86 条', { exact: true }).count(), 0);
      const input = await pack(); assert.equal(input.taskIds.length, 20);
    });

    await t.test('changing filters while a full-selection request is pending discards its late result', async () => {
      await open(86); await startHeldSelection(86);
      await page.getByRole('textbox', { name: '搜索交付内容', exact: true }).fill('跨页交付 1');
      await page.getByRole('button', { name: '查询', exact: true }).click();
      await selectedCount(0); await finishHeldSelection(); await selectedCount(0);
      assert.equal(await page.getByText('已选择本次筛选的全部 86 条', { exact: true }).count(), 0);
    });

    await t.test('clearing a pending full-selection request leaves no restored selection', async () => {
      await open(86); await startHeldSelection(86);
      await page.getByRole('button', { name: '清空选择', exact: true }).click();
      await selectedCount(0); await finishHeldSelection(); await selectedCount(0);
      assert.equal(await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).isChecked(), false);
    });

    await t.test('200 packed items can be selected and confirmed with all explicit item IDs', async () => {
      await open(200, 'PACKED', 'USER'); await selectAll(200);
      await page.getByRole('button', { name: '确认所选已交付', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '确认已交付', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已确认 200 条' }).waitFor();
      const input = requests.find(request => request.url.endsWith('/delivery-items/confirm')).input;
      assert.deepEqual(input.itemIds, Array.from({ length: 200 }, (_, index) => index + 1));
    });

    await t.test('201 ordinary results are blocked explicitly instead of silently truncating to 200', async () => {
      await open(201, 'PACKED', 'USER');
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      assert.equal(await fullButton(201).getAttribute('aria-disabled'), 'true');
      await fullButton(201).hover(); await page.getByRole('tooltip').filter({ hasText: /200 条/ }).waitFor();
      await fullButton(201).dispatchEvent('click'); await selectedCount(20);
      assert.equal(requests.filter(request => request.url.includes('limit=200&offset=0')).length, 0);
      assert.equal(await page.getByText('已选择本次筛选的全部 200 条', { exact: true }).count(), 0);
    });

    await t.test('a result that grows from 200 to 201 while selecting is rejected without truncating the response', async () => {
      await open(200, 'PACKED', 'USER');
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      selectionMode = 'grow'; await fullButton(200).click();
      await page.getByRole('alert').filter({ hasText: '已变为 201 条' }).waitFor();
      await selectedCount(20);
      assert.equal(await page.getByText('已选择本次筛选的全部 200 条', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).isChecked(), true);
    });

    await t.test('administrators retain filter-based delivered archives above 200 items', async () => {
      await open(201, 'DELIVERED', 'ADMIN', { state: 'DELIVERED' });
      assert.equal(await fullButton(201).count(), 0);
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check(); await fullButton(201).click();
      await page.getByRole('button', { name: '汇总保存已交付内容', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '生成文件', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '文件任务 HG-1 已创建' }).waitFor();
      const input = requests.find(request => request.url.endsWith('/delivery-archives/preview')).input;
      assert.equal(input.filters.state, 'DELIVERED'); assert.equal(input.itemIds, undefined);
      assert.equal(requests.filter(request => request.url.includes('limit=200&offset=0')).length, 0);
      await open(2001, 'DELIVERED', 'ADMIN', { state: 'DELIVERED' });
      await page.getByRole('checkbox', { name: '选择本页交付内容', exact: true }).check();
      assert.equal(await fullButton(2001).getAttribute('aria-disabled'), 'true');
      await fullButton(2001).hover(); await page.getByRole('tooltip').filter({ hasText: /2000 条/ }).waitFor();
    });
    assert.deepEqual(errors, []);
    console.log(`Cross-page selection visual QA: ${qaRoot}`);
  } finally {
    releaseSelection?.(); await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'shared-delivery-selection-browser-')));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
