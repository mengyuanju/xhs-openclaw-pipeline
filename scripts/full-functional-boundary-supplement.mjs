// Real UI boundary cases. Synthetic auxiliary accounts/knowledge are cleaned up.
// Only two source-name fixture fields are temporarily set and restored in isolated PG.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import pg from 'pg';
const origin=process.env.XHS_FUNCTIONAL_ORIGIN;assert.equal(new URL(origin).hostname,'127.0.0.1');
const connectionString=process.env.XHS_FUNCTIONAL_HOLD_DATABASE;assert.equal(new URL(connectionString).hostname,'127.0.0.1');assert.notEqual(new URL(connectionString).port,'5432');
const root=resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT??'reports/full-functional-2026-10-02');await mkdir(root,{recursive:true});
const token='boundary-'+randomUUID().slice(0,8), password='Ui-'+randomUUID();
const result={startedAt:new Date().toISOString(),origin,modelCalls:0,taskCount:100,cases:[],temporaryFixtures:{accounts:[],knowledgeIds:[]}};
const pool=new pg.Pool({connectionString}), browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}), guest=await browser.newContext({viewport:{width:1440,height:1000}});
for(const c of [context,guest])await c.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
const page=await context.newPage(), guestPage=await guest.newPage();for(const p of[page,guestPage]){p.setDefaultTimeout(30000);p.setDefaultNavigationTimeout(60000);}
const save=()=>writeFile(join(root,'functional-boundary-supplement.json'),JSON.stringify(result,null,2));
async function api(path,data,method=data===undefined?'GET':'POST',raw=false){const r=await context.request.fetch(origin+path,{method,data,headers:{origin}});const body=await r.json();assert.ok(r.ok(),path+' '+r.status()+' '+JSON.stringify(body));return raw?body:body.data;}
async function login(p,name,pass){await p.goto(origin+'/login',{waitUntil:'domcontentloaded'});await p.getByLabel('账号',{exact:true}).fill(name);await p.getByLabel('密码',{exact:true}).fill(pass);const[r]=await Promise.all([p.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'),p.getByRole('button',{name:'进入后台',exact:true}).click()]);return r;}
async function check(name,featureIds,action){const e={id:'BD'+String(result.cases.length+1).padStart(2,'0'),name,featureIds,startedAt:new Date().toISOString()};console.log('BOUNDARY '+e.id+' '+name);try{e.evidence=await action();e.status='PASS';}catch(cause){e.status='FAIL';e.error=String(cause.stack??cause).replaceAll(password,'[ephemeral test password]');}e.screenshot='boundary-'+e.id+'-'+e.status.toLowerCase()+'.png';await page.screenshot({path:join(root,e.screenshot),fullPage:true}).catch(()=>{});e.durationMs=Date.now()-Date.parse(e.startedAt);result.cases.push(e);await save();}
const taskIds=()=>page.locator('tbody button[aria-label^="查看作业 #"]').evaluateAll(nodes=>nodes.map(n=>Number(/#(\d+)/.exec(n.getAttribute('aria-label'))[1])));
async function captureList(action,params){const[r]=await Promise.all([page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/control-plane/v1/tasks'&&r.request().method()==='GET'&&Object.entries(params).every(([k,v])=>v===null?!u.searchParams.has(k):u.searchParams.get(k)===String(v));}),action()]);assert.equal(r.status(),200);const data=(await r.json()).data;await page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('tbody button[aria-label^="查看作业 #"]')].map(n=>Number(/#(\d+)/.exec(n.getAttribute('aria-label'))[1])))===JSON.stringify(ids),data.items.map(t=>t.id));return {parameters:Object.fromEntries(new URL(r.url()).searchParams),total:data.total,memberIds:data.items.map(t=>t.id),uiIds:await taskIds()};}
async function knowledgePage(action,params,expectedPage,size){const[r]=await Promise.all([page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/knowledge'&&r.request().method()==='GET'&&Object.entries(params).every(([k,v])=>v===null?!u.searchParams.has(k):u.searchParams.get(k)===String(v));}),action()]);assert.equal(r.status(),200);const u=new URL(page.url());await page.waitForURL(url=>Object.entries(params).every(([k,v])=>v===null?!url.searchParams.has(k):url.searchParams.get(k)===String(v)));
  const expected=await api('/api/copy-knowledge-items?'+new URLSearchParams({label:token,query:token,page:String(expectedPage),pageSize:String(size)}));
  await page.waitForFunction(titles=>JSON.stringify([...document.querySelectorAll('.copy-knowledge-list > li h3')].map(n=>n.textContent))===JSON.stringify(titles),expected.data.map(t=>t.title));assert.equal(expected.pagination.totalItems,51);assert.equal(expected.pagination.page,expectedPage);assert.equal(expected.pagination.pageSize,size);
  return {browserRequestUrl:r.url(),httpStatus:r.status(),url:page.url(),pagination:expected.pagination,memberIds:expected.data.map(t=>t.id),titles:expected.data.map(t=>t.title)};
}
let sourceSnapshot=[];
try{
  assert.equal(Number((await pool.query('SELECT count(*) n FROM tasks')).rows[0].n),100);
  assert.equal((await login(page,'functional-helper','123456')).status(),200);await page.waitForURL('**/workbench/personal');
  for(const role of['USER','REVIEWER']){const created=await api('/api/control-plane/v1/users',{username:token+'-'+role.toLowerCase(),displayName:'合成边界 '+role,role});result.temporaryFixtures.accounts.push({id:created.id,username:created.username,role});}
  await check('连续5次错误密码后实际429限制、正确密码仍受限、管理员取消/确认解除后成功登录',['F-AUTH-003'],async()=>{
    const username=result.temporaryFixtures.accounts[0].username,statuses=[];
    await guestPage.goto(origin+'/login',{waitUntil:'domcontentloaded'});await guestPage.getByLabel('账号',{exact:true}).fill(username);
    for(let i=0;i<6;i++){await guestPage.getByLabel('密码',{exact:true}).fill('invalid-password');const[r]=await Promise.all([guestPage.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'),guestPage.getByRole('button',{name:'进入后台',exact:true}).click()]);statuses.push(r.status());await guestPage.getByRole('alert').filter({hasText:i<5?'登录失败':'登录尝试过多'}).waitFor();assert.equal(r.status(),i<5?401:429);}
    await guestPage.getByRole('alert').filter({hasText:'登录尝试过多，请稍后再试'}).waitFor();await guestPage.getByLabel('密码',{exact:true}).fill('123456');const[blocked]=await Promise.all([guestPage.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'),guestPage.getByRole('button',{name:'进入后台',exact:true}).click()]);assert.equal(blocked.status(),429);
    await guestPage.screenshot({path:join(root,'boundary-real-login-rate-limit.png'),fullPage:true});
    await page.goto(origin+'/users',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'解除登录限制',exact:true}).click();let dialog=page.getByRole('alertdialog');await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'解除登录限制',exact:true}).click();dialog=page.getByRole('alertdialog');const[released]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login-limit/reset'),dialog.getByRole('button',{name:'确认解除',exact:true}).click()]);assert.equal(released.status(),200);const release=(await released.json()).data;assert.ok(release.clearedAccountCount>=1);
    const success=await login(guestPage,username,'123456');assert.equal(success.status(),200);await guestPage.waitForURL('**/profile');
    return {failedStatuses:statuses,validPasswordWhileLimited:429,uiLimitMessage:true,unlockCancelledThenConfirmed:true,release,realLoginAfterUnlock:200,screenshot:'boundary-real-login-rate-limit.png'};
  });
  await check('标注和质检真实登录个人页面均无管理员二级密码控件，直接接口也拒绝',['F-AUTH-014'],async()=>{
    const steps=[];for(const account of result.temporaryFixtures.accounts){await guest.request.post(origin+'/api/auth/logout',{headers:{origin}});assert.equal((await login(guestPage,account.username,'123456')).status(),200);await guestPage.waitForURL('**/profile');
      await guestPage.locator('#forced-current-password').fill('123456');await guestPage.locator('#forced-new-password').fill(password);await guestPage.locator('#forced-confirm-password').fill(password);await guestPage.getByRole('button',{name:'修改密码并重新登录',exact:true}).click();await guestPage.waitForURL('**/login?reauth=1&passwordChanged=1');
      assert.equal((await login(guestPage,account.username,password)).status(),200);await guestPage.waitForURL('**/workbench/personal');await guestPage.goto(origin+'/profile',{waitUntil:'domcontentloaded'});await guestPage.locator('#profile-current-password').waitFor();assert.equal(await guestPage.locator('#deletion-password').count(),0);assert.equal(await guestPage.getByRole('heading',{name:'永久删除二级密码',exact:true}).count(),0);
      const denied=await guest.request.post(origin+'/api/control-plane/v1/profile/deletion-password',{data:{currentPassword:password,deletionPassword:'Second-'+password},headers:{origin}});assert.equal(denied.status(),403);await guestPage.screenshot({path:join(root,'boundary-profile-'+account.role.toLowerCase()+'.png'),fullPage:true});steps.push({role:account.role,noDeletionSection:true,noDeletionInput:true,directEndpointStatus:denied.status()});}
    return {steps};
  });
  await check('51条明确合成文案知识辅助项，标签/搜索保留，每页10/20/50及全部页/边界实际点击',['F-KNOW-014'],async()=>{
    for(let i=1;i<=51;i++){const created=await api('/api/copy-knowledge-items',{title:token+' 合成分析 '+String(i).padStart(2,'0'),sourceCopy:'合成分页输入，无模型生成',analysisPrompt:'合成规则',summary:'合成分页夹具',analysis:'这条人工合成记录用于分页测试，不是模型分析结果。',labels:[token],analysisModel:'synthetic-fixture'});result.temporaryFixtures.knowledgeIds.push(created.id);}
    await page.goto(origin+'/knowledge',{waitUntil:'domcontentloaded'});const label=page.getByRole('button',{name:token+' 51',exact:true});if(!await label.isVisible())await page.getByRole('button',{name:/展开全部（/}).click();await label.click();await page.getByRole('searchbox',{name:'搜索分析标题',exact:true}).fill(token);
    await page.waitForURL(u=>u.searchParams.get('copyLabel')===token&&u.searchParams.get('copyQuery')===token);await page.waitForFunction(()=>document.querySelector('.copy-knowledge-pagination [role=status]')?.textContent==='第 1 / 6 页');
    const steps=[];for(const size of[20,50,10]){steps.push(await knowledgePage(async()=>{await page.getByRole('combobox',{name:'每页条数',exact:true}).click();await page.getByRole('option',{name:size+' 条 / 页',exact:true}).click();},{copyLabel:token,copyQuery:token,copyPage:null,copyPageSize:size===10?null:size},1,size));assert.equal(await page.getByRole('button',{name:'上一页',exact:true}).isDisabled(),true);
      const totalPages=Math.ceil(51/size),members=[...steps.at(-1).memberIds];for(let p=2;p<=totalPages;p++){const step=await knowledgePage(()=>page.getByRole('button',{name:'下一页',exact:true}).click(),{copyLabel:token,copyQuery:token,copyPage:p,copyPageSize:size===10?null:size},p,size);steps.push(step);members.push(...step.memberIds);}assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);assert.equal(new Set(members).size,51);assert.deepEqual(members.toSorted((a,b)=>a-b),result.temporaryFixtures.knowledgeIds.toSorted((a,b)=>a-b));
      for(let p=totalPages-1;p>=1;p--)steps.push(await knowledgePage(()=>page.getByRole('button',{name:'上一页',exact:true}).click(),{copyLabel:token,copyQuery:token,copyPage:p===1?null:p,copyPageSize:size===10?null:size},p,size));}
    return {syntheticFixtureCount:51,modelCalls:0,steps,allPageSizesTraversed:[10,20,50],labelAndSearchRetained:true};
  });
  await check('现有两条任务短时来源名称夹具，词包关键词真实筛选/无结果/清除恢复100条',['F-LIST-004'],async()=>{
    const packs=await api('/api/control-plane/v1/query-packages?limit=100');const list=packs.items??packs.packages??packs;const pack=list.find(p=>p.name.includes('100 条合成'));assert.ok(pack);
    sourceSnapshot=(await pool.query(`SELECT id,source_query_package_id,source_query_package_name FROM tasks t WHERE state='COPY_QUEUED' AND NOT EXISTS(SELECT 1 FROM task_executions e WHERE e.task_id=t.id) AND source_query_package_id IS NULL ORDER BY id DESC LIMIT 2`)).rows;assert.equal(sourceSnapshot.length,2);
    result.temporarySourceSnapshot=sourceSnapshot;await pool.query('UPDATE tasks SET source_query_package_id=$1,source_query_package_name=$2 WHERE id=ANY($3::bigint[])',[pack.id,pack.name,sourceSnapshot.map(t=>t.id)]);
    try{await page.goto(origin+'/workbench/all',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/查看作业 #/}).first().waitFor();
      await page.getByRole('searchbox',{name:'词包名称',exact:true}).fill('合成导入词包');const positive=await captureList(()=>page.getByRole('button',{name:'搜索',exact:true}).click(),{queryPackageName:'合成导入词包'});assert.equal(positive.total,2);assert.deepEqual(positive.memberIds.toSorted((a,b)=>a-b),sourceSnapshot.map(t=>Number(t.id)).toSorted((a,b)=>a-b));
      await page.getByRole('searchbox',{name:'词包名称',exact:true}).fill('没有这个词包的合成名称xyz');const empty=await captureList(()=>page.getByRole('button',{name:'搜索',exact:true}).click(),{queryPackageName:'没有这个词包的合成名称xyz'});assert.equal(empty.total,0);
      const cleared=await captureList(()=>page.getByRole('button',{name:'清除',exact:true}).click(),{queryPackageName:null});assert.equal(cleared.total,100);return{fixtureFields:['source_query_package_id','source_query_package_name'],fixtureTaskIds:sourceSnapshot.map(t=>Number(t.id)),positive,empty,cleared};
    }finally{for(const row of sourceSnapshot)await pool.query('UPDATE tasks SET source_query_package_id=$1,source_query_package_name=$2 WHERE id=$3',[row.source_query_package_id,row.source_query_package_name,row.id]);result.sourceFixtureRestored=true;}
  });
  await check('列表搜索/排序/每页/页码保留，打开详情任务ID进URL，刷新重开详情，关闭恢复原页成员',['F-LIST-034'],async()=>{
    await page.goto(origin+'/workbench/all',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/查看作业 #/}).first().waitFor();await page.getByRole('searchbox',{name:'Query 关键词或 #ID（如 #1024）',exact:true}).fill('合成');await captureList(()=>page.getByRole('button',{name:'搜索',exact:true}).click(),{query:'合成'});
    await captureList(async()=>{await page.locator('#workbench-task-sort').click();await page.getByRole('option',{name:'Query ID：从小到大',exact:true}).click();},{sortBy:'id',sortOrder:'asc'});
    await captureList(()=>page.getByRole('button',{name:'下一页',exact:true}).click(),{limit:20});await page.waitForURL(u=>u.searchParams.get('page')==='2');const before=page.url(),members=await taskIds(),id=members[0];
    await page.locator('tbody button[aria-label^="查看作业 #"]').first().click();const dialog=page.getByRole('dialog');await dialog.waitFor();await page.waitForURL(u=>u.searchParams.get('taskId')===String(id));const detailUrl=page.url();await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByText('Task #'+id,{exact:true}).waitFor();
    await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForURL(before);assert.deepEqual(await taskIds(),members);assert.equal(await page.getByRole('searchbox',{name:'Query 关键词或 #ID（如 #1024）',exact:true}).inputValue(),'合成');
    return{listUrlBefore:before,detailUrl,reloadedDetailId:id,closedUrl:page.url(),memberIdsBefore:members,memberIdsAfter:await taskIds(),queryAndSortAndPageSizeAndPageRetained:true};
  });
}catch(cause){result.fatalError=String(cause.stack??cause).replaceAll(password,'[ephemeral test password]');}
finally{
  const cleanupErrors=[];for(const id of result.temporaryFixtures.knowledgeIds)await api('/api/copy-knowledge-items/'+id,undefined,'DELETE').catch(e=>cleanupErrors.push(String(e)));
  for(const account of result.temporaryFixtures.accounts){const users=await api('/api/control-plane/v1/users').catch(()=>[]),user=users.find(u=>u.id===account.id);if(user)await api('/api/control-plane/v1/users/'+user.id,{expectedVersion:user.version},'DELETE').catch(e=>cleanupErrors.push(String(e)));}
  for(const row of sourceSnapshot)await pool.query('UPDATE tasks SET source_query_package_id=$1,source_query_package_name=$2 WHERE id=$3',[row.source_query_package_id,row.source_query_package_name,row.id]).catch(e=>cleanupErrors.push(String(e)));
  result.cleanup={errors:cleanupErrors,auxiliaryKnowledgeRemoved:cleanupErrors.length===0,auxiliaryAccountsRemoved:cleanupErrors.length===0,taskCount:Number((await pool.query('SELECT count(*) n FROM tasks')).rows[0].n)};
  result.finishedAt=new Date().toISOString();result.status=!result.fatalError&&result.cases.length===5&&result.cases.every(c=>c.status==='PASS')&&!cleanupErrors.length&&result.cleanup.taskCount===100?'PASS':'FAILED';await save();await browser.close();await pool.end();
}
console.log(JSON.stringify({status:result.status,passed:result.cases.filter(e=>e.status==='PASS').length,failed:result.cases.filter(e=>e.status==='FAIL').length,cleanup:result.cleanup}));if(result.status!=='PASS')process.exitCode=1;
