// Actual admin filter UI, captured HTTP parameters and independent member checks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const origin = process.env.XHS_FUNCTIONAL_ORIGIN; assert.equal(new URL(origin).hostname, '127.0.0.1');
const root = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02'); await mkdir(root, { recursive: true });
const result = { startedAt: new Date().toISOString(), origin, cases: [], taskWrites: 0, modelCalls: 0 };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(60000);
const save = () => writeFile(join(root, 'functional-list-filter-supplement.json'), JSON.stringify(result, null, 2));
async function api(path) { const r = await context.request.get(origin + '/api/control-plane' + path); assert.equal(r.status(), 200); return (await r.json()).data; }
const viewIds = () => page.locator('tbody button[aria-label^="查看作业 #"]').evaluateAll(nodes => nodes.map(n => Number(/#(\d+)/.exec(n.getAttribute('aria-label'))[1])).sort((a,b) => a-b));
async function check(name, featureIds, action) {
  const entry = { id: `LF${String(result.cases.length + 1).padStart(2, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  console.log('LIST_FILTER ' + entry.id + ' ' + name);
  try { entry.evidence = await action(); entry.status = 'PASS'; } catch (e) { entry.status = 'FAIL'; entry.error = String(e.stack ?? e); }
  entry.screenshot = `list-filter-${entry.id}-${entry.status.toLowerCase()}.png`;
  await page.screenshot({ path: join(root, entry.screenshot), fullPage: true }).catch(() => {});
  entry.durationMs = Date.now() - Date.parse(entry.startedAt); result.cases.push(entry); await save();
}
async function captured(action, parameters, expectedMembers) {
  const [response] = await Promise.all([page.waitForResponse(r => {
    const url = new URL(r.url()); return r.request().method() === 'GET' && url.pathname === '/api/control-plane/v1/tasks'
      && Object.entries(parameters).every(([k,v]) => v === null ? !url.searchParams.has(k) : url.searchParams.get(k) === String(v));
  }), action()]);
  assert.equal(response.status(), 200); const payload = (await response.json()).data;
  const actual = payload.items.map(t => t.id).sort((a,b)=>a-b), expected = expectedMembers.map(t=>t.id).sort((a,b)=>a-b);
  assert.equal(payload.total, expected.length); assert.deepEqual(actual, expected);
  await page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('tbody button[aria-label^="查看作业 #"]')].map(n=>Number(/#(\d+)/.exec(n.getAttribute('aria-label'))[1])).sort((a,b)=>a-b);
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, expected);
  assert.deepEqual(await viewIds(), expected);
  return { requestParameters: Object.fromEntries(new URL(response.url()).searchParams), total: payload.total, memberIds: actual, renderedMemberIds: await viewIds() };
}
async function selectAccount(kind, user, label) {
  await page.locator(kind === 'creator' ? '#workbench-creator' : '#workbench-assignee').click();
  const dialog = page.getByRole('dialog', { name: kind === 'creator' ? '选择创建者' : '选择标注人', exact: true });
  await dialog.getByRole('searchbox', { name: '搜索标注姓名或账号', exact: true }).fill(label ?? user.displayName);
  await dialog.getByRole('button').filter({ hasText: user.username }).first().click(); await dialog.waitFor({ state: 'hidden' });
}
let baseline, users, admin, helper, worker;
try {
  await page.goto(origin + '/login'); await page.getByLabel('账号', { exact: true }).fill('functional-helper'); await page.getByLabel('密码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.waitForURL('**/workbench/personal');
  baseline = (await api('/v1/tasks?includeTotal=true&limit=200')).items; assert.equal(baseline.length, 100);
  users = await api('/v1/users'); admin = users.find(u=>u.username==='admin'); helper = users.find(u=>u.username==='functional-helper'); worker = users.find(u=>u.username==='functional-worker');
  await page.goto(origin + '/workbench/all'); await page.getByRole('button', { name: /查看作业 #\d+：/ }).first().waitFor();
  await captured(async()=>{await page.getByRole('combobox', { name: '每页条数', exact: true }).click(); await page.getByRole('option', { name: '100 条 / 页', exact: true }).click();}, { limit: 100 }, baseline);
  await check('创建者姓名搜索无结果、按稳定账号选择、零任务账号及清除恢复100条', ['F-LIST-007'], async()=>{
    await page.locator('#workbench-creator').click(); let dialog = page.getByRole('dialog', { name: '选择创建者', exact: true });
    await dialog.getByRole('searchbox').fill('没有对应账号的合成姓名xyz'); await dialog.getByText('没有可选的标注，请更换姓名或账号。', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    const selected = await captured(()=>selectAccount('creator', admin), { createdByUserId: admin.username, createdByAccountId: admin.id }, baseline.filter(t=>t.createdByAccountId===admin.id));
    const empty = await captured(()=>selectAccount('creator', helper), { createdByUserId: helper.username, createdByAccountId: helper.id }, baseline.filter(t=>t.createdByAccountId===helper.id));
    const clear = await captured(()=>page.getByRole('button', { name: '清除创建者', exact: true }).click(), { createdByUserId: null, createdByAccountId: null }, baseline);
    return { nameSearch: admin.displayName, emptySearch: true, selected, zeroTaskAccount: empty, clear };
  });
  await check('负责人姓名搜索无结果、稳定账号成员核对、清除恢复100条', ['F-LIST-008'], async()=>{
    await page.locator('#workbench-assignee').click(); const dialog = page.getByRole('dialog', { name: '选择标注人', exact: true });
    await dialog.getByRole('searchbox').fill('没有对应标注姓名xyz'); await dialog.getByText('没有可选的标注，请更换姓名或账号。', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    const selected = await captured(()=>selectAccount('assignee', worker), { assignedToUserId: worker.username, assignedToAccountId: worker.id }, baseline.filter(t=>t.assignedToAccountId===worker.id));
    const clear = await captured(()=>page.getByRole('button', { name: '清除标注人', exact: true }).click(), { assignedToUserId: null, assignedToAccountId: null }, baseline);
    return { nameSearch: worker.displayName, emptySearch: true, selected, clear,
      verifiedScope: 'Assigned stable account and clearing to ALL. This picker has no separate unassigned-only option; unassigned route is separate.' };
  });
  await check('创建者当前角色5个全部选项、真实参数与每条成员当前角色核对', ['F-LIST-009'], async()=>{
    const steps = [];
    for (const [role,label] of [['ADMIN','管理员'],['REVIEWER','质检'],['USER','标注'],['UNKNOWN','未知角色'],['ALL','全部角色']]) {
      const expected = role === 'ALL' ? baseline : baseline.filter(t=>(t.createdByRole ?? 'UNKNOWN')===role);
      const evidence = await captured(async()=>{await page.getByRole('combobox', { name: '创建者当前角色', exact: true }).click();await page.getByRole('option', { name: label, exact: true }).click();}, { createdByRole: role === 'ALL' ? null : role }, expected);
      steps.push({ role, label, ...evidence });
    }
    return { steps };
  });
  await check('全部异常/长期无进度/失败/我的失败4项真实切换、HTTP参数和100任务独立成员谓词', ['F-LIST-012'], async()=>{
    const stale = t=>['COPY_RUNNING','IMAGE_RUNNING'].includes(t.state) && Date.now()-Date.parse(t.lastActivityAt||t.executionStartedAt||t.updatedAt||t.createdAt)>=30*60000;
    const failed = t=>['COPY_FAILED','IMAGE_FAILED'].includes(t.state)||t.currentStage==='IMAGE_RETRY_EXHAUSTED';
    const steps=[];
    for(const [label,mode,predicate] of [['全部异常','ANOMALY',t=>stale(t)||failed(t)],['长期无进度','STALE',stale],['失败任务','FAILED',failed]]) {
      const ev=await captured(()=>page.getByRole('button',{name:label,exact:true}).click(),{attention:mode},baseline.filter(predicate));
      assert.equal(await page.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');steps.push({label,mode,...ev});
    }
    const mine=await captured(()=>page.getByRole('button',{name:'我的失败任务',exact:true}).click(),{attention:'FAILED',createdByUserId:helper.username,createdByAccountId:helper.id},baseline.filter(t=>failed(t)&&t.createdByAccountId===helper.id));
    const cleared=await captured(()=>page.getByRole('button',{name:'清空筛选',exact:true}).click(),{attention:null,createdByUserId:null,createdByAccountId:null},baseline);
    return { steps, myFailed:mine, cleared };
  });
  assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total,100);
}catch(e){result.fatalError=String(e.stack??e)}finally{
  result.finishedAt=new Date().toISOString();result.status=!result.fatalError&&result.cases.length===4&&result.cases.every(c=>c.status==='PASS')?'PASS':'FAILED';await save();await browser.close();
}
console.log(JSON.stringify({status:result.status,passed:result.cases.filter(c=>c.status==='PASS').length,failed:result.cases.filter(c=>c.status==='FAIL').length,taskWrites:0}));
if(result.status!=='PASS')process.exitCode=1;
