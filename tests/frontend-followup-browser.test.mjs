import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';

test('copy candidates load on demand and image QA pages keep full counters and cancel stale reads', {
  skip: process.env.RUN_FRONTEND_FOLLOWUP_BROWSER !== '1', timeout: 180_000,
}, async () => {
  const { build } = await import('esbuild'); const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/frontend-followup'); await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `
    import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
    import{CopyFlowWorkbench}from'./app/copy-flow/copy-flow-workbench';
    import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';
    import{ImageQaWorkbench}from'./app/image-qa/image-qa-workbench';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
    import{TextInputDialogProvider}from'./components/ui/text-input-dialog';
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><TextInputDialogProvider>
      {location.pathname==='/copy-flow'?<CopyFlowWorkbench/>:location.pathname==='/copy-qa'?<CopyQaWorkbench/>:<ImageQaWorkbench role="ADMIN"/>}
    </TextInputDialogProvider></ConfirmDialogProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, format: 'esm', outdir: directory, entryNames: 'bundle',
    jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'next-fixture', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('link')
        ? `import React from'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`
        : `export const usePathname=()=>location.pathname;export const useRouter=()=>({refresh:()=>{},push:path=>location.assign(path)});` }));
    } }] });
  const { default: postcss } = await import('postcss'); const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(await readFile(join(directory, 'bundle.css'), 'utf8'), { from: resolve('app/globals.css') });
  const users = [{ id: 1, username: 'admin', displayName: '管理员', pendingCount: 3, autoBatchEnabled: true, autoBatchSize: 20 },
    { id: 2, username: 'peer', displayName: '审核人', pendingCount: 9000, autoBatchEnabled: false }];
  const tasks = Array.from({ length: 6 }, (_, index) => ({ taskId: index + 1, query: `候选任务 ${index + 1}`, approverAccountId: index < 3 ? 1 : 2,
    approverUsername: index < 3 ? 'admin' : 'peer', approvedAt: '2026-10-02T00:00:00Z' }));
  const qaItems = Array.from({ length: 225 }, (_, index) => ({ id: `item-${index + 1}`, anonymousCode: `IQ-${index + 1}`, freezePublicId: 'fake-freeze',
    status: 'PENDING', sampleKind: index % 2 ? 'MANDATORY_RECHECK' : 'RANDOM', blindReview: false, taskId: index + 1, query: `图片任务 ${index + 1}`,
    assets: [1, 2].map(page => ({ id: (index + 1) * 10 + page, mediaType: 'image/png', sha256: 'a'.repeat(64), pageIndex: page,
      originalName: `page-${page}.png`, url: `/v1/image-qa/items/item-${index + 1}/assets/${(index + 1) * 10 + page}` })),
    capabilities: { canPass: true, canReturnSingle: false, canReturnBatch: false, canDiscard: false }, blockers: { pendingImageEdits: 0 } }));
  const reads = [], mutations = [], errors = [], unexpected = [], evidence = {}; let browser;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = data => { if (!response.destroyed) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); } };
    if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(await readFile(join(directory, 'bundle.js'))); return; }
    if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (!url.pathname.startsWith('/api/')) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script type="module" src="/bundle.js"></script></body></html>'); return; }
    const read = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), aborted: false }; reads.push(read);
    response.on('close', () => { if (!response.writableFinished) read.aborted = true; });
    if (url.pathname === '/api/human-quality-settings') { reply(DEFAULT_HUMAN_QUALITY_SETTINGS); return; }
    if (url.pathname === '/api/control-plane/v2/copy-qa/candidates') {
      const summary = url.searchParams.get('summaryOnly') === 'true'; const accountId = Number(url.searchParams.get('accountId') || 0);
      if (!summary) await new Promise(resolve => setTimeout(resolve, 200));
      reply({ users, tasks: summary ? [] : accountId ? tasks.filter(task => task.approverAccountId === accountId) : tasks, truncated: false }); return;
    }
    if (url.pathname === '/api/control-plane/v2/copy-qa/batches' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      mutations.push(body); assert.match(body.requestId, /^[0-9a-f-]{36}$/u); reply({ displayName: '隔离验证批次' }); return;
    }
    if (url.pathname === '/api/control-plane/v2/copy-qa/batches' && request.method === 'GET') {
      reply({ items: [], total: 0, limit: 20, offset: 0 }); return;
    }
    if (url.pathname === '/api/control-plane/v1/image-qa/items') {
      assert.equal(url.searchParams.get('includeSummary'), 'true'); assert.equal(url.searchParams.get('limit'), '50');
      const status = url.searchParams.get('status'); const personName = url.searchParams.get('personName');
      if (personName === '慢') await new Promise(resolve => setTimeout(resolve, 1500));
      const visible = qaItems.filter(item => status === 'ALL' || item.status === status);
      const matching = personName ? [] : visible;
      const limit = 50; const total = matching.length; const offset = Math.min(Number(url.searchParams.get('offset') || 0), Math.floor((Math.max(1, total) - 1) / limit) * limit);
      reply({ items: matching.slice(offset, offset + limit), limit, offset, summary: { total,
        mandatoryCount: matching.filter(item => item.sampleKind === 'MANDATORY_RECHECK').length, assetCount: matching.reduce((sum, item) => sum + item.assets.length, 0) } }); return;
    }
    if (request.method === 'POST' && /\/v1\/image-qa\/items\/item-\d+\/pass$/u.test(url.pathname)) {
      await new Promise(resolve => setTimeout(resolve, 160));
      qaItems.find(item => url.pathname.includes(`/items/${item.id}/`)).status = 'PASSED'; reply({}); return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404; reply({});
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/copy-flow`); await page.getByRole('button', { name: '选择任务' }).first().waitFor();
    assert.equal(reads.filter(read => read.path.endsWith('/candidates')).length, 1);
    assert.equal(reads.find(read => read.path.endsWith('/candidates')).query.summaryOnly, 'true');
    assert.equal(await page.getByText('9000', { exact: true }).count(), 1);
    await page.getByRole('tab', { name: '混合模式' }).click();
    await page.getByRole('tab', { name: '个人模式' }).click();
    await page.getByRole('button', { name: '选择任务' }).first().click();
    await page.getByRole('button', { name: '返回用户列表' }).click();
    await page.waitForTimeout(260);
    assert.equal(await page.getByRole('heading', { name: '按用户创建批次' }).count(), 1);
    assert.equal(await page.getByText('候选任务 1', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '选择任务' }).first().click();
    await page.getByRole('checkbox', { name: '任务 1 入批', exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: /^任务 \d+ 入批$/u }).count(), 3);
    await page.getByRole('checkbox', { name: '任务 1 入批', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '任务 2 质检项', exact: true }).check();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('header button').disabled);
    assert.equal(await page.getByRole('checkbox', { name: '任务 1 入批', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: '任务 2 质检项', exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '手动创建批次', exact: true }).click();
    await page.getByRole('button', { name: '确认创建', exact: true }).click();
    await page.getByText('已创建 隔离验证批次，可前往文案质检页查看。').waitFor();
    assert.deepEqual(mutations[0].taskIds, [2, 3]); assert.deepEqual(mutations[0].sampleTaskIds, [2]); assert.equal(mutations[0].accountId, 1);
    assert.equal(reads.filter(read => read.path.endsWith('/candidates')).at(-1).query.summaryOnly, 'true');
    await page.getByRole('tab', { name: '混合模式' }).click(); await page.getByText('候选任务 6', { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: /^任务 \d+ 入批$/u }).count(), 6);
    await page.getByRole('checkbox', { name: '批量勾选质检项', exact: true }).check();
    assert.equal(await page.getByRole('checkbox', { name: '批量勾选入批任务', exact: true }).isChecked(), true);
    await page.getByRole('checkbox', { name: '批量勾选入批任务', exact: true }).uncheck();
    assert.equal(await page.getByRole('checkbox', { name: '批量勾选质检项', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('button', { name: '手动创建批次', exact: true }).isDisabled(), true);
    for (const id of [1, 2, 4, 5]) await page.getByRole('checkbox', { name: `任务 ${id} 入批`, exact: true }).check();
    for (const id of [2, 5]) await page.getByRole('checkbox', { name: `任务 ${id} 质检项`, exact: true }).check();
    await page.getByRole('button', { name: '手动创建批次', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(mutations.length, 1, 'cancelling mixed creation submits no mutation');
    await page.getByRole('button', { name: '手动创建批次', exact: true }).click();
    await page.getByRole('button', { name: '确认创建', exact: true }).click();
    await page.getByText('已创建 隔离验证批次，可前往文案质检页查看。').waitFor();
    assert.equal(mutations[1].mode, 'MIXED_MANUAL'); assert.deepEqual(mutations[1].taskIds, [1, 2, 4, 5]);
    assert.deepEqual(mutations[1].sampleTaskIds, [2, 5]); assert.equal(Object.hasOwn(mutations[1], 'accountId'), false);
    await page.getByRole('tab', { name: '个人模式' }).click();
    await page.getByRole('button', { name: '选择任务' }).first().click();
    await page.getByRole('checkbox', { name: '任务 1 入批', exact: true }).uncheck();
    await page.getByRole('button', { name: '按比例随机抽检并创建', exact: true }).click();
    await page.getByRole('alertdialog').getByText(/按 管理员 的抽检比例随机选取质检项/).waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(mutations.length, 2);
    await page.getByRole('button', { name: '按比例随机抽检并创建', exact: true }).click();
    await page.getByRole('button', { name: '确认创建', exact: true }).click();
    await page.getByText('已创建 隔离验证批次，可前往文案质检页查看。').waitFor();
    assert.equal(mutations[2].mode, 'PERSONAL_AUTO'); assert.equal(mutations[2].accountId, 1);
    assert.deepEqual(mutations[2].taskIds, [2, 3]); assert.deepEqual(mutations[2].sampleTaskIds, []);
    assert.equal(new Set(mutations.map(row => row.requestId)).size, 3);
    evidence.copy = { reads: reads.filter(read => read.path.endsWith('/candidates')), mutation: mutations[0] };
    evidence.copy.creations = mutations;
    await page.getByRole('link', { name: '进入文案质检', exact: true }).click();
    await page.waitForURL('**/copy-qa'); await page.getByRole('heading', { name: '待质检批次', exact: true }).waitFor();
    await page.screenshot({ path: join(directory, 'copy-flow-on-demand.png'), fullPage: true });

    await page.goto(`${origin}/image-qa`); const pagination = page.getByRole('navigation', { name: '图片质检分页' });
    await pagination.getByText('第 1 / 5 页 · 共 225 条', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 50);
    const metrics = page.getByRole('region', { name: '图片质检概况' });
    assert.deepEqual(await metrics.locator('article strong').allTextContents(), ['225', '112', '450', '全部']);
    for (let next = 0; next < 4; next++) {
      await pagination.getByRole('button', { name: '下一页', exact: true }).click();
      await pagination.getByText(`第 ${next + 2} / 5 页 · 共 225 条`, { exact: true }).waitFor();
    }
    await page.getByText('IQ-225', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 25);
    assert.equal(await page.getByText('IQ-225', { exact: true }).count(), 1);
    assert.equal(await pagination.getByRole('button', { name: '下一页' }).isDisabled(), true);
    const beforePass = reads.filter(read => read.path.endsWith('/image-qa/items')).length;
    await page.locator('tbody tr').first().getByRole('button', { name: '通过', exact: true }).click();
    await pagination.getByText('第 5 / 5 页 · 共 224 条', { exact: true }).waitFor();
    assert.equal(reads.filter(read => read.path.endsWith('/image-qa/items')).length - beforePass, 1);
    assert.equal(reads.filter(read => read.path.endsWith('/image-qa/items')).at(-1).query.offset, '200');
    await page.getByRole('tab', { name: '全部记录', exact: true }).click();
    await pagination.getByText('第 1 / 5 页 · 共 225 条', { exact: true }).waitFor();
    await page.getByLabel('按人员姓名筛选全部图片质检项', { exact: true }).fill('慢');
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).searchParams.get('personName') === '慢'),
      page.getByRole('button', { name: '应用人员', exact: true }).click(),
    ]);
    await page.getByRole('button', { name: '清除人员', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 50);
    assert.equal(await page.locator('tbody tr').count(), 50);
    assert.deepEqual(await metrics.locator('article strong').allTextContents(), ['225', '112', '450', '全部']);
    await page.locator('tbody tr').first().getByRole('button', { name: '通过', exact: true }).click();
    await page.getByRole('tab', { name: '已通过', exact: true }).click();
    await pagination.getByText('第 1 / 1 页 · 共 2 条', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.equal(reads.filter(read => read.path.endsWith('/image-qa/items')).at(-1).query.status, 'PASSED',
      'a completed mutation refreshes the current committed filter, never its previous filter');
    evidence.image = { reads: reads.filter(read => read.path.endsWith('/image-qa/items')), metrics: await metrics.locator('article strong').allTextContents() };
    await page.screenshot({ path: join(directory, 'image-qa-paged.png'), fullPage: true });
    assert.ok(reads.some(read => read.path.endsWith('/candidates') && read.aborted), 'leaving a candidate scope cancels its response');
    assert.ok(reads.some(read => read.query.personName === '慢' && read.aborted), 'changing filters cancels the pending image read');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
