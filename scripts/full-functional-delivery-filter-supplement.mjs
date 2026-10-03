// Read-only browser queries against the retained, explicitly isolated test service.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const active = JSON.parse(await readFile('reports/full-functional-2026-10-02/functional-active-environment.json', 'utf8'));
const origin = process.env.XHS_FUNCTIONAL_ORIGIN ?? active.origin;
assert.equal(new URL(origin).hostname, '127.0.0.1');
const out = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02');
await mkdir(out, { recursive: true });
const result = { startedAt: new Date().toISOString(), origin, evidenceType: 'UI_REAL_ISOLATED', modelCalls: 0, mutations: 0, cases: [], errors: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(90000);
page.on('pageerror', error => result.errors.push(error.message));
let number = 0;
async function check(name, featureIds, action) {
  const entry = { id: `DF${String(++number).padStart(2, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  console.log(`${entry.id} ${name}`);
  try { entry.evidence = await action(); entry.status = 'PASS'; } catch (error) { entry.status = 'FAIL'; entry.error = String(error.stack ?? error); }
  entry.screenshot = `delivery-filter-${entry.id}-${entry.status.toLowerCase()}.png`;
  await page.screenshot({ path: join(out, entry.screenshot), fullPage: true });
  result.cases.push(entry); await writeFile(join(out, 'functional-delivery-filter-supplement.json'), JSON.stringify(result, null, 2));
}
async function select(label, option) { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
async function query(action, expected = {}) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/control-plane/v1/delivery-items' && response.request().method() === 'GET' && Object.entries(expected).every(([key, value]) => new URL(response.url()).searchParams.get(key) === String(value)));
  await action(); const response = await responsePromise; assert.ok(response.ok());
  const params = Object.fromEntries(new URL(response.url()).searchParams); const data = (await response.json()).data;
  assert.equal(data.items.length <= Number(params.limit), true);
  const identifiers = data.items.map(item => `${item.taskId}:${item.copyRevisionId}:${item.imageRunId}`);
  assert.equal(new Set(identifiers).size, identifiers.length);
  await page.getByRole('region', { name: '共享交付内容', exact: true }).waitFor();
  await page.waitForFunction(ids => { const nodes = [...document.querySelectorAll('input[aria-label^="选择交付任务 "]')]; return nodes.length === ids.length && nodes.every((node, index) => node.getAttribute('aria-label') === `选择交付任务 ${ids[index]}`); }, data.items.map(item => item.taskId));
  return { params, total: data.total, summary: data.summary, taskIds: data.items.map(item => item.taskId), rowsMatchResponse: true };
}
async function apply(expected) { return query(() => page.getByRole('button', { name: '查询', exact: true }).click(), expected); }
async function reset() { await query(() => page.getByRole('button', { name: '重置', exact: true }).click(), { search: '', from: '', to: '', versionState: 'ALL', archiveState: 'ALL' }); }
try {
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' }); const login = page.getByRole('button', { name: '进入后台', exact: true });
  await page.waitForFunction(() => { const button = document.querySelector('button[type="submit"]'); return button && !button.disabled; });
  await page.getByLabel('账号', { exact: true }).fill('functional-helper'); await page.getByLabel('密码', { exact: true }).fill('123456'); await login.click(); await page.waitForURL(url => !url.pathname.startsWith('/login'));
  await page.goto(`${origin}/delivery-pool`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const element = document.querySelector('input[aria-label="搜索交付内容"]'); return element && Object.keys(element).some(key => key.startsWith('__reactProps') && typeof element[key]?.onChange === 'function'); });
  await check('交付五种日期快捷范围，独立核对北京时间闭区间与表格响应', ['F-DELIVERY-005'], async () => {
    const now = new Date(); const day = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const evidence = [];
    for (const [label, days, yesterday] of [['今天', 1, false], ['昨天', 1, true], ['近 7 天', 7, false], ['近 30 天', 30, false]]) {
      const end = now.getTime() - (yesterday ? 86400000 : 0); const expected = { from: day(end - (days - 1) * 86400000), to: day(end) };
      evidence.push({ label, ...await query(() => page.getByRole('button', { name: label, exact: true }).click(), expected) });
    }
    evidence.push({ label: '不限日期', ...await query(() => page.getByRole('button', { name: '不限日期', exact: true }).click(), { from: '', to: '' }) }); return evidence;
  });
  const initialResponse = await context.request.get(`${origin}/api/control-plane/v1/delivery-items?view=HISTORY&state=ALL&dateField=READY&from=&to=&search=&assigneeId=&deliveredById=&packedById=&archiveState=ALL&versionState=ALL&packageName=&clientBatchCode=&limit=100&offset=0`);
  assert.ok(initialResponse.ok()); const all = (await initialResponse.json()).data.items;
  await check('任务号、Query、批次号搜索及清空重置', ['F-DELIVERY-006'], async () => {
    await reset(); const sample = all[0]; assert.ok(sample, 'requires an existing isolated delivery fixture'); const evidence = [];
    for (const token of [String(sample.taskId), sample.query, sample.batchCode ?? sample.clientBatchCode ?? '不存在的交付批次']) {
      await page.getByRole('textbox', { name: '搜索交付内容', exact: true }).fill(token); const row = await apply({ search: token });
      if (token === String(sample.taskId) || token === sample.query) assert.ok(row.taskIds.includes(sample.taskId)); evidence.push(row);
    }
    await page.getByRole('textbox', { name: '搜索交付内容', exact: true }).fill('不存在的交付内容-no-match'); const none = await apply({ search: '不存在的交付内容-no-match' }); assert.equal(none.total, 0); evidence.push(none);
    await reset(); return { evidence, resetSearch: await page.getByRole('textbox', { name: '搜索交付内容', exact: true }).inputValue() };
  });
  await check('当前与历史视图的全部版本情况分支', ['F-DELIVERY-007'], async () => {
    await reset(); const evidence = [];
    for (const [label, state] of [['版本更新待重交', 'UPDATED'], ['全部版本情况', 'ALL']]) { await select('版本情况', label); evidence.push(await apply({ versionState: state })); }
    await page.getByRole('combobox', { name: '版本情况', exact: true }).click(); assert.equal(await page.getByRole('option', { name: '历史版本', exact: true }).count(), 0); await page.keyboard.press('Escape');
    evidence.push(await query(() => page.getByRole('button', { name: '交付记录（含历史版本）', exact: true }).click(), { view: 'HISTORY' }));
    for (const [label, state] of [['历史版本', 'HISTORICAL'], ['版本更新待重交', 'UPDATED'], ['全部版本情况', 'ALL']]) { await select('版本情况', label); evidence.push(await apply({ view: 'HISTORY', versionState: state })); }
    await reset(); return { currentHidesHistoricalOption: true, evidence };
  });
  await check('汇总保存三种状态、精确词包与甲方批次筛选', ['F-DELIVERY-009'], async () => {
    await reset(); const evidence = [];
    for (const [label, archiveState] of [['未汇总保存', 'NO'], ['已汇总保存', 'YES'], ['全部', 'ALL']]) { await select('汇总保存', label); evidence.push(await apply({ archiveState })); }
    const sample = all.find(item => item.packageName) ?? { packageName: 'delivery-filter-no-package', clientBatchCode: 'a'.repeat(32) };
    await page.getByPlaceholder('精确词包名', { exact: true }).fill(sample.packageName); const packageResult = await apply({ packageName: sample.packageName }); if (all.some(item => item.packageName)) assert.ok(packageResult.total > 0); else assert.equal(packageResult.total, 0); evidence.push(packageResult);
    await page.getByPlaceholder('精确词包名', { exact: true }).fill(`${sample.packageName}-non-exact`); const exact = await apply({ packageName: `${sample.packageName}-non-exact` }); assert.equal(exact.total, 0); evidence.push(exact);
    const batchCode = sample.clientBatchCode ?? 'a'.repeat(32); await page.getByPlaceholder('精确词包名', { exact: true }).fill(''); await page.getByPlaceholder('甲方批次编号', { exact: true }).fill(batchCode); const batch = await apply({ clientBatchCode: batchCode }); if (sample.clientBatchCode && all.some(item => item.clientBatchCode === sample.clientBatchCode)) assert.ok(batch.total > 0); else assert.equal(batch.total, 0); evidence.push(batch); await reset();
    return { evidence, realRecordsHavePackageSource: all.some(item => item.packageName), scope: 'actual ADMIN queries and empty-source boundary; positive package source membership uses component HTTP fixture', onlyAdminScope: 'USER absence independently checked in existing fixture' };
  });
  await check('三种页容量、末页边界与空结果分页', ['F-DELIVERY-017'], async () => {
    await reset(); const nav = page.getByRole('navigation', { name: '任务列表分页', exact: true }); const evidence = [];
    for (const size of [50, 100, 20]) { evidence.push(await query(() => select('每页条数', `${size} 条 / 页`), { limit: String(size), offset: '0' })); assert.equal(await nav.getByRole('button', { name: '首页', exact: true }).isDisabled(), true); }
    // The retained real service has fewer than 20 delivered rows; boundary buttons are genuinely disabled.
    const total = evidence.at(-1).total; if (total <= 20) { assert.equal(await nav.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true); assert.equal(await nav.getByRole('button', { name: '尾页', exact: true }).isDisabled(), true); }
    await page.getByRole('textbox', { name: '搜索交付内容', exact: true }).fill('delivery-empty-boundary'); const empty = await apply({ search: 'delivery-empty-boundary' }); assert.equal(empty.total, 0); assert.equal(await nav.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true); assert.equal(await nav.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await reset(); return { evidence, empty, scope: 'all page sizes and real empty/single-page boundaries; multi-page transitions tested in HTTP component fixture' };
  });
} finally {
  result.finishedAt = new Date().toISOString(); result.totals = { pass: result.cases.filter(row => row.status === 'PASS').length, fail: result.cases.filter(row => row.status === 'FAIL').length };
  await writeFile(join(out, 'functional-delivery-filter-supplement.json'), JSON.stringify(result, null, 2)); await browser.close();
}
console.log(JSON.stringify(result.totals)); process.exitCode = result.totals.fail ? 1 : 0;
