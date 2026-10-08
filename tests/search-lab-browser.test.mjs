import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSearchLabServer } from '../search-lab/server.mjs';
import { providerCatalogue } from '../search-lab/providers.mjs';
import { compareSearch } from '../search-lab/compare.mjs';
import { createCopyLabService } from '../search-lab/copy-service.mjs';
import { createPromptRuntime } from '../src/prompt-runtime.mjs';

test('search lab browser: all provider controls, cancellation, copy jobs, diagnostics and downloads', {
  skip: process.env.RUN_SEARCH_LAB_BROWSER !== '1', timeout: 120000,
}, async () => {
  const { chromium } = await import('playwright-core');
  const directory = resolve('reports/full-functional-2026-10-02/search-lab'); await mkdir(directory, { recursive: true });
  const requests = []; const searchInputs = []; let delayed = false;
  const copyService = createCopyLabService({ environment: {}, checkLogin: async () => {},
    loadConfiguration: async () => ({ source: 'FUNCTIONAL_FAKE', settings: {}, productionSettings: { knowledgeEnabled: false },
      knowledge: [], promptRuntime: createPromptRuntime({ source: 'FUNCTIONAL_FAKE' }) }),
    createClient: async () => ({ client: {}, model: 'fake-model', reviewModel: 'fake-review', provider: 'FAKE', thinking: 'low', secrets: [] }),
    generate: async input => {
      requests.push(input); await new Promise(done => setTimeout(done, 250));
      const post = { title: '测试文案标题', body: '资料经过核对的测试正文。', tags: ['#功能测试', '#桌面'],
        imagePlan: [1, 2, 3].map(i => ({ kind: i === 1 ? 'hero' : 'detail', headline: `第${i}页`, bullets: ['要点'], prompt: '测试规划' })) };
      return { status: 'COMPLETED', qualityStatus: input.textReviewEnabled === false ? 'SKIPPED' : 'PASS', post,
        original: { copy: { ...post, title: '原稿标题' } }, reviewed: { copy: post }, imagePlan: post.imagePlan,
        generation: { model: 'fake-model', revisionAttempted: true }, stageReviews: { text: { decision: 'PASS' } },
        repairHistory: [{ reason: '测试修订' }], promptTrace: [{ prompt: '测试提示词', output: 'fake-output' }] };
    },
  });
  const server = createSearchLabServer({ copyService,
    compare: async input => {
      if (delayed) await new Promise(done => setTimeout(done, 900));
      return compareSearch(input, { search: async config => {
        searchInputs.push(config);
        if (config.id === 'qianfan') throw new Error('fake-provider-failure');
        return { provider: config.id, result: { content: '<script>window.injected=true</script> 桌面整理资料',
          sources: [{ title: '公开资料', url: 'https://example.com/desk', snippet: '分区收纳方法' }] } };
      } });
    },
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    let failProviders = true;
    await page.route('**/api/providers', async route => {
      if (failProviders) { failProviders = false; await route.fulfill({ status: 503, body: '{"error":"temporary-test-error"}', contentType: 'application/json' }); }
      else await route.continue();
    });
    await page.goto(origin); await page.locator('#retry-providers').waitFor(); await page.locator('#retry-providers').click();
    await page.waitForFunction(() => document.querySelectorAll('.provider-card').length === 13);
    assert.equal(await page.locator('#compare-button').isDisabled(), true);
    await page.locator('#query-input').fill('桌面整理');
    for (const provider of providerCatalogue) {
      await page.getByRole('checkbox', { name: `比较 ${provider.label}`, exact: true }).check();
      const key = page.getByRole('textbox', { name: `${provider.label} API Key`, exact: true });
      await key.fill('fake-functional-key-' + provider.id);
      assert.equal(await key.getAttribute('type'), 'password');
      await page.getByRole('button', { name: `显示 ${provider.label} API Key`, exact: true }).click();
      assert.equal(await key.getAttribute('type'), 'text');
      await page.getByRole('button', { name: `隐藏 ${provider.label} API Key`, exact: true }).click();
      for (const field of provider.fields ?? []) {
        if (field.type === 'boolean') { await page.getByRole('checkbox', { name: `${provider.label} ${field.label}`, exact: true }).uncheck(); continue; }
        const value = field.name === 'host' ? 'https://test-hangzhou.opensearch.aliyuncs.com'
          : field.name === 'region' ? (provider.id === 'alibaba-bailian' ? 'cn-beijing' : 'mainland') : 'functional';
        await page.getByRole('textbox', { name: `${provider.label} ${field.label}`, exact: true }).fill(value);
      }
    }
    await page.locator('#query-input').fill(''); await page.locator('#compare-button').click(); await page.getByText('请先输入搜索 Query。', { exact: true }).waitFor(); assert.equal(searchInputs.length, 0);
    await page.locator('#query-input').fill('文'.repeat(500)); await page.locator('#query-input').press('End'); await page.locator('#query-input').pressSequentially('文'); assert.equal((await page.locator('#query-input').inputValue()).length, 500); assert.equal(await page.locator('#query-input').getAttribute('maxlength'), '500');
    await page.locator('#query-input').fill('桌面整理');
    await page.locator('#compare-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 13 && !document.querySelector('#generate-all-button').disabled);
    assert.equal(searchInputs.length, 13); assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('.result-card.is-failed').count(), 1);
    assert.equal(await page.locator('.result-card script').count(), 0);
    const successfulCard = page.locator('.result-card').filter({ hasText: 'DeepSeek（当前系统）' });
    await successfulCard.getByRole('button', { name: /复制摘要/ }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /桌面整理资料/);
    await page.locator('#copy-category').fill('生活'); await page.locator('#copy-audience').fill('办公人群');
    await page.locator('#copy-image-count').selectOption('3'); await page.locator('#copy-requirements').fill('使用清晰小标题');
    await page.locator('#copy-text-review').uncheck(); assert.equal(await page.locator('#copy-auto-revise').isDisabled(), true);
    await page.locator('#copy-text-review').check(); await page.locator('#copy-auto-revise').uncheck();
    await page.locator('#refresh-copy-config').click();
    await successfulCard.getByRole('button', { name: '生成最终文案', exact: true }).click();
    await successfulCard.locator('.final-post-title').first().waitFor();
    assert.equal(requests.length, 1); assert.equal(requests[0].requestedImageCount, 3);
    assert.equal(requests[0].autoReviseOnReject, false);
    await successfulCard.getByRole('button', { name: '复制最终文案', exact: true }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /测试文案标题/);
    const downloadEvent = page.waitForEvent('download'); await successfulCard.getByRole('button', { name: '下载 TXT', exact: true }).first().click();
    const file = await downloadEvent; const path = join(directory, 'copy-result.txt'); await file.saveAs(path);
    assert.match(await readFile(path, 'utf8'), /测试文案标题/);
    for (const details of await successfulCard.locator('details').all()) await details.locator(':scope > summary').click();
    await successfulCard.getByRole('button', { name: '重新生成文案', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#generate-all-button').disabled === false);
    assert.equal(requests.length, 2, 'explicit regeneration creates another job for the same search result');
    await page.locator('#generate-all-button').click(); await page.waitForFunction(() => document.querySelectorAll('.copy-progress.is-completed').length === 12);
    assert.equal(requests.length, 14, 'all successful providers create jobs after the independent explicit regeneration');
    assert.equal(searchInputs.length, 13, 'copy jobs do not search again');
    await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true });
    delayed = true; await page.locator('#compare-button').click(); await page.locator('#cancel-button').click();
    assert.equal(await page.locator('#compare-button').isDisabled(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await new Promise(done => server.close(done));
  }
});
