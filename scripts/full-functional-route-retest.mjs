// Retest failed route navigation against the same isolated 100-task environment.
// Initial failures remain immutable; merged PASS requires a real successful retry.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02-final-pass');
const input = join(root, 'functional-100-results.json');
const original = JSON.parse(await readFile(input, 'utf8'));
const origin = original.isolation.webUrl;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(original.taskCount, 100);
const failed = original.cases.filter(c => c.status === 'FAIL');
assert.ok(failed.every(c => c.name.startsWith('页面真实加载 ')), 'This retest may only resolve navigation failures');
const result = { startedAt: new Date().toISOString(), origin, taskCount: 100, modelCalls: 0, cases: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(60000);
  await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const form = document.querySelector('form.login-form');
    return form && Object.keys(form).some(k => k.startsWith('__reactProps') && typeof form[k]?.onSubmit === 'function');
  });
  await page.getByLabel('账号', { exact: true }).fill('functional-helper');
  await page.getByLabel('密码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '进入后台', exact: true }).click();
  await page.waitForURL('**/workbench/personal');
  const initial = await context.request.get(origin + '/api/control-plane/v1/tasks?includeTotal=true&limit=1');
  assert.equal(initial.status(), 200);
  assert.equal((await initial.json()).data.total, 100);
  for (const first of failed) {
    const route = first.name.slice('页面真实加载 '.length);
    const entry = { id: first.id, name: first.name, startedAt: new Date().toISOString(), initialStatus: first.status };
    try {
      const response = await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
      assert.ok(response.status() < 400);
      assert.equal(new URL(page.url()).pathname, route);
      const main = page.locator('main'); await main.waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '创建笔记', exact: true }).first().waitFor({ state: 'visible' });
      const text = await main.innerText(); assert.ok(text.trim().length > 3);
      const alerts = await page.getByRole('alert').allTextContents();
      assert.ok(!alerts.some(a => /加载失败|服务器错误|系统错误|连接失败/u.test(a)), alerts.join('；'));
      const screenshot = `route-retest-${first.id.toLowerCase()}.png`;
      await page.screenshot({ path: join(root, screenshot), fullPage: true });
      entry.status = 'PASS';
      entry.evidence = { route, finalPath: route, httpStatus: response.status(), textLength: text.length,
        visibleCreateButton: true, screenshot, waitCondition: 'DOMContentLoaded plus visible main and creation button' };
    } catch (e) { entry.status = 'FAIL'; entry.error = String(e.stack ?? e); }
    entry.durationMs = Date.now() - Date.parse(entry.startedAt); result.cases.push(entry);
    await writeFile(join(root, 'functional-route-retests.json'), JSON.stringify(result, null, 2));
  }
  result.status = result.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAILED';
  result.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'functional-route-retests.json'), JSON.stringify(result, null, 2));
  // Main runner may still be saving supplementary progress. Keep merged evidence separate.
  const main = JSON.parse(await readFile(input, 'utf8'));
  const supplemental = JSON.parse(await readFile(join(root, 'functional-browser-retests.json'), 'utf8'));
  const merged = { ...main, mergedAt: new Date().toISOString(), initialRunStatus: main.status,
    retryEvidence: 'functional-route-retests.json', originalRunEvidence: 'functional-100-initial-navigation-failure.json' };
  await writeFile(join(root, merged.originalRunEvidence), JSON.stringify(main, null, 2));
  merged.cases = main.cases.map(c => {
    const retry = result.cases.find(r => r.id === c.id && r.status === 'PASS');
    return retry ? { ...c, initialAttempt: c, ...retry, status: 'PASS', resolvedByActualRetest: true } : c;
  });
  merged.browserSupplement = { path: 'functional-browser-retests.json', status: supplemental.status,
    passed: supplemental.cases.filter(c => c.status === 'PASS').length,
    failed: supplemental.cases.filter(c => c.status === 'FAIL').length };
  merged.status = merged.cases.every(c => c.status === 'PASS') && supplemental.status === 'PASS' ? 'PASS' : 'FAILED';
  await writeFile(join(root, 'functional-100-final-results.json'), JSON.stringify(merged, null, 2));
  console.log(JSON.stringify({ status: merged.status, routeRetry: result.status, cases: merged.cases.length,
    supplemental: merged.browserSupplement, reportRoot: root }));
  if (merged.status !== 'PASS') process.exitCode = 1;
} finally { await browser.close(); }
