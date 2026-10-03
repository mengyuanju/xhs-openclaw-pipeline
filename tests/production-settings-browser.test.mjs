import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_PRODUCTION_SETTINGS, normalizeProductionSettings } from '../src/production-settings.mjs';
import { effectiveModelApiConfig } from '../src/model-api-config.mjs';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../src/human-quality-settings.mjs';
import { DEFAULT_WEB_SEARCH_SETTINGS } from '../src/web-search-config.mjs';

test('local production settings browser: model controls, repair saves, environment reset and native disclosure validity', {
  skip: process.env.RUN_PRODUCTION_SETTINGS_BROWSER !== '1', timeout: 240_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'production-settings-browser-'));
  const errors = [], patternErrors = [], requests = [], writes = [];
  let rejectNextSave = false;
  let browser, server;
  const record = { settings: DEFAULT_PRODUCTION_SETTINGS, updatedAt: '2026-10-02T00:00:00.000Z' };
  const effective = effectiveModelApiConfig(record.settings.modelApi, {});
  try {
    await build({ stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
      import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';
      import{Toaster}from'./components/ui/sonner';
      import{ProductionSettingsForm}from'./app/settings/production-settings-form';
      fetch('/fixture').then(r=>r.json()).then(data=>createRoot(document.getElementById('root')).render(
        <ConfirmDialogProvider><ProductionSettingsForm initialRecord={data.record} effectiveModelApi={data.effective}/><Toaster/></ConfirmDialogProvider>));`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(root, 'bundle.js'),
      jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
      define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' } });
    const [script, css] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'))]);
    server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(script); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      let data;
      if (url.pathname === '/fixture') data = { record, effective };
      if (url.pathname.startsWith('/api/')) {
        requests.push({ path: url.pathname, method: request.method });
        if (url.pathname === '/api/production-settings' && request.method === 'PATCH') {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const input = JSON.parse(raw); writes.push(input);
          if (rejectNextSave) {
            rejectNextSave = false; response.statusCode = 503; response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ error: { code: 'FIXTURE_TEMPORARY_FAILURE', message: '测试保存暂时失败，请重试' } })); return;
          }
          try {
            record.settings = normalizeProductionSettings({ ...record.settings, ...input,
              modelApi: { ...record.settings.modelApi, ...(input.modelApi ?? {}) } });
          } catch (error) {
            response.statusCode = 400; response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: error.message } })); return;
          }
          record.updatedAt = new Date().toISOString(); data = record;
        } else if (url.pathname === '/api/human-quality-settings') data = DEFAULT_HUMAN_QUALITY_SETTINGS;
        else if (url.pathname === '/api/layout-catalog') data = { catalog: null, revision: 'fixture-empty' };
        else if (url.pathname === '/api/web-search-settings') data = { settings: DEFAULT_WEB_SEARCH_SETTINGS,
          scope: 'local', effective: { provider: 'CODEX', providers: ['CODEX'], resultLimit: 5 },
          apiKeyConfigured: false, updatedAt: record.updatedAt };
        else { response.statusCode = 404; data = null; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); return;
      }
      if (data) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(data)); return; }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => { errors.push(error.message); console.log(JSON.stringify({ pageError: error.message })); });
    page.on('console', message => { if (/invalid regular expression|invalid.*pattern/iu.test(message.text())) patternErrors.push(message.text()); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    async function choose(label, option) {
      await page.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
    }
    async function save(label) {
      const before = writes.length;
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(text => [...document.querySelectorAll('button')]
        .some(button => button.textContent.trim() === text && button.disabled), label);
      assert.equal(writes.length, before + 1);
      return writes.at(-1);
    }
    const modelSave = page.getByRole('button', { name: '保存模型配置', exact: true });
    assert.equal(await modelSave.isDisabled(), true);
    await choose('独立文案提供方', '默认生成引擎（Codex）');
    assert.equal((await save('保存模型配置')).modelApi.copyGenerationProvider, 'CODEX');
    await choose('独立文案提供方', 'Dots Chat Completions');
    const dotsBase = page.getByLabel('Dots API 基础地址', { exact: true });
    assert.equal(await dotsBase.getAttribute('maxlength'), '500');
    await dotsBase.fill('not-a-url');
    assert.equal(await dotsBase.evaluate(element => element.validity.typeMismatch), true);
    await dotsBase.fill('https://invalid-fixture.example');
    await modelSave.click();
    await page.getByText(/dotsBaseUrl must use the documented Dots API origin/u).waitFor();
    assert.equal(record.settings.modelApi.copyGenerationProvider, 'CODEX', 'invalid Dots origin must leave the saved configuration intact');
    await dotsBase.fill(effective.dotsBaseUrl);
    await choose('Dots 模型', 'dots3-note-prev');
    for (const [label, value] of [['极简（minimal）', 'minimal'], ['低（low）', 'low'], ['中（medium）', 'medium'],
      ['高（high）', 'high'], ['超高（xhigh）', 'xhigh'], ['最高（max）', 'max']]) {
      await choose('文案思考强度', label);
      assert.equal((await save('保存模型配置')).modelApi.copyGenerationThinking, value);
    }
    await choose('文案思考强度', '高（high）');
    const models = [
      ['文本生成模型', 'textModel', 'openai/gpt-5.6-luna'],
      ['需求检测模型', 'screeningModel', 'openai/gpt-5.6-terra'],
      ['阶段审核模型', 'reviewModel', 'openai/gpt-5.5'],
      ['视觉验收模型', 'visionModel', 'openai/gpt-5.4'],
      ['独立终审模型', 'qualityModel', 'openai/gpt-5.4-mini'],
      ['图片生成模型', 'imageModel', 'openai/gpt-image-2'],
    ];
    for (const [label, , model] of models) await choose(label, model);
    await page.getByRole('button', { name: /网络与稳定性/u }).click();
    await choose('容量备用模型', 'openai/gpt-5.5');
    const cooldown = page.getByLabel('主模型满载冷却时间', { exact: true });
    const timeout = page.getByLabel('图片调用超时', { exact: true });
    for (const [input, minimum, maximum, valid] of [[cooldown, 60000, 3600000, 120000], [timeout, 30000, 540000, 45000]]) {
      await input.fill(String(minimum - 1));
      assert.equal(await input.evaluate(element => element.validity.rangeUnderflow), true);
      await input.fill(String(maximum + 1));
      assert.equal(await input.evaluate(element => element.validity.rangeOverflow), true);
      await input.fill(String(valid));
      assert.equal(await input.evaluate(element => element.checkValidity()), true);
    }
    const modelProxy = page.getByLabel('文本与视觉代理', { exact: true });
    const imageProxy = page.getByLabel('图片生成代理', { exact: true });
    await modelProxy.fill('invalid-url');
    assert.equal(await modelProxy.evaluate(element => element.validity.typeMismatch), true);
    await modelProxy.fill('http://fixture-user:fixture-password@127.0.0.1:18101');
    await modelSave.click();
    await page.getByText(/modelProxyUrl cannot contain credentials/u).waitFor();
    assert.equal(record.settings.modelApi.modelProxyUrl, null, 'credential-bearing proxy must not be stored');
    await modelProxy.fill('http://127.0.0.1:18101');
    await imageProxy.fill('http://127.0.0.1:18102');
    assert.equal(await imageProxy.evaluate(element => element.checkValidity()), true);
    const configured = await save('保存模型配置');
    assert.deepEqual(Object.keys(configured), ['modelApi']);
    assert.equal(configured.modelApi.copyGenerationProvider, 'DOTS');
    assert.equal(configured.modelApi.copyGenerationThinking, 'high');
    assert.equal(configured.modelApi.dotsBaseUrl, effective.dotsBaseUrl);
    assert.equal(configured.modelApi.dotsModel, 'dots3-note-prev');
    for (const [, key, model] of models) assert.equal(configured.modelApi[key], model);
    assert.equal(configured.modelApi.capacityFallbackModel, 'openai/gpt-5.5');
    assert.equal(configured.modelApi.modelCapacityCooldownMs, 120000);
    assert.equal(configured.modelApi.modelProxyUrl, 'http://127.0.0.1:18101');
    assert.equal(configured.modelApi.imageProxyUrl, 'http://127.0.0.1:18102');
    assert.equal(configured.modelApi.imageTimeoutMs, 45000);
    await page.reload();
    assert.match(await page.getByRole('combobox', { name: '独立文案提供方', exact: true }).textContent(), /Dots Chat Completions/u);
    await choose('文本生成模型', /^环境或默认值/u);
    assert.equal((await save('保存模型配置')).modelApi.textModel, null);
    await page.locator('section[aria-labelledby="model-api-heading"]')
      .getByRole('button', { name: '恢复环境配置', exact: true }).click();
    const restored = await save('保存模型配置');
    assert.deepEqual(Object.keys(restored.modelApi).sort(), ['agentProvider', 'copyGenerationProvider',
      'copyGenerationThinking', 'dotsBaseUrl', 'dotsModel', 'textModel', 'capacityFallbackModel',
      'modelCapacityCooldownMs', 'screeningModel', 'reviewModel', 'visionModel', 'qualityModel',
      'imageModel', 'modelProxyUrl', 'imageProxyUrl', 'imageTimeoutMs'].sort());
    assert.ok(Object.values(restored.modelApi).every(value => value === null));
    assert.match(await page.getByRole('combobox', { name: '独立文案提供方', exact: true }).textContent(), /环境或默认值/u);
    await page.getByRole('tab', { name: /质量与审核/u }).click();
    await choose('触发分数', '2 分');
    assert.match(await page.getByRole('combobox', { name: '目标分数', exact: true }).textContent(), /3 分/u);
    await page.getByRole('combobox', { name: '目标分数', exact: true }).click();
    assert.equal(await page.getByRole('option', { name: '2 分', exact: true }).count(), 0);
    await page.getByRole('option', { name: '3 分', exact: true }).click();
    for (const value of ['1 次', '2 次', '0 次']) await choose('最多修复次数', value);
    assert.deepEqual(await save('保存返修策略'), { qualityRepairEnabled: true,
      qualityRepairTriggerScore: 2, qualityRepairTargetScore: 3, qualityRepairMaxAttempts: 0 });
    await page.getByRole('switch', { name: '启用自动修复', exact: true }).uncheck();
    for (const label of ['触发分数', '目标分数', '最多修复次数']) {
      assert.equal(await page.getByRole('combobox', { name: label, exact: true }).isDisabled(), true);
    }
    assert.equal((await save('保存返修策略')).qualityRepairEnabled, false);
    await page.getByRole('switch', { name: '启用自动修复', exact: true }).check();
    await choose('触发分数', '1 分');
    await choose('目标分数', '2 分');
    await choose('最多修复次数', '2 次');
    rejectNextSave = true;
    const attempted = writes.length;
    await page.getByRole('button', { name: '保存返修策略', exact: true }).click();
    await page.getByText(/测试保存暂时失败/u).waitFor();
    assert.equal(writes.length, attempted + 1);
    assert.equal(await page.getByRole('button', { name: '保存返修策略', exact: true }).isEnabled(), true);
    assert.equal(record.settings.qualityRepairEnabled, false, 'failed save must not change the stored fixture');
    assert.deepEqual(await save('保存返修策略'), { qualityRepairEnabled: true,
      qualityRepairTriggerScore: 1, qualityRepairTargetScore: 2, qualityRepairMaxAttempts: 2 });
    await page.getByRole('tab', { name: /图片与输出/u }).click();
    const input = page.getByLabel('标识文字', { exact: true });
    await input.waitFor();
    assert.equal(await input.getAttribute('maxlength'), '12');
    const cases = [
      ['中文', true], ['English', true], ['123456', true], ['AI_生成', true], ['AI-生成', true], ['AI生成_2026-9', true],
      ['AI 生成', false], ['🤖', false], ['AI@生成', false],
    ];
    for (const [text, valid] of cases) {
      await input.fill(text);
      const actual = await input.evaluate(element => ({ value: element.value,
        valid: element.checkValidity(), patternMismatch: element.validity.patternMismatch,
        validationMessage: element.validationMessage }));
      assert.equal(actual.value, text);
      assert.equal(actual.valid, valid, `native browser validity for ${JSON.stringify(text)}`);
      assert.equal(actual.patternMismatch, !valid, `native patternMismatch for ${JSON.stringify(text)}`);
      if (!valid) assert.ok(actual.validationMessage.length > 0);
    }
    await page.getByRole('switch', { name: '显示标识', exact: true }).uncheck();
    assert.equal(await input.isDisabled(), true);
    assert.equal(await input.evaluate(element => element.willValidate), false);
    await page.getByRole('switch', { name: '显示标识', exact: true }).check();
    assert.equal(await input.isEnabled(), true);
    await input.fill('AI生成');
    assert.equal(await input.evaluate(element => element.checkValidity()), true);
    await page.getByText('自动修复次数：0 次', { exact: true }).waitFor();
    await page.getByRole('switch', { name: '显示标识', exact: true }).uncheck();
    assert.deepEqual(await save('保存交付配置'), { imageEditRepairMaxAttempts: 2,
      aiDisclosureEnabled: false, aiDisclosureText: 'AI生成' });
    await page.getByRole('switch', { name: '显示标识', exact: true }).check();
    await input.fill('AI生成_2026');
    assert.deepEqual(await save('保存交付配置'), { imageEditRepairMaxAttempts: 2,
      aiDisclosureEnabled: true, aiDisclosureText: 'AI生成_2026' });
    await page.reload();
    await page.getByRole('tab', { name: /图片与输出/u }).click();
    assert.equal(await page.getByLabel('标识文字', { exact: true }).inputValue(), 'AI生成_2026');
    assert.deepEqual(errors, []);
    assert.deepEqual(patternErrors, []);
    assert.ok(requests.length >= 3);
    assert.ok(requests.every(request => request.method === 'GET'
      || (request.path === '/api/production-settings' && request.method === 'PATCH')),
    'all writes stay within this component fake settings endpoint; no model or production configuration is used');
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const target = resolve(root), temporaryRoot = resolve(tmpdir());
    assert.ok(target.startsWith(`${temporaryRoot}\\`) || target.startsWith(`${temporaryRoot}/`));
    assert.ok(target.includes('production-settings-browser-'));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
