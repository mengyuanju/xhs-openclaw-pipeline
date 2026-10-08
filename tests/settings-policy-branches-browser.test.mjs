import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_PRODUCTION_SETTINGS } from '../src/production-settings.mjs';
import { DEFAULT_WEB_SEARCH_SETTINGS, normalizeWebSearchSettings, resolveWebSearchConfig } from '../src/web-search-config.mjs';
import { normalizeXiaohongshuSearchSettings } from '../src/xhs-query-search.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS, normalizeHumanQualitySettingsUpdate } from '../src/human-quality-settings.mjs';
import { DEFAULT_WORKFLOW_QUALITY_SETTINGS, normalizeWorkflowQualitySettings } from '../server/src/workflow-quality-settings.mjs';
import { BUILTIN_LAYOUT_CATALOG, importLayoutTemplates, normalizeLayoutCatalog } from '../server/src/layout-catalog.mjs';

const endpoints = {
  settings: '/api/control-plane/v1/settings', search: '/api/web-search-settings',
  xhs: '/api/control-plane/v1/settings/xhs_query_search',
  workflow: '/api/control-plane/v1/workflow-quality-settings', human: '/api/human-quality-settings',
  layout: '/api/control-plane/v1/layout-catalog',
};

test('central settings browser: primary and backup providers, XHS pacing, inspection permissions, score definitions and layout candidates', {
  skip: process.env.RUN_SETTINGS_POLICY_BRANCHES_BROWSER !== '1', timeout: 240_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/settings-policy-branches');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
    import{CentralDataWorkbench}from'./app/components/central-data-workbench';
    import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{Toaster}from'./components/ui/sonner';
    createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CentralDataWorkbench/><Toaster/></ConfirmDialogProvider>);`,
    resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'),
    jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
  const [js, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const writes = [], reads = [], errors = [], unexpected = [];
  let search = { ...structuredClone(DEFAULT_WEB_SEARCH_SETTINGS), doubaoSearchMode: 'CUSTOM' };
  let xhs = { key: 'xhs_query_search', version: 1, value: normalizeXiaohongshuSearchSettings({}), updatedAt: '2026-10-02T00:00:00.000Z' };
  let workflow = { ...structuredClone(DEFAULT_WORKFLOW_QUALITY_SETTINGS),
    copySampling: { ...DEFAULT_WORKFLOW_QUALITY_SETTINGS.copySampling, enabled: true, rateBps: 2000 },
    imageSampling: { ...DEFAULT_WORKFLOW_QUALITY_SETTINGS.imageSampling, enabled: true, reviewerBatchReturnEnabled: true } };
  let human = structuredClone(DEFAULT_HUMAN_QUALITY_SETTINGS);
  let layout = { catalog: { ...structuredClone(BUILTIN_LAYOUT_CATALOG), templates: structuredClone(BUILTIN_LAYOUT_CATALOG.templates.slice(0, 1)) }, revision: 'fixture-layout-1' };
  let layoutVersion = 1, failGenerate = false, holdGenerate = null, failSettingsRead = false;
  const candidate = { ...structuredClone(BUILTIN_LAYOUT_CATALOG.templates[0]),
    layoutTemplate: 'HERO_FUNCTIONAL_CANDIDATE', name: '隔离模型候选夹具', source: 'MODEL', enabled: false };
  const production = { key: 'production', version: 1, value: structuredClone(DEFAULT_PRODUCTION_SETTINGS) };
  const searchRecord = () => ({ settings: search, scope: 'central',
    effective: resolveWebSearchConfig({ XHS_WEB_SEARCH_PROVIDER: 'CODEX' }, search),
    apiKeyConfigured: null, providerKeyConfigured: { DOUBAO: null, DEEPSEEK: null }, updatedAt: '2026-10-02T00:00:00.000Z' });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return;
      }
      const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      if (request.method === 'GET') {
        reads.push(url.pathname);
        if (url.pathname === endpoints.settings) {
          if (failSettingsRead) {
            response.statusCode = 503; response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ error: { code: 'FIXTURE_SETTINGS_READ_FAILED', message: '隔离中心配置读取暂时失败' } })); return;
          }
          reply([production, xhs]); return;
        }
        if (url.pathname === endpoints.search) { reply(searchRecord()); return; }
        if (url.pathname === endpoints.workflow) { reply(workflow); return; }
        if (url.pathname === endpoints.human) { reply(human); return; }
        if (url.pathname === endpoints.layout) { reply(layout); return; }
      } else {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), write = { method: request.method, path: url.pathname, body };
        writes.push(write);
        try {
          if (url.pathname === endpoints.search && request.method === 'PATCH') {
            search = normalizeWebSearchSettings({ ...search, ...body });
            production.value.modelApi = { ...production.value.modelApi, ...search }; reply(searchRecord()); return;
          }
          if (url.pathname === endpoints.xhs && request.method === 'PUT') {
            xhs = { ...xhs, version: xhs.version + 1, value: normalizeXiaohongshuSearchSettings(body.value) }; reply(xhs); return;
          }
          if (url.pathname === endpoints.workflow && request.method === 'PUT') {
            assert.equal(body.expectedVersion, workflow.version);
            workflow = { ...normalizeWorkflowQualitySettings(body, workflow), version: workflow.version + 1 }; reply(workflow); return;
          }
          if (url.pathname === endpoints.human && request.method === 'PUT') {
            human = normalizeHumanQualitySettingsUpdate(body, human); reply(human); return;
          }
          if ([endpoints.layout, `${endpoints.layout}/generate`].includes(url.pathname) && request.method === 'POST') {
            assert.equal(body.expectedRevision, layout.revision);
            if (url.pathname.endsWith('/generate')) {
              assert.ok(body.brief.trim());
              if (failGenerate) { failGenerate = false; write.rejected = true; response.statusCode = 503;
                response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { code: 'FIXTURE_GENERATION_FAILED', message: '隔离候选夹具暂时失败' } })); return; }
              if (holdGenerate) await holdGenerate;
              const imported = importLayoutTemplates(layout.catalog, [candidate], { source: 'MODEL' });
              layout = { ...imported, revision: `fixture-layout-${++layoutVersion}`, promptSource: 'PUBLISHED' };
            } else {
              assert.equal(body.operation, 'REPLACE');
              layout = { catalog: normalizeLayoutCatalog(body.catalog), revision: `fixture-layout-${++layoutVersion}` };
            }
            reply(layout); return;
          }
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          write.rejected = true; response.statusCode = 400; response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: { code: 'FIXTURE_VALIDATION_ERROR', message: error.message } })); return;
        }
      }
      unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'Unexpected fixture request' } }));
    } catch (error) {
      errors.push(error.message); response.statusCode = 500; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'FIXTURE_ASSERTION', message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/settings`);
    const section = id => page.locator(`section[aria-labelledby="${id}"]`);
    const web = section('web-search-heading'), xhsPanel = section('xhs-query-search-heading');
    const quality = section('workflow-quality-settings-title'), humanPanel = section('human-quality-settings-heading');
    const catalog = section('layout-catalog-title');
    const choose = async (scope, label, option) => {
      await scope.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
    };
    const count = path => writes.filter(write => write.path === path).length;
    const last = path => writes.filter(write => write.path === path).at(-1);
    const save = async (scope, label, path) => {
      const before = count(path);
      await scope.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(({ id, label }) => [...document.querySelector(`section[aria-labelledby="${id}"]`).querySelectorAll('button')]
        .some(button => button.textContent.trim() === label && button.disabled), { id: await scope.getAttribute('aria-labelledby'), label });
      assert.equal(count(path), before + 1); assert.equal(last(path).rejected, undefined); return last(path).body;
    };

    // F-SETTING-002/003/005: exact provider payloads, distinct ordered fallbacks,
    // and the Custom/Global-only ICP controls use the actual central-page inputs.
    await web.getByRole('combobox', { name: '搜索服务', exact: true }).waitFor();
    assert.match(await web.getByRole('combobox', { name: '搜索服务', exact: true }).textContent(), /跟随执行机默认配置/u);
    for (const [label, value] of [['Codex 联网搜索', 'CODEX'], ['DeepSeek 联网搜索', 'DEEPSEEK'], ['火山引擎豆包搜索', 'DOUBAO']]) {
      await choose(web, '搜索服务', label);
      assert.equal((await save(web, '保存搜索配置', endpoints.search)).webSearchProvider, value);
    }
    const icp = web.getByRole('combobox', { name: '豆包搜索站点范围', exact: true });
    assert.equal(await icp.isDisabled(), true, 'Custom cannot apply an ICP-only filter');
    await choose(web, '豆包搜索模式', 'Global（按量后付费）');
    assert.equal(await icp.isEnabled(), true);
    for (const [label, value] of [['不限站点备案', false], ['仅 ICP 备案站点', true], ['默认：仅 ICP 备案站点', null]]) {
      await choose(web, '豆包搜索站点范围', label);
      assert.equal((await save(web, '保存搜索配置', endpoints.search)).doubaoIcpHostOnly, value);
    }
    await choose(web, '豆包搜索模式', 'Custom（订阅套餐）');
    assert.equal(await icp.isDisabled(), true);
    assert.equal((await save(web, '保存搜索配置', endpoints.search)).doubaoSearchMode, 'CUSTOM');
    await web.getByRole('button', { name: '添加备用服务', exact: true }).click();
    assert.match(await web.getByRole('combobox', { name: '第 1 个备用搜索服务', exact: true }).textContent(), /DeepSeek/u);
    await web.getByRole('combobox', { name: '第 1 个备用搜索服务', exact: true }).click();
    assert.equal(await page.getByRole('option', { name: '火山引擎豆包搜索', exact: true }).getAttribute('aria-disabled'), 'true');
    await page.getByRole('option', { name: 'Codex 联网搜索', exact: true }).click();
    await web.getByRole('button', { name: '添加备用服务', exact: true }).click();
    assert.equal(await web.getByRole('button', { name: '添加备用服务', exact: true }).isDisabled(), true);
    const moves = web.getByRole('button', { name: '上移', exact: true });
    assert.equal(await moves.nth(0).isDisabled(), true); await moves.nth(1).click();
    assert.deepEqual((await save(web, '保存搜索配置', endpoints.search)).webSearchProviderOrder, ['DOUBAO', 'DEEPSEEK', 'CODEX']);
    await web.getByRole('button', { name: '移除', exact: true }).nth(0).click();
    assert.deepEqual((await save(web, '保存搜索配置', endpoints.search)).webSearchProviderOrder, ['DOUBAO', 'CODEX']);
    await web.getByRole('button', { name: '只用首选服务', exact: true }).click();
    assert.equal((await save(web, '保存搜索配置', endpoints.search)).webSearchProviderOrder, null);
    await web.getByRole('button', { name: '恢复环境配置', exact: true }).click();
    const inherited = await save(web, '保存搜索配置', endpoints.search);
    assert.ok(Object.values(inherited).every(value => value === null));
    assert.match(await web.getByRole('combobox', { name: '搜索服务', exact: true }).textContent(), /跟随执行机默认配置/u);
    assert.equal(await web.getByLabel('DeepSeek 搜索模型', { exact: true }).isDisabled(), true);
    assert.equal(await web.getByLabel('API 搜索超时（毫秒）', { exact: true }).isDisabled(), true);
    assert.equal(await web.getByRole('combobox', { name: '豆包搜索模式', exact: true }).isDisabled(), true);

    // F-SETTING-008/009/010/011: cancel really issues no PUT, saved enable changes
    // preserve unsaved pacing, and all bounded fields plus combined quotas reject.
    const enabled = xhsPanel.getByRole('switch', { name: '小红书搜索总开关', exact: true });
    const limit = xhsPanel.getByLabel('每个 Query 保留链接数', { exact: true });
    const interval = xhsPanel.getByLabel('两次搜索最短间隔（秒）', { exact: true });
    const hourly = xhsPanel.getByLabel('滚动 60 分钟最多搜索（次）', { exact: true });
    const daily = xhsPanel.getByLabel('滚动 24 小时最多搜索（次）', { exact: true });
    await enabled.waitFor(); assert.equal(await limit.isDisabled(), true);
    await enabled.click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('heading', { name: '关闭小红书搜索？', exact: true }).waitFor();
    await confirmation.getByText(/待处理任务和已有结果会保留/u).waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await confirmation.waitFor({ state: 'detached' });
    assert.equal(count(endpoints.xhs), 0); assert.equal(await enabled.isChecked(), true);
    await interval.fill('120'); await enabled.click();
    await confirmation.getByRole('button', { name: '确认关闭', exact: true }).click();
    await xhsPanel.getByText('搜索已关闭', { exact: true }).waitFor();
    assert.equal(last(endpoints.xhs).body.value.enabled, false);
    assert.equal(last(endpoints.xhs).body.value.minimumIntervalSeconds, 60, 'enable toggle submits saved pacing rather than pending draft');
    assert.equal(await interval.inputValue(), '120', 'enable toggle preserves pending pacing');
    await enabled.click(); await xhsPanel.getByText('搜索已开启', { exact: true }).waitFor();
    assert.equal(last(endpoints.xhs).body.value.enabled, true);
    await choose(xhsPanel, '搜索模式', '深度排序模式'); assert.equal(await limit.isEnabled(), true);
    for (const [input, invalids, valid] of [[limit, ['0', '11', '1.5'], '7'],
      [interval, ['9', '3601', '10.5'], '120'], [hourly, ['0', '361', '1.5'], '20'], [daily, ['0', '8641', '1.5'], '100']]) {
      for (const value of invalids) {
        await input.fill(value);
        assert.equal(await xhsPanel.getByRole('button', { name: '保存小红书搜索配置', exact: true }).isDisabled(), true);
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
      }
      await input.fill(valid);
    }
    await hourly.fill('31'); await xhsPanel.getByRole('alert').getByText(/每小时最多只能设置 30 次/u).waitFor();
    await hourly.fill('20'); await daily.fill('481');
    await xhsPanel.getByRole('alert').getByText(/每 24 小时最多只能设置 480 次/u).waitFor();
    await daily.fill('100');
    const paced = await save(xhsPanel, '保存小红书搜索配置', endpoints.xhs);
    assert.deepEqual(paced, { value: { enabled: true, resultLimit: 7, searchMode: 'THOROUGH', minimumIntervalSeconds: 120, hourlyLimit: 20, dailyLimit: 100 } });
    await choose(xhsPanel, '搜索模式', '极速模式（默认）'); assert.equal(await limit.isDisabled(), true);
    assert.equal((await save(xhsPanel, '保存小红书搜索配置', endpoints.xhs)).value.searchMode, 'FASTEST');
    await xhsPanel.getByRole('button', { name: '恢复默认频率', exact: true }).click();
    assert.equal(await interval.inputValue(), '60'); assert.equal(await hourly.inputValue(), '30'); assert.equal(await daily.inputValue(), '150');
    const defaults = await save(xhsPanel, '保存小红书搜索配置', endpoints.xhs);
    assert.deepEqual(defaults.value, { enabled: true, resultLimit: 7, searchMode: 'FASTEST', minimumIntervalSeconds: 60, hourlyLimit: 30, dailyLimit: 150 });
    failSettingsRead = true;
    await page.reload();
    await xhsPanel.getByRole('alert').getByText(/隔离中心配置读取暂时失败/u).waitFor();
    assert.equal(await interval.isDisabled(), true);
    assert.equal(await xhsPanel.getByRole('button', { name: '保存小红书搜索配置', exact: true }).isDisabled(), true);
    const beforeReadRetry = count(endpoints.xhs);
    failSettingsRead = false;
    await xhsPanel.getByRole('button', { name: '重新读取', exact: true }).click();
    await xhsPanel.getByRole('switch', { name: '小红书搜索总开关', exact: true }).waitFor();
    assert.equal(count(endpoints.xhs), beforeReadRetry, 'read recovery causes no settings write');
    assert.equal(await interval.inputValue(), '60'); assert.equal(await limit.inputValue(), '7');
    assert.equal(await limit.isDisabled(), true);
    await page.getByRole('tab', { name: /兼容与高级/u }).click();
    const advanced = page.getByRole('tabpanel', { name: /兼容与高级/u });
    await advanced.getByText(/中心生产配置尚未成功读取/u).waitFor();
    await advanced.getByRole('button', { name: '重新读取', exact: true }).click();
    await advanced.getByLabel('未结构化配置', { exact: true }).waitFor();

    // F-SETTING-025/027: decimal threshold maps to exact basis points; invalid
    // requests are rejected by the actual server normalizer and never persisted.
    await page.getByRole('tab', { name: /质量与审核/u }).click();
    const threshold = quality.getByLabel('文案批次自动驳回率阈值', { exact: true });
    await threshold.waitFor();
    for (const [value, property] of [['0', 'rangeUnderflow'], ['100.01', 'rangeOverflow']]) {
      await threshold.fill(value); assert.equal(await threshold.evaluate((element, property) => element.validity[property], property), true);
      const old = workflow.copySampling.returnThresholdBps;
      await quality.getByRole('button', { name: '保存流程配置', exact: true }).click();
      await quality.getByRole('alert').getByText(/copySampling.returnThresholdBps/u).waitFor();
      assert.equal(workflow.copySampling.returnThresholdBps, old); assert.equal(last(endpoints.workflow).rejected, true);
    }
    for (const [value, expected] of [['0.01', 1], ['100', 10000], ['37.25', 3725]]) {
      await threshold.fill(value);
      assert.equal((await save(quality, '保存流程配置', endpoints.workflow)).copySampling.returnThresholdBps, expected);
    }
    const batchReturn = quality.getByRole('switch', { name: '允许质检员整批打回', exact: true });
    await batchReturn.uncheck(); assert.equal((await save(quality, '保存流程配置', endpoints.workflow)).imageSampling.reviewerBatchReturnEnabled, false);
    await quality.getByRole('switch', { name: '启用图片抽检', exact: true }).uncheck();
    assert.equal(await batchReturn.isDisabled(), true);
    await quality.getByRole('switch', { name: '启用图片抽检', exact: true }).check(); await batchReturn.check();
    assert.equal((await save(quality, '保存流程配置', endpoints.workflow)).imageSampling.reviewerBatchReturnEnabled, true);

    // F-SETTING-029/030: all four fixed scores retain their values, title/text
    // changes persist, reason codes survive unchanged labels, and both lists
    // exercise the actual ten-item/fifty-character validation contract.
    const humanSave = humanPanel.getByRole('button', { name: '保存人工评分标准', exact: true });
    await humanPanel.getByLabel('1 分档位名称', { exact: true }).waitFor();
    for (const score of [1, 2, 2.5, 3]) {
      const title = humanPanel.getByLabel(`${score} 分档位名称`, { exact: true });
      const description = humanPanel.getByLabel(`${score} 分档位说明`, { exact: true });
      assert.equal(await title.getAttribute('maxlength'), '20'); assert.equal(await description.getAttribute('maxlength'), '80');
      await title.fill(`  档位${score}  `); await description.fill(`  隔离功能测试档位 ${score} 的说明  `);
    }
    await humanPanel.getByLabel('1 分档位名称', { exact: true }).fill('   ');
    assert.equal(await humanSave.isDisabled(), true); await humanPanel.getByLabel('1 分档位名称', { exact: true }).fill('  档位1  ');
    await humanPanel.getByLabel('1 分档位说明', { exact: true }).fill(''); assert.equal(await humanSave.isDisabled(), true);
    await humanPanel.getByLabel('1 分档位说明', { exact: true }).fill('  隔离功能测试档位 1 的说明  ');
    await humanPanel.getByRole('switch', { name: '文案审核中显示评分档位说明', exact: true }).uncheck();
    const definitions = await save(humanPanel, '保存人工评分标准', endpoints.human);
    assert.deepEqual(definitions.scoreDefinitions.map(item => item.score), [1, 2, 2.5, 3]);
    assert.equal(human.scoreDefinitions[0].title, '档位1'); assert.equal(human.scoreDefinitions[0].description, '隔离功能测试档位 1 的说明');
    assert.equal(definitions.copyReviewDisplay.showScoreDescriptions, false);
    const copyReasons = humanPanel.getByLabel('文案扣分原因', { exact: true });
    const imageReasons = humanPanel.locator('#image-quality-reasons');
    const oldHuman = JSON.stringify(human);
    for (const [input, path] of [[copyReasons, 'copyReasons'], [imageReasons, 'imageReasons']]) {
      await input.fill(Array.from({ length: 11 }, (_, i) => `隔离原因${i + 1}`).join('\n'));
      await humanSave.click(); await humanPanel.getByRole('alert').getByText(new RegExp(`${path} must contain at most 10`)).waitFor();
      assert.equal(JSON.stringify(human), oldHuman); assert.equal(last(endpoints.human).rejected, true);
      await input.fill('字'.repeat(51)); await humanSave.click();
      await humanPanel.getByRole('alert').getByText(/must contain between 1 and 50 characters/u).waitFor();
      assert.equal(JSON.stringify(human), oldHuman);
      await input.fill(path === 'copyReasons' ? '事实或合规风险' : '画面文字错误');
    }
    await copyReasons.fill(['事实或合规风险', ...Array.from({ length: 9 }, (_, i) => `文案边界原因${i + 1}`)].join('\n'));
    await imageReasons.fill(['画面文字错误', ...Array.from({ length: 9 }, (_, i) => `图片边界原因${i + 1}`)].join('\n'));
    const tenReasons = await save(humanPanel, '保存人工评分标准', endpoints.human);
    assert.equal(tenReasons.copyReasons.length, 10); assert.equal(tenReasons.imageReasons.length, 10);
    await copyReasons.fill(`事实或合规风险\n\n${'文'.repeat(50)}`);
    await imageReasons.fill(`画面文字错误\n\n${'图'.repeat(50)}`);
    await humanPanel.getByRole('switch', { name: '文案审核中显示扣分原因', exact: true }).uncheck();
    const reasons = await save(humanPanel, '保存人工评分标准', endpoints.human);
    assert.equal(reasons.copyReasons[0].code, 'FACT_OR_COMPLIANCE'); assert.equal(reasons.imageReasons[0].code, 'TEXT_ERROR');
    assert.equal(reasons.copyReasons.length, 2); assert.equal(reasons.imageReasons.length, 2);
    assert.equal(reasons.copyReasons[1].label.length, 50); assert.equal(reasons.imageReasons[1].label.length, 50);
    assert.equal(reasons.copyReviewDisplay.showDeductionReasons, false);
    await imageReasons.fill(''); assert.equal(await humanSave.isDisabled(), true);
    await humanPanel.getByRole('alert').getByText(/当前原因列表为空，无法保存/u).waitFor();
    await humanPanel.getByRole('switch', { name: '图片质检中显示扣分原因', exact: true }).uncheck();
    const hidden = await save(humanPanel, '保存人工评分标准', endpoints.human);
    assert.deepEqual(hidden.imageReasons, []); assert.equal(hidden.imageReviewDisplay.showDeductionReasons, false);
    await imageReasons.fill('画面文字错误');
    await humanPanel.getByRole('switch', { name: '图片质检中显示扣分原因', exact: true }).check();
    await humanPanel.getByRole('switch', { name: '文案审核中显示扣分原因', exact: true }).check();
    await humanPanel.getByRole('switch', { name: '文案审核中显示评分档位说明', exact: true }).check();
    await save(humanPanel, '保存人工评分标准', endpoints.human);

    // F-SETTING-036/042: an actual candidate UI request reaches this fake only.
    // The candidate is synthetic; import validation makes it disabled by default.
    await page.getByRole('tab', { name: /图片与输出/u }).click();
    await choose(catalog, '自动选择方式', '匹配后随机（跳过视觉规划模型）');
    await page.getByText(/选择方式已保存/u).waitFor();
    assert.equal(last(endpoints.layout).body.catalog.selectionMode, 'RANDOM');
    await choose(catalog, '自动选择方式', '模型按内容规划');
    await page.waitForFunction(() => document.querySelector('#layout-selection-mode')?.textContent.includes('模型按内容规划'));
    assert.equal(last(endpoints.layout).body.catalog.selectionMode, 'MODEL');
    await catalog.getByText('用模型生成模板候选', { exact: true }).click();
    const brief = catalog.getByLabel(/^版式需求/u);
    const generate = catalog.getByRole('button', { name: '生成并自动入库', exact: true });
    assert.equal(await generate.isDisabled(), true); await brief.fill('   '); assert.equal(await generate.isDisabled(), true);
    assert.equal(await brief.getAttribute('maxlength'), '2000'); await brief.fill('隔离测试四个知识点卡片；此请求仅返回 fake 候选。');
    const originalLayout = JSON.stringify(layout);
    failGenerate = true; await generate.click();
    await catalog.getByRole('alert').getByText(/隔离候选夹具暂时失败/u).waitFor();
    assert.equal(JSON.stringify(layout), originalLayout); assert.equal(await brief.inputValue(), '隔离测试四个知识点卡片；此请求仅返回 fake 候选。');
    let releaseGenerate; holdGenerate = new Promise(resolve => { releaseGenerate = resolve; });
    await generate.click(); await catalog.getByRole('button', { name: '正在处理…', exact: true }).waitFor();
    assert.equal(await catalog.getByRole('combobox', { name: '自动选择方式', exact: true }).isDisabled(), true);
    releaseGenerate(); holdGenerate = null;
    await page.getByText(/模型候选已保存，请在表格中检查并启用/u).waitFor();
    assert.equal(last(`${endpoints.layout}/generate`).body.brief, '隔离测试四个知识点卡片；此请求仅返回 fake 候选。');
    const candidateRow = catalog.getByRole('row').filter({ hasText: 'HERO_FUNCTIONAL_CANDIDATE' });
    await candidateRow.waitFor(); assert.match(await candidateRow.textContent(), /模型候选/u);
    assert.equal(await candidateRow.getByRole('switch').isChecked(), false);
    assert.equal(await brief.inputValue(), ''); assert.equal(layout.catalog.templates.length, 2);
    await page.getByText(/使用已发布布局设计规则/u).waitFor();
    await catalog.getByRole('button', { name: '刷新目录', exact: true }).click();
    await candidateRow.waitFor(); assert.equal(await candidateRow.getByRole('switch').isChecked(), false);
    await page.screenshot({ path: join(directory, 'layout-candidate.png'), fullPage: true });
    await page.reload(); await page.getByRole('tab', { name: /质量与审核/u }).click();
    await quality.getByLabel('文案批次自动驳回率阈值', { exact: true }).waitFor();
    assert.equal(await threshold.inputValue(), '37.25'); assert.equal(await batchReturn.isChecked(), true);
    assert.equal(await humanPanel.getByLabel('1 分档位名称', { exact: true }).inputValue(), '档位1');
    assert.equal(await humanPanel.getByRole('switch', { name: '文案审核中显示评分档位说明', exact: true }).isChecked(), true);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    assert.ok(reads.length > 10);
    assert.ok(writes.every(write => [endpoints.search, endpoints.xhs, endpoints.workflow, endpoints.human,
      endpoints.layout, `${endpoints.layout}/generate`].includes(write.path)), 'all mutations remain inside these isolated fake endpoints');
    console.log(`settings policy screenshots: ${directory}`);
    console.log(JSON.stringify({ mutationCount: writes.length, fakeGenerationCount: count(`${endpoints.layout}/generate`), paidModelCalls: 0 }));
  } catch (error) {
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
