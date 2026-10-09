import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import { parseQueryPackageSpreadsheet } from '../server/src/query-package-spreadsheet.mjs';

test('query package browser: all list and item filters, actual files, staged decisions, pagination and rejection recovery', {
  skip: process.env.RUN_QUERY_PACKAGE_BROWSER !== '1', timeout: 240000,
}, async () => {
  const { build } = await import('esbuild'); const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'query-package-browser-')); const out = resolve('reports/full-functional-2026-10-02'); await mkdir(out, { recursive: true });
  await build({ stdin: { contents: `import'./app/globals.css';import React from'react';import{createRoot}from'react-dom/client';import{QueryPackageWorkbench}from'./app/query-packages/query-package-workbench';import{Toaster}from'./components/ui/sonner';createRoot(document.getElementById('root')).render(<><QueryPackageWorkbench role={new URLSearchParams(location.search).get('role')??'ADMIN'}/><Toaster/></>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
  const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
  const styled = await postcss([tailwind()]).process(await readFile(join(directory, 'bundle.css'), 'utf8'), { from: resolve('app/globals.css') }); await writeFile(join(directory, 'bundle.css'), styled.css);
  const statuses = ['DRAFT', 'IMPORTED', 'SCREENING', 'READY', 'PARTIALLY_USED', 'USED_UP', 'ABANDONED', 'PRODUCED', 'CLOSED'];
  const makeItem = n => ({ id: n, rowNumber: n, externalId: `external-${n}`, query: `合成Query ${n}`, issuedQuery: `下发Query ${n}`, input: {}, requestedImageCount: 'auto', validationStatus: n === 2 ? 'INVALID' : n === 3 ? 'DUPLICATE' : n === 4 ? 'TASK_CREATED' : 'READY', screeningDecision: n === 4 || n === 5 ? 'SELECTED' : n === 6 ? 'REJECTED' : 'PENDING', screeningReason: n === 6 ? '既有淘汰原因' : null, taskId: n === 4 ? 7004 : null, screeningAssignedToAccountId: 2, screeningAssignedToUserId: 'fixture-worker', version: 1 });
  let items = Array.from({ length: 205 }, (_, i) => makeItem(i + 1)); let version = 1;
  const counts = values => ({ total: values.length, pending: values.filter(i => i.screeningDecision === 'PENDING').length, selected: values.filter(i => i.screeningDecision === 'SELECTED').length, rejected: values.filter(i => i.screeningDecision === 'REJECTED').length, produced: values.filter(i => i.taskId).length });
  const summary = (id, status = 'SCREENING') => ({ id, name: id === 1 ? '主筛选夹具' : `词包夹具-${String(id).padStart(3, '0')}`, clientBatchCode: 'a'.repeat(32), status, assignedToUserId: 'fixture-worker', assignedToAccountId: 2, assignedToDisplayName: '合成筛选人', assignedToRole: 'USER', assigneeStatus: 'ACTIVE', assignedItemCount: 200, assignedUserCount: 1, participantCount: 1, participantNames: ['合成筛选人'], version: id === 1 ? version : 1, counts: id === 1 ? counts(items) : { total: 1, pending: status === 'ABANDONED' ? 0 : 1, selected: 0, rejected: 0, produced: 0 }, createdAt: '2026-10-01T01:00:00Z' });
  let packages = Array.from({ length: 201 }, (_, i) => summary(i + 1, i === 0 ? 'SCREENING' : statuses[(i - 1) % statuses.length]));
  const requests = [], imports = [], screenings = [], previewEvidence = [], evidence = [], errors = [], unexpected = [];
  let listFail = true, importFail = false, holdImport = false, releaseImport, screenFail = false, usersFail = false, noUsers = false, emptyRole = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const p = url.pathname;
    if (p === '/bundle.js' || p === '/bundle.css') { res.setHeader('content-type', p.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(join(directory, p.slice(1)))); return; }
    if (!p.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks); const body = p.endsWith('/import-preview') ? null : raw.length ? JSON.parse(raw.toString()) : null;
    requests.push({ method: req.method, path: p, params: Object.fromEntries(url.searchParams), body });
    const reply = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status >= 400 ? { error: { code: 'FIXTURE', message: data } } : { data })); };
    if (req.method === 'GET' && p.endsWith('/query-packages')) {
      if (listFail) { listFail = false; reply('合成词包列表失败，可刷新恢复', 503); return; }
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit')); const values = emptyRole ? [] : packages.map(item => item.id === 1 ? summary(1) : item);
      reply({ items: values.slice(offset, offset + limit), total: values.length, returnedCount: values.slice(offset, offset + limit).length }); return;
    }
    if (req.method === 'PUT' && p.endsWith('/import-preview')) {
      try { const preview = await parseQueryPackageSpreadsheet(raw, { sheet: url.searchParams.get('sheet') ?? undefined, column: url.searchParams.get('column') ?? undefined }); previewEvidence.push({ sourceBytes: raw.length, params: Object.fromEntries(url.searchParams), preview }); reply(preview); } catch (error) { reply(error.message, 400); } return;
    }
    if (req.method === 'POST' && p.endsWith('/query-packages')) {
      imports.push(body); if (holdImport) { holdImport = false; await new Promise(resolve => { releaseImport = resolve; }); }
      if (importFail) { importFail = false; reply('合成导入失败，请保留内容重试', 503); return; }
      const batches = body.splitByClientBatchCode ? [...new Set(body.items.map(item => item.clientBatchCode))] : [body.clientBatchCode]; const created = batches.map((batch, index) => ({ ...summary(300 + imports.length * 10 + index, 'IMPORTED'), name: `${body.name}${index ? `-${index}` : ''}`, clientBatchCode: batch })); packages.push(...created); reply({ packages: created }); return;
    }
    const detailMatch = p.match(/\/query-packages\/(\d+)$/);
    if (req.method === 'GET' && detailMatch) {
      const id = Number(detailMatch[1]); const pkg = id === 1 ? summary(1) : packages.find(item => item.id === id); if (!pkg) { reply('无权访问未分配词包', 404); return; }
      const filter = url.searchParams.get('itemFilter'), search = url.searchParams.get('itemSearch') ?? '';
      const values = (id === 1 ? items : items.slice(6, 12)).filter(item => (!search || item.query.includes(search) || item.externalId.includes(search)) && (filter === 'ALL' || filter === 'PENDING' && item.screeningDecision === 'PENDING' || filter === 'SELECTED' && item.screeningDecision === 'SELECTED' || filter === 'REJECTED' && item.screeningDecision === 'REJECTED' || filter === item.validationStatus));
      const offset = Number(url.searchParams.get('itemCursor')?.split(':')[1] ?? 0), limit = Number(url.searchParams.get('itemLimit')); const selected = values.slice(offset, offset + limit);
      reply({ ...pkg, visibleCounts: counts(id === 1 ? items : items.slice(6, 12)), countScope: url.searchParams.get('role') ? 'MY_ASSIGNMENT' : 'FULL_PACKAGE', items: selected, itemPage: { total: values.length, returnedCount: selected.length, hasMore: offset + selected.length < values.length, nextCursor: offset + selected.length < values.length ? `${version}:${offset + selected.length}` : null } }); return;
    }
    if (req.method === 'PUT' && p.endsWith('/1/screening')) {
      screenings.push(body); if (screenFail) { screenFail = false; version++; items[0].version++; reply('版本已变化，拒绝陈旧筛选', 409); return; }
      for (const decision of body.decisions) { const item = items.find(item => item.id === decision.itemId); assert.equal(decision.expectedItemVersion, item.version); assert.equal(item.validationStatus, 'READY'); item.screeningDecision = decision.decision === 'SELECT' ? 'SELECTED' : 'REJECTED'; item.screeningReason = decision.reason ?? null; if (decision.decision === 'SELECT') { item.taskId = 7000 + item.id; item.validationStatus = 'TASK_CREATED'; } item.version++; } version++; reply({ queryPackage: summary(1) }); return;
    }
    if (req.method === 'GET' && p.endsWith('/users')) { if (usersFail) { usersFail = false; reply('合成账号载入失败', 503); return; } reply(noUsers ? [] : [{ id: 2, username: 'fixture-worker', displayName: '合成筛选人', role: 'USER', status: 'ACTIVE' }]); return; }
    if (req.method === 'GET' && p.endsWith('/item-assignment-summary')) { reply({ packageId: Number(p.match(/query-packages\/(\d+)/)[1]), packageVersion: version, eligibleTotal: 200, assignedTotal: 0, unassignedTotal: 200, assignees: [] }); return; }
    unexpected.push(`${req.method} ${p}`); reply('Unexpected fixture request', 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`; const browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const listRows = () => page.locator('section > div.table-wrap tbody tr');
  const listSearch = () => page.getByPlaceholder('搜索词包、甲方批次或筛选人', { exact: true });
  const importDialog = () => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '导入 Query 词包', exact: true }) });
  const detailDialog = () => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '主筛选夹具', exact: true }) });
  const row = number => detailDialog().getByRole('row').filter({ has: page.getByRole('checkbox', { name: `选择第 ${number} 条 Query 进行筛选`, exact: true }) });
  async function openImport() { await page.getByRole('button', { name: '导入 Query 词包', exact: true }).click(); await importDialog().getByLabel('词包名称', { exact: true }).fill('合成文件导入词包'); await importDialog().getByLabel('甲方批次编号', { exact: true }).fill('A'.repeat(32)); }
  async function selectDetail(label) { await detailDialog().getByRole('combobox').click(); await page.getByRole('option', { name: label, exact: true }).click(); await page.waitForTimeout(80); }
  async function openDetail() { await listSearch().fill('主筛选夹具'); await listRows().getByRole('button', { name: '筛选 Query', exact: true }).click(); await detailDialog().getByRole('checkbox', { name: '选择第 1 条 Query 进行筛选', exact: true }).waitFor(); }
  async function file(name, contents, mimeType = 'text/plain') { await importDialog().getByLabel('读取文本或 XLSX 文件', { exact: true }).setInputFiles({ name, mimeType, buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents) }); }
  async function workbook(sheets) { const book = new ExcelJS.Workbook(); for (const [name, rows] of sheets) { const sheet = book.addWorksheet(name); rows.forEach(row => sheet.addRow(row)); } return Buffer.from(await book.xlsx.writeBuffer()); }
  try {
    await page.goto(origin); await page.getByRole('alert').filter({ hasText: '合成词包列表失败' }).waitFor(); await page.getByRole('button', { name: '刷新', exact: true }).click(); await listRows().first().waitFor(); assert.equal(await listRows().count(), 200);
    await page.getByText(/仍有更多词包/).waitFor(); await page.getByRole('button', { name: '加载更多词包', exact: true }).click(); await page.getByText(/已加载的 201 个词包/).waitFor(); assert.equal(await listRows().count(), 201); assert.equal(await page.getByRole('button', { name: '加载更多词包', exact: true }).count(), 0);
    const states = []; for (let index = 1; index <= statuses.length; index++) { await page.getByRole('combobox').click(); const option = page.getByRole('option').nth(index); states.push(await option.innerText()); await option.click(); const expected = packages.filter(item => item.status === statuses[index - 1]); assert.equal(await listRows().count(), expected.length); }
    await page.getByRole('combobox').click(); await page.getByRole('option', { name: '全部状态', exact: true }).click();
    for (const token of ['词包夹具-201', '合成筛选人', 'a'.repeat(32)]) { await listSearch().fill(token); assert.equal(await listRows().count(), packages.filter(item => `${item.name} ${item.clientBatchCode} ${item.assignedToDisplayName}`.includes(token)).length); }
    await listSearch().fill('no-such-package'); await page.getByText(/没有符合筛选条件的词包/).waitFor(); await listSearch().fill('');
    evidence.push({ id: 'QP01', featureIds: ['F-QPK-001', 'F-QPK-002', 'F-QPK-003', 'F-QPK-004', 'F-QPK-005', 'F-QPK-041'], status: 'PASS', scope: 'actual refresh after503,200+1paginationall9statuses/name/participant/batch/no-match filters and loaded-range counts', states, total: 201 });

    console.log('QP02 files begin'); await openImport(); const dialog = importDialog(), submit = dialog.getByRole('button', { name: '创建词包', exact: true }); const content = dialog.getByLabel('Query 内容', { exact: true });
    const packageName = dialog.getByLabel('词包名称', { exact: true });
    await file('合成.txt', '第一条\n第二条\n第一条\n\n'); await page.getByText('来源文件：合成.txt', { exact: true }).waitFor(); assert.equal(await content.inputValue(), '第一条\n第二条\n第一条\n\n'); await page.getByText('识别 2 条 · 重复 1 条', { exact: true }).waitFor();
    assert.equal(await packageName.inputValue(), '合成文件导入词包', 'TXT imports retain the manually entered package name');
    await file('合成.csv', 'CSV第一条\nCSV第二条'); await page.getByText('来源文件：合成.csv', { exact: true }).waitFor(); assert.equal(await content.inputValue(), 'CSV第一条\nCSV第二条');
    assert.equal(await packageName.inputValue(), '合成文件导入词包', 'CSV imports retain the manually entered package name');
    await content.fill(''); assert.equal(await submit.isDisabled(), true); assert.equal(imports.length, 0); assert.equal(await content.evaluate(element => element.validity.valueMissing), true);
    await file('超限10001.txt', Array.from({ length: 10001 }, (_, i) => `超限${i}`).join('\n')); await page.getByRole('alert').filter({ hasText: /10,000|10000/ }).waitFor(); assert.ok(await submit.isDisabled());
    await content.fill('超长'.repeat(251)); assert.ok(await submit.isDisabled()); await content.fill('失败保持与重试'); importFail = true; holdImport = true; await submit.click(); await page.getByRole('button', { name: '导入中…', exact: true }).waitFor(); assert.ok(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled()); assert.ok(await content.isDisabled()); assert.equal(imports.length, 1); releaseImport(); await page.getByRole('alert').filter({ hasText: '合成导入失败' }).waitFor(); assert.equal(await content.inputValue(), '失败保持与重试'); await submit.click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(imports[0].requestId, imports[1].requestId); assert.equal(imports[1].clientBatchCode, 'a'.repeat(32)); console.log('QP02 real XLSX begin');
    await openImport();
    const columnFile = await workbook([['甲表', [['Query', '备选'], ['甲列第一条', '替代列第一条'], ['甲列第二条', '替代列第二条']]], ['乙表', [['Query'], ['乙表唯一选题']]]]);
    await file('多页列.新版.XLSX', columnFile, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await dialog.getByRole('combobox').nth(1).waitFor();
    assert.equal(await packageName.inputValue(), '多页列.新版', 'Excel selection removes only the final extension, case insensitively');
    assert.equal(await content.inputValue(), '甲列第一条\n甲列第二条');
    await packageName.fill('手动调整词包名称');
    await dialog.getByRole('combobox').nth(1).click(); await page.getByRole('option', { name: 'B · 备选', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#query-package-content')?.value.startsWith('备选'));
    assert.equal(await content.inputValue(), '备选\n替代列第一条\n替代列第二条');
    assert.equal(await packageName.inputValue(), '手动调整词包名称', 'changing the selected column preserves the edited name');
    await dialog.getByRole('combobox').nth(0).click(); await page.getByRole('option', { name: '乙表', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#query-package-content')?.value === '乙表唯一选题');
    assert.equal(await packageName.inputValue(), '手动调整词包名称', 'changing the selected sheet preserves the edited name');
    await file('损坏.xlsx', 'not-a-zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await dialog.getByRole('alert').waitFor(); assert.equal(imports.length, 2);
    await file('空.xlsx', await workbook([['空表', [['Query']]]]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await dialog.getByRole('alert').filter({ hasText: '没有可导入' }).waitFor();
    const standard = await workbook([['标准', [['序号', '下发query', '生产query', '任务ID'], ['原始1', '下发第一条', '生产优先第一条', 'A'.repeat(32)], ['原始2', '回退下发第二条', '', 'b'.repeat(32)]]]]);
    await file('标准.xlsx', standard, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await dialog.getByText('按 2 个任务ID自动拆包', { exact: true }).waitFor();
    assert.equal(await packageName.inputValue(), '标准', 'selecting another Excel file replaces the previous name');
    assert.equal(await dialog.getByLabel('Query 内容', { exact: true }).count(), 0); assert.ok(await dialog.getByText('生产优先第一条', { exact: true }).isVisible()); assert.ok(await dialog.getByText('回退下发第二条', { exact: true }).first().isVisible());
    await submit.click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(imports.at(-1).name, '标准', 'the creation request uses the displayed Excel-derived name');
    assert.equal(imports.at(-1).splitByClientBatchCode, true); assert.deepEqual(imports.at(-1).items.map(item => [item.query, item.issuedQuery, item.clientBatchCode]), [['生产优先第一条', '下发第一条', 'a'.repeat(32)], ['回退下发第二条', '回退下发第二条', 'b'.repeat(32)]]);
    await openImport(); await file('错误任务ID.xlsx', await workbook([['标准', [['下发query', '生产query', '任务ID'], ['下发', '生产', 'invalid']]]]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await dialog.getByRole('alert').filter({ hasText: '任务ID必须' }).waitFor(); assert.ok(await submit.isDisabled()); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    evidence.push({ id: 'QP02', featureIds: ['F-QPK-006', 'F-QPK-007', 'F-QPK-008', 'F-QPK-009', 'F-QPK-010', 'F-QPK-011', 'F-QPK-012', 'F-QPK-013', 'F-QPK-014', 'F-QPK-015', 'F-QPK-041'], status: 'PASS', scope: 'real TXT/CSV/XLSX bytes, real production spreadsheet parser; Excel filename package naming, manual names survive sheet/column switches and TXT/CSV, new Excel name submitted; standard production/fallback/split; empty/corrupt/10001/long/invalid32 guards;503sameUUID retry and busy cancel/inputs; fake persistence only', imports });

    console.log('QP03 detail begin'); await openDetail(); await selectDetail('全部筛选结果'); await detailDialog().getByRole('button', { name: '继续加载', exact: true }).click(); await detailDialog().getByText('已加载 205 / 205 条', { exact: true }).waitFor();
    const viewport = detailDialog().getByRole('rowgroup'); await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; }); await detailDialog().getByRole('checkbox', { name: '选择第 205 条 Query 进行筛选', exact: true }).waitFor(); await viewport.evaluate(element => { element.scrollTop = 0; }); await row(1).waitFor();
    const filters = []; for (const [label, token] of [['待筛选', 'PENDING'], ['已通过', 'SELECTED'], ['已淘汰', 'REJECTED'], ['内容无效', 'INVALID'], ['重复项', 'DUPLICATE'], ['已创建作业', 'TASK_CREATED'], ['全部筛选结果', 'ALL']]) { await selectDetail(label); filters.push({ label, token, params: requests.findLast(request => request.path.endsWith('/query-packages/1') && request.method === 'GET').params }); assert.equal(filters.at(-1).params.itemFilter, token); }
    await detailDialog().getByPlaceholder('搜索 Query 或外部编号', { exact: true }).fill('external-205'); await detailDialog().getByRole('button', { name: '应用搜索', exact: true }).click(); await detailDialog().getByRole('checkbox', { name: '选择第 205 条 Query 进行筛选', exact: true }).waitFor(); assert.equal(await detailDialog().getByRole('checkbox', { name: /^选择第/ }).count(), 1); await detailDialog().getByPlaceholder('搜索 Query 或外部编号', { exact: true }).fill(''); await detailDialog().getByRole('button', { name: '应用搜索', exact: true }).click(); await row(1).waitFor();
    for (const n of [2, 3, 4]) { assert.ok(await row(n).getByRole('checkbox').isDisabled()); assert.ok(await row(n).getByRole('button', { name: '通过', exact: true }).isDisabled()); }
    await row(1).getByRole('button', { name: '通过', exact: true }).click(); await row(1).getByText('待提交：通过', { exact: true }).waitFor(); await row(1).getByRole('button', { name: '淘汰', exact: true }).click(); await row(1).getByText('待提交：淘汰', { exact: true }).waitFor(); assert.equal(screenings.length, 0); await detailDialog().getByRole('button', { name: '关闭', exact: true }).click(); await openDetail(); assert.equal(await detailDialog().getByText(/待提交：/).count(), 0); assert.equal(screenings.length, 0);
    await row(1).getByRole('button', { name: '淘汰', exact: true }).click(); await row(1).getByRole('button', { name: '通过', exact: true }).click(); await detailDialog().getByRole('button', { name: '提交本批 1', exact: true }).click(); await detailDialog().getByText(/已加载/).waitFor(); await page.waitForFunction(() => document.body.textContent.includes('通过项已自动进入文案生成')); assert.equal(screenings.at(-1).decisions[0].decision, 'SELECT'); assert.equal(items[0].taskId, 7001);
    await selectDetail('全部筛选结果'); await row(1).waitFor(); assert.ok(await row(1).getByRole('checkbox').isDisabled()); assert.match(await row(1).innerText(), /#7001/);
    await selectDetail('待筛选'); await row(7).getByRole('checkbox').check(); await detailDialog().getByLabel('筛选原因', { exact: true }).fill('合成批量淘汰原因'); await detailDialog().getByRole('button', { name: '批量淘汰 1', exact: true }).click(); await page.waitForFunction(() => document.body.textContent.includes('淘汰 1 条')); assert.equal(screenings.at(-1).decisions[0].reason, '合成批量淘汰原因'); assert.equal(items[6].taskId, null);
    await row(8).getByRole('button', { name: '通过', exact: true }).click(); screenFail = true; await detailDialog().getByRole('button', { name: '提交本批 1', exact: true }).click(); await page.waitForTimeout(300); assert.equal(await detailDialog().getByText(/待提交：/).count(), 0); assert.equal(await detailDialog().getByRole('button', { name: '提交本批', exact: true }).isDisabled(), true); assert.equal(items[7].screeningDecision, 'PENDING');
    // Rejection must remain visible after authoritative reload; product errors cannot vanish silently.
    await detailDialog().getByText(/版本已变化，拒绝陈旧筛选/).waitFor();
    await detailDialog().getByRole('button', { name: '关闭', exact: true }).click();
    evidence.push({ id: 'QP03', featureIds: ['F-QPK-023', 'F-QPK-024', 'F-QPK-025', 'F-QPK-026', 'F-QPK-027', 'F-QPK-028', 'F-QPK-029', 'F-QPK-030', 'F-QPK-031', 'F-QPK-032', 'F-QPK-033', 'F-QPK-035', 'F-QPK-041'], status: 'PASS', scope: 'actual200+5pagination/nativevirtualscroll,7filters,externalsearch/clear,readonlyguards;stagebothdirectionsclose/reopen noPUT;confirmSELECTexactversion/tasklink,REJECTreason;409clearsstalechoicesandvisibleerror;HTTPfakeproductionstate', filters, screenings });

    await listSearch().fill('词包夹具-007'); await listRows().getByRole('button', { name: '查看 Query', exact: true }).click(); const closed = page.getByRole('dialog'); await closed.getByRole('checkbox', { name: '选择第 8 条 Query 进行筛选', exact: true }).waitFor(); assert.ok(await closed.getByRole('checkbox', { name: '选择第 8 条 Query 进行筛选', exact: true }).isDisabled()); assert.equal(await closed.getByRole('button', { name: /^提交本批/ }).count(), 0); await closed.getByRole('button', { name: '关闭', exact: true }).click();
    await listSearch().fill('主筛选夹具'); usersFail = true; await listRows().getByRole('button', { name: '分配筛选', exact: true }).click(); const assignment = page.getByRole('dialog'); await assignment.getByRole('alert').filter({ hasText: '合成账号载入失败' }).waitFor(); await assignment.getByRole('button', { name: '取消', exact: true }).click(); noUsers = true; await listRows().getByRole('button', { name: '分配筛选', exact: true }).click(); await assignment.getByText(/没有.*账号|没有.*人员|没有可分配|没有启用中的质检或标注/).waitFor(); await assignment.getByRole('button', { name: '取消', exact: true }).click(); noUsers = false;
    emptyRole = true; for (const role of ['USER', 'REVIEWER']) { await page.goto(`${origin}?role=${role}`); await page.getByText(role === 'USER' ? '今天的词包已处理完成。' : '管理员暂未给你分配需要筛选的词包。', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '导入 Query 词包', exact: true }).count(), 0); }
    evidence.push({ id: 'QP04', featureIds: ['F-QPK-022', 'F-QPK-023', 'F-QPK-034', 'F-QPK-041'], status: 'PASS', scope: 'closed-package screening readonly;assignmentusers503cancel/reopen noactiveusers;actualUSER/REVIEWERempty/noimport;backendassignmentprivacyseparatelyrealPG' });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  } catch (error) {
    console.log('QP failure: '+String(error.stack).slice(0,4000)); releaseImport?.(); await page.screenshot({ path: join(out, 'query-package-browser-failure.png'), fullPage: false, timeout: 5000 }).catch(() => {}); const screen = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '[browser unresponsive]'); throw new Error(`${String(error.message).slice(0,4000)}\n${screen.slice(0,6000)}\n${JSON.stringify(requests.slice(-5))}`, { cause: error });
  } finally {
    await writeFile(join(out, 'query-package-browser-evidence.json'), JSON.stringify({ evidenceType: 'UI_FIXTURE_REAL_XLSX_PARSER', finishedAt: new Date().toISOString(), modelCalls: 0, cases: evidence, previews: previewEvidence, errors, unexpected }, null, 2)); releaseImport?.(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
});
