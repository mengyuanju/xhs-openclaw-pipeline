import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.XHS_FUNCTIONAL_ORIGIN;
assert.equal(new URL(origin).hostname, '127.0.0.1');
const report = resolve('reports/full-functional-2026-10-02'); await mkdir(report, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium-headless-shell' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
const page = await context.newPage(); const results = []; page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
const navigate = pathname => page.goto(origin + pathname, { waitUntil: 'domcontentloaded' });
async function waitForListHydration() {
  await page.waitForFunction(() => {
    const input = document.getElementById('workbench-query-search');
    return input && Object.keys(input).some(key => key.startsWith('__reactProps$') && typeof input[key]?.onChange === 'function');
  }, undefined, { timeout: 90000 });
}
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function restoreDuplicateFixture() {
  await navigate('/workbench/discarded');
  await waitForListHydration();
  await page.getByPlaceholder('Query 关键词或 #ID（如 #1024）').fill(process.env.XHS_FUNCTIONAL_DUPLICATE_QUERY);
  const listLoaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/v1/tasks') && response.url().includes('query='));
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const payload = await (await listLoaded).json();
  await page.waitForFunction(count => document.querySelectorAll('tbody tr button') .length === 0 || document.querySelectorAll('tbody tr').length === count, payload.data.items.length);
  const restoreButton = page.getByRole('button', { name: '恢复任务', exact: true });
  if (await restoreButton.count()) {
    await restoreButton.first().click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await restoreButton.first().click();
    const restored = page.waitForResponse(response => response.request().method() === 'POST' && /\/tasks\/\d+\/restore$/u.test(new URL(response.url()).pathname));
    await confirmation.getByRole('button', { name: '确认恢复', exact: true }).click();
    assert.equal((await restored).status(), 200);
    await restoreButton.waitFor({ state: 'detached' });
    return true;
  }
  return false;
}
async function check(id, featureIds, name, action) {
  const entry = { id, featureIds, name };
  try { entry.evidence = await action(); entry.status = 'PASS'; }
  catch (error) { entry.status = 'FAIL'; entry.error = error.stack; }
  await page.screenshot({ path: join(report, `report-supplement-${id}.png`), fullPage: true });
  results.push(entry); await writeFile(join(report, 'report-supplement-results.json'), JSON.stringify({ origin, cases: results, errors }, null, 2));
}
try {
  await navigate('/login'); await page.getByLabel('账号', { exact: true }).fill('functional-helper');
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return form && Object.keys(form).some(key => key.startsWith('__reactProps$') && typeof form[key]?.onSubmit === 'function');
  }, undefined, { timeout: 90000 });
  await page.getByLabel('密码', { exact: true }).fill(process.env.XHS_FUNCTIONAL_TEST_PASSWORD);
  await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.waitForURL(url => !url.pathname.startsWith('/login'));
  await check('RS01', ['F-REPORT-013', 'F-REPORT-014'], '数量标签全部切换、保存、刷新恢复及取消', async () => {
    await navigate('/reports/task-data'); await page.getByRole('button', { name: '展示设置', exact: true }).click();
    const dialog = page.getByRole('dialog'); const boxes = dialog.getByRole('checkbox'); const count = await boxes.count();
    assert.ok(count > 5); for (const box of await boxes.all()) await box.uncheck();
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: '展示设置', exact: true }).click();
    for (const box of await boxes.all()) assert.equal(await box.isChecked(), false);
    await boxes.first().check(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '展示设置', exact: true }).click(); assert.equal(await boxes.first().isChecked(), false);
    for (const box of await boxes.all()) await box.check(); await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.reload(); await page.getByRole('button', { name: '展示设置', exact: true }).click();
    for (const box of await boxes.all()) assert.equal(await box.isChecked(), true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); return { actualToggledLabels: count, reloadPersisted: true, canceledChangesNotSaved: true };
  });
  await check('RS02', ['F-REPORT-016', 'F-REPORT-018'], '二级统计和真实任务生命周期展开收起', async () => {
    await page.getByRole('button', { name: '展开二级统计', exact: true }).click();
    assert.equal(await page.locator('#task-secondary-metrics').isVisible(), true);
    await page.getByRole('button', { name: '收起二级统计', exact: true }).click();
    assert.equal(await page.locator('#task-secondary-metrics').isVisible(), false);
    const tasks = page.getByRole('button', { name: '展开任务时间线', exact: true }); assert.ok(await tasks.count() > 0);
    await tasks.first().click(); await page.getByRole('button', { name: '收起任务时间线', exact: true }).waitFor();
    await page.getByRole('button', { name: '收起任务时间线', exact: true }).click();
    return { secondaryMetrics: 'expand/collapse', actualTaskTimeline: 'expand/collapse' };
  });
  if (process.env.XHS_FUNCTIONAL_DUPLICATE_QUERY) await check('RS03', ['F-LIST-020', 'F-LIST-021', 'F-LIST-022'], '重复Query去重预览、取消与实际废弃', async () => {
    await restoreDuplicateFixture();
    await navigate('/workbench/all'); await waitForListHydration(); await page.getByPlaceholder('Query 关键词或 #ID（如 #1024）').fill(process.env.XHS_FUNCTIONAL_DUPLICATE_QUERY);
    await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByRole('checkbox', { name: '按 Query 去重', exact: true }).check();
    await page.locator('tbody tr').first().getByRole('checkbox').check();
    await page.getByRole('button', { name: '预览重复项', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '确认废弃 1 条', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const newPreview = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/duplicate-query-discard-preview'));
    await page.getByRole('button', { name: '预览重复项', exact: true }).click(); await newPreview;
    const responseEvent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/duplicate-query-discard'));
    await dialog.getByRole('button', { name: '确认废弃 1 条', exact: true }).click();
    const response = await responseEvent; assert.equal(response.status(), 200); const payload = await response.json();
    assert.equal(payload.data.discardedCount, 1);
    await page.getByText('重复 Query 处理完成：已废弃 1 条，保留 1 条，跳过 0 条。', { exact: true }).waitFor();
    const restoredViaUi = await restoreDuplicateFixture(); assert.equal(restoredViaUi, true);
    return { actualMutation: payload.data, canceledPreview: true, restoredViaUi, restoreCancelVerified: true };
  });
  assert.deepEqual(errors, []);
  process.exitCode = results.some(result => result.status === 'FAIL') ? 1 : 0;
} catch (error) {
  const safe = String(error.stack ?? error).replaceAll(process.env.XHS_FUNCTIONAL_TEST_PASSWORD, '[temporary password]');
  await writeFile(join(report, 'report-supplement-startup-error.json'), JSON.stringify({ origin, error: safe, cases: results }, null, 2));
  throw new Error(safe);
} finally { await browser.close(); }
