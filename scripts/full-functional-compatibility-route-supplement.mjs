import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
const origin = process.env.XHS_FUNCTIONAL_ORIGIN; assert.equal(new URL(origin).hostname, '127.0.0.1');
const root = resolve('reports/full-functional-2026-10-02'); await mkdir(root,{recursive:true});
const browser=await chromium.launch({channel:'chromium-headless-shell',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
const result={startedAt:new Date().toISOString(),cases:[],modelCalls:0,taskWrites:0};
const api=async path=>{const r=await context.request.get(origin+'/api/control-plane'+path);assert.equal(r.status(),200);return(await r.json()).data;};
const save=()=>writeFile(join(root,'functional-compatibility-route-supplement.json'),JSON.stringify(result,null,2));
async function check(name,featureIds,fn){const row={id:`VR${result.cases.length+1}`,name,featureIds};try{row.evidence=await fn();row.status='PASS';}catch(e){row.status='FAIL';row.error=String(e.stack??e);}result.cases.push(row);await save();}
try{
  await page.goto(origin+'/login');await page.getByLabel('账号',{exact:true}).fill(process.env.XHS_FUNCTIONAL_TEST_USER);await page.getByLabel('密码',{exact:true}).fill(process.env.XHS_FUNCTIONAL_TEST_PASSWORD);await page.getByRole('button',{name:'进入后台',exact:true}).click();await page.waitForURL('**/workbench/personal');
  const baseline=await api('/v1/tasks?includeTotal=true&limit=200');assert.equal(baseline.total,100);
  await check('未知作业视图实际404页面',['F-VIEW-010'],async()=>{const r=await page.goto(origin+'/workbench/synthetic-missing-view');assert.equal(r.status(),404);await page.getByText('This page could not be found.',{exact:true}).waitFor();return{httpStatus:404};});
  await check('历史交付池兼容路由实际状态成员与详情',['F-VIEW-007'],async()=>{
    const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/control-plane/v1/tasks'&&new URL(r.url()).searchParams.get('states')==='REVIEWED'),page.goto(origin+'/workbench/completed')]);assert.equal(r.status(),200);const data=(await r.json()).data;
    const expected=baseline.items.filter(t=>t.state==='REVIEWED').map(t=>t.id).sort((a,b)=>a-b);assert.deepEqual(data.items.map(t=>t.id).sort((a,b)=>a-b),expected);assert.ok(data.items.every(t=>t.deliveryStatus==='READY'));
    await page.waitForFunction(expected=>{const ids=[...document.querySelectorAll('tbody button[aria-label^="查看作业 #"]')].map(n=>Number(/#(\d+)/.exec(n.getAttribute('aria-label'))[1])).sort((a,b)=>a-b);return JSON.stringify(ids)===JSON.stringify(expected);},expected);
    if(expected.length){await page.getByRole('button',{name:new RegExp(`查看作业 #${expected[0]}：`)}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');}
    return{params:Object.fromEntries(new URL(r.url()).searchParams),taskIds:expected,taskStates:[...new Set(data.items.map(t=>t.state))],deliveryStates:data.items.map(t=>({id:t.id,deliveryStatus:t.deliveryStatus,deliveryReady:t.deliveryReady})),detailOpened:expected.length>0};
  });
  assert.equal((await api('/v1/tasks?includeTotal=true&limit=1')).total,100);
}catch(e){result.fatalError=String(e.stack??e);}finally{result.status=!result.fatalError&&result.cases.length===2&&result.cases.every(r=>r.status==='PASS')?'PASS':'FAIL';result.finishedAt=new Date().toISOString();await save();await browser.close();}
console.log(JSON.stringify({status:result.status,cases:result.cases.map(r=>({id:r.id,status:r.status}))}));if(result.status!=='PASS')process.exitCode=1;
