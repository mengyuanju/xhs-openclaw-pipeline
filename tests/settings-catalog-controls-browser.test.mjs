import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { BUILTIN_LAYOUT_CATALOG, LAYOUT_FAMILIES, normalizeLayoutCatalog, templateKey } from '../server/src/layout-catalog.mjs';
import { changeLayoutCatalog, layoutCatalogRecord } from '../server/src/layout-catalog-settings.mjs';
import { LAYOUT_KIND_LABELS, normalizeLayoutPresets } from '../server/src/layout-library.mjs';
import { DEFAULT_PRODUCTION_SETTINGS, normalizeProductionSettings } from '../src/production-settings.mjs';

const endpoint = '/api/control-plane/v1/layout-catalog';
const productionEndpoint = '/api/control-plane/v1/settings/production';
const enabled = process.env.RUN_SETTINGS_CATALOG_CONTROLS_BROWSER === '1';

async function createFixture(contents, respond) {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/settings-catalog-controls');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
    import{Toaster}from'./components/ui/sonner';${contents}`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
  alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [script, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const errors = [], unexpected = [], requests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(script); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return;
      }
      const entry = { path: url.pathname, method: request.method }; requests.push(entry);
      let raw = ''; for await (const chunk of request) raw += chunk;
      if (raw) entry.body = JSON.parse(raw);
      const reply = (data, status = 200) => { entry.status = status; response.statusCode = status;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      const reject = (status, code, message) => { entry.status = status; response.statusCode = status;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code, message } })); };
      if (await respond(entry, reply, reject)) return;
      unexpected.push(`${request.method} ${url.pathname}`); reject(404, 'UNEXPECTED', 'Unexpected fixture request');
    } catch (error) {
      errors.push(error.message); response.statusCode = 500; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'FIXTURE_ASSERTION', message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) {
      unexpected.push(`EXTERNAL ${route.request().method()} ${route.request().url()}`); await route.abort(); return;
    }
    await route.continue();
  });
  return { page, browser, origin, directory, errors, unexpected, requests,
    async close() { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function choose(page, scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function clickMutation(page, button, url, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === url && response.request().method() !== 'GET'), button.click(),
  ]);
  assert.equal(response.status(), status);
  await page.waitForFunction(() => !document.querySelector('[aria-labelledby="layout-catalog-title"]')
    || document.querySelector('[aria-labelledby="layout-catalog-title"]').getAttribute('aria-busy') === 'false');
  return response.json();
}

test('central layout catalog browser: filters, pagination, retained versions, complete editing and atomic text/file imports', {
  skip: !enabled, timeout: 240_000,
}, async () => {
  let settings = { layoutCatalog: normalizeLayoutCatalog({ ...structuredClone(BUILTIN_LAYOUT_CATALOG),
    templates: BUILTIN_LAYOUT_CATALOG.templates.map((item, index) => ({ ...structuredClone(item), enabled: index % 3 !== 0 })) }) };
  let advertisedRevision = layoutCatalogRecord(settings).revision, failRead = false, holdWrite = null;
  const fixture = await createFixture(`import{LayoutCatalogSettings}from'./app/settings/layout-catalog-settings';
    createRoot(document.getElementById('root')).render(<><LayoutCatalogSettings remote/><Toaster/></>);`, async (entry, reply, reject) => {
    if (entry.path !== endpoint || !['GET', 'POST'].includes(entry.method)) return false;
    if (entry.method === 'GET') {
      if (failRead) { failRead = false; reject(503, 'FIXTURE_READ_FAILED', '隔离目录读取暂时失败'); return true; }
      const record = layoutCatalogRecord(settings); advertisedRevision = record.revision; reply(record); return true;
    }
    const body = entry.body;
    assert.equal(body.expectedRevision, advertisedRevision, 'every browser write uses the exact last advertised revision');
    assert.match(body.expectedRevision, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(body).sort(), (body.operation === 'REPLACE' ? ['catalog', 'expectedRevision', 'operation']
      : body.operation === 'IMPORT' ? ['expectedRevision', 'operation', 'templates'] : ['expectedRevision', 'operation']).sort());
    if (holdWrite) await holdWrite;
    try {
      const changed = changeLayoutCatalog(settings, body);
      settings = changed.settings; advertisedRevision = changed.record.revision; reply(changed.record);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      reject(error.code === 'CATALOG_CONFLICT' ? 409 : 400, error.code || 'VALIDATION_ERROR', error.message);
    }
    return true;
  });
  const { page, origin, requests } = fixture;
  const writes = () => requests.filter(entry => entry.method === 'POST');
  const rows = page.locator('section[aria-labelledby="layout-catalog-title"] tbody tr');
  const panel = page.locator('section[aria-labelledby="layout-catalog-title"]');
  const keys = items => items.map(templateKey);
  async function assertRows(expected) {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[aria-labelledby="layout-catalog-title"] tbody tr')]
      .map(row => { const text = row.querySelector('[role="switch"]').getAttribute('aria-label');
        const [, code, version] = /^启用 (.+) 版本 (\d+)$/u.exec(text); return `${code}@${version}`; })) === JSON.stringify(expected), keys(expected));
    assert.equal(await rows.count(), expected.length);
  }
  const findTemplate = key => settings.layoutCatalog.templates.find(item => templateKey(item) === key);
  const rowFor = (code, version) => rows.filter({ has: page.getByRole('switch', { name: `启用 ${code} 版本 ${version}`, exact: true }) });
  try {
    await page.goto(`${origin}/settings`);
    await assertRows(settings.layoutCatalog.templates.slice(0, 10));
    const pagination = panel.getByRole('navigation', { name: '布局模板分页', exact: true });
    assert.equal(await pagination.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await assertRows(settings.layoutCatalog.templates.slice(10, 20));
    await pagination.getByRole('button', { name: '下一页', exact: true }).click();
    await assertRows(settings.layoutCatalog.templates.slice(20));
    assert.equal(await pagination.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await pagination.getByRole('button', { name: '上一页', exact: true }).click();
    await assertRows(settings.layoutCatalog.templates.slice(10, 20));
    for (const size of [20, 50, 10]) {
      await choose(page, panel, '每页显示', `${size} 条`); await assertRows(settings.layoutCatalog.templates.slice(0, size));
      assert.equal(await pagination.count(), size === 50 ? 0 : 1);
    }
    for (const [family, label] of Object.entries(LAYOUT_FAMILIES)) {
      await choose(page, panel, '版式分类', label);
      await assertRows(settings.layoutCatalog.templates.filter(item => item.layoutKind === family));
    }
    await choose(page, panel, '版式分类', '所有分类');
    for (const [label, state] of [['已启用', true], ['未启用', false]]) {
      await choose(page, panel, '启用状态', label); await assertRows(settings.layoutCatalog.templates.filter(item => item.enabled === state).slice(0, 10));
    }
    await choose(page, panel, '版式分类', LAYOUT_FAMILIES.hero);
    await assertRows(settings.layoutCatalog.templates.filter(item => item.layoutKind === 'hero' && !item.enabled));
    await choose(page, panel, '启用状态', '全部状态'); await choose(page, panel, '版式分类', '所有分类');
    const search = panel.getByPlaceholder('编码、含义或适合内容');
    for (const query of ['hero_left', '单一产品', '主体/视觉在左']) {
      await search.fill(query); await assertRows(settings.layoutCatalog.templates.filter(item =>
        `${item.name} ${item.layoutTemplate} ${item.description} ${item.suitableContent}`.toLowerCase().includes(query.toLowerCase())));
    }
    await search.fill('fixture-no-such-layout'); await panel.getByText('没有匹配的模板，请调整搜索或筛选条件。', { exact: true }).waitFor();
    assert.equal(await rows.count(), 0); await search.fill('HERO_CENTER');
    const original = structuredClone(findTemplate('HERO_CENTER@2'));
    const untouched = settings.layoutCatalog.templates.filter(item => item.layoutTemplate !== 'HERO_CENTER');
    for (const checked of [true, false, true]) {
      await clickMutation(page, rowFor('HERO_CENTER', 2).getByRole('switch'), endpoint);
      assert.equal(findTemplate('HERO_CENTER@2').enabled, checked);
      assert.equal(await rowFor('HERO_CENTER', 2).getByRole('switch').isChecked(), checked);
      assert.deepEqual(settings.layoutCatalog.templates.filter(item => item.layoutTemplate !== 'HERO_CENTER'), untouched);
    }
    await page.reload(); await search.fill('HERO_CENTER');
    assert.equal(await rowFor('HERO_CENTER', 2).getByRole('switch').isChecked(), true);
    const beforeCancel = writes().length;
    await rowFor('HERO_CENTER', 2).getByRole('button', { name: '编辑新版本', exact: true }).click();
    let editor = panel.locator('form');
    await editor.getByLabel('模板名称', { exact: true }).fill('取消草稿');
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.equal(await editor.count(), 0); assert.equal(writes().length, beforeCancel);
    assert.equal(findTemplate('HERO_CENTER@3'), undefined);
    await rowFor('HERO_CENTER', 2).getByRole('button', { name: '编辑新版本', exact: true }).click();
    editor = panel.locator('form');
    const values = { name: '隔离完整字段新版本', description: '隔离语义：主体靠左且文字有序', suitableContent: '适合四个知识点',
      subjectRegion: '左侧三分之一', textRegion: '右侧两个文字栏', readingOrder: '标题、主体、从上到下的说明' };
    for (const [key, label] of [['name', '模板名称'], ['description', '排版含义'], ['suitableContent', '适合内容'],
      ['subjectRegion', '主体区域'], ['textRegion', '文字区域'], ['readingOrder', '阅读顺序']]) {
      const input = editor.getByLabel(label, { exact: true });
      assert.equal(await input.getAttribute('maxlength'), key === 'name' ? '60' : '300');
      await input.fill(''); assert.equal(await input.evaluate(element => element.validity.valueMissing), true);
      await editor.getByRole('button', { name: '保存新版本', exact: true }).click();
      assert.equal(writes().length, beforeCancel, `${label} blank blocks native form submission`);
      await input.fill(`  ${values[key]}  `);
    }
    const min = editor.getByLabel('最少内容条目', { exact: true }), max = editor.getByLabel('最多内容条目', { exact: true });
    for (const input of [min, max]) {
      for (const value of ['0', '7', '1.5']) {
        await input.fill(value); assert.equal(await input.evaluate(element => element.checkValidity()), false);
        await editor.getByRole('button', { name: '保存新版本', exact: true }).click(); assert.equal(writes().length, beforeCancel);
      }
      await input.fill(input === min ? '3' : '6');
    }
    await max.fill('2'); assert.equal(await max.evaluate(element => element.validity.rangeUnderflow), true);
    await editor.getByRole('button', { name: '保存新版本', exact: true }).click(); assert.equal(writes().length, beforeCancel);
    await max.fill('6');
    const rules = editor.getByLabel(/^视觉规则（每行一条）/u);
    await rules.fill(Array.from({ length: 9 }, (_, index) => `规则${index + 1}`).join('\n'));
    await clickMutation(page, editor.getByRole('button', { name: '保存新版本', exact: true }), endpoint, 400);
    await panel.getByRole('alert').getByText(/视觉规则需为1～8条/u).waitFor();
    assert.equal(findTemplate('HERO_CENTER@3'), undefined); assert.equal(await rules.inputValue(), Array.from({ length: 9 }, (_, index) => `规则${index + 1}`).join('\n'));
    await rules.fill('字'.repeat(201));
    await clickMutation(page, editor.getByRole('button', { name: '保存新版本', exact: true }), endpoint, 400);
    await panel.getByRole('alert').getByText(/视觉规则需为1～200个字符/u).waitFor();
    await rules.fill('  水平文字且保持明确对比  \n  不新增事实或装饰文字  ');
    await clickMutation(page, editor.getByRole('button', { name: '保存新版本', exact: true }), endpoint);
    await editor.waitFor({ state: 'detached' });
    const newer = findTemplate('HERO_CENTER@3');
    for (const [key, value] of Object.entries(values)) assert.equal(newer[key], value);
    assert.deepEqual(newer.rules, ['水平文字且保持明确对比', '不新增事实或装饰文字']);
    assert.equal(newer.minItems, 3); assert.equal(newer.maxItems, 6); assert.equal(newer.source, 'MANUAL');
    assert.deepEqual(findTemplate('HERO_CENTER@2'), { ...original, enabled: false });
    assert.deepEqual(newer.applicablePageKinds, original.applicablePageKinds);
    assert.equal(settings.layoutCatalog.templates.length, 28);
    await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
    await rowFor('HERO_CENTER', 3).waitFor();
    assert.equal(await rowFor('HERO_CENTER', 2).getByRole('switch').isChecked(), false);
    assert.equal(await rowFor('HERO_CENTER', 3).getByRole('switch').isChecked(), true);
    failRead = true;
    const preserved = JSON.stringify(settings);
    await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
    await panel.getByRole('alert').getByText(/隔离目录读取暂时失败/u).waitFor();
    await rowFor('HERO_CENTER', 3).waitFor(); assert.equal(JSON.stringify(settings), preserved);
    await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
    await panel.getByRole('alert').waitFor({ state: 'detached' });

    await panel.locator('summary').filter({ hasText: '批量导入模板 JSON' }).click();
    const json = panel.locator('#layout-import-json'), importButton = panel.getByRole('button', { name: '校验并导入', exact: true });
    await json.fill('   '); assert.equal(await importButton.isDisabled(), true);
    const beforeSyntax = writes().length; await json.fill('{broken'); await importButton.click();
    await panel.getByRole('alert').getByText(/请输入 JSON 数组/u).waitFor(); assert.equal(writes().length, beforeSyntax);
    const incoming = (code, name = code) => ({ ...structuredClone(BUILTIN_LAYOUT_CATALOG.templates[0]), layoutTemplate: code, name, source: 'MANUAL' });
    const textTemplate = incoming('HERO_TEXT_IMPORTED', '文本导入夹具');
    await json.fill(JSON.stringify([textTemplate]));
    const importedText = await clickMutation(page, importButton, endpoint);
    assert.equal(importedText.data.added, 1); assert.equal(importedText.data.unchanged, 0);
    assert.equal(await json.inputValue(), ''); assert.equal(findTemplate('HERO_TEXT_IMPORTED@2').name, '文本导入夹具');
    const fileInput = panel.getByLabel('JSON 文件', { exact: true });
    await json.fill('文件拒绝时保留此草稿'); const beforeOversize = writes().length;
    await fileInput.setInputFiles({ name: 'too-large.json', mimeType: 'application/json', buffer: Buffer.alloc(1_000_001, 32) });
    await panel.getByRole('alert').getByText('文件不得超过 1 MB', { exact: true }).waitFor();
    assert.equal(await json.inputValue(), '文件拒绝时保留此草稿'); assert.equal(writes().length, beforeOversize);
    const fileTemplate = incoming('HERO_FILE_IMPORTED', '文件导入边界夹具');
    const document = JSON.stringify({ templates: [fileTemplate] });
    const boundaryBytes = Buffer.concat([Buffer.from(document), Buffer.alloc(1_000_000 - Buffer.byteLength(document), 32)]);
    await fileInput.setInputFiles({ name: 'exactly-one-million.json', mimeType: 'application/json', buffer: boundaryBytes });
    await page.waitForFunction(() => document.querySelector('#layout-import-json').value.length > 900_000);
    const importedFile = await clickMutation(page, importButton, endpoint);
    assert.equal(importedFile.data.added, 1); assert.equal(findTemplate('HERO_FILE_IMPORTED@2').name, '文件导入边界夹具');
    assert.equal(await json.inputValue(), '');
    const beforeAtomic = JSON.stringify(settings);
    const atomicValid = incoming('HERO_ATOMIC_REJECTED', '原子性有效前项');
    const invalidBatch = JSON.stringify([atomicValid, { ...incoming('HERO_SCHEMA_REJECTED'), unexpectedField: true }]);
    await json.fill(invalidBatch); await clickMutation(page, importButton, endpoint, 400);
    await panel.getByRole('alert').getByText(/不支持字段 unexpectedField/u).waitFor();
    assert.equal(JSON.stringify(settings), beforeAtomic); assert.equal(await json.inputValue(), invalidBatch);
    const conflictBatch = JSON.stringify([atomicValid, { ...findTemplate('HERO_CENTER@2'), name: '同编码版本改设计须被拒绝' }]);
    await json.fill(conflictBatch); await clickMutation(page, importButton, endpoint, 400);
    await panel.getByRole('alert').getByText(/模板版本冲突：HERO_CENTER@2/u).waitFor();
    assert.equal(JSON.stringify(settings), beforeAtomic); assert.equal(findTemplate('HERO_ATOMIC_REJECTED@2'), undefined);
    assert.equal(await json.inputValue(), conflictBatch);
    const concurrentTemplate = incoming('HERO_REVISION_RETRY', '保留并重试导入草稿');
    const concurrentDraft = JSON.stringify([concurrentTemplate]); await json.fill(concurrentDraft);
    const priorRevision = advertisedRevision;
    // A separate fixture actor changes one activation via the real domain helper.
    settings = changeLayoutCatalog(settings, { operation: 'REPLACE', expectedRevision: layoutCatalogRecord(settings).revision,
      catalog: { ...settings.layoutCatalog, templates: settings.layoutCatalog.templates.map(item => item.layoutTemplate === 'HERO_LEFT' ? { ...item, enabled: !item.enabled } : item) } }).settings;
    const concurrentState = JSON.stringify(settings);
    await clickMutation(page, importButton, endpoint, 409);
    await panel.getByRole('alert').getByText(/布局目录已被其他操作修改，请刷新后重试/u).waitFor();
    assert.equal(writes().at(-1).body.expectedRevision, priorRevision); assert.equal(JSON.stringify(settings), concurrentState);
    assert.equal(await json.inputValue(), concurrentDraft);
    await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
    await panel.getByRole('alert').waitFor({ state: 'detached' }); assert.equal(await json.inputValue(), concurrentDraft);
    await clickMutation(page, importButton, endpoint);
    assert.ok(findTemplate('HERO_REVISION_RETRY@2')); assert.equal(await json.inputValue(), '');
    const builtin = panel.getByRole('button', { name: '导入内置 27 个模板', exact: true });
    const beforeDuplicate = JSON.stringify(settings);
    const repeated = await clickMutation(page, builtin, endpoint);
    assert.equal(repeated.data.added, 0); assert.equal(repeated.data.unchanged, 27);
    assert.equal(JSON.stringify(settings), beforeDuplicate);
    let release; holdWrite = new Promise(resolve => { release = resolve; });
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await builtin.click(); await page.waitForFunction(() => document.querySelector('[aria-labelledby="layout-catalog-title"]').getAttribute('aria-busy') === 'true');
    for (const button of [builtin, panel.getByRole('button', { name: '刷新目录', exact: true }), importButton]) assert.equal(await button.isDisabled(), true);
    assert.equal(await fileInput.isDisabled(), true); assert.equal(await panel.getByRole('combobox', { name: '自动选择方式', exact: true }).isDisabled(), true);
    assert.equal(await rowFor('HERO_CENTER', 3).getByRole('switch').isDisabled(), true);
    release(); holdWrite = null; assert.equal((await pending).status(), 200);
    await page.waitForFunction(() => document.querySelector('[aria-labelledby="layout-catalog-title"]').getAttribute('aria-busy') === 'false');
    assert.equal(JSON.stringify(settings), beforeDuplicate);
    await panel.getByRole('button', { name: '查看当前目录 JSON', exact: true }).click();
    assert.deepEqual(JSON.parse(await json.inputValue()), settings.layoutCatalog);
    await page.screenshot({ path: join(fixture.directory, 'catalog-complete-controls.png'), fullPage: true });
    await page.reload(); await choose(page, panel, '每页显示', '50 条');
    await assertRows(settings.layoutCatalog.templates); assert.equal(settings.layoutCatalog.templates.length, 31);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.unexpected, []);
    assert.ok(requests.every(entry => entry.path === endpoint && ['GET', 'POST'].includes(entry.method)));
    console.log(JSON.stringify({ scopeIds: ['F-SETTING-035', 'F-SETTING-037', 'F-SETTING-038', 'F-SETTING-039', 'F-SETTING-040', 'F-SETTING-041'],
      writes: writes().length, rejectedWrites: writes().filter(entry => entry.status >= 400).length,
      finalTemplates: settings.layoutCatalog.templates.length, domainHelper: 'changeLayoutCatalog',
      fileLimitBytes: 1_000_000, screenshot: join(fixture.directory, 'catalog-complete-controls.png'), paidModelCalls: 0, originalHundredRowDatasetModified: false }));
  } catch (error) {
    await page.screenshot({ path: join(fixture.directory, 'catalog-failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await fixture.close(); }
});

test('central legacy presets browser: every page and layout choice, random participation, bounded creation and saved isolated compatibility settings', {
  skip: !enabled, timeout: 240_000,
}, async () => {
  const initialPresets = normalizeLayoutPresets(Array.from({ length: 49 }, (_, index) => ({
    id: `fixture-preset-${index + 1}`, name: `原有隔离布局${index + 1}`, kind: 'all', enabled: true, layout: { mode: 'CUSTOM' },
  })));
  let production = { key: 'production', version: 1, value: normalizeProductionSettings({
    ...structuredClone(DEFAULT_PRODUCTION_SETTINGS), layoutPresets: initialPresets,
  }) };
  let failSave = false, failRead = false, holdSave = null;
  const fixture = await createFixture(`import{RemoteLayoutPresetsSettings}from'./app/settings/layout-presets-settings';
    const root=createRoot(document.getElementById('root'));
    async function read(){return fetch('/api/control-plane/v1/settings').then(r=>r.json()).then(r=>r.data);}
    read().then(records=>root.render(<><RemoteLayoutPresetsSettings initialPresets={records.find(item=>item.key==='production').value.layoutPresets}
      onSaved={async()=>{await read();}}/><Toaster/></>));`, async (entry, reply, reject) => {
    if (entry.path === '/api/control-plane/v1/settings' && entry.method === 'GET') {
      if (failRead) { failRead = false; reject(503, 'FIXTURE_READ_FAILED', '隔离兼容配置读取暂时失败'); return true; }
      reply([production]); return true;
    }
    if (entry.path !== productionEndpoint || entry.method !== 'PUT') return false;
    assert.deepEqual(Object.keys(entry.body), ['value']);
    assert.deepEqual(Object.keys(entry.body.value).sort(), Object.keys(production.value).sort());
    for (const key of Object.keys(production.value).filter(key => key !== 'layoutPresets')) {
      assert.deepEqual(entry.body.value[key], production.value[key], `${key} must not be changed by compatibility preset saves`);
    }
    if (holdSave) await holdSave;
    if (failSave) { failSave = false; reject(503, 'FIXTURE_SAVE_FAILED', '隔离兼容配置保存暂时失败'); return true; }
    try {
      const presets = normalizeLayoutPresets(entry.body.value.layoutPresets);
      const value = normalizeProductionSettings({ ...entry.body.value, layoutPresets: presets });
      production = { ...production, version: production.version + 1, value }; reply(production);
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
      reject(400, 'VALIDATION_ERROR', error.message);
    }
    return true;
  });
  const { page, origin, requests } = fixture;
  const writes = () => requests.filter(entry => entry.method === 'PUT');
  const added = page.getByRole('button', { name: '新增布局种类', exact: true });
  const save = page.getByRole('button', { name: '保存布局种类', exact: true });
  const expanded = page.locator('.layout-preset-fields').filter({ visible: true });
  const existingProduction = structuredClone(production.value);
  try {
    await page.goto(`${origin}/settings`); await added.waitFor();
    assert.equal(await page.locator('.layout-preset').count(), 49); assert.equal(await added.isEnabled(), true);
    await added.click(); assert.equal(await page.locator('.layout-preset').count(), 50);
    assert.equal(await added.isDisabled(), true, 'the fiftieth entry disables further creation');
    assert.equal(await expanded.count(), 1);
    const name = expanded.getByLabel('布局名称', { exact: true });
    assert.equal(await name.getAttribute('maxlength'), '60'); await name.fill('   ');
    assert.equal(await save.isDisabled(), true); assert.equal(writes().length, 0);
    await name.fill('  中心兼容完整控件夹具  ');
    for (const label of Object.values(LAYOUT_KIND_LABELS)) {
      await choose(page, expanded, '适用页面', label);
      assert.equal(await expanded.getByRole('combobox', { name: '适用页面', exact: true }).textContent(), label);
    }
    const options = {
      '标题位置': ['左上', '上方居中', '右上', '底部'],
      '主体位置': ['左侧', '中央', '右侧', '上方', '下方', '铺满画面'],
      '文字区域': ['左侧', '右侧', '上方', '下方', '融入主体画面'],
      '文字对齐': ['左对齐', '居中', '右对齐'],
      '留白': ['紧凑', '适中', '宽松'],
    };
    for (const [label, choices] of Object.entries(options)) {
      for (const option of choices) {
        await choose(page, expanded, label, option);
        assert.equal(await expanded.getByRole('combobox', { name: label, exact: true }).textContent(), option);
      }
    }
    const share = expanded.getByRole('slider', { name: /^主体占比/u });
    assert.equal(await share.getAttribute('min'), '20'); assert.equal(await share.getAttribute('max'), '90');
    assert.equal(await share.getAttribute('step'), '5');
    await share.focus(); await page.keyboard.press('Home'); assert.equal(await share.inputValue(), '20');
    await expanded.getByText('主体 · 20%', { exact: true }).waitFor();
    await page.keyboard.press('End'); assert.equal(await share.inputValue(), '90');
    await expanded.getByText('主体 · 90%', { exact: true }).waitFor();
    const schematic = expanded.locator('.layout-schematic');
    assert.equal(await schematic.getAttribute('data-title'), 'bottom');
    assert.equal(await schematic.getAttribute('data-subject'), 'full');
    assert.equal(await schematic.getAttribute('data-text'), 'overlay');
    const direction = expanded.getByLabel('补充布局要求', { exact: true });
    assert.equal(await direction.getAttribute('maxlength'), '1000');
    await direction.fill('  主体铺满，文字融入画面，保持水平阅读与充分留白。  ');
    const random = expanded.getByRole('switch', { name: '参与随机选择', exact: true });
    await random.uncheck(); assert.equal(await random.isChecked(), false);
    await random.check(); assert.equal(await random.isChecked(), true);
    await random.uncheck();
    const beforeSave = JSON.stringify(production);
    failSave = true; await clickMutation(page, save, productionEndpoint, 503);
    await page.getByRole('alert').getByText(/隔离兼容配置保存暂时失败/u).waitFor();
    assert.equal(JSON.stringify(production), beforeSave); assert.equal(await name.inputValue(), '  中心兼容完整控件夹具  ');
    assert.equal(await random.isChecked(), false); assert.equal(await save.isEnabled(), true);
    await clickMutation(page, save, productionEndpoint);
    await page.getByText('旧版布局预设已保存。', { exact: true }).waitFor();
    assert.equal(production.value.layoutPresets.length, 50);
    const stored = production.value.layoutPresets.at(-1);
    assert.equal(stored.name, '中心兼容完整控件夹具'); assert.equal(stored.kind, 'summary'); assert.equal(stored.enabled, false);
    assert.deepEqual(stored.layout, { mode: 'CUSTOM', titlePosition: 'bottom', subjectPosition: 'full', textPosition: 'overlay',
      alignment: 'right', imageShare: 90, spacing: 'airy', direction: '主体铺满，文字融入画面，保持水平阅读与充分留白。' });
    assert.deepEqual(production.value.layoutPresets.slice(0, 49), initialPresets);
    for (const key of Object.keys(existingProduction).filter(key => key !== 'layoutPresets')) assert.deepEqual(production.value[key], existingProduction[key]);
    await page.reload(); await added.waitFor(); assert.equal(await added.isDisabled(), true);
    const disclosure = page.getByRole('button', { name: '中心兼容完整控件夹具 · 总结 · 已停用', exact: true });
    await disclosure.click(); assert.equal(await expanded.count(), 1);
    assert.equal(await expanded.getByLabel('布局名称', { exact: true }).inputValue(), stored.name);
    assert.equal(await expanded.getByRole('switch', { name: '参与随机选择', exact: true }).isChecked(), false);
    assert.equal(await expanded.getByLabel('补充布局要求', { exact: true }).inputValue(), stored.layout.direction);
    await expanded.getByLabel('布局名称', { exact: true }).fill('只留草稿的失败读取夹具');
    const beforeReadFailure = writes().length; failRead = true; await save.click();
    await page.getByRole('alert').getByText(/隔离兼容配置读取暂时失败/u).waitFor();
    assert.equal(writes().length, beforeReadFailure, 'failed read before compatibility PUT must issue no write');
    assert.equal(production.value.layoutPresets.at(-1).name, stored.name);
    assert.equal(await expanded.getByLabel('布局名称', { exact: true }).inputValue(), '只留草稿的失败读取夹具');
    await expanded.getByLabel('布局名称', { exact: true }).fill('保留读取失败草稿后重试成功');
    await expanded.getByRole('switch', { name: '参与随机选择', exact: true }).check();
    let release; holdSave = new Promise(resolve => { release = resolve; });
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === productionEndpoint && response.request().method() === 'PUT');
    await save.click(); await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    assert.equal(await added.isDisabled(), true); assert.equal(await expanded.getByLabel('布局名称', { exact: true }).isDisabled(), true);
    assert.equal(await expanded.getByRole('button', { name: '删除布局种类', exact: true }).isDisabled(), true);
    assert.equal(await expanded.getByRole('combobox', { name: '主体位置', exact: true }).isDisabled(), true);
    release(); holdSave = null; assert.equal((await pending).status(), 200);
    await save.waitFor(); assert.equal(production.value.layoutPresets.at(-1).name, '保留读取失败草稿后重试成功');
    assert.equal(production.value.layoutPresets.at(-1).enabled, true);
    await page.screenshot({ path: join(fixture.directory, 'legacy-complete-controls.png'), fullPage: true });
    const beforeDelete = writes().length;
    await expanded.getByRole('button', { name: '删除布局种类', exact: true }).click();
    assert.equal(await page.locator('.layout-preset').count(), 49); assert.equal(await added.isEnabled(), true);
    assert.equal(writes().length, beforeDelete, 'removing a compatibility draft is not persisted until explicit save');
    await clickMutation(page, save, productionEndpoint);
    assert.deepEqual(production.value.layoutPresets, initialPresets);
    await page.reload(); await added.waitFor(); assert.equal(await page.locator('.layout-preset').count(), 49);
    assert.equal(await page.getByRole('button', { name: /保留读取失败草稿后重试成功/u }).count(), 0);
    for (const key of Object.keys(existingProduction).filter(key => key !== 'layoutPresets')) assert.deepEqual(production.value[key], existingProduction[key]);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.unexpected, []);
    assert.ok(requests.every(entry => (entry.method === 'GET' && entry.path === '/api/control-plane/v1/settings')
      || (entry.method === 'PUT' && entry.path === productionEndpoint)));
    console.log(JSON.stringify({ scopeIds: ['F-SETTING-045', 'F-SETTING-046'], writes: writes().length,
      rejectedWrites: writes().filter(entry => entry.status >= 400).length, pageKindChoices: 7, layoutChoiceActions: 21,
      maxPresets: 50, noSeparateCancelOrRereadButton: true, screenshot: join(fixture.directory, 'legacy-complete-controls.png'),
      paidModelCalls: 0, originalHundredRowDatasetModified: false }));
  } catch (error) {
    await page.screenshot({ path: join(fixture.directory, 'legacy-failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await fixture.close(); }
});
