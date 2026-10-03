import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_PRODUCTION_SETTINGS } from '../src/production-settings.mjs';
import { DEFAULT_WEB_SEARCH_SETTINGS, DEFAULT_DEEPSEEK_SEARCH_MODEL, DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  normalizeWebSearchSettings, resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { normalizeXiaohongshuSearchSettings } from '../src/xhs-query-search.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS, normalizeHumanQualitySettingsUpdate } from '../src/human-quality-settings.mjs';
import { DEFAULT_WORKFLOW_QUALITY_SETTINGS, normalizeWorkflowQualitySettings } from '../server/src/workflow-quality-settings.mjs';
import { BUILTIN_LAYOUT_CATALOG } from '../server/src/layout-catalog.mjs';

test('remaining settings browser: search model bounds, tab drafts, blind sampling, read recovery, conflicts and feedback placeholders', {
  skip: process.env.RUN_SETTINGS_REMAINING_BROWSER !== '1', timeout: 240_000,
}, async () => {
  const { build } = await import('esbuild'); const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/settings-remaining'); await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
    import{CentralDataWorkbench}from'./app/components/central-data-workbench';
    import{HumanRatingFeedback}from'./app/workbench/human-quality-rating';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{Toaster}from'./components/ui/sonner';
    function Feedback(){const[settings,setSettings]=useState(null);const[notes,setNotes]=useState({copy:'',image:''});
      useEffect(()=>{fetch('/api/human-quality-settings').then(r=>r.json()).then(v=>setSettings(v.data))},[]);
      return settings&&<>{['copy','image'].map(kind=><section aria-label={kind+' actual feedback'} key={kind}><HumanRatingFeedback
        id={kind+'-fixture'} reasonOptions={settings[kind+'Reasons']} reasons={[]} note={notes[kind]}
        notePlaceholder={settings.noteGuidance[kind+'Placeholder']} showReasonOptions={false}
        onToggleReason={()=>{}} onNoteChange={value=>setNotes(previous=>({...previous,[kind]:value}))}/></section>)}</>}
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider>{location.search.includes('feedback=1')?<Feedback/>:<CentralDataWorkbench/>}<Toaster/></ConfirmDialogProvider>);`,
    resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic',
    platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss'); const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const paths = { search: '/api/web-search-settings', workflow: '/api/control-plane/v1/workflow-quality-settings', human: '/api/human-quality-settings' };
  let search = structuredClone(DEFAULT_WEB_SEARCH_SETTINGS), human = structuredClone(DEFAULT_HUMAN_QUALITY_SETTINGS);
  let workflow = { ...structuredClone(DEFAULT_WORKFLOW_QUALITY_SETTINGS),
    copySampling: { ...DEFAULT_WORKFLOW_QUALITY_SETTINGS.copySampling, enabled: true },
    imageSampling: { ...DEFAULT_WORKFLOW_QUALITY_SETTINGS.imageSampling, enabled: true } };
  const failures = new Set(Object.values(paths)), rejectWrites = new Set();
  const writes = [], reads = [], errors = [], unexpected = []; const held = new Map();
  const searchRecord = () => ({ settings: search, scope: 'central', effective: resolveWebSearchConfig({}, search),
    apiKeyConfigured: null, providerKeyConfigured: { DOUBAO: null, DEEPSEEK: null }, updatedAt: '2026-10-02T00:00:00Z' });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) { response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return; }
      const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      const reject = (status, code, message) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code, message } })); };
      if (request.method === 'GET') {
        reads.push(url.pathname);
        if (failures.has(url.pathname)) { reject(503, 'FIXTURE_READ_FAILURE', `隔离读取失败 ${url.pathname}`); return; }
        if (url.pathname === paths.search) { reply(searchRecord()); return; }
        if (url.pathname === paths.workflow) { reply(workflow); return; }
        if (url.pathname === paths.human) { reply(human); return; }
        if (url.pathname === '/api/control-plane/v1/settings') { reply([
          { key: 'production', version: 1, value: structuredClone(DEFAULT_PRODUCTION_SETTINGS) },
          { key: 'xhs_query_search', version: 1, value: normalizeXiaohongshuSearchSettings({}) }]); return; }
        if (url.pathname === '/api/control-plane/v1/layout-catalog') { reply({ catalog: BUILTIN_LAYOUT_CATALOG, revision: 'fixture-layout-1' }); return; }
      } else if (Object.values(paths).includes(url.pathname)) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); writes.push({ path: url.pathname, method: request.method, body });
        assert.equal(request.method, url.pathname === paths.search ? 'PATCH' : 'PUT');
        if (held.has(url.pathname)) await held.get(url.pathname);
        if (rejectWrites.delete(url.pathname)) { reject(503, 'FIXTURE_SAVE_FAILURE', '隔离保存失败，草稿保留'); return; }
        try {
          if (url.pathname === paths.search) { assert.equal('expectedVersion' in body, false, 'search has no version conflict protocol'); search = normalizeWebSearchSettings({ ...search, ...body }); reply(searchRecord()); return; }
          if (url.pathname === paths.workflow) {
            if (body.expectedVersion !== workflow.version) { reject(409, 'FIXTURE_VERSION_CONFLICT', '流程配置版本已改变，请重新读取'); return; }
            workflow = { ...normalizeWorkflowQualitySettings(body, workflow), version: workflow.version + 1 }; reply(workflow); return;
          }
          human = normalizeHumanQualitySettingsUpdate(body, human); reply(human); return;
        } catch (error) { if (error instanceof assert.AssertionError) throw error; reject(400, 'FIXTURE_VALIDATION', error.message); return; }
      }
      unexpected.push(`${request.method} ${url.pathname}`); reject(404, 'UNEXPECTED', 'Unexpected fixture request');
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code: 'FIXTURE_ASSERTION', message: error.message } })); }
  });
  let browser, page;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const panel = id => page.locator(`section[aria-labelledby="${id}"]`);
    const web = panel('web-search-heading'), quality = panel('workflow-quality-settings-title'), humanPanel = panel('human-quality-settings-heading');
    const count = path => writes.filter(write => write.path === path).length;
    const last = path => writes.filter(write => write.path === path).at(-1);
    const save = async (scope, label, path) => { const before = count(path); await scope.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(({ id, label }) => [...document.querySelector(`section[aria-labelledby="${id}"]`).querySelectorAll('button')]
        .some(button => button.textContent.trim() === label && button.disabled), { id: await scope.getAttribute('aria-labelledby'), label });
      assert.equal(count(path), before + 1); return last(path).body; };
    const selectProvider = async name => { await web.getByRole('combobox', { name: '搜索服务', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click(); };
    await page.goto(`${origin}/settings`);
    await web.getByRole('alert').waitFor(); assert.equal(await web.getByRole('button', { name: '保存搜索配置', exact: true }).isDisabled(), true);
    assert.equal(await web.getByLabel('DeepSeek 搜索模型', { exact: true }).isDisabled(), true);
    failures.delete(paths.search); await web.getByRole('button', { name: '重新读取', exact: true }).click();
    await web.getByRole('combobox', { name: '搜索服务', exact: true }).waitFor();
    await page.getByRole('tab', { name: /^质量与审核/u }).click(); await quality.getByRole('alert').waitFor();
    assert.equal(await quality.getByRole('button', { name: '保存流程配置', exact: true }).count(), 0);
    failures.delete(paths.workflow); await quality.getByRole('button', { name: '重新读取', exact: true }).click();
    await quality.locator('#copy-sampling-enabled').waitFor(); await humanPanel.getByRole('alert').waitFor();
    assert.equal(await humanPanel.getByRole('button', { name: '保存人工评分标准', exact: true }).isDisabled(), true);
    assert.equal(await humanPanel.getByRole('button', { name: '重新读取', exact: true }).count(), 0, 'human module offers full-page reread, no local reread button');
    assert.equal(writes.length, 0); failures.delete(paths.human); await page.reload();
    await page.getByRole('tab', { name: /^质量与审核/u }).click(); await humanPanel.locator('#copy-quality-note-placeholder').waitFor();

    // The actual four tabs retain each mounted module's unsaved draft.
    await humanPanel.locator('#image-quality-note-placeholder').fill('未保存图片提示草稿');
    await quality.locator('#copy-sampling-blind').check();
    await page.getByRole('tab', { name: /^生成与模型/u }).click(); await selectProvider('DeepSeek 联网搜索');
    const model = web.getByLabel('DeepSeek 搜索模型', { exact: true }); await model.fill('deepseek-unsaved-fixture');
    for (const name of [/^图片与输出/u, /^兼容与高级/u, /^质量与审核/u, /^生成与模型/u]) await page.getByRole('tab', { name }).click();
    assert.equal(await model.inputValue(), 'deepseek-unsaved-fixture');
    await page.getByRole('tab', { name: /^质量与审核/u }).click(); assert.equal(await quality.locator('#copy-sampling-blind').isChecked(), true);
    assert.equal(await humanPanel.locator('#image-quality-note-placeholder').inputValue(), '未保存图片提示草稿'); assert.equal(writes.length, 0);
    await page.getByRole('tab', { name: /^质量与审核/u }).press('End'); assert.equal(await page.locator('#settings-tab-advanced').getAttribute('aria-selected'), 'true');
    await page.locator('#settings-tab-advanced').press('Home'); assert.equal(await page.locator('#settings-tab-generation').getAttribute('aria-selected'), 'true');
    await page.reload(); await selectProvider('DeepSeek 联网搜索');
    assert.equal(await model.getAttribute('maxlength'), '128');
    const searchSave = web.getByRole('button', { name: '保存搜索配置', exact: true });
    for (const invalid of ['@model', '/model', 'model with spaces', '中文模型']) { await model.fill(invalid);
      assert.equal(await model.getAttribute('aria-invalid'), 'true'); assert.equal(await searchSave.isDisabled(), true); }
    await model.fill('a'.repeat(128));
    const timeout = web.getByLabel('API 搜索超时（毫秒）', { exact: true }), sources = web.getByLabel('联网搜索来源数', { exact: true });
    for (const [input, invalids, valid] of [[timeout, ['4999', '120001', '5000.5'], '5000'], [sources, ['0', '11', '1.5'], '1']]) {
      for (const invalid of invalids) { await input.fill(invalid); assert.equal(await input.getAttribute('aria-invalid'), 'true'); assert.equal(await searchSave.isDisabled(), true); }
      await input.fill(valid); assert.equal(await input.getAttribute('aria-invalid'), 'false');
    }
    let payload = await save(web, '保存搜索配置', paths.search); assert.equal(payload.deepseekSearchModel.length, 128); assert.equal(payload.webSearchTimeoutMs, 5000); assert.equal(payload.webSearchResultLimit, 1);
    await timeout.fill('120000'); await sources.fill('10'); await model.fill('deepseek-functional-v4');
    payload = await save(web, '保存搜索配置', paths.search); assert.equal(payload.webSearchTimeoutMs, 120000); assert.equal(payload.webSearchResultLimit, 10);
    await web.getByRole('button', { name: '使用 DeepSeek 默认模型', exact: true }).click();
    assert.equal(await model.inputValue(), DEFAULT_DEEPSEEK_SEARCH_MODEL); assert.equal(await timeout.inputValue(), String(DEFAULT_WEB_SEARCH_TIMEOUT_MS));
    payload = await save(web, '保存搜索配置', paths.search); assert.equal(payload.deepseekSearchModel, DEFAULT_DEEPSEEK_SEARCH_MODEL);
    await model.fill('deepseek-pending'); let release; held.set(paths.search, new Promise(resolve => { release = resolve; }));
    const beforeHeldSearch = count(paths.search); await searchSave.click();
    await page.waitForFunction(() => document.querySelector('#deepseek-search-model').disabled);
    assert.equal(count(paths.search), beforeHeldSearch + 1); assert.equal(await timeout.isDisabled(), true); assert.equal(await sources.isDisabled(), true);
    assert.equal(await web.getByRole('button', { name: '恢复环境配置', exact: true }).isDisabled(), true); release(); held.delete(paths.search);
    await searchSave.waitFor(); await page.waitForFunction(() => document.querySelector('#deepseek-search-model').disabled === false);
    await model.fill('deepseek-failed-preserved'); rejectWrites.add(paths.search); await searchSave.click();
    await web.getByRole('alert').filter({ hasText: '隔离保存失败，草稿保留' }).waitFor(); assert.equal(await model.inputValue(), 'deepseek-failed-preserved'); assert.equal(search.deepseekSearchModel, 'deepseek-pending');
    await save(web, '保存搜索配置', paths.search); await page.reload(); assert.equal(await model.inputValue(), 'deepseek-failed-preserved');

    await page.getByRole('tab', { name: /^质量与审核/u }).click(); await quality.locator('#copy-sampling-enabled').waitFor();
    const workflowSave = quality.getByRole('button', { name: '保存流程配置', exact: true });
    await quality.locator('#copy-sampling-blind').check(); await quality.locator('#image-sampling-blind').check();
    await quality.locator('#copy-sampling-enabled').uncheck(); await quality.locator('#image-sampling-enabled').uncheck();
    assert.equal(await quality.locator('#copy-sampling-rate').isDisabled(), true); assert.equal(await quality.locator('#image-sampling-rate').isDisabled(), true);
    assert.equal(await quality.locator('#copy-sampling-blind').isEnabled(), true, 'copy blindness is independent of sampling');
    assert.equal(await quality.locator('#image-sampling-blind').isDisabled(), true);
    payload = await save(quality, '保存流程配置', paths.workflow); assert.equal(payload.copySampling.enabled, false); assert.equal(payload.imageSampling.enabled, false);
    assert.equal(payload.copySampling.blindReviewEnabled, true); assert.equal(payload.imageSampling.blindReviewEnabled, true);
    await quality.locator('#copy-sampling-enabled').check(); await quality.locator('#image-sampling-enabled').check();
    await quality.locator('#copy-sampling-blind').uncheck(); await quality.locator('#image-sampling-blind').uncheck();
    for (const value of ['0', '100', '25.75']) {
      for (const id of ['copy-sampling-rate', 'image-sampling-rate']) { await quality.locator(`#${id}`).fill(value); await quality.locator(`#${id}`).blur(); }
      payload = await save(quality, '保存流程配置', paths.workflow); assert.equal(payload.copySampling.rateBps, Number(value) * 100); assert.equal(payload.imageSampling.rateBps, Number(value) * 100);
    }
    for (const id of ['copy-sampling-rate', 'image-sampling-rate']) {
      const input = quality.locator(`#${id}`); await input.fill('-1'); assert.equal(await input.evaluate(element => element.validity.rangeUnderflow), true);
      await input.blur(); assert.equal(await input.inputValue(), '0', 'sampling input explicitly clamps below-range values on blur');
      await input.fill('101'); assert.equal(await input.evaluate(element => element.validity.rangeOverflow), true);
      await input.blur(); assert.equal(await input.inputValue(), '100', 'sampling input explicitly clamps above-range values on blur');
      await input.fill('25.755'); await input.blur(); assert.equal(await input.inputValue(), '25.76', 'sampling input rounds to two decimal places');
    }
    const writesBeforeUndo = writes.length; await quality.getByRole('button', { name: '撤销更改', exact: true }).click();
    assert.equal(writes.length, writesBeforeUndo); assert.equal(await quality.locator('#copy-sampling-rate').inputValue(), '25.75'); assert.equal(await workflowSave.isDisabled(), true);
    await quality.locator('#copy-sampling-rate').fill('50'); workflow.version += 1; await workflowSave.click();
    await quality.getByRole('alert').filter({ hasText: '流程配置版本已改变，请重新读取' }).waitFor();
    assert.equal(await quality.locator('#copy-sampling-rate').inputValue(), '50'); assert.equal(workflow.copySampling.rateBps, 2575);
    failures.add(paths.workflow); await quality.getByRole('button', { name: '重新读取', exact: true }).click();
    await quality.getByRole('alert').filter({ hasText: '隔离读取失败' }).waitFor();
    assert.equal(await quality.locator('#copy-sampling-rate').inputValue(), '50', 'failed reread preserves the valid existing draft instead of replacing it with defaults');
    failures.delete(paths.workflow); await quality.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#copy-sampling-rate').value === '25.75');
    assert.equal(await workflowSave.isDisabled(), true);
    await quality.locator('#copy-sampling-rate').fill('40'); held.set(paths.workflow, new Promise(resolve => { release = resolve; }));
    await workflowSave.click(); await page.waitForFunction(() => document.querySelector('#copy-sampling-enabled').disabled);
    assert.equal(await quality.getByRole('button', { name: '重新读取', exact: true }).isDisabled(), true); assert.equal(await quality.getByRole('button', { name: '撤销更改', exact: true }).isDisabled(), true);
    assert.ok((await quality.locator('input').evaluateAll(elements => elements.map(input => input.disabled))).every(Boolean));
    release(); held.delete(paths.workflow); await page.waitForFunction(() => document.querySelector('#copy-sampling-enabled').disabled === false);
    assert.equal(last(paths.workflow).body.expectedVersion, workflow.version - 1);

    const humanSave = humanPanel.getByRole('button', { name: '保存人工评分标准', exact: true });
    const copyHint = humanPanel.locator('#copy-quality-note-placeholder'), imageHint = humanPanel.locator('#image-quality-note-placeholder');
    for (const input of [copyHint, imageHint]) { assert.equal(await input.getAttribute('maxlength'), '100'); const previous = await input.inputValue();
      await input.fill('   '); assert.equal(await humanSave.isDisabled(), true); await input.fill(previous); }
    await copyHint.fill('文案真实提示'.repeat(20).slice(0, 100)); await imageHint.fill('图片真实提示'.repeat(20).slice(0, 100));
    held.set(paths.human, new Promise(resolve => { release = resolve; })); await humanSave.click();
    await page.waitForFunction(() => document.querySelector('#image-quality-note-placeholder').disabled);
    assert.ok((await humanPanel.locator('input,textarea').evaluateAll(elements => elements.map(input => input.disabled))).every(Boolean));
    release(); held.delete(paths.human); await page.waitForFunction(() => document.querySelector('#image-quality-note-placeholder').disabled === false);
    assert.equal(last(paths.human).body.noteGuidance.imagePlaceholder, await imageHint.inputValue());
    assert.equal(human.noteGuidance.imagePlaceholder.length, 100);
    await imageHint.fill('保存失败仍保留图片提示'); rejectWrites.add(paths.human); await humanSave.click();
    await humanPanel.getByRole('alert').filter({ hasText: '隔离保存失败，草稿保留' }).waitFor(); assert.equal(await imageHint.inputValue(), '保存失败仍保留图片提示');
    await save(humanPanel, '保存人工评分标准', paths.human); await page.screenshot({ path: join(directory, 'workflow-and-feedback-controls.png'), fullPage: true });
    await page.reload(); await page.getByRole('tab', { name: /^质量与审核/u }).click(); await imageHint.waitFor();
    assert.equal(await imageHint.inputValue(), '保存失败仍保留图片提示'); assert.equal(await quality.locator('#copy-sampling-rate').inputValue(), '40');
    const beforeFeedback = writes.length; await page.goto(`${origin}/settings?feedback=1`);
    for (const kind of ['copy', 'image']) { const input = page.locator(`#${kind}-fixture-note`); await input.waitFor();
      assert.equal(await input.getAttribute('placeholder'), human.noteGuidance[`${kind}Placeholder`]); assert.equal(await input.inputValue(), '', 'saved guidance is a placeholder, never a submitted assessment note');
      await input.fill(`${kind} 人工实际说明`); assert.equal(await input.inputValue(), `${kind} 人工实际说明`); }
    assert.equal(writes.length, beforeFeedback);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    assert.ok(writes.every(write => Object.values(paths).includes(write.path)));
    console.log(`remaining settings screenshots: ${directory}`);
    console.log(JSON.stringify({ mutationCount: writes.length, scopeIds: ['F-SETTING-001','F-SETTING-004','F-SETTING-006','F-SETTING-024','F-SETTING-026','F-SETTING-028','F-SETTING-031','F-SETTING-032','F-SETTING-048'],
      fakeHttp: true, paidModelCalls: 0, originalHundredRowDatasetModified: false }));
  } catch (error) { if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
