// Existing prompt UI only, against the explicitly retained temporary service.
// Publishing modifies test configuration; no production services or model calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
const root=resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT??'reports/full-functional-2026-10-02-final');
const active=JSON.parse(await readFile('reports/full-functional-2026-10-02/functional-active-environment.json','utf8'));
const origin=process.env.XHS_FUNCTIONAL_ORIGIN??active.origin;assert.equal(new URL(origin).hostname,'127.0.0.1');
const result={startedAt:new Date().toISOString(),origin,evidenceType:'UI_REAL_ISOLATED',modelCalls:0,cases:[],errors:[],notice:'Only isolated existing prompt configuration is published; no task/model/publishing destination is invoked.'};
const caseFilter=process.env.XHS_FUNCTIONAL_PROMPT_CASES?.split(',')??null;let caseNumber=0;
if(process.env.XHS_FUNCTIONAL_PROMPT_RESUME==='1'){const previous=JSON.parse(await readFile(join(root,'functional-prompt-supplement.json'),'utf8'));result.cases=previous.cases.filter(entry=>!caseFilter?.includes(entry.id));result.resumedFrom=previous.startedAt;}
await mkdir(root,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1080}});const page=await context.newPage();page.setDefaultTimeout(45000);page.setDefaultNavigationTimeout(90000);
page.on('pageerror',error=>result.errors.push(error.message));
async function request(p,body,method=body===undefined?'GET':'POST'){const r=await context.request.fetch(origin+p,{method,headers:{origin},data:body});const j=await r.json();assert.ok(r.ok(),`${p}: ${r.status()} ${JSON.stringify(j)}`);return j.data??j;}
const save=()=>writeFile(join(root,'functional-prompt-supplement.json'),JSON.stringify(result,null,2));
async function check(name,featureIds,action){const entry={id:`P${String(++caseNumber).padStart(3,'0')}`,name,featureIds,startedAt:new Date().toISOString()};if(caseFilter&&!caseFilter.includes(entry.id))return;console.log(`PROMPT ${entry.id} ${name}`);
  try{entry.evidence=await action();entry.status='PASS';}catch(error){entry.status='FAIL';entry.error=String(error.stack??error);}
  entry.durationMs=Date.now()-Date.parse(entry.startedAt);entry.screenshot=`prompt-${entry.id}-${entry.status.toLowerCase()}.png`;
  await page.screenshot({path:join(root,entry.screenshot),fullPage:true}).catch(()=>{});result.cases.push(entry);result.cases.sort((a,b)=>a.id.localeCompare(b.id));await save();await page.keyboard.press('Escape').catch(()=>{});
}
async function select(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();}
async function gotoPrompts(){await page.goto(origin+'/prompts',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>{const el=document.querySelector('#central-prompt-content-TEXT_SYSTEM');return el&&Object.keys(el).some(key=>key.startsWith('__reactProps')&&typeof el[key]?.onChange==='function');},undefined,{timeout:60000});}
async function waitPolicyHydration(){await page.waitForFunction(()=>{const el=document.querySelector('input[type="number"][max="100"]');return el&&Object.keys(el).some(key=>key.startsWith('__reactProps')&&typeof el[key]?.onChange==='function');},undefined,{timeout:60000});}
async function settle(){await page.waitForTimeout(250);}
let originalPolicy;
try{
  await page.goto(origin+'/login',{waitUntil:'domcontentloaded'});await page.getByLabel('账号',{exact:true}).fill('functional-helper');await page.getByLabel('密码',{exact:true}).fill('123456');
  await page.getByRole('button',{name:'进入后台',exact:true}).click();await page.waitForURL(url=>!url.pathname.startsWith('/login'));
  await check('准备缺失候选草稿实际点击，两次执行不覆盖已有人工版本', ['F-PROMPT-013'],async()=>{
    await gotoPrompts();const before=await request('/api/control-plane/v1/prompts');
    await page.getByRole('button',{name:'准备缺失的候选草稿',exact:true}).click();await page.getByText('候选草稿已准备，已有人工版本保持不变。请逐项编辑并发布。',{exact:true}).waitFor();
    const after=await request('/api/control-plane/v1/prompts');for(const item of before)for(const version of item.versions){assert.ok(after.find(row=>row.kind===item.kind)?.versions.some(v=>v.id===version.id&&v.content===version.content));}
    await page.getByRole('button',{name:'准备缺失的候选草稿',exact:true}).click();await settle();const second=await request('/api/control-plane/v1/prompts');
    assert.equal(second.reduce((n,row)=>n+row.versions.length,0),after.reduce((n,row)=>n+row.versions.length,0));
    return{preservedExistingVersions:true,afterTemplateCount:after.length,idempotent:true};
  });
  await check('执行配置全部字段边界、缺版本拒绝、发布缺失业务规则后保存并恢复配置', ['F-PROMPT-006','F-PROMPT-014','F-PROMPT-015','F-PROMPT-016','F-PROMPT-017'],async()=>{
    await gotoPrompts();const config=await request('/api/prompt-runtime');originalPolicy=config.settings;
    for(const [label,value] of [['案例入选分数','101'],['长度修复目标下限','399'],['长度修复目标上限','601'],['OCR 最低置信度','1.01']]){
      const input=page.getByLabel(label,{exact:true});const before=await input.inputValue();await input.fill(value);assert.equal(await input.evaluate(el=>el.validity.valid),false);await input.fill(before);
    }
    await page.getByLabel('长度修复目标下限',{exact:true}).fill('590');await page.getByLabel('长度修复目标上限',{exact:true}).fill('410');
    await page.getByRole('button',{name:/^(保存执行配置|检查版本并启用统一规则)$/}).click();await page.getByRole('alert').filter({hasText:/下限|上限|目标/}).waitFor();
    await page.getByLabel('长度修复目标下限',{exact:true}).fill(String(originalPolicy.copyRepairTargetMin));await page.getByLabel('长度修复目标上限',{exact:true}).fill(String(originalPolicy.copyRepairTargetMax));
    const enabledQuery=page.getByRole('switch',{name:'启用 Query 筛选',exact:true});const enabledVisual=page.getByRole('switch',{name:'启用视觉规划',exact:true});
    if(!await enabledQuery.isChecked())await enabledQuery.check();if(!await enabledVisual.isChecked())await enabledVisual.check();
    const templates=await request('/api/control-plane/v1/prompts');const required=config.catalog.filter(item=>item.layer==='BUSINESS'&&item.executionStatus!=='RESERVED'&&!['IMAGE_SEARCH_SYSTEM','LAYOUT_CATALOG_SYSTEM'].includes(item.kind));
    const missing=required.filter(item=>!templates.find(template=>template.kind===item.kind)?.versions.some(version=>version.status==='PUBLISHED'));
    if(missing.length){await page.getByRole('button',{name:/^(保存执行配置|检查版本并启用统一规则)$/}).click();await page.getByRole('alert').filter({hasText:'请先发布以下提示词'}).waitFor();}
    const published=[];
    for(const item of missing){
      await page.getByLabel('查找所有提示词',{exact:true}).fill(item.label);await page.getByRole('region',{name:'提示词搜索结果',exact:true}).getByRole('button').first().click();
      const editor=page.locator(`#central-prompt-content-${item.kind}`);await editor.fill((await editor.inputValue())+`\n合成UI执行配置验证${randomUUID().slice(0,8)}`);
      await page.locator('form').filter({has:editor}).getByRole('button',{name:'提交更新',exact:true}).click();
      let dialog=page.getByRole('alertdialog');await dialog.waitFor();if(await dialog.getByRole('button',{name:'仍然提交更新',exact:true}).count()){await dialog.getByRole('button',{name:'仍然提交更新',exact:true}).click();}
      await dialog.getByRole('button',{name:'提交更新',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByText(/v\d+ 已更新并发布/).waitFor();published.push(item.kind);
    }
    const savedThreshold=originalPolicy.copyKnowledgeThreshold===86?83:86;
    await page.getByLabel('案例入选分数',{exact:true}).fill(String(savedThreshold));await page.getByLabel('长度修复目标下限',{exact:true}).fill('450');await page.getByLabel('长度修复目标上限',{exact:true}).fill('550');
    await page.getByLabel('OCR 最低置信度',{exact:true}).fill('0.85');await select('文字比较方式','历史宽松比较（忽略空白、引号等）');
    await page.getByRole('button',{name:/^(保存执行配置|检查版本并启用统一规则)$/}).click();await page.getByText('执行配置已保存；新执行使用此配置，历史执行沿用原版本。',{exact:true}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});await waitPolicyHydration();const saved=await request('/api/prompt-runtime');assert.equal(saved.active,true);assert.equal(saved.settings.copyKnowledgeThreshold,savedThreshold);assert.equal(saved.settings.copyRepairTargetMin,450);assert.equal(saved.settings.copyRepairTargetMax,550);assert.equal(saved.settings.ocrMinimumConfidence,0.85);assert.equal(saved.settings.ocrComparison,'LEGACY_NORMALIZED');
    assert.equal(saved.settings.queryReviewEnabled,true);assert.equal(saved.settings.visualPlanningEnabled,true);
    await page.getByLabel('案例入选分数',{exact:true}).fill(String(originalPolicy.copyKnowledgeThreshold));await page.getByLabel('长度修复目标下限',{exact:true}).fill(String(originalPolicy.copyRepairTargetMin));await page.getByLabel('长度修复目标上限',{exact:true}).fill(String(originalPolicy.copyRepairTargetMax));
    await page.getByLabel('OCR 最低置信度',{exact:true}).fill(String(originalPolicy.ocrMinimumConfidence));await select('文字比较方式',originalPolicy.ocrComparison==='LEGACY_NORMALIZED'?'历史宽松比较（忽略空白、引号等）':'只忽略排版换行');
    if(!originalPolicy.queryReviewEnabled)await page.getByRole('switch',{name:'启用 Query 筛选',exact:true}).uncheck();if(!originalPolicy.visualPlanningEnabled)await page.getByRole('switch',{name:'启用视觉规划',exact:true}).uncheck();
    const restoreResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/prompt-runtime'&&response.request().method()==='PUT');
    await page.getByRole('button',{name:'保存执行配置',exact:true}).click();assert.equal((await restoreResponse).status(),200);assert.deepEqual((await request('/api/prompt-runtime')).settings,originalPolicy);
    return{invalidBoundariesRejected:4,minGreaterThanMaxRejected:true,missingTemplatesRejected:missing.map(item=>item.kind),publishedByUI:published,settingsPersistedThenRestored:true,modelCalls:0};
  });
  await check('提示词放弃修改取消/确认，历史展开载入取消/确认，载入本身不发布', ['F-PROMPT-007','F-PROMPT-008'],async()=>{
    await gotoPrompts();await page.getByRole('tab',{name:'文案生成',exact:true}).click();const editor=page.locator('#central-prompt-content-TEXT_SYSTEM');const text=await editor.inputValue();
    await editor.fill(text+'\n合成临时编辑，不应发布');await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.ok((await editor.inputValue()).endsWith('不应发布'));
    await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();assert.equal(await editor.inputValue(),text);
    const before=await request('/api/control-plane/v1/prompts');const template=before.find(item=>item.kind==='TEXT_SYSTEM');const published=template.versions.find(version=>version.status==='PUBLISHED');
    const history=page.getByRole('region',{name:/历史版本$/}).last();
    const summaries=history.locator('[data-slot=disclosure-trigger]');if(!await summaries.count())throw Error('TEXT_SYSTEM history region is not visible');
    await summaries.last().click();const load=history.getByRole('button',{name:'载入此版本编辑',exact:true}).last();
    await editor.fill(text+'\n旧草稿应受确认保护');await load.click();await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.ok((await editor.inputValue()).endsWith('确认保护'));
    await load.click();await page.getByRole('alertdialog').getByRole('button',{name:'替换编辑内容',exact:true}).click();
    assert.equal((await request('/api/control-plane/v1/prompts')).find(item=>item.kind==='TEXT_SYSTEM').versions.find(version=>version.status==='PUBLISHED').id,published.id);
    return{discardCancelAndConfirm:true,historyLoadCancelAndConfirm:true,publishedVersionUnchanged:published.id,limitation:'中心历史内容载入后可提交为新版本；本机重新发布旧版本按钮当前中心未挂载。'};
  });
  await check('Web执行记录折叠刷新、固定契约展开与知识库真实导航', ['F-PROMPT-018','F-PROMPT-019'],async()=>{
    await gotoPrompts();await page.getByRole('button',{name:'查看 Web 执行记录（管理员）',exact:true}).click();
    await page.getByRole('button',{name:'刷新最近 50 次执行',exact:true}).click();await settle();const text=await page.getByText(/暂无执行记录|没有执行记录/).count();
    await page.getByRole('button',{name:'查看固定契约与允许变量（只读）',exact:true}).click();
    const link=page.getByRole('link',{name:'打开知识库管理优秀文案分析模板与视觉配方',exact:true});assert.equal(await link.getAttribute('href'),'/knowledge');
    await link.click();await page.waitForURL(url=>url.pathname==='/knowledge');
    return{historyExpandedAndRefreshed:true,emptyRecordsVisible:Boolean(text),fixedContractExpanded:true,knowledgeNavigation:true,limitation:'没有新增真实模型调用，实际非空执行记录/附件另由模型smoke与模型记录浏览器夹具验证。'};
  });
}catch(error){result.fatalError=String(error.stack??error);throw error;}finally{
  result.status=result.fatalError||result.cases.some(entry=>entry.status==='FAIL')?'FAILED':'PASS';result.finishedAt=new Date().toISOString();await save();await browser.close();
}
console.log(JSON.stringify({status:result.status,passed:result.cases.filter(entry=>entry.status==='PASS').length,failed:result.cases.filter(entry=>entry.status==='FAIL').length}));if(result.status!=='PASS')process.exitCode=1;
