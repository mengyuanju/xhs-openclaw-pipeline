// All currently mounted task report conditions, actual browser requests and XLSX.
// One explicitly labeled read-failure response is injected to verify error recovery.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import ExcelJS from '@excel.js/exceljs';
const origin = process.env.XHS_FUNCTIONAL_ORIGIN; assert.equal(new URL(origin).hostname, '127.0.0.1');
const root = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02'); await mkdir(root, { recursive: true });
const endpoint = '/api/control-plane/v1/admin/task-data-report/query';
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const result = { startedAt: new Date().toISOString(), origin, taskWrites: 0, modelCalls: 0, cases: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(60000);
let all = [], last, users = [];
const save = () => writeFile(join(root, 'functional-task-report-supplement.json'), JSON.stringify(result, null, 2));
async function check(name, featureIds, action) {
  const item = { id: `RF${String(result.cases.length + 1).padStart(2, '0')}`, name, featureIds, startedAt: new Date().toISOString() };
  console.log('REPORT_FILTER ' + item.id + ' ' + name);
  try { item.evidence = await action(); item.status = 'PASS'; } catch (e) { item.status = 'FAIL'; item.error = String(e.stack ?? e); }
  item.screenshot = `task-report-${item.id}-${item.status.toLowerCase()}.png`; await page.screenshot({ path: join(root, item.screenshot), fullPage: true }).catch(() => {});
  item.durationMs = Date.now() - Date.parse(item.startedAt); result.cases.push(item); await save();
}
async function reportPage(action) {
  const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === endpoint), action()]);
  assert.equal(response.status(), 200); const data = (await response.json()).data, request = response.request().postDataJSON();
  await page.waitForFunction(ids => {
    const section = document.querySelector('[role="region"][aria-label="任务数据明细"]');
    const rows = section ? [...section.querySelectorAll('tbody > tr')].map(r => Number(r.cells[0]?.textContent.trim())) : [];
    return JSON.stringify(rows) === JSON.stringify(ids);
  }, data.items.map(t => t.taskId));
  const from = Date.parse(`${request.time.from}T${request.time.fromTime}+08:00`), to = Date.parse(`${request.time.to}T${request.time.toTime}+08:00`);
  assert.ok(data.items.every(t => Date.parse(t.reportAt) >= from && Date.parse(t.reportAt) <= to));
  last = { request, data };
  return { request, httpStatus: response.status(), total: data.total, page: data.page, pageSize: data.pageSize, memberIds: data.items.map(t=>t.taskId),
    dateBoundsVerified: true, poolOverview: data.poolOverview, activityOverview: data.activityOverview };
}
const query = () => reportPage(() => page.getByRole('button', { name: '查询任务', exact: true }).click());
const selectField = name => page.locator('label').filter({ hasText: new RegExp(`^${name}`) }).locator('select');
async function verifyMembers(expected) {
  assert.equal(last.data.total, expected.length);
  const collected = [...last.data.items];
  for (let p = 2; p <= Math.ceil(last.data.total / last.data.pageSize); p++) {
    const r = await context.request.post(origin + endpoint, { data: { ...last.request, page: p }, headers: { origin } });
    assert.equal(r.status(), 200); collected.push(...(await r.json()).data.items);
  }
  assert.deepEqual(collected.map(t=>t.taskId).sort((a,b)=>a-b), expected.map(t=>t.taskId).sort((a,b)=>a-b));
  return { exactAllMemberIds: collected.map(t=>t.taskId), completeMemberCount: collected.length };
}
async function calendar(label, date, time, months = false) {
  await page.getByRole('button', { name: new RegExp(`^${label}：`) }).click(); const group = page.getByRole('group', { name: label + '选择', exact: true });
  if (months) { const before = await group.locator('strong').innerText(); await group.getByRole('button', { name: '上个月', exact: true }).click();
    assert.notEqual(await group.locator('strong').innerText(), before); await group.getByRole('button', { name: '下个月', exact: true }).click(); assert.equal(await group.locator('strong').innerText(), before); }
  await group.getByRole('button', { name: date, exact: true }).click();
  for (const [i, unit] of ['时', '分', '秒'].entries()) await group.getByLabel(label + unit, { exact: true }).selectOption(time.split(':')[i]);
  await group.getByRole('button', { name: '完成', exact: true }).click(); await group.waitFor({ state: 'hidden' });
  assert.ok((await page.getByRole('button', { name: new RegExp(`^${label}：`) }).getAttribute('aria-label')).includes(date + ' ' + time));
}
async function clearMore() {
  for (const name of ['任务ID或任务名','改派次数（≥）']) await page.getByLabel(name, { exact: true }).fill('');
  for (const name of ['驳回次数','文案质检人','图片质检人']) await selectField(name).selectOption('');
}
async function conditionMembers(predicate) { const info = await query(); return { ...info, ...await verifyMembers(all.filter(predicate)) }; }
try {
  await page.goto(origin + '/login'); await page.getByLabel('账号', { exact: true }).fill('functional-helper'); await page.getByLabel('密码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '进入后台', exact: true }).click(); await page.waitForURL('**/workbench/personal');
  const accountResponse = await context.request.get(origin + '/api/control-plane/v1/users'); users = (await accountResponse.json()).data;
  const initial = await reportPage(() => page.goto(origin + '/reports/task-data', { waitUntil: 'domcontentloaded' }));
  all = [...last.data.items];
  for (let p = 2; p <= Math.ceil(last.data.total / last.data.pageSize); p++) { const r = await context.request.post(origin + endpoint, { data: { ...last.request, page: p }, headers: { origin } }); all.push(...(await r.json()).data.items); }
  assert.equal(all.length, last.data.total); result.initial = { ...initial, totalUniqueMembers: new Set(all.map(t=>t.taskId)).size };
  await check('任务池概况全部卡片与真实响应一致、刷新保持全池范围', ['F-REPORT-001'], async()=>{
    const firstPool = last.data.poolOverview;
    const evidence = await reportPage(()=>page.getByRole('button',{name:'刷新数据',exact:true}).click()); assert.deepEqual(last.data.poolOverview, firstPool);
    const panel = page.locator('section[aria-labelledby="task-pool-overview-title"]');
    for(const [key,label] of [['copyReviewPending','文案待审核'],['copyReworkPending','文案待返修'],['secondAssignmentPending','待二次分配'],['copyQaPending','文案待质检'],['imageGenerating','待生图及生图中'],['imageReviewPending','图片待审核'],['imageQaPending','图片待质检']]) {
      const card=panel.locator('div').filter({has:page.locator('span',{hasText:new RegExp(`^${label}$`)})}).filter({has:page.locator('strong')}).last();
      assert.equal(Number((await card.locator('strong').innerText()).replaceAll(',','')),firstPool[key]);
    }
    return {...evidence, cardsCompared:7};
  });
  await check('开始/结束日历上月下月、日期和时分秒选择、完成后真实查询范围', ['F-REPORT-002'], async()=>{
    await calendar('开始时间', yesterday, '00:01:02', true); await calendar('结束时间', today, '23:58:57', true);
    const evidence=await query(); assert.deepEqual(evidence.request.time,{field:'FIRST_COPY_REVIEW_ACTION',from:yesterday,to:today,fromTime:'00:01:02',toTime:'23:58:57'});
    return {...evidence,...await verifyMembers(all), monthNavigation:true, dateAndSecondSelection:true};
  });
  await check('标注人历任账号筛选和全部可见状态逐项查询、机器失败状态不暴露', ['F-REPORT-003'], async()=>{
    const worker=users.find(u=>u.username==='functional-worker'); await selectField('标注人').selectOption(String(worker.id));
    const annotator=await conditionMembers(t=>t.annotationPeople.some(p=>p.accountId===worker.id));
    assert.ok(last.data.activityPeople.every(p=>p.accountId===worker.id)); await selectField('标注人').selectOption('');
    const options=await selectField('任务状态').locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,label:n.textContent})));
    assert.ok(!options.some(o=>['COPY_QUEUED','COPY_RUNNING','COPY_FAILED','IMAGE_FAILED'].includes(o.value)));
    const steps=[];for(const option of options.filter(o=>o.value)) {await selectField('任务状态').selectOption(option.value);steps.push({option,...await conditionMembers(t=>t.state===option.value)});}
    await selectField('任务状态').selectOption(''); await conditionMembers(()=>true);
    return {annotator,options,steps,hiddenMachineStatesAbsent:true};
  });
  await check('更多条件真实展开/收起、7个字段显示且关闭不丢输入', ['F-REPORT-004'], async()=>{
    const toggle=page.getByRole('button',{name:'更多条件',exact:true});await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    for(const name of ['任务ID或任务名','改派次数（≥）'])await page.getByLabel(name,{exact:true}).waitFor({state:'visible'});
    for(const name of ['驳回次数','文案质检人','图片质检人'])await selectField(name).waitFor({state:'visible'});
    await page.getByLabel('任务ID或任务名',{exact:true}).fill('#'+all[0].taskId);await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    await toggle.click();assert.equal(await page.getByLabel('任务ID或任务名',{exact:true}).inputValue(),'#'+all[0].taskId);await clearMore();
    return {expandedCollapsed:true, fieldsVisible:5, retainedTaskInput:true};
  });
  await check('任务 #ID 精确、数字名称、中文模糊、无结果及含SQL字符输入实际查询', ['F-REPORT-005'], async()=>{
    const steps=[];for(const text of ['#'+all[0].taskId,String(all[0].taskId).padStart(3,'0'),'收纳','不存在-合成任务名xyz',"' OR 1=1 --"]) {
      await page.getByLabel('任务ID或任务名',{exact:true}).fill(text); const predicate=text.startsWith('#')?t=>t.taskId===Number(text.slice(1)):t=>t.taskName.toLowerCase().includes(text.toLowerCase());
      steps.push({text,...await conditionMembers(predicate)});
    }
    await page.getByLabel('任务ID或任务名',{exact:true}).fill('');await conditionMembers(()=>true);return {steps};
  });
  await check('驳回0/1/2次、改派>=0/1/100000、两类实际质检人及组合条件成员核对', ['F-REPORT-006'], async()=>{
    const steps=[];for(const value of ['0','1','2']) {await selectField('驳回次数').selectOption(value);steps.push({rejections:Number(value),...await conditionMembers(t=>t.rejectionCount===Number(value))});}
    await selectField('驳回次数').selectOption('');
    for(const value of ['0','1','100000']) {await page.getByLabel('改派次数（≥）',{exact:true}).fill(value);steps.push({reassignmentsAtLeast:Number(value),...await conditionMembers(t=>t.reassignmentCount>=Number(value))});}
    await page.getByLabel('改派次数（≥）',{exact:true}).fill(''); const reviewer=users.find(u=>u.username==='functional-reviewer');
    for(const [label,key]of[['文案质检人','copyQaPeople'],['图片质检人','imageQaPeople']]){await selectField(label).selectOption(String(reviewer.id));steps.push({label,reviewerId:reviewer.id,...await conditionMembers(t=>t[key].some(p=>p.accountId===reviewer.id))});await selectField(label).selectOption('');}
    await selectField('驳回次数').selectOption('1');await selectField('文案质检人').selectOption(String(reviewer.id));
    steps.push({combined:true,...await conditionMembers(t=>t.rejectionCount===1&&t.copyQaPeople.some(p=>p.accountId===reviewer.id))});await clearMore();await conditionMembers(()=>true);return {steps};
  });
  await check('日期倒置和次数负值/小数/超过上限的可见错误与查询禁用、0/100000边界', ['F-REPORT-007'], async()=>{
    await calendar('开始时间',tomorrow,'00:00:00');await page.getByRole('alert').filter({hasText:'请选择有效的开始和结束时间'}).waitFor();assert.equal(await page.getByRole('button',{name:'查询任务',exact:true}).isDisabled(),true);
    await calendar('开始时间',yesterday,'00:01:02');const number=page.getByLabel('改派次数（≥）',{exact:true});
    for(const value of ['-1','0.5','100001']){await number.fill(value);await page.getByRole('alert').filter({hasText:'人员账号及次数条件应填写有效整数'}).waitFor();assert.equal(await page.getByRole('button',{name:'查询任务',exact:true}).isDisabled(),true);}
    for(const value of ['0','100000']){await number.fill(value);assert.equal(await page.getByRole('button',{name:'查询任务',exact:true}).isEnabled(),true);}
    await number.fill('');await query();return {invertedDateDenied:true,invalidNumbers:['-1','0.5','100001'],validBounds:[0,100000],
      verifiedScope:'Visible date-order and integer limits. More-than20 conditions and saved-query save control are not reachable from mounted seven fixed-condition fields.'};
  });
  await check('标注作业概况和人员表按真实响应核对、实际下载XLSX并读取全部指标', ['F-REPORT-015'], async()=>{
    await clearMore();await query();const people=last.data.activityPeople.filter(p=>p.copyReview||p.copyRework||p.imageReview||p.imagePassed||p.deliveryTotal);
    const overview=page.locator('section[aria-labelledby="task-overview-title"]');assert.ok((await overview.innerText()).includes('标注作业概览'));
    const expected=people.map(p=>[p.displayName&&p.username&&p.displayName!==p.username?`${p.displayName}（${p.username}）`:p.displayName||p.username,
      p.copyReview+p.copyRework,p.copyReview,p.copyRework,p.imageReview,p.imageFirstReview,p.imageRework,p.imagePassed,p.deliveryTotal]);
    const table=page.locator('[role="region"][aria-label="作业详情"]');assert.equal(await table.locator('tbody tr').count(),people.length);
    const button=page.getByRole('button',{name:'导出 Excel',exact:true});const[download]=await Promise.all([page.waitForEvent('download',{timeout:60000}),button.click()]);
    const file='task-report-activity-verified.xlsx';await download.saveAs(join(root,file));const bytes=await readFile(join(root,file));assert.ok(bytes.length>100);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);const sheet=workbook.getWorksheet(1);const rows=[];sheet.eachRow((row,n)=>{if(n>1)rows.push(row.values.slice(1));});assert.deepEqual(rows,expected);
    return {request:last.request,activityOverview:last.data.activityOverview,actualPeople:people.length,allWorkbookRows:rows,file,bytes:bytes.length,suggestedName:download.suggestedFilename(),
      verifiedScope:'Actual mounted export is XLSX. Workbook values and visible people count verified, not mislabeled CSV.'};
  });
  await check('任务20条分页、全部成员无重复、上一/下一边界及固定默认时间倒序', ['F-REPORT-017'], async()=>{
    await query();const pages=[last.data.items];assert.equal(await page.getByRole('button',{name:'上一页',exact:true}).isDisabled(),true);
    while(last.data.page<Math.ceil(last.data.total/last.data.pageSize)){await reportPage(()=>page.getByRole('button',{name:'下一页',exact:true}).click());pages.push(last.data.items);}
    assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);const rows=pages.flat();assert.equal(new Set(rows.map(t=>t.taskId)).size,all.length);
    assert.deepEqual(rows.map(t=>t.taskId).sort((a,b)=>a-b),all.map(t=>t.taskId).sort((a,b)=>a-b));
    assert.equal(last.request.sort,'FIRST_COPY_REVIEW_ACTION');assert.equal(last.request.order,'DESC');for(let i=1;i<rows.length;i++)assert.ok(Date.parse(rows[i-1].reportAt)>=Date.parse(rows[i].reportAt));
    while(last.data.page>1)await reportPage(()=>page.getByRole('button',{name:'上一页',exact:true}).click());assert.equal(await page.getByRole('button',{name:'上一页',exact:true}).isDisabled(),true);
    return {pages:pages.map(p=>p.map(t=>t.taskId)),total:rows.length,fixedSort:last.request.sort,order:last.request.order,
      verifiedScope:'Current page exposes pagination and fixed default sorting. Interactive sorting selector is not mounted.'};
  });
  await check('受控报表读取故障提示、保留合法查询入口、解除注入后真实HTTP恢复', ['F-REPORT-021'], async()=>{
    const message='合成测试注入的报表读取故障';let injected=0;
    await page.route(origin+endpoint,async route=>{injected++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'AUDIT_INJECTED_READ_FAILURE',message}})});});
    try{const[failed]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===endpoint&&r.status()===503),page.getByRole('button',{name:'刷新数据',exact:true}).click()]);assert.equal(failed.status(),503);
      await page.getByRole('alert').filter({hasText:message}).waitFor();assert.equal(await page.getByRole('button',{name:'查询任务',exact:true}).isEnabled(),true);
    }finally{await page.unroute(origin+endpoint);}
    const recovered=await query();return {faultInjection:'one browser-fulfilled503 synthetic response; no backend mutation',injected,errorVisible:true,...recovered,...await verifyMembers(all),recoveredRealHttp:true};
  });
}catch(e){result.fatalError=String(e.stack??e)}finally{result.finishedAt=new Date().toISOString();result.status=!result.fatalError&&result.cases.length===10&&result.cases.every(c=>c.status==='PASS')?'PASS':'FAILED';await save();await browser.close();}
console.log(JSON.stringify({status:result.status,passed:result.cases.filter(c=>c.status==='PASS').length,failed:result.cases.filter(c=>c.status==='FAIL').length,taskWrites:0}));if(result.status!=='PASS')process.exitCode=1;
