import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('legacy delivery browser: all tool tabs, frozen downloads and precise preview publishing use isolated HTTP fakes', {
  skip: process.env.RUN_LEGACY_DELIVERY_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const { build } = await import('esbuild'); const { chromium } = await import('playwright-core');
  const { default: JSZip } = await import('jszip');
  const root = resolve('.codex_artifacts/legacy-delivery'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from'react';import{createRoot}from'react-dom/client';import{DeliveryPoolWorkbench}from'./app/delivery-pool/delivery-pool-workbench';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{Toaster}from'./components/ui/sonner';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><DeliveryPoolWorkbench role={location.search.includes('user')?'USER':'ADMIN'} username="worker"/><Toaster/></ConfirmDialogProvider>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
  const js = await readFile(join(directory, 'bundle.js')); const rawCss = await readFile(join(directory, 'bundle.css'), 'utf8');
  const { default: postcss } = await import('postcss'); const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const zip = new JSZip(); zip.file('synthetic-fixture.txt', 'This archive is a fake delivery, not model output.'); const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
  const batchId = randomUUID(), code = 'a'.repeat(32), stamp = '2026-10-02T08:00:00Z';
  const batch = { id: 1, publicId: batchId, code: 'JF-1234ABCD', scope: 'SELECTED', queryPackageName: 'fixture-package', queryPackageNames: ['fixture-package'], clientBatchCode: code, status: 'GENERATED', batchKind: 'ADMIN_DELIVERY', createdByRole: 'ADMIN', fileName: 'fixture.zip', byteSize: bytes.length, sha256: 'a'.repeat(64), taskCount: 1, createdByAccountId: 1, createdByUsername: 'admin', createdAt: stamp, firstDownloadedAt: null, lastDownloadedAt: null, downloadCount: 0, deliveredAt: null, deliveredByAccountId: null, deliveredByUsername: null };
  const entries = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, taskId: index + 1, query: `legacy-fixture-${index + 1}`, queryPackageId: 1, queryPackageName: 'fixture-package', clientBatchCode: code, queryPackageDeleted: false, copyRevisionId: 1, imageRunId: 'image-fixture', status: 'READY', approvedAt: stamp, preview: null, packingState: index === 2 ? 'PACKED' : 'UNPACKED', deliveryBatch: index === 2 ? batch : null, previousDeliveryBatch: null }));
  const requests = [], errors = []; let failList = false, browser;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'); const p = url.pathname;
    if (p === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
    if (p === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (!p.startsWith('/api/')) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: p, query: Object.fromEntries(url.searchParams), body });
    const reply = (data, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(status >= 400 ? { error: { code: 'FIXTURE', message: data } } : { data })); };
    if (request.method === 'GET' && (/\/archive(?:\/[^/]+)?$/u.test(p) || /\/xlsx\/[^/]+$/u.test(p))) { response.setHeader('content-type', 'application/zip'); response.setHeader('content-disposition', 'attachment; filename="fixture.zip"'); response.setHeader('content-length', bytes.length); response.end(bytes); return; }
    if (/\/assets\/\d+/u.test(p)) { response.setHeader('content-type', 'image/png'); response.end(png); return; }
    if (p === '/api/control-plane/v1/delivery-pool') {
      if (failList) { reply('fixture list unavailable', 503); return; }
      const pending = entries.filter(e => e.packingState !== 'PACKED').length, packed = 4 - pending, published = entries.filter(e => e.preview).length;
      const selected = entries.filter(e => url.searchParams.get('packingState') === 'PENDING' ? e.packingState !== 'PACKED' : url.searchParams.get('packingState') === 'PACKED' ? e.packingState === 'PACKED' : true);
      const offset = Number(url.searchParams.get('offset')); reply({ items: selected.slice(offset, offset + 2), total: selected.length, facets: { clientBatches: [{ code, count: 4, pendingCount: pending, packedCount: packed, updatedCount: 0, queryPackageCount: 1 }], queryPackages: [{ id: 1, name: 'fixture-package', clientBatchCode: code, deleted: false, count: 4, unuploadedCount: 4 - published, publishedCount: published, revokedCount: 0, pendingCount: pending, packedCount: packed, updatedCount: 0 }], unassigned: null }, summary: { readyCount: 4, pendingCount: pending, packedCount: packed, updatedCount: 0 } }); return;
    }
    if (p === '/api/control-plane/v1/delivery-batches') { reply({ items: [batch], total: 1 }); return; }
    if (p === `/api/control-plane/v1/delivery-batches/${batchId}`) { reply({ ...batch, items: [{ id: 1, ordinal: 1, taskId: 3, copyRevisionId: 1, imageRunId: 'image-fixture', query: 'legacy-fixture-3', queryPackageId: 1, queryPackageName: 'fixture-package', clientBatchCode: code }] }); return; }
    if (/\/tasks\/\d+$/u.test(p)) { const id = Number(p.split('/').at(-1)); reply({ id, query: `legacy-fixture-${id}`, currentCopyRevisionId: 1, currentImageRunId: 'image-fixture', copyRevisions: [{ id: 1, content: { copy: { title: '合成图文标题', body: '合成测试正文，未调用模型。', tags: ['测试'] } } }], assets: [1, 2].map(n => ({ id: n, imageRunId: 'image-fixture', url: `/v1/assets/${n}` })), imageRuns: [{ id: 'image-fixture', result: { images: [{ assetId: 1 }, { assetId: 2 }] } }] }); return; }
    if (request.method === 'POST' && (p.endsWith('/archive') || p.endsWith('/xlsx'))) { reply({ downloadId: randomUUID(), fileName: p.endsWith('/xlsx') ? 'fixture.xlsx' : 'fixture.zip', taskCount: body?.taskIds?.length || 1, expiresAt: '2027-01-01T00:00:00Z', ...(p.endsWith('/archive') ? { batchId, batchCode: batch.code } : {}) }); return; }
    if (p === '/api/control-plane/v1/delivery-pool/previews') { const chosen = (body.taskIds?.length ? entries.filter(e => body.taskIds.includes(e.taskId)) : entries.filter(e => !e.preview)).slice(0, body.limit); for (const entry of chosen) entry.preview = { id: randomUUID(), noteId: 'b'.repeat(32), url: `http://127.0.0.1:${server.address().port}/published`, contentHash: 'a'.repeat(64), status: 'PUBLISHED', publishedAt: stamp, revokedAt: null }; reply({ scope: 'QUERY_PACKAGES', limit: body.limit, requestedCount: chosen.length, publishedCount: chosen.length, createdCount: chosen.length, reusedCount: 0, failedCount: 0, items: chosen.map(e => ({ taskId: e.taskId, deliveryEntryId: e.id, noteId: 'b'.repeat(32), previewUrl: e.preview.url, reused: false })), failures: [] }); return; }
    reply(`${request.method} ${p}`, 404);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chromium-headless-shell' }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByRole('button', { name: '预览图文', exact: true }).first().waitFor();
    await page.getByLabel('搜索交付内容', { exact: true }).fill('legacy-fixture-1\nlegacy-fixture-2');
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByRole('button', { name: '清除全部搜索条件', exact: true }).click();
    await page.getByRole('button', { name: /^加载更多/ }).click(); await page.getByRole('button', { name: '预览图文', exact: true }).nth(2).waitFor();
    await page.getByRole('button', { name: '预览图文', exact: true }).first().click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('heading', { name: '合成图文标题', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true); await dialog.getByRole('button', { name: '下一页', exact: true }).click(); assert.equal(await dialog.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '查看第 1 页', exact: true }).click(); assert.equal(await dialog.getByRole('button', { name: '查看第 1 页', exact: true }).getAttribute('aria-pressed'), 'true');
    const popup = page.waitForEvent('popup'); await dialog.getByRole('link', { name: '新窗口查看当前原图', exact: true }).click(); await (await popup).close(); await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    const download = async action => { const [d] = await Promise.all([page.waitForEvent('download'), action()]); const filename = join(directory, `download-${randomUUID()}.zip`); await d.saveAs(filename); assert.deepEqual(await readFile(filename), bytes); };
    await download(() => page.getByRole('button', { name: /导出.*文章与图片为 Excel/ }).click()); assert.equal(requests.findLast(r => r.method === 'POST').body.scope, 'ALL_READY');
    await page.getByRole('checkbox', { name: '选择任务 1', exact: true }).check(); await download(() => page.getByRole('button', { name: /导出已选 1 篇文章与图片为 Excel/ }).click()); assert.deepEqual(requests.findLast(r => r.method === 'POST').body, { scope: 'SELECTED', taskIds: [1] });
    await download(() => page.getByRole('button', { name: '已选新建批次（1）', exact: true }).click()); assert.deepEqual(requests.findLast(r => r.method === 'POST').body, { scope: 'SELECTED', taskIds: [1] });
    await download(() => page.getByRole('button', { name: /^新建交付批次/ }).click()); assert.equal(requests.findLast(r => r.method === 'POST').body.scope, 'ALL_READY');
    await download(() => page.getByRole('button', { name: '创建单条批次', exact: true }).first().click()); assert.equal(requests.findLast(r => r.method === 'POST').body.taskIds.length, 1);
    await page.getByRole('button', { name: '上传这一条', exact: true }).first().click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(requests.filter(r => r.path.endsWith('/previews')).length, 0);
    await page.getByRole('button', { name: '上传这一条', exact: true }).first().click(); await page.getByRole('alertdialog').getByRole('button', { name: '上传这一条', exact: true }).click(); await page.getByRole('link', { name: '打开预览', exact: true }).first().waitFor(); assert.equal(requests.findLast(r => r.path.endsWith('/previews')).body.taskIds.length, 1);
    const published = page.waitForEvent('popup'); await page.getByRole('link', { name: '打开预览', exact: true }).first().click(); await (await published).close();
    await page.getByRole('checkbox', { name: '选择任务 2', exact: true }).check();
    await page.getByRole('tab', { name: /预览发布/ }).click();
    await page.getByRole('button', { name: '上传已指定的 1 条尚未上传内容', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '上传这 1 条', exact: true }).click();
    await page.getByText('预览处理完成：新建 1 条，复用 0 条。', { exact: true }).waitFor(); assert.deepEqual(requests.findLast(r => r.path.endsWith('/previews')).body.taskIds, [2]);
    await page.getByLabel('搜索预览上传范围').fill('fixture'); await page.getByRole('button', { name: '勾选当前结果', exact: true }).click(); await page.getByRole('button', { name: '取消当前结果', exact: true }).click(); await page.getByRole('button', { name: '勾选当前结果', exact: true }).click(); await page.getByRole('button', { name: '清空选择', exact: true }).click(); await page.getByRole('button', { name: '勾选当前结果', exact: true }).click();
    for (const value of ['1 条（测试）', '10 条', '25 条', '50 条', '100 条', '200 条', '1 条（测试）']) { await page.getByRole('combobox', { name: '本次预览上传条数上限' }).click(); await page.getByRole('option', { name: value, exact: true }).click(); }
    await page.getByRole('button', { name: /整包上传.*最多 1 条/ }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '测试上传 1 条', exact: true }).click(); await page.getByText('预览处理完成：新建 1 条，复用 0 条。', { exact: true }).waitFor(); assert.equal(requests.findLast(r => r.path.endsWith('/previews')).body.limit, 1);
    await page.getByRole('tab', { name: /交付历史/ }).click(); await page.getByRole('button', { name: '查看明细', exact: true }).click(); await page.getByRole('heading', { name: 'JF-1234ABCD 明细', exact: true }).waitFor(); await page.getByRole('button', { name: '关闭明细', exact: true }).click(); await download(() => page.getByRole('button', { name: '下载 Excel', exact: true }).click()); await download(() => page.getByRole('link', { name: '重新下载 ZIP', exact: true }).click());
    await page.getByRole('tab', { name: /交付内容/ }).click(); await page.getByRole('combobox', { name: '交付状态', exact: true }).click();
    const allLoaded = page.waitForResponse(response => response.url().includes('packingState=ALL')); await page.getByRole('option', { name: '全部状态', exact: true }).click(); await allLoaded;
    await page.getByRole('button', { name: /^加载更多/ }).click(); await page.getByRole('link', { name: '重下原批次', exact: true }).waitFor(); await download(() => page.getByRole('link', { name: '重下原批次', exact: true }).click());
    await page.screenshot({ path: join(directory, 'legacy-delivery-desktop.png'), fullPage: true });
    failList = true; await page.getByRole('button', { name: /刷新/ }).first().click(); await page.getByText('fixture list unavailable（FIXTURE）', { exact: true }).waitFor(); failList = false; await page.getByRole('button', { name: /刷新/ }).first().click(); await page.getByRole('button', { name: '预览图文', exact: true }).first().waitFor();
    await page.goto(origin + '/?user=1'); await page.getByRole('button', { name: '预览图文', exact: true }).first().waitFor(); assert.equal(await page.getByRole('tab', { name: /预览发布/ }).count(), 0); assert.equal(await page.getByRole('button', { name: '上传这一条', exact: true }).count(), 0);
    assert.deepEqual(errors, []); await writeFile(join(directory, 'evidence.json'), JSON.stringify({ fake: true, modelCalls: 0, requests, errors }, null, 2)); console.log(`Legacy delivery browser evidence: ${directory}`);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
