import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { decodeReference } from '../src/image-edit-pixels.mjs';
import { STANDALONE_IMAGE_EDITOR_LIMITS as limits } from '../src/standalone-image-editor-config.mjs';

test('standalone boundary browser: name, five-image upload errors, list pagination and deletion cancellation/retry', {
  skip: process.env.RUN_STANDALONE_BOUNDARY_BROWSER !== '1', timeout: 150_000,
}, async () => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright-core');
  const base = resolve('.codex_artifacts/standalone-boundaries'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from'react';import{createRoot}from'react-dom/client';import{ImageEditorWorkbench}from'./app/image-editor/workbench';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{BackgroundTasksProvider}from'./app/components/background-tasks';import{Toaster}from'./components/ui/sonner';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><BackgroundTasksProvider accountKey="standalone-boundary"accountUsername="fixture"accountId={7}><ImageEditorWorkbench/><Toaster/></BackgroundTasksProvider></ConfirmDialogProvider>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const js = await readFile(join(directory, 'bundle.js')), rawCss = await readFile(join(directory, 'bundle.css'), 'utf8');
  const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const raster = sharp({ create: { width: limits.width, height: limits.height, channels: 4, background: '#edf3e9' } });
  const [png, jpeg, webp, small] = await Promise.all([raster.clone().png().toBuffer(), raster.clone().jpeg().toBuffer(), raster.clone().webp().toBuffer(), sharp({ create: { width: 20, height: 20, channels: 4, background: '#eeeeee' } }).png().toBuffer()]);
  let rows = Array.from({ length: 21 }, (_, i) => ({ id: 901+i, title: `边界图片${i+1}`, owner: 'fixture', status: i === 0 ? 'RUNNING' : 'UPLOADED', nodeId: i === 0 ? 'fixture-worker' : null, error: null, createdAt: '2026-10-02T00:00:00Z' }));
  let failList = false, failDelete = true, failUpload = false, workspace = null, browser;
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), p = url.pathname;
    if (p === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
    if (p === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (!p.startsWith('/api/')) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<html><meta charset="utf-8"><link rel="stylesheet"href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: p, query: Object.fromEntries(url.searchParams), body });
    const reply = (value, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(status >= 400 ? { error: { code: 'FIXTURE', message: value } } : { data: value })); };
    if (p.endsWith('/image-editor/limits')) { reply('Legacy fixture', 404); return; }
    if (p.endsWith('/image-editor/workspaces/delete')) {
      if (failDelete) { reply('合成删除暂时失败', 503); return; }
      rows = rows.filter(row => !body.workspaceIds.includes(row.id)); reply({ deletedIds: body.workspaceIds }); return;
    }
    if (p.endsWith('/image-editor/workspaces') && request.method === 'GET') {
      if (failList) { reply('合成列表暂时失败', 503); return; }
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      reply({ total: rows.length, items: rows.slice(offset, offset+limit) }); return;
    }
    if (p.endsWith('/image-editor/workspaces') && request.method === 'POST') {
      if (failUpload) { failUpload = false; reply('合成上传暂时失败', 503); return; }
      try {
        for (const image of body.images) {
          const decoded = await decodeReference(Buffer.from(image.base64, 'base64'), image.mediaType);
          if (decoded.width !== limits.width || decoded.height !== limits.height) throw new TypeError('原图必须为 1086×1448，不会自动拉伸或裁切');
        }
        workspace = { id: 980, title: body.title, status: 'UPLOADED', runId: randomUUID(), copyRevisionId: 44, runs: [], assets: body.images.map((_, i) => ({ id: 701+i, sha256: String(i+1).repeat(64), url: '/v1/image-editor/assets/'+(701+i) })) };
        reply(workspace);
      } catch (error) { reply(error.message, 400); }
      return;
    }
    if (p.includes('/image-editor/assets/')) { response.setHeader('content-type', 'image/png'); response.end(png); return; }
    if (p.endsWith('/workspaces/980')) { reply(workspace); return; }
    if (p.endsWith('/workspaces/980/image-edits')) { reply([]); return; }
    reply('Unused fixture '+p, 404);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chromium-headless-shell' });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`; await page.goto(origin);
    const list = page.getByRole('region', { name: '图片编辑列表', exact: true });
    await list.getByText('第 1 / 2 页', { exact: true }).waitFor();
    assert.equal(await list.locator('tbody tr').count(), 20);
    assert.equal(await list.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
    assert.equal(await list.getByLabel('选择图片 边界图片1', { exact: true }).isDisabled(), true);
    assert.equal(await list.locator('tbody tr').first().getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
    await list.getByRole('button', { name: '下一页', exact: true }).click();
    await list.getByText('第 2 / 2 页', { exact: true }).waitFor(); assert.equal(await list.locator('tbody tr').count(), 1);
    assert.equal(await list.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await list.getByRole('button', { name: '上一页', exact: true }).click(); await list.getByText('第 1 / 2 页', { exact: true }).waitFor();
    await list.getByRole('button', { name: '下一页', exact: true }).click(); await list.getByText('边界图片21', { exact: true }).waitFor();
    const deleteCount = () => requests.filter(row => row.path.endsWith('/delete')).length;
    await list.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(deleteCount(), 0); assert.equal(rows.length, 21);
    await list.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await list.getByRole('alert').filter({ hasText: '合成删除暂时失败' }).waitFor(); assert.equal(rows.length, 21); assert.equal(await list.locator('tbody tr').count(), 1);
    failDelete = false; await list.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await list.getByText('第 1 / 1 页', { exact: true }).waitFor(); assert.equal(await list.locator('tbody tr').count(), 20); assert.equal(rows.length, 20);
    await list.getByLabel('全选本页可删除图片').check(); assert.equal(await list.getByRole('checkbox', { checked: true }).count(), 20); // header plus 19 removable rows
    await list.getByRole('button', { name: '批量删除（19）', exact: true }).click(); const before = deleteCount(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(deleteCount(), before);
    await list.getByRole('button', { name: '批量删除（19）', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await list.getByText('共 1 条图片编辑', { exact: true }).waitFor(); assert.deepEqual(rows.map(row => row.id), [901]);
    failList = true; await list.getByRole('button', { name: '刷新', exact: true }).click(); await list.getByRole('alert').filter({ hasText: '合成列表暂时失败' }).waitFor(); assert.equal(await list.locator('tbody tr').count(), 1);
    failList = false; await list.getByRole('button', { name: '刷新', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="图片编辑列表"]')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: '新增图片', exact: true }).click();
    const title = page.getByLabel('图片名称（可选）', { exact: true }); assert.equal(await title.getAttribute('maxlength'), '200'); await title.fill('名'.repeat(200)); await title.press('End'); await title.pressSequentially('额'); assert.equal((await title.inputValue()).length, 200);
    const uploadsBefore = requests.filter(row => row.method === 'POST' && row.path.endsWith('/workspaces')).length;
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); assert.equal(requests.filter(row => row.method === 'POST' && row.path.endsWith('/workspaces')).length, uploadsBefore);
    await page.getByRole('button', { name: '新增图片', exact: true }).click(); assert.equal(await title.inputValue(), ''); await title.fill('合成五张格式检查');
    const input = page.getByLabel('上传待编辑图片', { exact: true });
    await input.setInputFiles(Array.from({ length: 6 }, (_, i) => ({ name: 'six-'+i+'.png', mimeType: 'image/png', buffer: png })));
    await page.getByRole('alert').filter({ hasText: '每次最多上传 5 张' }).waitFor(); assert.equal(workspace, null);
    assert.equal(requests.filter(row => row.method === 'POST' && row.path.endsWith('/workspaces')).length, uploadsBefore);
    await input.setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
    await page.getByRole('alert').filter({ hasText: /图片|image|Image|PNG|png/ }).waitFor(); assert.equal(workspace, null);
    await input.setInputFiles({ name: 'wrong-size.png', mimeType: 'image/png', buffer: small }); await page.getByRole('alert').filter({ hasText: '原图必须为 1086×1448' }).waitFor(); assert.equal(workspace, null);
    failUpload = true; await input.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: png }); await page.getByRole('alert').filter({ hasText: '合成上传暂时失败' }).waitFor(); assert.equal(await title.inputValue(), '合成五张格式检查'); assert.equal(await input.isEnabled(), true);
    const files = [{ name: 'one.png', mimeType: 'image/png', buffer: png }, { name: 'two.jpg', mimeType: 'image/jpeg', buffer: jpeg }, { name: 'three.webp', mimeType: 'image/webp', buffer: webp }, { name: 'four.png', mimeType: 'image/png', buffer: png }, { name: 'five.png', mimeType: 'image/png', buffer: png }];
    await input.setInputFiles(files); await page.getByText('已上传 5 张图片', { exact: true }).waitFor();
    assert.equal(workspace.title, '合成五张格式检查'); assert.equal(workspace.assets.length, 5);
    const commit = requests.findLast(row => row.method === 'POST' && row.path.endsWith('/workspaces')).body; assert.deepEqual(commit.images.map(row => row.mediaType), files.map(row => row.mimeType));
    const button = page.getByRole('button', { name: '第 5 张', exact: true }); await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true'); await page.getByRole('button', { name: '第 1 张', exact: true }).click();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    assert.deepEqual(errors, []); await page.screenshot({ path: join(directory, 'standalone-boundaries.png'), fullPage: true });
    const evidence = { backend: 'isolated HTTP fixture; decodeReference and image dimensions validated with actual Sharp', modelCalls: 0, featureIds: ['F-STAND-001','F-STAND-002','F-STAND-003','F-STAND-004','F-STAND-006','F-STAND-010','F-STAND-011','F-STAND-012'], scope: '21 rows actual 20/1 pagination and last-page deletion recovery; running row disabled, individual and batch cancel/confirm/error/retry, refresh503 retains rows; name200/reset/cancel no POST; max5 rejects6 before POST, corrupt and wrong-size visible backend errors, upload503 retains name, actual PNG/JPEG/WebP 5-image commit order and page1/5', requests, errors, screenshot: join(directory, 'standalone-boundaries.png') };
    await writeFile(resolve('reports/full-functional-2026-10-02/standalone-boundary-browser-evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
