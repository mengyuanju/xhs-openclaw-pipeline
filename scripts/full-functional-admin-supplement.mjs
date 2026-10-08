// UI supplement for the explicitly supplied temporary 100-record test service.
// All extra accounts/packages/nodes use admin-supp-* names. No models are called.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const reportRoot = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02-final');
const setup = JSON.parse(await readFile(join(reportRoot, 'functional-100-results.json'), 'utf8'));
const origin = process.env.XHS_FUNCTIONAL_ORIGIN ?? setup.isolation.webUrl;
const center = process.env.XHS_FUNCTIONAL_CENTER ?? setup.isolation.centerUrl;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(center).hostname, '127.0.0.1');
const password = process.env.XHS_FUNCTIONAL_PASSWORD ?? '123456';
const username = process.env.XHS_FUNCTIONAL_USERNAME ?? 'functional-helper';
const suffix = randomUUID().slice(0, 8);
const fixtureUser = `admin-supp-${suffix}`;
const fixtureName = `管理员补测标注-${suffix}`;
const fixturePackage = `admin-supp-全淘汰词包-${suffix}`;
const executorId = `admin-supp-executor-${suffix}`;
const executorName = `管理员补测执行机-${suffix}`;
const result = { startedAt: new Date().toISOString(), origin, evidenceType: 'UI_REAL_ISOLATED', modelCalls: 0,
  syntheticFixtures: true, cases: [], errors: [], limitations: [
    '词包页面没有重命名、恢复废弃入口；搜索节点页面没有新增/编辑入口，仅查看和移除。',
    '本脚本只操作新增 admin-supp-* 夹具，不删除 100 条主任务或原导入词包。',
  ] };
const caseFilter = process.env.XHS_FUNCTIONAL_ADMIN_CASES?.split(',') ?? null;
let caseNumber = 0;
if (process.env.XHS_FUNCTIONAL_ADMIN_RESUME === '1') {
  const previous = JSON.parse(await readFile(join(reportRoot, 'functional-admin-supplement.json'), 'utf8'));
  result.cases = previous.cases.filter(entry => !caseFilter?.includes(entry.id));
  result.resumedFrom = previous.startedAt;
}
result.fixtures = { fixtureUser, fixtureName, fixturePackage, executorId };
await mkdir(reportRoot, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(90000);
page.on('pageerror', error => result.errors.push(error.message));
const reportFile = join(reportRoot, 'functional-admin-supplement.json');
const save = () => writeFile(reportFile, JSON.stringify(result, null, 2));
async function api(path, body, method = body === undefined ? 'GET' : 'POST', expected = null) {
  const response = await context.request.fetch(origin + '/api/control-plane' + path, { method, headers: { origin }, data: body });
  const payload = await response.json();
  if (expected) assert.equal(response.status(), expected, JSON.stringify(payload));
  else assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(payload)}`);
  return payload.data ?? payload;
}
async function goto(route) {
  await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
  const selector = route === '/users' ? 'input[placeholder="搜索姓名或账号"]' : route === '/query-packages' ? 'input[placeholder="搜索词包、甲方批次或筛选人"]' : null;
  if (selector) await page.waitForFunction(selector => { const el = document.querySelector(selector); return el && Object.keys(el).some(key => key.startsWith('__reactProps') && typeof el[key]?.onChange === 'function'); }, selector, { timeout: 60000 });
}
async function packageList() { const data = await api('/v1/query-packages'); return Array.isArray(data) ? data : data.items ?? []; }
async function until(action, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await action()) return; await page.waitForTimeout(150); }
  throw Error(message);
}
async function check(name, featureIds, action) {
  const entry = { id: `A${String(++caseNumber).padStart(3, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  if (caseFilter && !caseFilter.includes(entry.id)) return;
  console.log(`ADMIN ${entry.id} ${name}`);
  try { entry.evidence = await action(); entry.status = 'PASS'; }
  catch (error) { entry.status = 'FAIL'; entry.error = String(error.stack ?? error).replaceAll(password, '[test password]'); }
  entry.durationMs = Date.now() - Date.parse(entry.startedAt);
  entry.screenshot = `admin-${entry.id}-${entry.status.toLowerCase()}.png`;
  await page.screenshot({ path: join(reportRoot, entry.screenshot), fullPage: true }).catch(() => {});
  result.cases.push(entry); result.cases.sort((a, b) => a.id.localeCompare(b.id)); await save();
  await page.keyboard.press('Escape').catch(() => {});
}
async function select(label, value, scope = page) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function userRow() { return page.getByRole('row').filter({ hasText: '@' + fixtureUser }); }
async function moreUser(action) {
  const row = await userRow(); await row.getByRole('button', { name: fixtureName + '的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function poolPage() { await goto('/users'); await page.getByRole('tab', { name: /自动分配池/ }).click(); }
async function poolMore(action) {
  await page.getByRole('row').filter({ hasText: '@' + fixtureUser }).getByRole('button', { name: fixtureName + '的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
let createdUser;
let createdPackage;
let originalPool;
try {
  await page.goto(origin + '/login'); await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '进入后台', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
  const nodeResponse = await fetch(center + '/v1/nodes', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: executorId, name: executorName, copyConcurrency: 1, imageConcurrency: 1,
      codexTotalConcurrency: 1, codexImageConcurrency: 1, imageWorkerEnabled: false }) });
  assert.ok(nodeResponse.ok, 'isolated executor fixture registration failed');

  await check('用户实际新增，重复账号与无效输入拒绝，取消不写入', ['F-USER-003', 'F-USER-004'], async () => {
    await goto('/users'); await page.getByRole('button', { name: '新增用户', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('登录账号', { exact: true }).fill(fixtureUser);
    await dialog.getByLabel('姓名', { exact: true }).fill(fixtureName);
    await dialog.getByRole('button', { name: '创建用户', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    createdUser = (await api('/v1/users')).find(user => user.username === fixtureUser); assert.ok(createdUser);
    assert.equal(createdUser.mustChangePassword, true);
    await page.getByRole('button', { name: '新增用户', exact: true }).click();
    await dialog.getByLabel('登录账号', { exact: true }).fill('UPPERCASE');
    assert.equal(await dialog.getByLabel('登录账号', { exact: true }).evaluate(input => input.validity.valid), false);
    await dialog.getByLabel('登录账号', { exact: true }).fill('bad/user'); assert.equal(await dialog.getByLabel('登录账号', { exact: true }).evaluate(input => input.validity.valid), false); await dialog.getByLabel('登录账号', { exact: true }).fill(fixtureUser); assert.equal(await dialog.getByLabel('登录账号', { exact: true }).evaluate(input => input.validity.valid), true); await dialog.getByLabel('姓名', { exact: true }).fill('重复账号');
    await dialog.getByRole('button', { name: '创建用户', exact: true }).click(); await dialog.getByRole('alert').waitFor();
    assert.equal((await api('/v1/users')).filter(user => user.username === fixtureUser).length, 1);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    return { userId: createdUser.id, duplicateRejected: true, invalidPatternRejected: true, initialPasswordChangeRequired: true };
  });
  await check('重置密码先取消后确认，凭据版本改变，重新登录要求改初始密码', ['F-USER-012'], async () => {
    await goto('/users'); await page.getByPlaceholder('搜索姓名或账号').fill(fixtureUser);
    const before = (await api('/v1/users')).find(user => user.id === createdUser.id);
    await moreUser('重置密码'); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/users')).find(user => user.id === createdUser.id).credentialVersion, before.credentialVersion);
    await moreUser('重置密码'); await page.getByRole('alertdialog').getByRole('button', { name: '确认重置', exact: true }).click();
    await until(async () => (await api('/v1/users')).find(user => user.id === createdUser.id).credentialVersion > before.credentialVersion, 'Credential version was not changed');
    const other = await browser.newContext(); const p = await other.newPage();
    try { await p.goto(origin + '/login'); await p.getByLabel('账号', { exact: true }).fill(fixtureUser);
      await p.getByLabel('密码', { exact: true }).fill(password); await p.getByRole('button', { name: '进入后台', exact: true }).click();
      await p.getByRole('dialog').getByText('必须先修改初始密码', { exact: true }).waitFor();
    } finally { await other.close(); }
    return { cancelPreservedCredentialVersion: true, confirmChangedCredentialVersion: true, forcedPasswordUI: true };
  });
  await check('解除登录限制取消与确认，页面反馈及有效接口结果', ['F-USER-014'], async () => {
    await goto('/users'); await page.getByRole('button', { name: '解除登录限制', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '解除登录限制', exact: true }).click();
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/login-limit/reset'));
    await page.getByRole('alertdialog').getByRole('button', { name: '确认解除', exact: true }).click();
    const response = await responsePromise; assert.ok(response.ok());
    await page.getByText('已解除全部登录限制，受限账号现在可以重新登录。', { exact: true }).waitFor();
    return { cancelAndConfirm: true, resetHttpStatus: response.status(), limitation: '本项未制造被限制账号；限制触发和解除行为另由认证单元测试验证。' };
  });
  await check('分配池加入人员搜索、无匹配、默认不选人、取消及实际加入', ['F-USER-001', 'F-USER-017', 'F-USER-018'], async () => {
    originalPool = await api('/v1/auto-assignment'); await poolPage();
    await page.getByRole('button', { name: '加入标注', exact: true }).click(); let dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('输入姓名或账号').fill('不存在的补测人员');
    assert.ok(await dialog.getByRole('combobox', { name: '标注', exact: true }).isDisabled());
    await dialog.getByPlaceholder('输入姓名或账号').fill(fixtureUser);
    assert.match(await dialog.getByRole('combobox', { name: '标注', exact: true }).innerText(), /请选择标注/);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/auto-assignment')).workers.some(worker => worker.username === fixtureUser), false);
    await page.getByRole('button', { name: '加入标注', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('输入姓名或账号').fill(fixtureUser); await select('标注', `${fixtureName}（@${fixtureUser}）`, dialog);
    const limit = dialog.locator('#auto-assignment-limit'); await limit.fill('0'); assert.equal(await limit.evaluate(input => input.validity.valid), false);
    await limit.fill('501'); assert.equal(await limit.evaluate(input => input.validity.valid), false);
    await limit.fill('2'); await dialog.getByRole('button', { name: '确认加入', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await api('/v1/auto-assignment')).workers.find(worker => worker.username === fixtureUser).assignmentLimit, 2);
    return { noImplicitUserSelected: true, canceledAddDidNotPersist: true, limitsRejected: [0, 501], savedLimit: 2 };
  });
  await check('分配模式切换确认取消，成员编辑、暂停恢复、移出取消再确认', ['F-USER-015', 'F-USER-019', 'F-USER-020', 'F-USER-021'], async () => {
    await poolPage(); const originalMode = (await api('/v1/auto-assignment')).settings.mode ?? 'CONTINUOUS';
    const targetMode = originalMode === 'CONTINUOUS' ? '定量分配' : '持续补位';
    await select('自动分配方式', targetMode); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/auto-assignment')).settings.mode ?? 'CONTINUOUS', originalMode);
    await select('自动分配方式', targetMode); await page.getByRole('alertdialog').getByRole('button', { name: '确认切换', exact: true }).click();
    const changedMode = targetMode === '定量分配' ? 'FIXED_QUANTITY' : 'CONTINUOUS';
    await until(async () => (await api('/v1/auto-assignment')).settings.mode === changedMode, 'Mode switch did not persist');
    const row = page.getByRole('row').filter({ hasText: '@' + fixtureUser });
    await page.waitForFunction(expected => document.querySelector('#auto-assignment-mode')?.textContent?.includes(expected), targetMode, { timeout: 60000 });
    await row.getByRole('button', { name: changedMode === 'FIXED_QUANTITY' ? '编辑数量' : '编辑上限', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.locator('#auto-assignment-limit').fill('3');
    await dialog.getByRole('button', { name: changedMode === 'FIXED_QUANTITY' ? '保存数量' : '保存上限', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal((await api('/v1/auto-assignment')).workers.find(worker => worker.username === fixtureUser).assignmentLimit, 3);
    await poolMore('暂停接单'); await until(async () => (await api('/v1/auto-assignment')).workers.find(worker => worker.username === fixtureUser).status === 'PAUSED', 'Pause did not persist');
    await poolMore('恢复接单'); await until(async () => (await api('/v1/auto-assignment')).workers.find(worker => worker.username === fixtureUser).status === 'ACTIVE', 'Resume did not persist');
    await poolMore('移出人员池'); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await api('/v1/auto-assignment')).workers.some(worker => worker.username === fixtureUser));
    await poolMore('移出人员池'); await page.getByRole('alertdialog').getByRole('button', { name: '确认移出', exact: true }).click();
    await until(async () => !(await api('/v1/auto-assignment')).workers.some(worker => worker.username === fixtureUser), 'Removal did not persist');
    await select('自动分配方式', originalMode === 'CONTINUOUS' ? '持续补位' : '定量分配');
    await page.getByRole('alertdialog').getByRole('button', { name: '确认切换', exact: true }).click();
    return { modeCancelPreserved: true, modeSwitchRestored: true, editedCount: 3, pausedResumed: true, removalCanceledThenConfirmed: true };
  });
  await check('用户删除取消后保留、确认删除新增无任务账号，当前账号删除禁用', ['F-USER-013'], async () => {
    await goto('/users'); await page.getByPlaceholder('搜索姓名或账号').fill(username);
    const current = page.getByRole('row').filter({ hasText: '@' + username }); await current.getByRole('button', { name: /更多操作/ }).click();
    assert.equal(await page.getByRole('menuitem', { name: '删除用户', exact: true }).getAttribute('aria-disabled'), 'true'); await page.keyboard.press('Escape');
    await page.getByPlaceholder('搜索姓名或账号').fill(fixtureUser); await moreUser('删除用户');
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await api('/v1/users')).some(user => user.id === createdUser.id));
    await moreUser('删除用户'); await page.getByRole('alertdialog').getByRole('button', { name: '永久删除', exact: true }).click();
    await until(async () => !(await api('/v1/users')).some(user => user.id === createdUser.id), 'User deletion did not persist');
    return { canceledThenDeletedUserId: createdUser.id, currentUserDeletionDisabled: true, fixtureHadNoTasks: true };
  });
  await check('词包纯文本实际导入、32位编号校验、重复计数及不新增正式任务', ['F-QPK-006', 'F-QPK-007', 'F-QPK-008', 'F-QPK-014'], async () => {
    const before = (await api('/v1/tasks?includeTotal=true&limit=1')).total;
    await goto('/query-packages'); await page.getByRole('button', { name: '导入 Query 词包', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('词包名称', { exact: true }).fill(fixturePackage);
    await dialog.getByLabel('甲方批次编号', { exact: true }).fill('bad');
    await dialog.getByLabel('Query 内容', { exact: true }).fill(`全淘汰合成候选${suffix}甲\n全淘汰合成候选${suffix}乙\n全淘汰合成候选${suffix}甲\n全淘汰合成候选${suffix}丙`);
    assert.ok(await dialog.getByRole('button', { name: '创建词包', exact: true }).isDisabled());
    await dialog.getByLabel('甲方批次编号', { exact: true }).fill(randomUUID().replaceAll('-', ''));
    await dialog.getByText('识别 3 条 · 重复 1 条', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '创建词包', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    createdPackage = (await packageList()).find(item => item.name === fixturePackage); assert.ok(createdPackage);
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, before);
    return { packageId: createdPackage.id, candidates: 3, duplicateCount: 1, formalTaskCountUnaffected: before };
  });
  await check('词包搜索名称和批次、无结果恢复、分配取消/按数/平均/全部收回', ['F-QPK-003', 'F-QPK-016', 'F-QPK-017', 'F-QPK-018', 'F-QPK-019', 'F-QPK-020', 'F-QPK-021'], async () => {
    await goto('/query-packages'); const search = page.getByPlaceholder('搜索词包、甲方批次或筛选人');
    await search.fill('admin-supp-不存在'); assert.equal(await page.getByRole('row').filter({ hasText: fixturePackage }).count(), 0);
    await search.fill(fixturePackage); const row = page.getByRole('row').filter({ hasText: fixturePackage }); await row.waitFor();
    await search.fill(createdPackage.clientBatchCode); await row.waitFor(); await search.fill(fixturePackage);
    await row.getByRole('button', { name: '分配筛选', exact: true }).click(); let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await row.getByRole('button', { name: '分配筛选', exact: true }).click(); dialog = page.getByRole('dialog');
    const people = dialog.getByRole('checkbox'); await until(async () => await people.count() > 0, 'Assignment people not loaded');
    for (const checkbox of await people.all()) if (await checkbox.isChecked()) await checkbox.uncheck();
    await people.first().check(); const labels = await people.first().getAttribute('aria-label');
    await dialog.locator('#query-package-assignment-strategy').click(); await page.getByRole('option', { name: '按条数分配', exact: true }).click();
    const countInput = dialog.locator('input[type="number"]').first(); await countInput.fill('0'); assert.equal(await countInput.evaluate(input => input.validity.valid), false);
    await countInput.fill('2'); await dialog.getByRole('button', { name: '保存分配', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const assigned = await api(`/v1/query-packages/${createdPackage.id}?itemLimit=10`); assert.equal(assigned.items.filter(item => item.screeningAssignedToUserId).length, 2);
    await row.getByRole('button', { name: '分配筛选', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.locator('#query-package-assignment-strategy').click(); await page.getByRole('option', { name: '平均分配', exact: true }).click();
    await dialog.getByRole('button', { name: '保存分配', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await api(`/v1/query-packages/${createdPackage.id}?itemLimit=10`)).items.filter(item => item.screeningAssignedToUserId).length, 3);
    await row.getByRole('button', { name: '分配筛选', exact: true }).click(); dialog = page.getByRole('dialog');
    await until(async () => await dialog.getByRole('checkbox').count() > 0, 'Recall users not loaded');
    for (const checkbox of await dialog.getByRole('checkbox').all()) if (await checkbox.isChecked()) await checkbox.uncheck();
    await dialog.getByRole('button', { name: '保存分配', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await api(`/v1/query-packages/${createdPackage.id}?itemLimit=10`)).items.filter(item => item.screeningAssignedToUserId).length, 0);
    return { searchedNameAndBatch: true, noMatch: true, selectedPerson: labels, assignedByCount: 2, evenAssigned: 3, recalled: 3 };
  });
  await check('词包单行暂存改判、关闭不落库，明细搜索、全部淘汰不生成正式任务', ['F-QPK-023', 'F-QPK-024', 'F-QPK-027', 'F-QPK-028', 'F-QPK-029', 'F-QPK-032', 'F-QPK-035'], async () => {
    await goto('/query-packages'); await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill(fixturePackage);
    const row = page.getByRole('row').filter({ hasText: fixturePackage }); await row.getByRole('button', { name: '筛选 Query', exact: true }).click();
    let dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '通过', exact: true }).first().click();
    await dialog.getByRole('button', { name: '淘汰', exact: true }).first().click(); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal((await api(`/v1/query-packages/${createdPackage.id}?itemLimit=10`)).items.every(item => item.screeningDecision === 'PENDING'), true);
    await row.getByRole('button', { name: '筛选 Query', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('搜索 Query 或外部编号').fill(`${suffix}乙`); await dialog.getByRole('button', { name: '应用搜索', exact: true }).click();
    await dialog.getByText(/已加载 1 \/ 1 条/).waitFor(); await dialog.getByPlaceholder('搜索 Query 或外部编号').fill('');
    await dialog.getByRole('button', { name: '应用搜索', exact: true }).click(); await dialog.getByText(/已加载 3 \/ 3 条/).waitFor();
    await dialog.getByLabel('选择已加载的可筛选 Query', { exact: true }).check(); await dialog.getByLabel('筛选原因', { exact: true }).fill('合成 UI 全淘汰，仅用于安全功能测试');
    const before = (await api('/v1/tasks?includeTotal=true&limit=1')).total;
    await dialog.getByRole('button', { name: /^批量淘汰 3$/ }).click();
    await until(async () => (await api(`/v1/query-packages/${createdPackage.id}?itemLimit=10`)).items.every(item => item.screeningDecision === 'REJECTED'), 'Reject did not persist');
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, before);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    return { stagedChangeWasNotPersisted: true, searchCount: 1, allRejected: 3, taskCountUnaffected: before };
  });
  await check('词包废弃空原因禁用与取消、确认废弃、删除预检和错误名称拒绝及取消', ['F-QPK-036', 'F-QPK-037', 'F-QPK-038', 'F-QPK-039', 'F-QPK-040'], async () => {
    await goto('/query-packages'); await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill(fixturePackage);
    const row = page.getByRole('row').filter({ hasText: fixturePackage });
    // A fully rejected package is USED_UP and has no abandon action. Create a
    // separate unreviewed fixture through the UI for the actual abandon branch.
    await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill('');
    await page.getByRole('button', { name: '导入 Query 词包', exact: true }).click();
    let pending = page.getByRole('dialog'); const pendingName = `admin-supp-废弃词包-${suffix}`;
    await pending.getByLabel('词包名称', { exact: true }).fill(pendingName);
    await pending.getByLabel('甲方批次编号', { exact: true }).fill(randomUUID().replaceAll('-', ''));
    await pending.getByLabel('Query 内容', { exact: true }).fill(`待废弃合成候选${suffix}`);
    await pending.getByRole('button', { name: '创建词包', exact: true }).click(); await pending.waitFor({ state: 'hidden' });
    await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill(pendingName);
    const pendingRow = page.getByRole('row').filter({ hasText: pendingName });
    const abandon = pendingRow.getByRole('button', { name: '废弃词包', exact: true });
    const pendingStatus = (await packageList()).find(item => item.name === pendingName)?.status;
    await abandon.click(); pending = page.getByRole('dialog'); assert.ok(await pending.getByRole('button', { name: '确认废弃词包', exact: true }).isDisabled());
    await pending.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await packageList()).find(item => item.name === pendingName)?.status, pendingStatus);
    await abandon.click(); await page.getByRole('dialog').getByLabel('废弃原因', { exact: true }).fill('合成 UI 完成后废弃备用词包');
    await page.getByRole('dialog').getByRole('button', { name: '确认废弃词包', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal((await packageList()).find(item => item.name === pendingName)?.status, 'ABANDONED');
    await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill(fixturePackage);
    await row.getByRole('button', { name: '永久删除', exact: true }).click(); let dialog = page.getByRole('dialog');
    await dialog.getByText('符合永久删除条件；正式作业不会被删除', { exact: true }).waitFor();
    assert.ok(await dialog.getByRole('button', { name: '永久删除', exact: true }).isDisabled());
    await dialog.getByLabel('永久删除原因', { exact: true }).fill('合成安全功能测试清理');
    await dialog.getByLabel('管理员二级密码', { exact: true }).fill('synthetic-wrong-password');
    await dialog.locator('#query-package-delete-confirmation').fill('错误词包名');
    assert.ok(await dialog.getByRole('button', { name: '永久删除', exact: true }).isDisabled());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await packageList()).some(item => item.id === createdPackage.id));
    return { packageId: createdPackage.id, eligibleDeletionPreview: true, emptyFieldsAndWrongNameDisabled: true, canceledDeletionPreserved: true,
      abandonEmptyReasonDisabled: true, abandonCanceledThenConfirmed: true, pendingFixtureName: pendingName,
      limitation: '真正删除和错误二级密码接口验证由下一组执行；废弃分支使用另一个从未生成正式作业的备用词包。' };
  });
  await check('管理员个人二级密码实际设置、词包错误密码拒绝、正确密码永久删除', ['F-AUTH-013', 'F-QPK-039', 'F-QPK-040'], async () => {
    const deletionPassword = `Synthetic-${suffix}-secondary`;
    await page.goto(origin + '/profile', { waitUntil: 'domcontentloaded' }); await page.getByLabel('当前登录密码', { exact: true }).fill(password);
    await page.getByLabel('二级密码', { exact: true }).fill(deletionPassword); await page.getByLabel('确认二级密码', { exact: true }).fill(deletionPassword);
    await page.getByRole('button', { name: /^(设置|更新)二级密码$/ }).click(); await page.getByText(/二级密码已设置|二级密码已更新/).waitFor();
    await goto('/query-packages'); await page.getByPlaceholder('搜索词包、甲方批次或筛选人').fill(fixturePackage);
    await page.getByRole('row').filter({ hasText: fixturePackage }).getByRole('button', { name: '永久删除', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByText('符合永久删除条件；正式作业不会被删除', { exact: true }).waitFor();
    await dialog.getByLabel('永久删除原因', { exact: true }).fill('合成 UI 测试完成后的夹具清理');
    await dialog.getByLabel('管理员二级密码', { exact: true }).fill('synthetic-wrong-password');
    await dialog.locator('#query-package-delete-confirmation').fill(fixturePackage); await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
    await dialog.getByRole('alert').waitFor(); assert.ok((await packageList()).some(item => item.id === createdPackage.id));
    await dialog.getByLabel('管理员二级密码', { exact: true }).fill(deletionPassword); const taskCount = (await api('/v1/tasks?includeTotal=true&limit=1')).total;
    await dialog.getByRole('button', { name: '永久删除', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await packageList()).some(item => item.id === createdPackage.id), false);
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, taskCount);
    return { secondaryPasswordSetByUI: true, wrongPasswordRejected: true, deletedPackageId: createdPackage.id, formalTaskCountPreserved: taskCount };
  });
  await check('执行机在线删除禁用，离线后取消保留、确认移除且刷新不再显示', ['F-EXEC-001', 'F-EXEC-003', 'F-EXEC-004'], async () => {
    await page.goto(origin + '/executors', { waitUntil: 'domcontentloaded' }); let remove = page.getByRole('button', { name: '删除执行机 ' + executorName, exact: true });
    const node = (await api('/v1/executor-statuses')).find(node => node.id === executorId);
    let onlineDeleteDisabled = null;
    if (node.online) { onlineDeleteDisabled = await remove.isDisabled(); assert.equal(onlineDeleteDisabled, true); }
    await until(async () => !(await api('/v1/executor-statuses')).find(node => node.id === executorId)?.online, 'Fixture did not become offline', 110000);
    await page.getByRole('button', { name: '刷新', exact: true }).click(); await until(async () => await remove.isEnabled(), 'Delete button remained disabled');
    await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await api('/v1/executor-statuses')).some(node => node.id === executorId));
    await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await remove.waitFor({ state: 'hidden' }); assert.equal((await api('/v1/executor-statuses')).some(node => node.id === executorId), false);
    return { onlineDeleteDisabled, offlineDeleteCanceledThenConfirmed: true, removedNodeId: executorId };
  });
  await check('小红书搜索节点离线夹具状态读取、移除取消及确认', ['F-EXEC-005', 'F-EXEC-006'], async () => {
    const nodes = await api('/v1/xhs-search-statuses'); const node = nodes.find(node => node.id.startsWith('admin-supp-search'));
    assert.ok(node, 'Need an explicitly isolated admin-supp-search node fixture; no production/100 task search is claimed by this script');
    await page.goto(origin + '/executors', { waitUntil: 'domcontentloaded' }); const remove = page.getByRole('button', { name: '移除搜索节点 ' + node.name, exact: true });
    assert.equal(node.online, false); await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await api('/v1/xhs-search-statuses')).some(item => item.id === node.id));
    await remove.click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认移除', exact: true }).click(); await remove.waitFor({ state: 'hidden' });
    assert.equal((await api('/v1/xhs-search-statuses')).some(item => item.id === node.id), false);
    return { nodeId: node.id, displayedAuthStatus: node.authStatus, cancelPreserved: true, confirmedRemoval: true, fixtureSource: 'isolated temporary PostgreSQL only' };
  });
  await check('账号三权限、自动成批边界与全量质检实际双向保存及角色门禁', ['F-USER-006', 'F-USER-007', 'F-USER-008', 'F-USER-010', 'F-USER-011'], async () => {
    await goto('/users'); await page.getByRole('button', { name: '新增用户', exact: true }).click();
    let dialog = page.getByRole('dialog'); const flagsUsername = `admin-supp-flags-${suffix}`; const flagsName = `权限配置补测-${suffix}`;
    await dialog.getByLabel('登录账号', { exact: true }).fill(flagsUsername); await dialog.getByLabel('姓名', { exact: true }).fill(flagsName);
    assert.equal(await dialog.locator('input[name="imageQcEnabled"]').isDisabled(), true, 'USER cannot enable image QA');
    await select('角色', '质检', dialog);
    await dialog.locator('input[name="copyReviewEnabled"]').uncheck(); await dialog.locator('input[name="copyQcEnabled"]').check(); await dialog.locator('input[name="imageQcEnabled"]').check();
    const automatic = dialog.getByRole('checkbox', { name: /自动文案成批/ }); await automatic.check();
    const full = dialog.getByRole('checkbox', { name: /文案全量质检/ }); await full.check();
    const size = dialog.getByLabel('自动成批任务数', { exact: true });
    for (const invalid of ['0', '5001']) { await size.fill(invalid); assert.equal(await size.evaluate(input => input.validity.valid), false); }
    await size.fill('2'); await dialog.getByRole('button', { name: '创建用户', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    let saved = (await api('/v1/users')).find(user => user.username === flagsUsername); assert.ok(saved);
    const settings = user => ({ role: user.role, copyReviewEnabled: user.copyReviewEnabled, copyQcEnabled: user.copyQcEnabled, imageQcEnabled: user.imageQcEnabled, autoCopyBatchEnabled: user.autoCopyBatchEnabled, autoCopyBatchSize: user.autoCopyBatchSize, copyFullInspection: user.copyFullInspection });
    assert.deepEqual(settings(saved), { role: 'REVIEWER', copyReviewEnabled: false, copyQcEnabled: true, imageQcEnabled: true, autoCopyBatchEnabled: true, autoCopyBatchSize: 2, copyFullInspection: true });
    await page.getByPlaceholder('搜索姓名或账号').fill(flagsUsername); const row = page.getByRole('row').filter({ hasText: '@' + flagsUsername });
    await row.getByRole('button', { name: '编辑', exact: true }).click(); dialog = page.getByRole('dialog');
    assert.equal(await dialog.locator('input[name="copyQcEnabled"]').isChecked(), true); assert.equal(await dialog.locator('input[name="imageQcEnabled"]').isChecked(), true); assert.equal(await dialog.getByRole('checkbox', { name: /文案全量质检/ }).isChecked(), true);
    await dialog.locator('input[name="copyReviewEnabled"]').check(); await dialog.locator('input[name="copyQcEnabled"]').uncheck(); await dialog.locator('input[name="imageQcEnabled"]').uncheck();
    await dialog.getByRole('checkbox', { name: /自动文案成批/ }).uncheck(); assert.equal(await dialog.getByLabel('自动成批任务数', { exact: true }).isDisabled(), true);
    await dialog.getByRole('checkbox', { name: /文案全量质检/ }).uncheck(); await dialog.getByRole('button', { name: '保存修改', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    saved = (await api('/v1/users')).find(user => user.username === flagsUsername);
    assert.deepEqual(settings(saved), { role: 'REVIEWER', copyReviewEnabled: true, copyQcEnabled: false, imageQcEnabled: false, autoCopyBatchEnabled: false, autoCopyBatchSize: 2, copyFullInspection: false });
    await row.getByRole('button', { name: flagsName + '的更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '删除用户', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '永久删除', exact: true }).click(); await until(async () => !(await api('/v1/users')).some(user => user.id === saved.id), 'Flags fixture was not deleted');
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, 100);
    return { accountId: saved.id, reviewerThreePermissionsSavedBothDirections: true, userImageQcDisabled: true, autoAndFullInspectionSavedBothDirections: true, invalidBatchSizes: [0, 5001], fixtureDeleted: true, taskCount: 100, limitation: '仅证明账号控件与配置持久化，实际不同权限账号访问路由由认证/导航与服务端测试负责。' };
  });
} catch (error) {
  result.fatalError = String(error.stack ?? error).replaceAll(password, '[test password]');
  throw error;
} finally {
  if (originalPool) {
    const current = await api('/v1/auto-assignment').catch(() => null);
    if (current && (current.settings.mode !== originalPool.settings.mode || current.settings.enabled !== originalPool.settings.enabled)) {
      await api('/v1/auto-assignment/settings', { enabled: originalPool.settings.enabled, mode: originalPool.settings.mode ?? 'CONTINUOUS', expectedVersion: current.settings.version }, 'PATCH');
      result.poolSettingsRestored = true;
    }
  }
  result.status = result.fatalError || result.cases.length === 0 || result.cases.some(entry => entry.status === 'FAIL') ? 'FAILED' : 'PASS';
  result.finishedAt = new Date().toISOString(); await save(); await browser.close();
}
console.log(JSON.stringify({ status: result.status, passed: result.cases.filter(entry => entry.status === 'PASS').length, failed: result.cases.filter(entry => entry.status === 'FAIL').length }));
if (result.status !== 'PASS') process.exitCode = 1;
