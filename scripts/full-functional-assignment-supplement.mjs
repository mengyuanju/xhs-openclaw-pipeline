// Actual assignment UI on two recorded COPY_REVIEW_PENDING fixtures; restore ownership.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.XHS_FUNCTIONAL_ORIGIN; assert.equal(new URL(origin).hostname, '127.0.0.1');
const root = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02'); await mkdir(root, { recursive: true });
const result = { startedAt: new Date().toISOString(), origin, modelCalls: 0, taskIds: [65, 66],
  notice: 'Additional mutations in recovered temporary database only. Authoritative 100-task final snapshot is independent and immutable.', cases: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(60000);
const save = () => writeFile(join(root, 'functional-assignment-supplement.json'), JSON.stringify(result, null, 2));
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await context.request.fetch(origin + '/api/control-plane' + path, { method, data: body, headers: { origin } });
  const p = await r.json(); assert.ok(r.ok(), `${path}: ${r.status()} ${JSON.stringify(p)}`); return p.data;
}
async function check(name, featureIds, action) {
  const entry = { id: `AS${String(result.cases.length + 1).padStart(2, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  console.log('ASSIGN_UI ' + entry.id + ' ' + name);
  try { entry.evidence = await action(); entry.status = 'PASS'; } catch (e) { entry.status = 'FAIL'; entry.error = String(e.stack ?? e); }
  entry.screenshot = `assignment-${entry.id}-${entry.status.toLowerCase()}.png`; await page.screenshot({ path: join(root, entry.screenshot), fullPage: true }).catch(() => {});
  entry.durationMs = Date.now() - Date.parse(entry.startedAt); result.cases.push(entry); await save();
}
async function search(text) {
  await page.goto(origin + '/workbench/all', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Query 关键词或 #ID（如 #1024）').fill(text);
  const [response] = await Promise.all([page.waitForResponse(r => {
    const url = new URL(r.url());
    return r.request().method() === 'GET' && url.pathname === '/api/control-plane/v1/tasks'
      && (text.startsWith('#') ? url.searchParams.get('taskId') === text.slice(1) : url.searchParams.get('query') === text);
  }),
    page.getByRole('button', { name: '搜索', exact: true }).click()]);
  assert.equal(response.status(), 200);
  await page.getByRole('button', { name: /查看作业 #65：/ }).waitFor();
}
const assignment = () => page.getByRole('dialog', { name: /^(?:分配任务|改派任务|批量(?:分配|改派))/ });
async function pick(username) {
  await assignment().locator('#task-assignment-user').click(); const picker = page.getByRole('dialog', { name: '选择任务负责人', exact: true });
  await picker.getByRole('searchbox', { name: '搜索标注姓名或账号', exact: true }).fill(username);
  await picker.getByRole('button').filter({ hasText: username }).first().click(); await picker.waitFor({ state: 'hidden' });
}
async function openTask(id) {
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(`查看作业 #${id}：`) }) });
  await row.getByRole('button', { name: /^分配$|^改派$/ }).click(); await assignment().waitFor();
}
async function submit() {
  const dialog = assignment(); const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() !== 'GET' && /\/(?:assignee|batch-assignee)$/.test(new URL(r.url()).pathname)),
    dialog.getByRole('button', { name: /^确认(?:分配|改派|分配\/改派)$/ }).click()]);
  assert.equal(response.status(), 200); await dialog.waitFor({ state: 'hidden' });
}
let originals = [], assignee;
try {
  await page.goto(origin + '/login'); await page.getByLabel('账号', { exact: true }).fill('functional-helper');
  await page.getByLabel('密码', { exact: true }).fill('123456'); await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.waitForURL('**/workbench/personal');
  assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, 100);
  originals = await Promise.all(result.taskIds.map(id => api(`/v1/tasks/${id}`))); assert.ok(originals.every(t => t.state === 'COPY_REVIEW_PENDING'));
  result.originalTasks = originals;
  await save();
  assignee = await api('/v1/users', { username: `assign-ui-supp-${randomUUID().slice(0, 6)}`, displayName: '分配界面合成补测员', role: 'USER', autoCopyBatchEnabled: false });
  result.fixtureUser = { id: assignee.id, username: assignee.username };
  await save();
  await api('/v1/tasks/batch-assignee', { taskIds: result.taskIds, assignedToUserId: null, assignedToAccountId: null, reason: '隔离UI首次分配前置条件，完成后还原原负责人' });
  await check('首次分配：账号搜索无结果、清除选择、取消不写入及实际选择确认', ['F-ASSIGN-001', 'F-ASSIGN-002', 'F-ASSIGN-004'], async () => {
    await search('#65'); await openTask(65); await assignment().locator('#task-assignment-user').click();
    const picker = page.getByRole('dialog', { name: '选择任务负责人', exact: true });
    await picker.getByRole('searchbox', { name: '搜索标注姓名或账号', exact: true }).fill('does-not-exist-synthetic-xyz');
    await picker.getByText('没有可选的标注，请更换姓名或账号。', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    await pick(assignee.username); await assignment().getByRole('button', { name: '清除负责人', exact: true }).click();
    assert.ok((await assignment().locator('#task-assignment-user').innerText()).includes('待分配任务池'));
    await pick(assignee.username); await assignment().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/tasks/65')).assignedToUserId, null);
    await openTask(65); await pick(assignee.username); await submit(); const t = await api('/v1/tasks/65');
    assert.equal(t.assignedToUserId, assignee.username); assert.equal(t.assignedToAccountId, assignee.id);
    return { taskId: 65, emptySearch: true, clearSelection: true, cancelUnchanged: true, assignedToAccountId: t.assignedToAccountId };
  });
  await check('实际改派：原因必填拒绝、取消保持原归属和确认新负责人', ['F-ASSIGN-003', 'F-ASSIGN-004'], async () => {
    await search('#65'); await openTask(65); await pick('functional-reviewer');
    await assignment().getByRole('button', { name: '确认改派', exact: true }).click();
    await assignment().getByRole('alert').filter({ hasText: '请填写改派原因' }).waitFor();
    assert.equal((await api('/v1/tasks/65')).assignedToUserId, assignee.username);
    await assignment().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/tasks/65')).assignedToUserId, assignee.username);
    await openTask(65); await pick('functional-reviewer'); await assignment().locator('#task-assignment-reason').fill('隔离功能测试实际改派原因');
    await submit(); assert.equal((await api('/v1/tasks/65')).assignedToUserId, 'functional-reviewer');
    return { taskId: 65, emptyReasonDenied: true, cancelUnchanged: true, newAssignee: 'functional-reviewer' };
  });
  await check('两条不同归属批量分配：必须明确目标、取消、实际分配并还原原负责人', ['F-ASSIGN-005', 'F-ASSIGN-004'], async () => {
    await search('完整功能合成测试 06');
    for (const id of result.taskIds) await page.getByRole('checkbox', { name: `选择任务 #${id}`, exact: true }).check();
    await page.getByRole('button', { name: '批量分配/改派 2', exact: true }).click();
    assert.equal(await assignment().getByRole('button', { name: '确认分配/改派', exact: true }).isDisabled(), true);
    await assignment().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/v1/tasks/65')).assignedToUserId, 'functional-reviewer'); assert.equal((await api('/v1/tasks/66')).assignedToUserId, null);
    await page.getByRole('button', { name: '批量分配/改派 2', exact: true }).click(); await pick(assignee.username);
    await assignment().locator('#task-assignment-reason').fill('隔离功能测试批量两条任务责任交接'); await submit();
    const changed = await Promise.all(result.taskIds.map(id => api(`/v1/tasks/${id}`)));
    assert.ok(changed.every(t => t.assignedToUserId === assignee.username && t.assignedToAccountId === assignee.id));
    return { taskIds: result.taskIds, mixedAssigneeNeedsExplicitChoice: true, cancelPreserved: true, changedAssignee: assignee.username,
      verifiedScope: 'Two successful UI batch assignments. Partial server failure boundary belongs to separate component/API tests.' };
  });
} catch (e) { result.fatalError = String(e.stack ?? e); }
finally {
  try {
    for (const t of originals) await api(`/v1/tasks/${t.id}/assignee`, { assignedToUserId: t.assignedToUserId,
      assignedToAccountId: t.assignedToAccountId, reason: '补测结束，恢复隔离任务原始负责人' }, 'PATCH');
    result.restoredTasks = await Promise.all(originals.map(t => api(`/v1/tasks/${t.id}`)));
    assert.ok(result.restoredTasks.every((t, i) => t.assignedToAccountId === originals[i].assignedToAccountId && t.state === originals[i].state));
    assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total, 100); result.restoration = 'PASS';
  } catch (e) { result.restoration = 'FAIL'; result.restorationError = String(e.stack ?? e); }
  result.status = result.cases.length === 3 && result.cases.every(c => c.status === 'PASS') && result.restoration === 'PASS' && !result.fatalError ? 'PASS' : 'FAILED';
  result.finishedAt = new Date().toISOString(); await save(); await browser.close();
}
console.log(JSON.stringify({ status: result.status, passed: result.cases.filter(c => c.status === 'PASS').length, taskIds: result.taskIds, restoration: result.restoration }));
if (result.status !== 'PASS') process.exitCode = 1;
